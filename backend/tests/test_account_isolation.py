import re
import sqlite3
import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.app import create_app
from backend.auth_api import COOKIE
from backend.database import connect
from backend.storage import Registry, StoreError
from backend.tests.auth_helpers import sign_in


def test_login_is_required_for_pages_and_every_business_route(tmp_path):
    frontend = tmp_path/'frontend'; frontend.mkdir()
    (frontend/'index.html').write_text('sign in',encoding='utf-8')
    (frontend/'home.html').write_text('private shell',encoding='utf-8')
    with TestClient(create_app(tmp_path/'config',frontend)) as client:
        assert client.get('/index.html').text == 'sign in'
        for page in ['/','/home.html','/reader.html','/plans.html','/knowledge.html','/docs','/openapi.json']:
            response = client.get(page,follow_redirects=False)
            assert response.status_code == 303, page
            assert response.headers['location'] == '/index.html'
            assert response.headers['cache-control'] == 'no-store'
        session = client.get('/api/session').json()
        assert session['user_id'] is None and session['data_dir'] == ''
        client.headers['X-LexiVault-Token'] = session['token']
        for path in ['/api/workspaces','/api/workspace/current','/api/health']:
            response = client.get(path)
            assert response.status_code == 401 and response.json()['code'] == 'loginRequired'
        assert client.post('/api/workspaces',json={'name':'denied'}).status_code == 401
        assert client.post('/api/workspaces/choose').status_code == 401
        sign_in(client)
        assert client.get('/home.html').text == 'private shell'
        assert client.get('/home.html').headers['cache-control'] == 'no-store'


def test_two_accounts_have_separate_spaces_current_selection_and_all_child_routes(tmp_path):
    app = create_app(tmp_path/'config')
    with TestClient(app) as first:
        user_a = sign_in(first,'a@example.com')
        a1 = first.post('/api/workspaces',json={'name':'A1'}).json()
        a2 = first.post('/api/workspaces',json={'name':'A2'}).json()
        first.post(f"/api/workspaces/{a1['id']}/open")
        with closing(TestClient(app)) as second:
            second.portal = first.portal  # Two cookie jars, one ASGI lifespan and event loop.
            user_b = sign_in(second,'b@example.com')
            assert second.get('/api/workspaces').json() == []
            assert second.get('/api/workspace/current').json() is None
            b = second.post('/api/workspaces',json={'name':'B'}).json()
            assert [s['id'] for s in second.get('/api/workspaces').json()] == [b['id']]
            assert {s['id'] for s in first.get('/api/workspaces').json()} == {a1['id'],a2['id']}
            assert first.get('/api/workspace/current').json()['id'] == a1['id']
            assert second.get('/api/workspace/current').json()['id'] == b['id']
            # Exercise the gate on every registered child route, before body/parameter validation.
            routes = {path:methods for path,methods in app.openapi()['paths'].items() if path.startswith('/api/workspaces/{workspace_id}')}
            assert len(routes) >= 25
            for template, methods in routes.items():
                path = template.replace('{workspace_id}',a1['id'])
                path = re.sub(r'\{[^}]+\}','unavailable',path)
                for method in methods.keys() & {'get','post','put','patch','delete','head'}:
                    response = second.request(method,path)
                    assert response.status_code == 404, (method,path,response.text)
                    assert a1['path'] not in response.text
            assert second.post('/api/workspaces',json={'name':'stale'},headers={'X-LexiVault-User':user_a['id']}).status_code == 401
            assert second.get('/api/auth/me').json()['user']['id'] == user_b['id']
    # Each account's current selection survives process recreation.
    with TestClient(create_app(tmp_path/'config')) as restarted:
        sign_in(restarted,'a@example.com')
        assert restarted.get('/api/workspace/current').json()['id'] == a1['id']
        sign_in(restarted,'b@example.com')
        assert restarted.get('/api/workspace/current').json()['id'] == b['id']


