"""Search literature providers and acquire selected papers into a local workspace."""

import asyncio
import json
import re
import tempfile
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from .arxiv import Arxiv, paper_family, paper_id
from .credentials import CredentialVault
from .inspect_pdf import validate_pdf
from .openalex import OpenAlex, require_key, work_id
from .storage import StoreError, digest
from .vault import user_path


class Acquisition(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=120)
    directory: str = Field(default='', max_length=1000)
    separate_version: bool = False


Provider = Literal['arxiv', 'openalex']


def acquisition_state(workspace, provider, identity, separate_version):
    family = paper_family(identity) if provider == 'arxiv' else identity
    versions = workspace.source_versions(provider, family)
    exact = next((doc for key, doc in versions if key == identity and doc['file_available']
                  and not (doc['rel_path'] or '').startswith('.lexivault/trash/')), None)
    if exact:
        return None, {'status': 'already_available', 'document': exact}
    exact = next((doc for key, doc in versions if key == identity), None)
    other = next(((key, doc) for key, doc in versions if key != identity), None)
    if not exact and other and not separate_version:
        return None, {'status': 'version_available', 'existing_version': other[0], 'document': other[1]}
    return exact, None


def metadata_for(workspace, paper):
    metadata = {key: paper[key] for key in ('title', 'authors', 'year', 'abstract')}
    try:
        doi = workspace.normalize_doi(paper['doi'])
    except StoreError:
        doi = None
    # Distinct arXiv versions can share one publication DOI. Keep both originals addressable.
    metadata['doi'] = doi if doi and not workspace.document_with_doi(doi) else None
    return metadata | {'document_type': paper.get('document_type', 'preprint')}


def acquire(workspace, source, selection, provider='arxiv', key=None):
    identity = selection.id
    if provider == 'arxiv':
        if paper_id(identity) != identity or paper_family(identity) == identity:
            raise StoreError('请选择有明确版本的 arXiv 检索结果。', 422)
    elif work_id(identity) != identity:
        raise StoreError('请选择有效的 OpenAlex 检索结果。', 422)
    directory = selection.directory
    if not user_path(workspace.root, directory, True).is_dir():
        raise StoreError('目标文件夹不存在，请先创建。', 404)
    with workspace.lock:
        _, existing = acquisition_state(workspace, provider, identity, selection.separate_version)
        if existing:
            return existing

    paper = source.article(identity, key) if provider == 'openalex' else source.article(identity)
    record = {'provider': provider, 'external_id': identity, 'url': paper['source_url']}
    if provider == 'arxiv' and paper.get('license_hint'):
        record['license_hint'] = paper['license_hint']
    with tempfile.TemporaryDirectory(prefix='literature-') as temporary:
        path = Path(temporary) / 'download.pdf'
        try:
            if provider == 'openalex':
                pages, download_source = source.download(paper, path, key)
            else:
                source.download(paper, path)
                pages, download_source = validate_pdf(path), 'public'
        except StoreError as error:
            with workspace.lock:
                document, existing = acquisition_state(workspace, provider, identity, selection.separate_version)
                if existing:
                    return existing
                if not document:
                    document = workspace.create_metadata(metadata_for(workspace, paper), record)
            return {'status': 'metadata_only', 'document': document, 'message': error.message}
        data = path.read_bytes()

    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', ' ', paper['title'][:100]).strip(' .')
    # Include the version in the filename and avoid reserved Windows basenames.
    label = 'OpenAlex' if provider == 'openalex' else 'arXiv'
    filename = f"{label} {identity.replace('/', ' ')}{(' - ' + filename) if filename else ''}.pdf"
    with workspace.lock:
        document, existing = acquisition_state(workspace, provider, identity, selection.separate_version)
        if existing:
            return existing
        sha = digest(data)
        if document and document['sha256'] and document['sha256'] != sha:
            return {
                'status': 'metadata_only', 'document': document,
                'message': '来源文件与已登记的原件内容不同，请恢复原件或手动另存新版 PDF。',
            }
        duplicate_id = workspace.document_with_hash(sha)
        result = workspace.ingest(
            data, filename, pages, directory=directory,
            document_id=document['id'] if document and not duplicate_id else None,
            metadata=metadata_for(workspace, paper) if not document and not duplicate_id else None,
            source_record=record,
        )
    status = 'already_available' if result['duplicate'] and not result.get('restored') else 'downloaded'
    return {'status': status, 'document': result, 'download_source': download_source}


async def credential_body(request):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 4096:
            raise StoreError('OpenAlex Key 请求格式有误。', 422)
        body.extend(chunk)
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise StoreError('OpenAlex Key 请求格式有误。', 422) from error
    if not isinstance(payload, dict) or not isinstance(payload.get('key'), str):
        raise StoreError('请输入 OpenAlex API Key。', 422)
    return require_key(payload['key'].strip())


def discovery_router(registry, notify, accounts):
    router = APIRouter(tags=['discovery'])
    arxiv, openalex = Arxiv(), OpenAlex()
    credentials = CredentialVault(accounts.path)

    @router.get('/api/discovery/openalex/credential')
    def openalex_status(request: Request):
        return {'configured': credentials.configured(request.state.user['id'])}

    @router.put('/api/discovery/openalex/credential')
    async def bind_openalex(request: Request):
        key = await credential_body(request)
        user_id = request.state.user['id']
        await asyncio.to_thread(openalex.check_key, key)
        await asyncio.to_thread(credentials.save_openalex, user_id, key)
        return {'configured': True}

    @router.delete('/api/discovery/openalex/credential')
    def unbind_openalex(request: Request):
        credentials.remove_openalex(request.state.user['id'])
        return {'configured': False}

    @router.get('/api/discovery/{provider}/search')
    def search(provider: Provider, request: Request, query: Annotated[str, Query(min_length=1, max_length=300)],
               year_from: Annotated[int, Query(ge=1900, le=2100)] = 1900,
               year_to: Annotated[int, Query(ge=1900, le=2100)] = 2100,
               sort: Literal['relevance', 'newest', 'oldest'] = 'relevance',
               start: Annotated[int, Query(ge=0, lt=1000)] = 0,
               limit: Annotated[int, Query(ge=1, le=50)] = 10):
        if year_from > year_to:
            raise StoreError('结束年份不能早于起始年份。', 422)
        if provider == 'openalex':
            if start % limit:
                raise StoreError('OpenAlex 请按整页请求结果。', 422)
            data = openalex.search(query.strip(), year_from, year_to, sort, start, limit,
                                   require_key(credentials.openalex_key(request.state.user['id'])))
            return {'total': data['total'], 'items': [
                {name: value for name, value in paper.items() if name != 'public_pdf_urls'} for paper in data['items']
            ]}
        return arxiv.search(query.strip(), year_from, year_to, sort, start, min(limit, 1000 - start))

    @router.post('/api/workspaces/{workspace_id}/discovery/{provider}/acquire')
    async def acquire_paper(workspace_id: str, provider: Provider, body: Acquisition, request: Request):
        source, key = arxiv, None
        if provider == 'openalex':
            source = openalex
            key = require_key(await asyncio.to_thread(credentials.openalex_key, request.state.user['id']))
        result = await asyncio.to_thread(acquire, registry.get(workspace_id), source, body, provider, key)
        if result['status'] in {'downloaded', 'metadata_only'}:
            await notify(workspace_id)
        return result

    return router
