"""Public arXiv search and versioned PDF retrieval."""

import re
import math
import threading
import time
from collections import OrderedDict
from datetime import date
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from io import BytesIO
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree

from .storage import MAX_PDF, StoreError

API = 'https://export.arxiv.org/api/query'
ORIGIN = 'https://arxiv.org'
HOSTS = {'arxiv.org', 'export.arxiv.org'}
IDENTIFIER = re.compile(r'(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*/\d{7})(?:v[1-9]\d{0,5})?', re.I | re.ASCII)
NS = {'atom': 'http://www.w3.org/2005/Atom', 'arxiv': 'http://arxiv.org/schemas/atom',
      'os': 'http://a9.com/-/spec/opensearch/1.1/'}


def paper_id(value):
    value = value.strip()
    try:
        url = urlsplit(value)
    except ValueError:
        return None
    if url.scheme in {'http', 'https'} and url.hostname in HOSTS:
        value = re.sub(r'^/(?:abs|pdf)/', '', url.path).removesuffix('.pdf')
    elif value.casefold().startswith('arxiv:'):
        value = value[6:].strip()
    return value.lower() if IDENTIFIER.fullmatch(value) else None


def paper_family(identity):
    return re.sub(r'v[1-9]\d*$', '', identity)


def abs_url(identity):
    return f'{ORIGIN}/abs/{identity}'


class ArxivRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if (target.scheme != 'https' or target.netloc.lower() not in HOSTS or
                not target.path.startswith(('/api/query', '/pdf/'))):
            raise StoreError('arXiv 返回了异常跳转，请到来源页查看。', 502)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Arxiv:
    def __init__(self):
        self.opener = build_opener(ArxivRedirects())
        self.network_lock = threading.Lock()
        self.cache_lock = threading.Lock()
        self.next_request = 0
        self.rate_limited_until = 0
        self.feeds = OrderedDict()
        self.papers = OrderedDict()

    def _transfer(self, url, output, limit, pdf=False):
        accepted = 'application/pdf' if pdf else 'application/atom+xml, application/xml'
        request = Request(url, headers={'Accept': accepted, 'User-Agent': 'LexiVault/0.4 (local research workspace)'})
        with self.network_lock:
            remaining = math.ceil(self.rate_limited_until - time.monotonic())
            if remaining > 0:
                raise StoreError(f'arXiv 正在限流，请约 {remaining} 秒后重试。', 429, retry_after=remaining)
            time.sleep(max(0, self.next_request - time.monotonic()))
            deadline = time.monotonic() + 60
            try:
                with self.opener.open(request, timeout=15) as response:
                    if pdf and paper_id(response.geturl()) != paper_id(url):
                        raise StoreError('arXiv 跳转到了不同版本，请打开来源页查看。', 502)
                    length = response.headers.get('Content-Length', '')
                    if length.isdecimal() and int(length) > limit:
                        raise StoreError('来源文件超过 50 MiB。' if pdf else 'arXiv 返回的检索数据过大。', 413)
                    if pdf and response.headers.get_content_type() in {'text/html', 'application/xhtml+xml'}:
                        raise StoreError('来源返回了网页，未获取到 PDF。', 502)
                    size = 0
                    while chunk := response.read1(64 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise StoreError('来源文件超过 50 MiB。' if pdf else 'arXiv 返回的检索数据过大。', 413)
                        if time.monotonic() > deadline:
                            raise StoreError('arXiv 响应超时，请稍后重试。', 504)
                        output.write(chunk)
            except HTTPError as error:
                with error:
                    if error.code == 429:
                        retry_after = error.headers.get('Retry-After', '')
                        try:
                            cooldown = int(retry_after) if retry_after.isdecimal() else math.ceil(
                                parsedate_to_datetime(retry_after).timestamp() - time.time()
                            )
                        except (TypeError, ValueError, OverflowError):
                            cooldown = 15
                        cooldown = max(3, cooldown)
                        self.rate_limited_until = time.monotonic() + cooldown
                        raise StoreError(f'arXiv 正在限流，请约 {cooldown} 秒后重试。', 429, retry_after=cooldown) from error
                    if error.code in {401, 403, 404, 410} and pdf:
                        raise StoreError('来源暂未提供可下载的 PDF，请打开来源页查看。', 404) from error
                    raise StoreError(f'arXiv 暂时无法响应（HTTP {error.code}），请稍后重试。', 502) from error
            except (TimeoutError, URLError, HTTPException, ConnectionError) as error:
                raise StoreError('无法连接 arXiv 或响应超时，请检查网络后重试。', 502) from error
            finally:
                self.next_request = max(self.next_request, time.monotonic() + 3)

    def search(self, query, year_from, year_to, sort, start, limit):
        identity = paper_id(query)
        params = {'start': start, 'max_results': limit}
        if identity:
            params['id_list'] = identity
        else:
            words = re.findall(r'[\w][\w.-]*', query)
            if not words:
                raise StoreError('请输入论文标题、关键词或 arXiv 编号。', 422)
            conditions = [f'all:"{word}"' for word in words]
            if year_from > 1900 or year_to < 2100:
                conditions.append(f'submittedDate:[{year_from}01010000 TO {year_to}12312359]')
            params['search_query'] = ' AND '.join(conditions)
            params['sortBy'] = 'relevance' if sort == 'relevance' else 'submittedDate'
            params['sortOrder'] = 'ascending' if sort == 'oldest' else 'descending'
        return self._feed(params)

    def _feed(self, params):
        url = f'{API}?{urlencode(params)}'
        with self.cache_lock:
            cached = self.feeds.get(url)
            if cached and cached[0] > time.monotonic():
                self.feeds.move_to_end(url)
                return cached[1]
        data = BytesIO()
        self._transfer(url, data, 4 * 1024 * 1024)
        try:
            root = ElementTree.fromstring(data.getvalue())
            total = int(root.findtext('os:totalResults', namespaces=NS))
            items = [paper for entry in root.findall('atom:entry', NS) if (paper := parse_entry(entry))]
        except (ElementTree.ParseError, TypeError, ValueError) as error:
            raise StoreError('arXiv 没有返回可读取的检索结果。', 502) from error
        result = {'total': total, 'items': items}
        with self.cache_lock:
            self.feeds[url] = (time.monotonic() + 3600, result)
            self.feeds.move_to_end(url)
            if len(self.feeds) > 80:
                self.feeds.popitem(last=False)
            for item in items:
                self.papers[item['id']] = item
                self.papers.move_to_end(item['id'])
            while len(self.papers) > 400:
                self.papers.popitem(last=False)
        return result

    def article(self, identity):
        with self.cache_lock:
            cached = self.papers.get(identity)
        if cached:
            return cached
        result = self._feed({'id_list': identity, 'max_results': 1})
        for item in result['items']:
            if item['id'] == identity:
                return item
        raise StoreError('arXiv 当前没有返回这一版本，请重新检索。', 404)

    def download(self, item, target):
        if not item['pdf_available']:
            raise StoreError('来源暂未提供 PDF，请打开来源页查看。', 404)
        with target.open('xb') as output:
            self._transfer(f"{ORIGIN}/pdf/{item['id']}", output, MAX_PDF, pdf=True)
        with target.open('rb') as downloaded:
            if downloaded.read(5) != b'%PDF-':
                raise StoreError('下载内容不是 PDF，已保留来源链接。', 502)


def parse_entry(entry):
    def text(name):
        return ' '.join(entry.findtext(name, '', NS).split())

    identity = paper_id(text('atom:id'))
    title = text('atom:title')[:500]
    if not identity or paper_family(identity) == identity or not title:
        return None
    try:
        year = date.fromisoformat(text('atom:published')[:10]).year
    except ValueError:
        year = None
    authors = [' '.join(name.text.split())[:200] for name in entry.findall('atom:author/atom:name', NS) if name.text]
    tags = [node.get('term')[:60] for node in entry.findall('atom:category', NS) if node.get('term')]
    return {
        'id': identity, 'title': title, 'authors': authors[:100], 'year': year,
        'abstract': text('atom:summary')[:25000], 'doi': text('arxiv:doi')[:512] or None,
        'source_url': abs_url(identity), 'tags': tags[:8], 'license_hint': text('arxiv:license')[:500],
        'pdf_available': any(link.get('type') == 'application/pdf' for link in entry.findall('atom:link', NS)),
    }