def test_two_accounts_can_open_and_edit_the_same_directory(tmp_path,monkeypatch):
    app = create_app(tmp_path/'config')
    space = app.state.registry.add(tmp_path/'old-space')
    note = space.root/'original.md'; note.write_text('# Original\n',encoding='utf-8')
    original = note.read_bytes()
    monkeypatch.setattr('backend.app.subprocess.run',lambda *args,**kwargs:SimpleNamespace(returncode=0,stdout=json.dumps(str(space.root))))
    with TestClient(app) as client:
        sign_in(client)
        assert client.get('/api/workspaces').json() == []
        assert client.get('/api/workspace/current').json() is None
        assert client.get(f'/api/workspaces/{space.id}/files').status_code == 404
        assert client.get('/api/legacy-workspaces').status_code == 404
        assert client.post(f'/api/legacy-workspaces/{space.id}/claim').status_code == 404
        response = client.post('/api/workspaces/choose')
        assert response.status_code == 200, response.text
        assert client.get('/api/workspace/current').json()['id'] == space.id
        assert client.post('/api/workspaces/choose').status_code == 200
        assert client.get(f'/api/workspaces/{space.id}/files').status_code == 200
        doc = client.post(f'/api/workspaces/{space.id}/documents', json={'title':'共享文献'}).json()
        note_url = f'/api/workspaces/{space.id}/documents/{doc["id"]}/note'
        first = client.put(note_url, json={'markdown':'账号 A 保存', 'expected_revision':'uncreated'})
        assert first.status_code == 200, first.text
        sign_in(client,'other@example.com')
        assert client.get('/api/workspaces').json() == []
        assert client.get(f'/api/workspaces/{space.id}/files').status_code == 404
        response = client.post('/api/workspaces/choose')
        assert response.status_code == 200 and response.json()['id'] == space.id, response.text
        assert client.get(note_url).json()['markdown'] == '账号 A 保存'
        second = client.put(note_url, json={'markdown':'账号 B 保存', 'expected_revision':first.json()['revision']})
        assert second.status_code == 200, second.text
        assert Path(first.json()['path']).read_text(encoding='utf-8').endswith('账号 B 保存')
        sign_in(client)
        assert client.get(note_url).json()['markdown'] == '账号 B 保存'
        stale = client.put(note_url, json={'markdown':'旧草稿', 'expected_revision':first.json()['revision']})
        assert stale.status_code == 409
    assert note.read_bytes() == original


def test_import_cannot_register_overlapping_or_internal_directories(tmp_path):
    registry = Registry(tmp_path/'config')
    root = tmp_path/'papers'
    space = registry.add(root,user_id='a')
    child = root/'nested'; child.mkdir()
    for target in [child,tmp_path,registry.root,registry.root/'backups',registry.root/'workspaces']:
        with pytest.raises(StoreError):
            registry.add(target,user_id='b')
    assert not (child/'.lexivault').exists()
    assert not (tmp_path/'.lexivault').exists()
    assert registry.authorized(space.id,'a').id == space.id
    with pytest.raises(StoreError):
        registry.authorized(space.id,'b')


@pytest.mark.parametrize('has_metadata',[False,True])
def test_stale_parent_without_metadata_does_not_block_opening(tmp_path,has_metadata):
    config=tmp_path/'config'
    registry=Registry(config)
    parent=tmp_path/'code'
    workspace=registry.add(parent/'my-vault')
    note=workspace.root/'original.md';note.write_text('Keep this note',encoding='utf-8')
    if has_metadata:
        (parent/'.lexivault').mkdir()
    with connect(registry.database) as db:
        db.execute('INSERT INTO workspace_registry(id,name,root_path,last_opened_at) VALUES(?,?,?,?)',
                   ('stale-parent','old code folder',str(parent),1))
    restarted=Registry(config)
    assert restarted.opened('my-user')==[]
    if not has_metadata:
        assert restarted.add(workspace.root,user_id='my-user').id==workspace.id
        assert restarted.authorized(workspace.id,'my-user').root==workspace.root
    else:
        with pytest.raises(StoreError,match='重叠'):
            restarted.add(workspace.root,user_id='my-user')
        assert restarted.opened('my-user')==[]
    with connect(restarted.database) as db:
        assert db.execute('SELECT 1 FROM workspace_registry WHERE id=?',('stale-parent',)).fetchone()
    assert note.read_text(encoding='utf-8')=='Keep this note'


