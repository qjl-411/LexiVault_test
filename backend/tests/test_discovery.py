import io
import socket
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from backend.app import create_app
from backend.arxiv import Arxiv
from backend import openalex, public_pdf
from backend.accounts import AccountStore
from backend.credentials import CredentialVault, MASTER_ENV, MASTER_FILENAME
from backend.database import connect
from backend.storage import StoreError
from backend.tests.auth_helpers import sign_in


def pdf_bytes(pages):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(300, 400)
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def test_arxiv_search_download_deduplicate_and_preserve_versions(tmp_path, monkeypatch):
    requests = []
    fail_once = {'2601.01235v1'}

    def transfer(self, url, output, limit, pdf=False):
        request = urlsplit(url)
        requests.append(request)
        if pdf:
            identity = request.path.removeprefix('/pdf/')
            if identity in fail_once:
                fail_once.remove(identity)
                raise StoreError('测试网络超时', 504)
            output.write(pdf_bytes({'2601.01234v1': 1, '2601.01234v2': 2, '2601.01235v1': 3}[identity]))
            return
        identity = parse_qs(request.query).get('id_list', ['2601.01234v1'])[0]
        output.write(f'''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"
                          xmlns:os="http://a9.com/-/spec/opensearch/1.1/">
          <os:totalResults>1</os:totalResults><entry>
            <id>https://arxiv.org/abs/{identity}</id><title>A paper &amp; its title</title>
            <summary>A searchable abstract</summary><published>2026-01-02T00:00:00Z</published>
            <author><name>Example Author</name></author><arxiv:doi>10.1000/{identity.split('v')[0]}</arxiv:doi>
            <link type="application/pdf" href="https://arxiv.org/pdf/{identity}"/>
          </entry></feed>'''.encode())

    monkeypatch.setattr(Arxiv, '_transfer', transfer)
    app = create_app(tmp_path / 'app')
    with TestClient(app) as client:
        search_url = '/api/discovery/arxiv/search'
        client.get('/api/session')
        assert client.get(search_url, params={'query':'paper'}).status_code == 401
        user = sign_in(client)
        workspace = app.state.registry.create(tmp_path, 'Reading', user['id'])
        folder = workspace.root / '论文'
        folder.mkdir()
        base = '/api/workspaces/' + workspace.id
        acquired = base + '/discovery/arxiv/acquire'

        result = client.get(search_url, params={'query':'paper', 'limit':5, 'year_from':2024}).json()
        item = result['items'][0]
        assert result['total'] == 1
        assert item['id'] == '2601.01234v1' and item['authors'] == ['Example Author']
        assert 'submittedDate:' in parse_qs(requests[-1].query)['search_query'][0]
        call = {'id':item['id'], 'directory':'论文'}
        assert client.post(acquired, json=call | {'directory':'../outside'}).status_code in {403, 422}
        assert client.post(acquired, json=call | {'id':'https://elsewhere.invalid/secret'}).status_code == 422
        first = client.post(acquired, json=call).json()
        assert first['status'] == 'downloaded'
        document = first['document']
        assert document['title'] == 'A paper & its title'
        original = workspace.root / document['rel_path']
        assert original.parent == folder and original.read_bytes() == pdf_bytes(1)
        file_url = f"{base}/documents/{document['id']}/file?revision={document['sha256']}"
        assert client.get(file_url).content == pdf_bytes(1)
        count = len(requests)
        assert client.post(acquired, json=call).json()['status'] == 'already_available'
        assert len(requests) == count and len(list(folder.glob('*.pdf'))) == 1

        version = call | {'id':'2601.01234v2'}
        assert client.post(acquired, json=version).json()['status'] == 'version_available'
        new = client.post(acquired, json=version | {'separate_version':True}).json()
        assert new['status'] == 'downloaded' and new['document']['id'] != document['id']
        assert original.read_bytes() == pdf_bytes(1)

        pending = call | {'id':'2601.01235v1'}
        failed = client.post(acquired, json=pending).json()
        assert failed['status'] == 'metadata_only' and failed['message'] == '测试网络超时'
        assert not failed['document']['file_available']
        retried = client.post(acquired, json=pending).json()
        assert retried['status'] == 'downloaded'
        assert retried['document']['id'] == failed['document']['id']
        assert (workspace.root / Path(retried['document']['rel_path'])).read_bytes() == pdf_bytes(3)


