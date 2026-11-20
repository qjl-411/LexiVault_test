"""Search OpenAlex and resolve usable PDF copies for the selected work."""

import json
import re
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .inspect_pdf import validate_pdf
from .public_pdf import download_pdf, https_url
from .storage import StoreError

API_HOST = 'api.openalex.org'
WORK_FIELDS = ('id,display_name,doi,publication_year,abstract_inverted_index,authorships,'
               'best_oa_location,primary_location,locations,has_content,content_urls,type,topics')
WORK_ID = re.compile(r'W[1-9]\d{0,19}', re.ASCII | re.I)
DOI = re.compile(r'10\.\d{4,9}/\S+', re.I)


def require_key(key):
    if not key:
        raise StoreError('请先在文献发现的来源设置中填写 OpenAlex API Key。', 400)
    if not re.fullmatch(r'[!-~]{1,256}', key):
        raise StoreError('OpenAlex API Key 格式有误，请从官网重新复制。', 422)
    return key


def work_id(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    url = https_url(value)
    if url and url.hostname in {'openalex.org', API_HOST}:
        value = url.path.rstrip('/').rsplit('/', 1)[-1]
    return value.upper() if WORK_ID.fullmatch(value) else None


def doi_from(value):
    value = re.sub(r'^(?:doi:\s*|https?://(?:dx\.)?doi\.org/)', '', (value or '').strip(), flags=re.I)
    return value[:512].lower() if value and len(value) <= 512 and DOI.fullmatch(value) else None


class OpenAlexRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = https_url(newurl)
        if not target or target.netloc.lower() != API_HOST:
            raise StoreError('OpenAlex API 返回了异常跳转。', 502)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class OpenAlex:
    def __init__(self):
        self.opener = build_opener(OpenAlexRedirect())

    def _json(self, path, params, key):
        query = '?' + urlencode(params) if params else ''
        request = Request(f'https://{API_HOST}{path}{query}', headers={
            'Authorization': f'Bearer {require_key(key)}',
            'Accept': 'application/json',
            'User-Agent': 'LexiVault/0.4 (local research workspace)',
        })
        try:
            with self.opener.open(request, timeout=15) as response:
                payload = response.read(8 * 1024 * 1024 + 1)
        except HTTPError as error:
            with error:
                if error.code in {401, 403}:
                    raise StoreError('OpenAlex 拒绝了 API Key，请检查是否复制正确并验证过邮箱。', 403) from error
                if error.code == 429:
                    raise StoreError('OpenAlex 达到请求频率或当日额度，请稍后重试。', 429) from error
                if error.code == 404:
                    raise StoreError('OpenAlex 没有找到这篇文献。', 404) from error
                raise StoreError(f'OpenAlex 暂时无法响应（HTTP {error.code}）。', 502) from error
        except (OSError, HTTPException) as error:
            raise StoreError('无法连接 OpenAlex，请检查网络后重试。', 502) from error
        if len(payload) > 8 * 1024 * 1024:
            raise StoreError('OpenAlex 返回的数据过大，请减少每页结果数量。', 502)
        try:
            result = json.loads(payload)
        except ValueError as error:
            raise StoreError('OpenAlex 返回了无法读取的结果。', 502) from error
        if not isinstance(result, dict):
            raise StoreError('OpenAlex 返回了无法读取的结果。', 502)
        return result

    def check_key(self, key):
        self._json('/rate-limit', {}, key)

    def search(self, query, year_from, year_to, sort, start, limit, key):
        if not query:
            raise StoreError('请输入关键词、论文标题、DOI 或 OpenAlex 编号。', 422)
        identity, doi = work_id(query), doi_from(query)
        if identity or doi:
            name = identity or ('https://doi.org/' + quote(doi, safe='/'))
            try:
                paper = parse_work(self._json(f'/works/{name}', {'select': WORK_FIELDS}, key))
            except StoreError as error:
                if error.status != 404:
                    raise
                paper = None
            return {'total': int(paper is not None), 'items': [paper] if paper and not start else []}
        filters = {}
        if year_from > 1900:
            filters['from_publication_date'] = f'{year_from}-01-01'
        if year_to < 2100:
            filters['to_publication_date'] = f'{year_to}-12-31'
        params = {'search': query, 'page': start // limit + 1, 'per_page': limit, 'select': WORK_FIELDS}
        if filters:
            params['filter'] = ','.join(f'{name}:{value}' for name, value in filters.items())
        if sort != 'relevance':
            params['sort'] = 'publication_date:asc' if sort == 'oldest' else 'publication_date:desc'
        response = self._json('/works', params, key)
        rows, total = response.get('results'), (response.get('meta') or {}).get('count')
        if not isinstance(rows, list) or not isinstance(total, int):
            raise StoreError('OpenAlex 返回了无法读取的检索结果。', 502)
        return {'total': total, 'items': [paper for row in rows if (paper := parse_work(row))]}

    def article(self, identity, key):
        paper = parse_work(self._json(f'/works/{identity}', {'select': WORK_FIELDS}, key))
        if paper and paper['id'] == identity:
            return paper
        raise StoreError('这条 OpenAlex 记录有更新，请重新检索。', 404)

    def download(self, paper, target, key):
        failure = None
        for url in paper['public_pdf_urls']:
            try:
                download_pdf(url, target)
                return validate_pdf(target), 'public'
            except StoreError as error:
                failure = error
        if paper['cached_pdf']:
            try:
                secret = require_key(key)
                url = f"https://content.openalex.org/works/{paper['id']}.pdf?{urlencode({'api_key': secret})}"
                download_pdf(url, target, secret=secret)
                return validate_pdf(target), 'cache'
            except StoreError as error:
                failure = error
        raise failure or StoreError('OpenAlex 未找到可自动获取的全文，请打开来源页查看。', 404)


def abstract_from(index):
    if not isinstance(index, dict):
        return ''
    words = {}
    for word, positions in index.items():
        if not isinstance(positions, list):
            continue
        for position in positions:
            if type(position) is int and 0 <= position < 5000:
                words[position] = word[:120]
    return ' '.join(words[position] for position in sorted(words))[:25000]


def parse_work(row):
    if not isinstance(row, dict):
        return None
    identity = work_id(row.get('id'))
    title = (row.get('display_name') or '')[:500].strip()
    if not identity or not title:
        return None
    best = row.get('best_oa_location') or {}
    primary = row.get('primary_location') or {}
    locations = [best, *(row.get('locations') or [])]
    urls = list(dict.fromkeys(location['pdf_url'] for location in locations
                             if location.get('is_oa') is True and https_url(location.get('pdf_url'))))[:3]
    cached = (row.get('has_content') or {}).get('pdf') is True or bool((row.get('content_urls') or {}).get('pdf'))
    landing = next((url for url in (best.get('landing_page_url'), primary.get('landing_page_url'))
                    if https_url(url)), f'https://openalex.org/{identity}')
    authors = [(entry.get('author') or {}).get('display_name') or entry.get('raw_author_name') or ''
               for entry in (row.get('authorships') or [])[:100]]
    tags = [topic['display_name'][:60] for topic in (row.get('topics') or [])[:5] if topic.get('display_name')]
    year = row.get('publication_year')
    return {
        'id': identity, 'title': title, 'authors': [name[:200] for name in authors if name],
        'year': year if type(year) is int and 1000 <= year <= 2200 else None,
        'abstract': abstract_from(row.get('abstract_inverted_index')), 'doi': doi_from(row.get('doi')),
        'source_url': landing, 'tags': tags,
        'document_type': 'preprint' if row.get('type') == 'preprint' else 'paper',
        'public_pdf_urls': urls, 'cached_pdf': cached, 'pdf_available': bool(urls or cached),
    }
