"""Fetch a provider's HTTPS PDF without giving it access to the local network."""

import http.client
import ipaddress
import socket
import ssl
import time
from urllib.parse import parse_qs, quote, urljoin, urlsplit

from .storage import MAX_PDF, StoreError

TLS = ssl.create_default_context()
REDIRECTS = {301, 302, 303, 307, 308}
REPOSITORY_HOSTS = {'arxiv.org', 'export.arxiv.org', 'pmc.ncbi.nlm.nih.gov', 'europepmc.org'}


def https_url(value):
    """Accept public HTTPS URLs structurally. The downloader also checks and pins DNS."""
    if not isinstance(value, str) or not value or any(ord(char) < 33 or ord(char) == 127 for char in value):
        return None
    try:
        url = urlsplit(value)
        if url.scheme.lower() == 'https' and url.hostname and not url.username and not url.password and '@' not in url.netloc and url.port in (None, 443):
            return url
    except ValueError:
        pass
    return None


def public_addresses(host):
    addresses = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
    if not addresses:
        raise StoreError('公开 PDF 来源的域名无法解析。', 502)
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if isinstance(ip, ipaddress.IPv6Address):
            if ip.sixtofour or ip.teredo or ip.scope_id or ip in ipaddress.ip_network('64:ff9b::/96'):
                raise StoreError('PDF 来源指向不受支持的网络地址。', 403)
            ip = ip.ipv4_mapped or ip
        if not ip.is_global or ip.is_multicast or ip.is_reserved:
            raise StoreError('PDF 来源指向非公开网络地址。', 403)
    return addresses


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=TLS)
        self.address = address

    def connect(self):
        connection = socket.create_connection((self.address, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(connection, server_hostname=self.host)
        except BaseException:
            connection.close()
            raise


def request_pdf(url, deadline, *, cached=False):
    host = url.hostname.encode('idna').decode('ascii')
    target = quote(url.path or '/', safe="/%:@!$&'()*+,;=-._~")
    if url.query:
        target += '?' + quote(url.query, safe="/%:@!?$&'()*+,;=-._~[]")
    # Fixed service hosts also work through local DNS proxies that return synthetic addresses.
    # All other hosts, including arbitrary redirect targets, must resolve to public IPs.
    trusted = host in REPOSITORY_HOSTS or (cached and host.endswith(('.openalex.org', '.r2.cloudflarestorage.com')))
    addresses = [None] if trusted else public_addresses(host)
    for address in addresses:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        timeout = min(12, remaining)
        connection = PinnedHTTPS(host, address, timeout) if address else http.client.HTTPSConnection(
            host, port=443, timeout=timeout, context=TLS
        )
        try:
            connection.request('GET', target, headers={
                'Accept': 'application/pdf, application/octet-stream;q=0.9',
                'User-Agent': 'LexiVault/0.4 (local research workspace)',
            })
            return connection, connection.getresponse()
        except (OSError, http.client.HTTPException):
            connection.close()
    raise StoreError('无法连接 PDF 来源或响应超时。', 502)


def save_pdf(response, target, deadline):
    length = response.getheader('Content-Length', '')
    if length.isdecimal() and int(length) > MAX_PDF:
        raise StoreError('来源 PDF 超过 50 MiB。', 413)
    if response.headers.get_content_type() in {'text/html', 'application/xhtml+xml'}:
        raise StoreError('来源返回了网页，未获取到 PDF。', 502)
    signature = response.read(5)
    if signature != b'%PDF-':
        raise StoreError('来源返回的内容不是 PDF。', 502)
    with target.open('wb') as output:
        output.write(signature)
        size = len(signature)
        while chunk := response.read1(64 * 1024):
            size += len(chunk)
            if size > MAX_PDF:
                raise StoreError('来源 PDF 超过 50 MiB。', 413)
            if time.monotonic() > deadline:
                raise StoreError('PDF 来源响应超时。', 504)
            output.write(chunk)


def download_pdf(value, target, *, secret=None):
    """For OpenAlex content, only its official initial URL is allowed to carry a Key."""
    deadline = time.monotonic() + 45
    for hop in range(5):
        url = https_url(value)
        if not url:
            raise StoreError('PDF 来源地址无效或未使用 HTTPS。', 502)
        if secret and hop == 0 and url.netloc.lower() != 'content.openalex.org':
            raise StoreError('OpenAlex 凭据只能发送给官方全文接口。', 502)
        if secret and hop > 0 and ('api_key' in parse_qs(url.query) or secret in value):
            raise StoreError('OpenAlex 缓存返回了带有凭据的异常跳转。', 502)
        try:
            connection, response = request_pdf(url, deadline, cached=bool(secret))
            try:
                if response.status in REDIRECTS and response.getheader('Location'):
                    value = urljoin(value, response.getheader('Location'))
                    continue
                if response.status == 429:
                    raise StoreError('全文来源达到访问限制或额度，请稍后再试。', 429)
                if response.status in {401, 403}:
                    raise StoreError('全文来源拒绝了本次请求。', 403)
                if response.status != 200:
                    raise StoreError(f'全文来源暂不可用（HTTP {response.status}）。', 502)
                save_pdf(response, target, deadline)
                return
            finally:
                response.close()
                connection.close()
        except (OSError, ValueError, http.client.HTTPException) as error:
            raise StoreError('无法读取 PDF 来源，请稍后重试。', 502) from error
    raise StoreError('PDF 来源跳转过多。', 502)
