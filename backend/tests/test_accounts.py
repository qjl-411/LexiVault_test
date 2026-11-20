import pytest
from fastapi.testclient import TestClient

from backend.accounts import AccountStore
from backend.app import create_app
from backend.auth_api import COOKIE, create_account_app
from backend.database import connect
from backend.storage import StoreError
from backend.tests.auth_helpers import register_for_test

PASSWORD = 'ReadingNotes2026'


def register(store, email, password=PASSWORD):
    _, code = store.issue_code(email, 'register')
    return store.register(email, password, code=code)


def test_passwords_are_salted_argon2_and_duplicate_email_is_rejected(tmp_path):
    store = AccountStore(tmp_path/'accounts.sqlite')
    user = register(store, ' Student@Example.COM ')
    assert user['email'] == 'student@example.com' and 'password_hash' not in user
    with connect(store.path) as db:
        hashed = db.execute('SELECT password_hash FROM users').fetchone()[0]
        assert hashed.startswith('$argon2id$') and hashed != PASSWORD
    assert store.passwords.verify(hashed,PASSWORD)
    assert PASSWORD.encode() not in store.path.read_bytes()
    with pytest.raises(StoreError) as error:
        store.register('STUDENT@example.com',PASSWORD)
    assert error.value.status == 409


def test_session_hashes_rotation_expiry_revocation_and_persistence(tmp_path):
    clock = [1000.0]
    store = AccountStore(tmp_path/'accounts.sqlite',clock=lambda:clock[0])
    user = register(store, 'user@example.com')
    raw,lifetime = store.login(user['email'],PASSWORD,remember=True)
    assert lifetime == 30*86400 and store.current(raw)['id'] == user['id']
    with connect(store.path) as db:
        assert db.execute('SELECT token_hash FROM sessions').fetchone()[0] != raw
    restarted = AccountStore(store.path,clock=lambda:clock[0])
    assert restarted.current(raw)['id'] == user['id']
    second,_ = store.login(user['email'],PASSWORD,old_token=raw)
    assert second != raw and store.current(raw) is None
    store.logout(second); assert store.current(second) is None
    third,_ = store.login(user['email'],PASSWORD)
    clock[0] += 12*3600+1
    assert store.current(third) is None


def test_invalid_passwords_disabled_users_and_rate_limit(tmp_path):
    store = AccountStore(tmp_path/'accounts.sqlite')
    with pytest.raises(StoreError):
        store.register('bad@example.com','short')
    user = register(store, 'user@example.com')
    for _ in range(10):
        with pytest.raises(StoreError) as error:
            store.login('user@example.com','wrong')
        assert error.value.status == 401
    with pytest.raises(StoreError) as error:
        store.login('user@example.com','wrong')
    assert error.value.status == 429
    other = register(store, 'disabled@example.com')
    with connect(store.path) as db:
        db.execute("UPDATE users SET status='disabled' WHERE id=?",(other['id'],))
    with pytest.raises(StoreError) as disabled:
        store.login('disabled@example.com',PASSWORD,ip='another-device')
    assert disabled.value.status == 401


