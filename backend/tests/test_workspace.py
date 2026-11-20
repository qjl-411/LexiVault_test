import sqlite3
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.storage import Workspace
from backend.tests.auth_helpers import sign_in


def test_choose_existing_directory_registers_for_current_account_and_cancel_preserves_selection(tmp_path,monkeypatch):
    application=create_app(tmp_path/'config')
    folder=tmp_path/'existing';folder.mkdir()
    note=folder/'existing.md';note.write_text('# Keep this note',encoding='utf-8')
    picked=[str(folder),None]
    monkeypatch.setattr('backend.app.subprocess.run',lambda *args,**kwargs:SimpleNamespace(returncode=0,stdout=json.dumps(picked.pop(0))))
    with TestClient(application) as client:
        user=sign_in(client)
        response=client.post('/api/workspaces/choose');assert response.status_code==200,response.text
        space=response.json()
        assert space['path']==str(folder.resolve())
        assert application.state.registry.authorized(space['id'],user['id']).root==folder.resolve()
        assert client.get('/api/workspace/current').json()['id']==space['id']
        assert client.post('/api/workspaces/choose').json()=={'cancelled':True}
        assert client.get('/api/workspace/current').json()['id']==space['id']
        assert note.read_text(encoding='utf-8')=='# Keep this note'


def test_create_workspace_in_selected_location_handles_cancel_and_name_collision(tmp_path, monkeypatch):
    config = tmp_path / 'config'
    parent = tmp_path / '我的资料'
    parent.mkdir()
    created = parent / '毕业课题'
    monkeypatch.setattr('backend.app.select_workspace_directory', lambda title: None)
    with TestClient(create_app(config)) as client:
        sign_in(client)
        response = client.post('/api/workspaces', json={'name':'毕业课题'})
        assert response.status_code == 200 and response.json() == {'cancelled': True}
        assert not created.exists()
        assert client.get('/api/workspace/current').json() is None

        monkeypatch.setattr('backend.app.select_workspace_directory', lambda title: parent)
        response = client.post('/api/workspaces', json={'name':' 毕业课题 '})
        assert response.status_code == 201, response.text
        space = response.json()
        assert space['path'] == str(created.resolve())
        assert [item.name for item in created.iterdir()] == ['.lexivault']
        assert not (config / 'workspaces').exists()
        assert client.get('/api/workspace/current').json()['id'] == space['id']

        existing = parent / '已有资料'
        existing.mkdir()
        note = existing / '笔记.md'
        note.write_text('已有笔记', encoding='utf-8')
        assert client.post('/api/workspaces', json={'name':'已有资料'}).status_code == 409
        assert client.post('/api/workspaces', json={'name':'../越界'}).status_code == 422
        assert not (tmp_path / '越界').exists()
        assert list(existing.iterdir()) == [note]
        assert note.read_text(encoding='utf-8') == '已有笔记'
        assert client.get('/api/workspace/current').json()['id'] == space['id']


def test_current_workspace_and_conversations_are_isolated_and_survive_restart(tmp_path):
    app=create_app(tmp_path/'config')
    with TestClient(app) as client:
        client.headers['X-LexiVault-Token']=client.get('/api/session').json()['token']
        sign_in(client)
        assert client.get('/api/workspace/current').json() is None
        first=client.post('/api/workspaces',json={'name':'空间甲'}).json()
        second=client.post('/api/workspaces',json={'name':'空间乙'}).json()
        assert client.get('/api/workspace/current').json()['id']==second['id']
        path=f"/api/workspaces/{first['id']}/assistant"
        assert client.get(path).json()['state']['conversations']==[]
        state={'conversations':[{'id':'chat-1','title':'我的问题','messages':[{'id':'m1','role':'user','text':'测试内容'}]}], 'notes':[], 'documents':[], 'activeId':'chat-1'}
        assert client.put(path,json={'expected_version':0,'state':state}).json()['version']==1
        assert client.put(path,json={'expected_version':0,'state':state}).status_code==409
        assert client.get(f"/api/workspaces/{second['id']}/assistant").json()['state']['conversations']==[]
        client.post(f"/api/workspaces/{first['id']}/open")
        assert client.get('/api/workspace/current').json()['id']==first['id']
    with TestClient(create_app(tmp_path/'config')) as restarted:
        sign_in(restarted)
        assert restarted.get('/api/workspace/current').json()['id']==first['id']
        saved=restarted.get(path).json()
        assert saved['state']['workspaceName']=='空间甲'
        assert saved['state']['conversations'][0]['messages'][0]['text']=='测试内容'


def test_invalid_duplicate_messages_cannot_erase_saved_conversations(tmp_path):
    with TestClient(create_app(tmp_path/'config')) as client:
        client.headers['X-LexiVault-Token']=client.get('/api/session').json()['token']
        sign_in(client)
        workspace=client.post('/api/workspaces',json={'name':'测试'}).json()
        path=f"/api/workspaces/{workspace['id']}/assistant"
        chat={'id':'c','title':'真实对话','messages':[{'id':'m','role':'user','text':'保留'}]}
        assert client.put(path,json={'expected_version':0,'state':{'conversations':[chat]}}).status_code==200
        chat['messages'].append(chat['messages'][0])
        assert client.put(path,json={'expected_version':1,'state':{'conversations':[chat]}}).status_code==422
        assert len(client.get(path).json()['state']['conversations'][0]['messages'])==1


def test_v2_upgrade_backs_up_without_changing_document_files(tmp_path):
    root=tmp_path/'space'
    workspace=Workspace(root)
    doc=workspace.create_metadata({'title':'已有文献'})
    note=workspace.note(doc['id'])
    with sqlite3.connect(root/'.lexivault'/'library.sqlite') as db:
        for table in ('plan_files','plans','plan_preferences','messages','conversations','assistant_state','file_trash','workspace_settings'):
            db.execute(f'DROP TABLE {table}')
        db.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
        db.execute('DELETE FROM schema_migrations WHERE version>=3')
    upgraded=Workspace(root)
    assert upgraded.migration_backup.exists()
    assert upgraded.documents()[0]['title']=='已有文献'
    assert upgraded.note(doc['id'])['markdown']==note['markdown']
    with sqlite3.connect(upgraded.migration_backup) as old:
        assert old.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]=='2'
