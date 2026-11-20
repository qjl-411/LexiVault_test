from __future__ import annotations

import secrets
import logging
import smtplib
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .accounts import AccountStore
from .mailer import EmailSender
from .storage import StoreError

COOKIE = 'lv_account_session'
logger = logging.getLogger(__name__)
EmailCode = Annotated[str, Field(min_length=4, max_length=4, pattern=r'^[0-9]{4}$')]


class Credentials(BaseModel):
    model_config = ConfigDict(extra='forbid')
    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)
    remember: bool = False
    code: EmailCode | None = None


class Registration(Credentials):
    nickname: str = Field(default='', max_length=80)
    code: EmailCode


class EmailRequest(BaseModel):
    email: str = Field(min_length=1, max_length=254)


class VerificationRequest(EmailRequest):
    purpose: Literal['register','verify_email']
    password: str | None = Field(default=None, max_length=128)


class PasswordReset(EmailRequest):
    code: EmailCode
    password: str = Field(min_length=1, max_length=128)


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    theme: Literal['light','dark'] | None = None
    font_size: int | None = Field(default=None, ge=12, le=26)


def account_router(store: AccountStore, secure_cookies=False):
    router = APIRouter(prefix='/api/auth', tags=['accounts'])
    mailer = EmailSender.from_env()

    def client_ip(request):
        return request.client.host if request.client else 'unknown'

    def require_mailer():
        if mailer is None:
            raise StoreError('邮件服务尚未配置。', 503, code='mailUnavailable')

    def deliver_code(email, purpose, code, report_failure=False):
        if code is None:
            return
        try:
            mailer.send_code(email,purpose,code)
        except (OSError, ValueError, smtplib.SMTPException):
            store.discard_code(email,purpose,code)
            logger.warning('Account email delivery failed for %s', purpose)
            if report_failure:
                raise StoreError('验证码邮件发送失败，请稍后重试。', 503, code='mailDeliveryFailed')

    def notify_reset(email):
        try:
            mailer.notify_password_reset(email)
        except (OSError, ValueError, smtplib.SMTPException):
            logger.warning('Password reset notification delivery failed')

    def user(request, csrf=False):
        raw = request.cookies.get(COOKIE)
        identity = store.current(raw)
        if not identity:
            raise StoreError('请先登录账号。', 401, code='loginRequired')
        if csrf and not secrets.compare_digest(request.headers.get('x-account-csrf',''), store.csrf(raw)):
            raise StoreError('账号请求校验失败，请刷新页面。', 403)
        return identity

    @router.post('/email-code')
    def email_code(body: VerificationRequest, request: Request):
        require_mailer()
        email, code = store.issue_code(body.email,body.purpose,client_ip(request),body.password)
        deliver_code(email,body.purpose,code,report_failure=True)
        return {'accepted': True}

    @router.post('/register', status_code=201)
    def register(body: Registration, request: Request):
        return {'user': store.register(body.email,body.password,body.nickname,client_ip(request),code=body.code)}

    @router.post('/login')
    def login(body: Credentials, request: Request, response: Response):
        raw, lifetime = store.login(body.email,body.password,body.remember,client_ip(request),request.cookies.get(COOKIE),body.code)
        response.set_cookie(COOKIE, raw, httponly=True, secure=secure_cookies, samesite='strict',
                            max_age=lifetime if body.remember else None, path='/')
        return {'user': store.current(raw), 'csrf_token': store.csrf(raw), 'settings': store.settings(store.current(raw)['id'])}

    @router.get('/me')
    def current(request: Request):
        identity = store.current(request.cookies.get(COOKIE))
        if not identity:
            return {'user': None}
        return {'user': identity, 'csrf_token': store.csrf(request.cookies[COOKIE]), 'settings': store.settings(identity['id'])}

    @router.post('/logout')
    def logout(request: Request, response: Response):
        raw = request.cookies.get(COOKIE)
        if store.current(raw):
            user(request, csrf=True)
        store.logout(raw)
        response.delete_cookie(COOKIE, path='/', secure=secure_cookies, httponly=True, samesite='strict')
        return {'signed_out': True}

    @router.get('/settings')
    def settings(request: Request):
        return store.settings(user(request)['id'])

    @router.patch('/settings')
    def save_settings(body: SettingsPatch, request: Request):
        return store.update_settings(user(request, csrf=True)['id'],body.model_dump(exclude_none=True))

    @router.post('/password-reset')
    def password_reset(body: EmailRequest, request: Request, background: BackgroundTasks):
        require_mailer()
        email, code = store.issue_code(body.email,'reset_password',client_ip(request))
        background.add_task(deliver_code,email,'reset_password',code)
        return {'accepted': True}

    @router.post('/password-reset/confirm')
    def confirm_password_reset(body: PasswordReset, request: Request, background: BackgroundTasks):
        store.reset_password(body.email,body.code,body.password,client_ip(request))
        if mailer is not None:
            background.add_task(notify_reset,store.normalize_email(body.email))
        return {'password_reset': True}

    return router


def create_account_app(data_dir: Path, secure_cookies=True):
    """Deployable account-only service. It never opens any local paper workspace."""
    store = AccountStore(data_dir / 'accounts.sqlite')
    app = FastAPI(title='LexiVault account service')
    app.state.accounts = store

    @app.exception_handler(StoreError)
    async def failure(request, error):
        return JSONResponse({'message': error.message, **error.details},status_code=error.status)

    @app.middleware('http')
    async def origin_check(request, call_next):
        origin = request.headers.get('origin')
        if (origin and origin != str(request.base_url).rstrip('/')) or request.headers.get('sec-fetch-site') == 'cross-site':
            return JSONResponse({'message': '拒绝跨站点账号请求。'},status_code=403)
        if request.method not in {'GET','HEAD','OPTIONS'} and 'application/json' not in request.headers.get('content-type',''):
            return JSONResponse({'message': '账号接口仅接受 JSON 请求。'},status_code=415)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    app.include_router(account_router(store,secure_cookies))
    return app