def test_openalex_acquisition_prefers_public_falls_back_to_cache_and_keeps_metadata(tmp_path, monkeypatch):
    key = 'local-fixture-key-abc'
    calls = []
    download_calls = []

    def work(identity):
        number = int(identity[1:])
        return {
            'id': 'https://openalex.org/' + identity,
            'display_name': 'OpenAlex example ' + identity,
            'publication_year': 2024,
            'doi': f'https://doi.org/10.1000/{identity}',
            'abstract_inverted_index': {'example': [1], 'An': [0], 'abstract.': [2]},
            'authorships': [{'author': {'display_name': 'Example Author'}}],
            'best_oa_location': {'is_oa': True, 'landing_page_url': 'https://example.org/record',
                                 'pdf_url': f'https://public.example.org/{identity}.pdf' if number < 3 else None},
            'locations': [{'is_oa': False, 'pdf_url': 'https://restricted.example.org/should-never-open.pdf'}],
            'has_content': {'pdf': number < 3},
        }

    def api(self, path, params, supplied):
        assert supplied == key
        calls.append((path, params))
        if path == '/rate-limit':
            return {}
        if path == '/works':
            return {'results': [work(f'W{i}') for i in range(1, 4)], 'meta': {'count': 3}}
        return work(path.rsplit('/', 1)[1])

    def download(url, target, secret=None):
        request = urlsplit(url)
        download_calls.append((request.hostname, request.path))
        if request.hostname == 'content.openalex.org':
            assert secret == key
            assert parse_qs(request.query)['api_key'] == [key]
            target.write_bytes(pdf_bytes(2))
        else:
            assert secret is None and key not in url and request.hostname == 'public.example.org'
            target.write_bytes(b'%PDF- deliberately damaged' if request.path == '/W2.pdf' else pdf_bytes(1))

    monkeypatch.setattr(openalex.OpenAlex, '_json', api)
    monkeypatch.setattr(openalex, 'download_pdf', download)
    app = create_app(tmp_path / 'app')
    with TestClient(app) as client:
        user = sign_in(client)
        workspace = app.state.registry.create(tmp_path, 'Library', user['id'])
        search = '/api/discovery/openalex/search'
        credential = '/api/discovery/openalex/credential'
        acquire = f'/api/workspaces/{workspace.id}/discovery/openalex/acquire'

        assert client.get(credential).json() == {'configured': False}
        assert client.get(search, params={'query':'paper'}).status_code == 400
        assert client.put(credential, json={'key':key}).json() == {'configured': True}
        result = client.get(search, params={'query':'study', 'year_from':2024, 'limit':5}).json()
        assert result['total'] == 3
        assert result['items'][0]['abstract'] == 'An example abstract.'
        assert 'public_pdf_urls' not in result['items'][0]
        assert calls[-1][1]['filter'] == 'from_publication_date:2024-01-01'
        assert key not in str(result)

        first = client.post(acquire, json={'id':'W1'}).json()
        second = client.post(acquire, json={'id':'W2'}).json()
        third = client.post(acquire, json={'id':'W3'}).json()
        assert first['status'] == second['status'] == 'downloaded'
        assert first['download_source'] == 'public' and second['download_source'] == 'cache'
        assert download_calls == [
            ('public.example.org', '/W1.pdf'), ('public.example.org', '/W2.pdf'),
            ('content.openalex.org', '/works/W2.pdf'),
        ]
        assert (workspace.root / first['document']['rel_path']).read_bytes() == pdf_bytes(1)
        assert (workspace.root / second['document']['rel_path']).read_bytes() == pdf_bytes(2)
        assert third['status'] == 'metadata_only' and not third['document']['file_available']
        assert third['document']['source_url'] == 'https://example.org/record'
        assert client.post(acquire, json={'id':'W2'}).json()['status'] == 'already_available'
        assert len(list(workspace.root.glob('*.pdf'))) == 2
        assert key.encode() not in (workspace.root / '.lexivault' / 'library.sqlite').read_bytes()