def test_local_auth_api_cookie_csrf_settings_logout_and_required_login(tmp_path, monkeypatch):
    monkeypatch.setattr('backend.auth_api.EmailSender.from_env', lambda: None)
    application = create_app(tmp_path/'本机配置')
    with TestClient(application) as client:
        token = client.get('/api/session').json()['token']; client.headers['x-lexivault-token'] = token
        assert client.get('/api/auth/me').json() == {'user':None}
        assert register_for_test(client,'user@example.com',PASSWORD).status_code == 201
        login = client.post('/api/auth/login',json={'email':'user@example.com','password':PASSWORD,'remember':True})
        assert login.status_code == 200,login.text
        assert 'HttpOnly' in login.headers['set-cookie'] and 'SameSite=strict' in login.headers['set-cookie']
        assert 'Max-Age=2592000' in login.headers['set-cookie']
        assert client.patch('/api/auth/settings',json={'theme':'dark'}).status_code == 403
        client.headers['x-account-csrf'] = login.json()['csrf_token']
        assert client.patch('/api/auth/settings',json={'theme':'dark','font_size':18}).json()['font_size'] == 18
        assert client.patch('/api/auth/settings',json={'api_key':'secret'}).status_code == 422
        assert client.get('/api/auth/me').json()['settings']['theme'] == 'dark'
        space = client.post('/api/workspaces',json={'name':'本地资料'}).json()
        assert client.post(f"/api/workspaces/{space['id']}/open").status_code == 200
        with connect(application.state.registry.database) as db:
            assert db.execute('SELECT last_user_id FROM workspace_registry').fetchone()[0] == login.json()['user']['id']
        assert client.post('/api/auth/logout',json={}).status_code == 200
        assert client.get('/api/auth/me').json()['user'] is None
        assert client.get('/api/workspaces').status_code == 401
        reset = client.post('/api/auth/password-reset',json={'email':'user@example.com'})
        assert reset.status_code == 503 and reset.json()['code'] == 'mailUnavailable'


def test_account_only_service_has_secure_cookie_and_never_reads_workspaces(tmp_path):
    (tmp_path/'workspaces.json').write_text('[{"path":"unrelated-directory"}]',encoding='utf-8')
    app = create_account_app(tmp_path)
    with TestClient(app,base_url='https://accounts.example.test') as client:
        assert register_for_test(client,'user@example.com',PASSWORD).status_code == 201
        response = client.post('/api/auth/login',json={'email':'user@example.com','password':PASSWORD})
        assert 'Secure' in response.headers['set-cookie'] and 'HttpOnly' in response.headers['set-cookie']
        assert client.get('/api/auth/me').json()['user']['email'] == 'user@example.com'
        assert client.get('/api/workspaces').status_code == 404
        assert client.post('/api/auth/login',json={'email':'user@example.com','password':PASSWORD},headers={'origin':'https://evil.example'}).status_code == 403
        assert client.post('/api/auth/login',content='email=user@example.com',headers={'content-type':'application/x-www-form-urlencoded'}).status_code == 415
    assert not (tmp_path/'app.sqlite').exists()
    assert not (tmp_path/'library.sqlite').exists()


def test_newer_account_schema_is_not_modified(tmp_path):
    path = tmp_path/'accounts.sqlite'
    with connect(path) as db:
        db.execute('CREATE TABLE account_meta(key TEXT PRIMARY KEY,value TEXT)')
        db.execute("INSERT INTO account_meta VALUES('schema_version','99')")
    before = path.read_bytes()
    with pytest.raises(StoreError,match='更新版本'):
        AccountStore(path)
    assert path.read_bytes() == before


def test_mail_verification_and_reset_revoke_old_sessions(tmp_path, monkeypatch):
    inbox = []

    class TestMailer:
        def send_code(self, email, purpose, code):
            inbox.append((email,purpose,code))

        def notify_password_reset(self, email):
            inbox.append((email,'notice',None))

    monkeypatch.setattr('backend.auth_api.EmailSender.from_env', lambda: TestMailer())
    digits = iter([42, 316, 9940])
    monkeypatch.setattr('backend.accounts.secrets.randbelow', lambda limit: next(digits))
    with TestClient(create_app(tmp_path/'config')) as client:
        client.headers['X-LexiVault-Token'] = client.get('/api/session').json()['token']
        email = 'reader@example.test'
        credentials = {'email':email,'password':PASSWORD}
        assert client.post('/api/auth/register',json=credentials).status_code == 422
        assert client.post('/api/auth/email-code',json={'email':email,'purpose':'register'}).json() == {'accepted':True}
        assert inbox == [(email,'register','0042')]
        response = client.post('/api/auth/register',json={**credentials,'code':'0042'})
        assert response.status_code == 201, response.text
        assert client.post('/api/auth/login',json=credentials).status_code == 200
        old_cookie = client.cookies.get(COOKIE)
        unknown = client.post('/api/auth/password-reset',json={'email':'unknown@example.test'})
        known = client.post('/api/auth/password-reset',json={'email':email})
        assert unknown.status_code == known.status_code == 200
        assert unknown.json() == known.json() == {'accepted':True}
        assert len(inbox) == 2 and inbox[-1] == (email,'reset_password','9940')
        payload = {'email':email,'password':'UpdatedPassword2026'}
        url = '/api/auth/password-reset/confirm'
        for _ in range(4):
            assert client.post(url,json={**payload,'code':'0000'}).json()['code'] == 'invalidCode'
        assert client.post(url,json={**payload,'code':'9940'}).json() == {'password_reset':True}
        assert inbox[-1] == (email,'notice',None)
        assert client.app.state.accounts.current(old_cookie) is None
        assert client.post(url,json={**payload,'code':'9940'}).json()['code'] == 'invalidCode'
        assert client.post('/api/auth/login',json=credentials).status_code == 401
        assert client.post('/api/auth/login',json=payload).status_code == 200


