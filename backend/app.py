from __future__ import annotations

import asyncio
import json
import logging
import secrets
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from .static import FrontendStaticFiles
from pydantic import BaseModel, Field
from watchfiles import awatch

from .storage import MAX_PDF, NOTE_HEADER, Registry, StoreError, atomic_write, digest, within
from .accounts import AccountStore
from .auth_api import COOKIE, account_router
from .catalog_api import catalog_router
from .discovery_api import discovery_router
from .inspect_pdf import validate_pdf
from .workspace_api import workspace_router
from .plans_api import plan_router


class NoteInput(BaseModel):
    markdown: str = Field(max_length=2 * 1024 * 1024)
    expected_revision: str = Field(max_length=80)
    path: str | None = Field(default=None,max_length=1000)


class WorkspaceInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class PositionInput(BaseModel):
    page: int = Field(ge=1)


def select_workspace_directory(title: str) -> Path | None:
    try:
        result = subprocess.run([sys.executable, '-m', 'backend.pick_folder', title],
                                capture_output=True, text=True, encoding='utf-8', timeout=180,
                                cwd=str(Path(__file__).resolve().parents[1]))
    except subprocess.TimeoutExpired:
        raise StoreError('目录选择已超时，请重试。', 408)
    if result.returncode:
        raise StoreError('无法打开目录选择窗口，请检查本地服务是否可使用桌面。', 503)
    selected = json.loads(result.stdout)
    return Path(selected) if selected else None