def test_openalex_key_survives_restart_and_is_bound_to_the_account(tmp_path, monkeypatch):
    monkeypatch.delenv(MASTER_ENV, raising=False)
    first_key, second_key = 'private-key-fixture-for-first', 'private-key-fixture-for-second'
    used = []

    def check(self, key):
        if key not in {first_key, second_key}:
            raise StoreError('OpenAlex 拒绝了 API Key。', 403)

    def search(self, query, *parameters):
        used.append(parameters[-1])
        return {'total':0, 'items':[]}

    monkeypatch.setattr(openalex.OpenAlex, 'check_key', check)
    monkeypatch.setattr(openalex.OpenAlex, 'search', search)
    data = tmp_path / 'app'
    credential = '/api/discovery/openalex/credential'
    lookup = '/api/discovery/openalex/search?query=paper'
    first_email, second_email = 'first@example.com', 'second@example.com'
    app = create_app(data)
    with TestClient(app) as one, TestClient(app) as two:
        one.get('/api/session')
        assert one.get(credential).status_code == 401
        first_user = sign_in(one, first_email)
        sign_in(two, second_email)
        assert one.put(credential, json={'key':first_key}).json() == {'configured':True}
        assert two.get(credential).json() == {'configured':False}
        assert two.get(lookup, headers={'X-LexiVault-OpenAlex-Key':first_key}).status_code == 400
        assert two.put(credential, json={'key':second_key}).json() == {'configured':True}
        assert one.put(credential, json={'key':['value-never-echoed']}).status_code == 422
        rejected = one.put(credential, json={'key':'invalid-never-echoed'})
        assert rejected.status_code == 403 and 'invalid-never-echoed' not in rejected.text
        assert one.get(lookup, headers={'X-LexiVault-OpenAlex-Key':second_key}).status_code == 200
        assert two.get(lookup).status_code == 200
        assert used == [first_key, second_key]

    assert (data / MASTER_FILENAME).is_file()
    database = data / 'accounts.sqlite'
    raw = database.read_bytes()
    assert first_key.encode() not in raw and second_key.encode() not in raw
    with connect(database) as db:
        encrypted = db.execute('SELECT ciphertext FROM openalex_credentials WHERE user_id=?',
                               (first_user['id'],)).fetchone()[0]
        assert isinstance(encrypted, bytes)

    restarted = create_app(data)
    with TestClient(restarted) as one, TestClient(restarted) as two:
        sign_in(one, first_email)
        sign_in(two, second_email)
        assert one.get(credential).json() == {'configured':True}
        assert one.get(lookup).status_code == 200
        assert used[-1] == first_key
        assert one.delete(credential).json() == {'configured':False}
        assert one.get(lookup).status_code == 400
        assert two.get(credential).json() == {'configured':True}
        assert two.get(lookup).status_code == 200 and used[-1] == second_key


def test_openalex_credentials_upgrade_account_database_and_use_deployment_master(tmp_path, monkeypatch):
    database = tmp_path / 'accounts.sqlite'
    store = AccountStore(database)
    email = 'existing@example.com'
    _, code = store.issue_code(email, 'register')
    user = store.register(email, 'ResearchTest2026', code=code)
    with connect(database) as db:
        db.execute('DROP TABLE openalex_credentials')
        db.execute("UPDATE account_meta SET value='2' WHERE key='schema_version'")

    deployed = AccountStore(database)
    assert len(list((tmp_path / 'backups').glob('accounts-v2-*.sqlite'))) == 1
    raw, _ = deployed.login(email, 'ResearchTest2026')
    assert deployed.current(raw)['id'] == user['id']
    master = Fernet.generate_key().decode()
    monkeypatch.setenv(MASTER_ENV, master)
    vault = CredentialVault(database)
    vault.save_openalex(user['id'], 'fixture-only')
    assert not (tmp_path / MASTER_FILENAME).exists()
    assert CredentialVault(database).openalex_key(user['id']) == 'fixture-only'

    monkeypatch.setenv(MASTER_ENV, Fernet.generate_key().decode())
    with pytest.raises(StoreError, match='无法解密'):
        vault.openalex_key(user['id'])
    monkeypatch.setenv(MASTER_ENV, master)
    assert vault.openalex_key(user['id']) == 'fixture-only'
    with connect(database) as db:
        db.execute('DELETE FROM users WHERE id=?', (user['id'],))
    assert not vault.configured(user['id'])


def test_openalex_pdf_transport_blocks_private_destinations_and_key_redirects(tmp_path, monkeypatch):
    def dns(host, port, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('127.0.0.1', port))]

    monkeypatch.setattr(public_pdf.socket, 'getaddrinfo', dns)
    with pytest.raises(StoreError, match='非公开'):
        public_pdf.download_pdf('https://host.example/reader.pdf', tmp_path / 'private.pdf')
    assert not (tmp_path / 'private.pdf').exists()

    class Redirect:
        status = 302

        def getheader(self, field):
            return 'https://storage.example/attachment.pdf?api_key=test-key'

        def close(self):
            pass

    seen = []

    def redirect(url, deadline, *, cached=False):
        seen.append(url.hostname)
        return Redirect(), Redirect()

    monkeypatch.setattr(public_pdf, 'request_pdf', redirect)
    with pytest.raises(StoreError, match='凭据'):
        public_pdf.download_pdf('https://content.openalex.org/works/W1.pdf?api_key=test-key',
                                tmp_path / 'redirect.pdf', secret='test-key')
    assert seen == ['content.openalex.org']