def test_resend_invalidates_previous_code_and_expiry_prevents_registration(tmp_path):
    now = [1000.0]
    store = AccountStore(tmp_path/'accounts.sqlite', clock=lambda:now[0])
    email = 'reader@example.test'
    _, old_code = store.issue_code(email,'register')
    with pytest.raises(StoreError) as cooldown:
        store.issue_code(email,'register')
    assert cooldown.value.details['code'] == 'codeCooldown'
    now[0] += 60
    _, new_code = store.issue_code(email,'register')
    assert new_code != old_code
    with pytest.raises(StoreError) as invalid:
        store.register(email,PASSWORD,code=old_code)
    assert invalid.value.details['code'] == 'invalidCode'
    now[0] += 600
    with pytest.raises(StoreError) as expired:
        store.register(email,PASSWORD,code=new_code)
    assert expired.value.details['code'] == 'expiredCode'


def test_legacy_account_keeps_id_and_verifies_with_original_password(tmp_path):
    store = AccountStore(tmp_path/'accounts.sqlite')
    user = register(store, 'legacy@example.test')
    with connect(store.path) as db:
        db.execute('ALTER TABLE users DROP COLUMN email_verified_at')
        db.execute('DROP TABLE email_challenges')
        db.execute("UPDATE account_meta SET value='1' WHERE key='schema_version'")
    migrated = AccountStore(store.path)
    assert len(list((tmp_path/'backups').glob('accounts-v1-*.sqlite'))) == 1
    with pytest.raises(StoreError) as needs_verification:
        migrated.login(user['email'],PASSWORD)
    assert needs_verification.value.details['code'] == 'emailVerificationRequired'
    assert migrated.issue_code(user['email'],'reset_password')[1] is None
    with pytest.raises(StoreError) as wrong_password:
        migrated.issue_code(user['email'],'verify_email',password='wrong')
    assert wrong_password.value.details['code'] == 'invalidCredentials'
    _, code = migrated.issue_code(user['email'],'verify_email',password=PASSWORD)
    raw,_ = migrated.login(user['email'],PASSWORD,code=code)
    assert migrated.current(raw)['id'] == user['id']


def test_failed_registration_email_can_be_retried(tmp_path, monkeypatch):
    def fail(*args):
        raise OSError('mail server offline')

    from types import SimpleNamespace
    monkeypatch.setattr('backend.auth_api.EmailSender.from_env', lambda: SimpleNamespace(send_code=fail))
    with TestClient(create_app(tmp_path/'config')) as client:
        client.headers['X-LexiVault-Token'] = client.get('/api/session').json()['token']
        for _ in range(2):
            response = client.post('/api/auth/email-code',json={'email':'reader@example.test','purpose':'register'})
            assert response.status_code == 503 and response.json()['code'] == 'mailDeliveryFailed'