def create_app(data_dir: Path, frontend: Path | None = None):
    registry = Registry(data_dir)
    accounts = AccountStore(data_dir / 'accounts.sqlite')
    token = secrets.token_urlsafe(32)
    watchers = {}
    listeners = {}
    note_versions = {}

    async def notify(workspace_id):
        for queue in tuple(listeners.get(workspace_id, set())):
            if queue.empty():
                queue.put_nowait({"type": "workspace_changed"})

    def observe(workspace):
        changed = False
        for document in workspace.documents():
            key = (workspace.id, document["id"])
            try:
                note = workspace.note(document["id"])
                old = note_versions.get(key)
                if old and old["revision"] != note["revision"]:
                    changed = True
                    if not old["missing"] and old["revision"]!="uncreated":
                        path = within(workspace.root, f".lexivault/history/notes/{document['id']}/{old['revision']}.md")
                        if not path.exists():
                            atomic_write(path, (NOTE_HEADER.format(id=document["id"]) + old["markdown"]).encode("utf-8"))
                note_versions[key] = note
            except (StoreError, OSError):
                # Notify clients so invalid encoding/deletions are visible, never replace drafts.
                changed = True
        return changed

    async def watch(workspace):
        await asyncio.to_thread(observe, workspace)
        try:
            async for changes in awatch(str(workspace.root),
                                        debounce=150, rust_timeout=1500, yield_on_timeout=True):
                changed = await asyncio.to_thread(observe, workspace)
                visible_changes=[change for change in changes if ".lexivault" not in Path(change[1]).relative_to(workspace.root).parts]
                if changed or visible_changes:
                    await notify(workspace.id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.exception("Workspace watcher stopped")
            for queue in listeners.get(workspace.id, set()):
                if queue.empty():
                    queue.put_nowait({"type": "watcher_error"})

    def start_watcher(workspace):
        if workspace.id not in watchers:
            watchers[workspace.id] = asyncio.create_task(watch(workspace))

    @asynccontextmanager
    async def lifespan(app):
        for workspace in registry.items.values():
            start_watcher(workspace)
        yield
        for task in watchers.values():
            task.cancel()
        for task in watchers.values():
            with suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="LexiVault local reading API", lifespan=lifespan)
    app.state.registry = registry
    app.state.accounts = accounts

    @app.exception_handler(StoreError)
    async def store_error(request, error):
        return JSONResponse({"message": error.message, **error.details}, status_code=error.status)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        host = request.url.hostname
        if host not in {"localhost", "127.0.0.1", "::1", "testserver"}:
            return JSONResponse({"message": "仅允许本机访问。"}, status_code=403)
        if request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            if (origin and origin != str(request.base_url).rstrip("/")) or request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"message": "拒绝跨站点请求。"}, status_code=403)
            if request.url.path != "/api/session":
                if request.cookies.get("lv_session") != token:
                    return JSONResponse({"message": "本地会话已失效，请刷新页面。"}, status_code=401)
                if request.method not in {"GET", "HEAD"} and request.headers.get("x-lexivault-token") != token:
                    return JSONResponse({"message": "请求缺少本地会话校验。"}, status_code=403)
        identity = None
        page = request.url.path == '/' or request.url.path.endswith('.html') or request.url.path in {'/docs','/redoc','/openapi.json'}
        api = request.url.path.startswith('/api/')
        if page or api:
            identity = await asyncio.to_thread(accounts.current, request.cookies.get(COOKIE))
            request.state.user = identity
        public_api = request.url.path in {
            '/api/session','/api/auth/register','/api/auth/login','/api/auth/me','/api/auth/logout',
            '/api/auth/email-code','/api/auth/password-reset','/api/auth/password-reset/confirm',
        }
        if (api and not public_api) or (page and request.url.path != '/index.html'):
            if not identity:
                if page:
                    response = RedirectResponse('/index.html', status_code=303)
                else:
                    response = JSONResponse({'message':'请先登录账号。','code':'loginRequired'}, status_code=401)
                response.headers['Cache-Control'] = 'no-store'
                return response
        if api and identity and not public_api:
            expected_user = request.headers.get('x-lexivault-user')
            if expected_user and expected_user != identity['id']:
                return JSONResponse({'message':'账号已切换，请重新打开页面。','code':'accountChanged'}, status_code=401, headers={'Cache-Control':'no-store'})
            parts = request.url.path.strip('/').split('/')
            if len(parts) >= 3 and parts[:2] == ['api','workspaces'] and parts[2] != 'choose':
                try:
                    await asyncio.to_thread(registry.authorized, parts[2], identity['id'])
                except StoreError as error:
                    return JSONResponse({'message':error.message, **error.details}, status_code=error.status, headers={'Cache-Control':'no-store'})
        try:
            response = await call_next(request)
        except Exception:
            logging.exception("Local request failed")
            return JSONResponse({"message": "操作未完成，请检查文件权限、磁盘空间或服务日志。"}, status_code=500)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif page:
            response.headers['Cache-Control'] = 'no-store'
        elif request.url.path.endswith(('.js','.mjs')):
            response.headers['Cache-Control'] = 'no-cache'
        return response

    @app.get("/api/session")
    def session(request: Request):
        identity = request.state.user
        response = JSONResponse({"token": token, "user_id": identity['id'] if identity else None,
                                 "data_dir": str(registry.root) if identity else ''})
        response.set_cookie("lv_session", token, httponly=True, samesite="strict")
        return response

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    app.include_router(account_router(accounts))
    app.include_router(catalog_router(registry))
    app.include_router(discovery_router(registry, notify, accounts))
    app.include_router(workspace_router(registry))
    app.include_router(plan_router(registry))
    from .files_api import files_router
    app.include_router(files_router(registry))

    @app.get("/api/workspaces")
    def workspaces(request: Request):
        return registry.opened(request.state.user['id'])

    @app.post('/api/workspaces/{workspace_id}/open')
    def mark_open(workspace_id: str, request: Request):
        return registry.mark_open(workspace_id,request.state.user['id'])

    @app.post("/api/workspaces", status_code=201)
    async def new_workspace(body: WorkspaceInput, request: Request):
        parent = await asyncio.to_thread(select_workspace_directory, '选择新工作空间的保存位置')
        if parent is None:
            return JSONResponse({'cancelled': True})
        workspace = await asyncio.to_thread(registry.create, parent, body.name, request.state.user['id'])
        start_watcher(workspace)
        return workspace.info()

    @app.post("/api/workspaces/choose")
    async def choose_workspace(request: Request):
        path = await asyncio.to_thread(select_workspace_directory, '选择已有工作空间目录')
        if path is None:
            return {"cancelled": True}
        workspace = await asyncio.to_thread(registry.add, path, user_id=request.state.user['id'])
        start_watcher(workspace)
        return workspace.info()

    @app.get("/api/workspaces/{workspace_id}/documents")
    def documents(workspace_id: str):
        return registry.get(workspace_id).documents()

    @app.post("/api/workspaces/{workspace_id}/imports", status_code=201)
    async def import_pdf(workspace_id: str, file: UploadFile = File(), document_id: str | None = Form(default=None),directory: str=Form(default="")):
        workspace = registry.get(workspace_id)
        try:
            data = await file.read(MAX_PDF + 1)
        finally:
            await file.close()
        if len(data) > MAX_PDF or not data.startswith(b"%PDF-"):
            raise StoreError("请选择不超过 50 MiB 的 PDF 原件。", 413 if len(data) > MAX_PDF else 400)
        def validate_and_ingest():
            with tempfile.TemporaryDirectory(prefix="import-", dir=registry.root) as temp:
                path = Path(temp) / "input.pdf"
                path.write_bytes(data)
                count = validate_pdf(path)
            return workspace.ingest(data, file.filename or "paper.pdf", count,document_id=document_id,directory=directory)
        result = await asyncio.to_thread(validate_and_ingest)
        await notify(workspace_id)
        return result

    @app.get("/api/workspaces/{workspace_id}/documents/{doc_id}/file")
    def original(workspace_id: str, doc_id: str, revision: str | None = None):
        path, document = registry.get(workspace_id).original(doc_id, revision)
        return FileResponse(path, media_type="application/pdf", filename=document["filename"], content_disposition_type="inline")

    @app.put("/api/workspaces/{workspace_id}/documents/{doc_id}/position")
    def position(workspace_id: str, doc_id: str, body: PositionInput):
        registry.get(workspace_id).set_position(doc_id, body.page)
        return {"saved": True}

    @app.get("/api/workspaces/{workspace_id}/documents/{doc_id}/note")
    def read_note(workspace_id: str, doc_id: str):
        return registry.get(workspace_id).note(doc_id)

    @app.put("/api/workspaces/{workspace_id}/documents/{doc_id}/note")
    async def save_note(workspace_id: str, doc_id: str, body: NoteInput):
        result = await asyncio.to_thread(registry.get(workspace_id).save_note, doc_id, body.markdown, body.expected_revision,body.path)
        await notify(workspace_id)
        return result

    @app.post("/api/workspaces/{workspace_id}/documents/{doc_id}/conflicts", status_code=201)
    def conflict_copy(workspace_id: str, doc_id: str, body: NoteInput):
        return registry.get(workspace_id).save_conflict(doc_id, body.markdown)

    @app.get("/api/workspaces/{workspace_id}/documents/{doc_id}/history")
    def history(workspace_id: str, doc_id: str):
        return registry.get(workspace_id).history(doc_id)

    @app.get("/api/workspaces/{workspace_id}/documents/{doc_id}/history/{revision}")
    def history_version(workspace_id: str, doc_id: str, revision: str):
        return registry.get(workspace_id).history_note(doc_id, revision)

    @app.websocket("/api/workspaces/{workspace_id}/events")
    async def events(websocket: WebSocket, workspace_id: str):
        origin = websocket.headers.get("origin")
        expected = f"{'https' if websocket.url.scheme == 'wss' else 'http'}://{websocket.headers.get('host')}"
        if websocket.cookies.get("lv_session") != token or (origin and origin != expected):
            await websocket.close(code=1008)
            return
        try:
            identity = await asyncio.to_thread(accounts.current, websocket.cookies.get(COOKIE))
            await asyncio.to_thread(registry.authorized, workspace_id, identity['id'] if identity else None)
        except StoreError:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        queue = asyncio.Queue(maxsize=1)
        listeners.setdefault(workspace_id, set()).add(queue)
        last_sent = time.monotonic()
        try:
            while True:
                identity = await asyncio.to_thread(accounts.current, websocket.cookies.get(COOKIE))
                if not identity:
                    await websocket.close(code=1008)
                    break
                await asyncio.to_thread(registry.authorized, workspace_id, identity['id'])
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1)
                except asyncio.TimeoutError:
                    if time.monotonic() - last_sent < 15:
                        continue
                    event = {"type": "heartbeat"}
                if not await asyncio.to_thread(accounts.current, websocket.cookies.get(COOKIE)):
                    await websocket.close(code=1008)
                    break
                await websocket.send_json(event)
                last_sent = time.monotonic()
        except (WebSocketDisconnect, RuntimeError, StoreError):
            pass
        finally:
            listeners[workspace_id].discard(queue)

    @app.get("/")
    def index():
        return RedirectResponse("/home.html")

    if frontend:
        app.mount("/", FrontendStaticFiles(directory=str(frontend), html=True), name="frontend")
    return app