def test_two_accounts_can_concurrently_open_an_existing_workspace(tmp_path,monkeypatch):
    import backend.storage as storage
    first=Registry(tmp_path/'config')
    workspace=first.add(tmp_path/'existing')
    second=Registry(tmp_path/'config')
    gate=Barrier(2)
    def synchronized_workspace(*args,**kwargs):
        gate.wait(timeout=10)
        return workspace
    monkeypatch.setattr(storage,'Workspace',synchronized_workspace)
    def open_as(registry,user):
        return registry.add(workspace.root,user_id=user).id
    with ThreadPoolExecutor(max_workers=2) as pool:
        attempts=[pool.submit(open_as,first,'a'),pool.submit(open_as,second,'b')]
        assert [attempt.result() for attempt in attempts] == [workspace.id, workspace.id]
    assert first.current('a')['id'] == second.current('b')['id'] == workspace.id


def test_websocket_requires_opened_workspace_and_closes_after_logout(tmp_path,monkeypatch):
    app = create_app(tmp_path/'config')
    with TestClient(app) as client:
        sign_in(client,'a@example.com')
        space = client.post('/api/workspaces',json={'name':'A'}).json()
        path = f"/api/workspaces/{space['id']}/events"
        old_cookie = client.cookies.get(COOKIE)
        with client.websocket_connect(path) as socket:
            assert client.post('/api/auth/logout',json={}).status_code == 200
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
        assert app.state.accounts.current(old_cookie) is None
        sign_in(client,'b@example.com')
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path):
                pass
        monkeypatch.setattr('backend.app.subprocess.run', lambda *args,**kwargs:
                            SimpleNamespace(returncode=0,stdout=json.dumps(space['path'])))
        assert client.post('/api/workspaces/choose').status_code == 200
        with client.websocket_connect(path):
            pass


def test_app_v1_upgrade_backs_up_and_does_not_guess_open_history(tmp_path):
    root = tmp_path/'config'; root.mkdir()
    path = root/'app.sqlite'
    with sqlite3.connect(path) as db:
        db.executescript("""CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO app_meta VALUES('schema_version','1');
            INSERT INTO app_meta VALUES('legacy_json_imported','1');
            CREATE TABLE workspace_registry(id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL UNIQUE,last_opened_at REAL NOT NULL,last_user_id TEXT);""")
        db.execute('INSERT INTO workspace_registry VALUES(?,?,?,?,?)',('old','Old',str(tmp_path/'old'),1,'previous-user'))
    Registry(root)
    with connect(path) as db:
        assert db.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0] == '3'
        assert db.execute('SELECT COUNT(*) FROM user_workspace_history').fetchone()[0] == 0
    saved = list((root/'backups').glob('app-v1-*.sqlite'))
    assert len(saved) == 1
    with sqlite3.connect(saved[0]) as db:
        assert db.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0] == '1'


def test_app_v2_migrates_owned_spaces_into_open_history(tmp_path):
    registry = Registry(tmp_path/'config')
    first = registry.add(tmp_path/'first', user_id='a')
    second = registry.add(tmp_path/'second', user_id='a')
    with connect(registry.database) as db:
        db.execute('ALTER TABLE workspace_registry ADD COLUMN owner_user_id TEXT')
        db.execute("UPDATE workspace_registry SET owner_user_id='a'")
        db.execute('DROP TABLE user_workspace_history')
        db.execute("UPDATE app_meta SET value='2' WHERE key='schema_version'")
    upgraded = Registry(registry.root)
    assert [item['id'] for item in upgraded.opened('a')] == [second.id, first.id]
    assert upgraded.current('a')['id'] == second.id
    assert upgraded.opened('b') == []
    upgraded.add(first.root, user_id='b')
    restarted = Registry(registry.root)
    assert [item['id'] for item in restarted.opened('a')] == [second.id, first.id]
    assert restarted.current('b')['id'] == first.id
    saved = list((registry.root/'backups').glob('app-v2-*.sqlite'))
    assert len(saved) == 1
    with connect(saved[0]) as db:
        assert db.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0] == '2'
