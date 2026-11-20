import { icon } from '../suite.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
})[character]);
const providers = { arxiv: 'arXiv', openalex: 'OpenAlex' };
const credentialURL = '/api/discovery/openalex/credential';
function sourceLink(paper) {
  if (paper.provider === 'openalex') {
    try {
      const url = new URL(paper.source_url);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* use the canonical record */ }
    return 'https://openalex.org/' + encodeURIComponent(paper.id);
  }
  return 'https://arxiv.org/abs/' + paper.id.split('/').map(encodeURIComponent).join('/');
}
const readerLink = document => 'reader.html?document=' + encodeURIComponent(document.id);
const labels = {
  pending: '待获取', downloading: '正在获取…', downloaded: '已入库',
  already_available: '已在工作空间', metadata_only: '已保存题录 · 可重试或手动补充 PDF',
  version_available: '已有其他版本', failed: '获取失败',
};

export function initLiveDiscovery(space) {
  const q = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const lifecycle = new window.AbortController();
  const on = (target, type, handler) => target.addEventListener(type, handler, { signal: lifecycle.signal });
  const results = q('#discovery-results'), pagination = q('#discovery-pagination');
  const list = q('#discovery-queue'), confirm = q('#confirm-acquisition');
  const searchInput = q('#discovery-query'), sort = q('#discovery-sort'), pageSize = q('#discovery-page-size');
  const yearFrom = q('#discovery-year-from'), yearTo = q('#discovery-year-to');
  const dialog = q('#acquisition-dialog'), queue = new Map();
  const workspace = space.current?.layout === 'files' ? space.current : null;
  let papers = [], total = 0, page = 1, query = '', request, acquiring = false, loadingFolders = false, toastTimer;
  let provider = 'arxiv', openAlexConfigured = false, keyRequest;
  const sourcePreference = space.userId ? 'lexivault.discovery.source.' + space.userId : null;

  function status(message) { q('#discovery-status').textContent = message; }
  function notify(message) {
    status(message);
    const toast = q('#suite-toast');
    toast.hidden = false; toast.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }
  function panel(name) {
    q('.d-workspace').dataset.activePanel = name;
    for (const button of all('[data-workspace-tab]')) {
      const active = button.dataset.workspaceTab === name;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
  function resultMessage(heading, detail = '') {
    results.innerHTML = `<div class="d-empty">${icon('search')}<strong>${escape(heading)}</strong><p>${escape(detail)}</p></div>`;
  }
  function renderResults() {
    const expanded = new Set(all('.d-paper details[open]').map(el => el.closest('[data-result-id]').dataset.resultId));
    const scroll = results.scrollTop;
    if (!papers.length) {
      resultMessage(query ? '没有找到符合条件的论文' : `搜索 ${providers[provider]} 论文`,
        query ? '试试其他关键词，或扩大年份范围。' : searchInput.placeholder);
      return;
    }
    results.innerHTML = papers.map(paper => {
      const selected = queue.has(paper.id), title = escape(paper.title), id = escape(paper.id);
      const authors = paper.authors.length > 4 ? `${paper.authors.slice(0, 4).join('、')} 等` : paper.authors.join('、');
      const doi = /^10\.\d{4,9}\/\S+$/i.test(paper.doi ?? '') ? paper.doi.split('/').map(encodeURIComponent).join('/') : '';
      return `<article class="d-paper" data-result-id="${id}"><h4>${title}</h4>
        <div class="d-paper-meta"><span>${escape(authors)}${paper.year ? ' · ' + escape(paper.year) : ''} · ${id}</span>
        <span class="d-paper-access${paper.pdf_available ? ' is-open' : ''}">${paper.pdf_available ? (paper.provider === 'openalex' ? '可能有 PDF' : '公开 PDF') : '题录'}</span></div>
        <p class="d-paper-summary">${escape(paper.abstract.slice(0, 340))}${paper.abstract.length > 340 ? '…' : ''}</p>
        <div class="d-paper-bottom"><div class="d-paper-tags">${paper.tags.map(tag => `<span>${escape(tag)}</span>`).join('')}</div></div>
        <details${expanded.has(paper.id) ? ' open' : ''}><summary>摘要与来源</summary><p>${escape(paper.abstract)}</p>
        <p><a href="${escape(sourceLink(paper))}" target="_blank" rel="noopener noreferrer">打开来源页 ↗</a>${doi ? ` · <a href="https://doi.org/${escape(doi)}" target="_blank" rel="noopener noreferrer">查看出版版本 ↗</a>` : ''}</p></details>
        <button type="button" class="d-add-paper" data-toggle-paper="${id}" aria-pressed="${selected}" aria-label="${selected ? '移出' : '加入'}获取队列：${title}"${acquiring ? ' disabled' : ''}>${icon(selected ? 'task' : 'plus')}</button></article>`;
    }).join('');
    results.scrollTop = scroll;
  }
  function renderPagination() {
    const size = Number(pageSize.value), pages = Math.max(1, Math.ceil(Math.min(total, 1000) / size));
    q('#discovery-result-count').textContent = query ? `${providers[provider]} · ${total.toLocaleString('zh-CN')} 篇` : providers[provider];
    q('#discovery-page-range').textContent = papers.length ? `${(page - 1) * size + 1}–${(page - 1) * size + papers.length} / ${total} 篇` : '';
    pagination.innerHTML = pages > 1 ? `<button type="button" data-live-page="${page-1}" aria-label="上一页"${page <= 1 ? ' disabled' : ''}>‹</button>
      <span aria-current="page">${page} / ${pages}</span><button type="button" data-live-page="${page+1}" aria-label="下一页"${page >= pages ? ' disabled' : ''}>›</button>` : '';
    q('.d-results-footnote').textContent = total > 1000 ? '可翻阅前 1,000 条，缩小检索范围可查看更多。' : `论文来源为 ${providers[provider]}。`;
  }
  async function search(nextPage = 1) {
    const from = Number(yearFrom.value), to = Number(yearTo.value);
    const valid = Number.isInteger(from) && Number.isInteger(to) && from >= 1900 && from <= to && to <= 2100;
    q('#discovery-year-error').hidden = valid;
    q('#discovery-year-error').textContent = valid ? '' : '请输入 1900—2100 的有效年份范围。';
    q('#filter-year-summary').textContent = from === 1900 && to === 2100 ? '不限' : `${from}—${to}`;
    if (!valid) { panel('filters'); return; }
    request?.abort();
    if (!query) {
      request = null; papers = []; total = 0; page = 1;
      results.removeAttribute('aria-busy');
      renderResults(); renderPagination(); return;
    }
    const pending = new window.AbortController();
    request = pending;
    const selectedProvider = provider, label = providers[selectedProvider];
    const size = Number(pageSize.value);
    const params = new URLSearchParams({ query, year_from: from, year_to: to, sort: sort.value, start: (nextPage - 1) * size, limit: size });
    results.setAttribute('aria-busy', 'true');
    resultMessage(`正在检索 ${label}…`); pagination.replaceChildren();
    try {
      const data = await space.request(`/api/discovery/${selectedProvider}/search?${params}`, { signal: pending.signal });
      if (request !== pending) return;
      papers = data.items.map(paper => ({ ...paper, provider: selectedProvider }));
      total = data.total; page = nextPage; results.scrollTop = 0;
      renderResults(); renderPagination(); status(`检索完成，共 ${total} 篇。`);
    } catch (error) {
      if (request !== pending) return;
      papers = []; total = 0;
      resultMessage('检索未完成', error.message);
      q('#discovery-result-count').textContent = `${label} · 检索未完成`;
      q('#discovery-page-range').textContent = ''; status(error.message);
    } finally {
      if (request === pending) { request = null; results.removeAttribute('aria-busy'); }
    }
  }
  function pendingRows() { return [...queue.values()].filter(row => row.status === 'pending'); }
  function renderQueue() {
    q('#queue-count').textContent = q('#queue-tab-count').textContent = queue.size;
    q('.d-queue-badge').textContent = acquiring ? '获取中' : queue.size ? '获取状态' : '待确认';
    confirm.disabled = acquiring || loadingFolders || !pendingRows().length;
    list.innerHTML = queue.size ? [...queue.values()].map(row => {
      const paper = row.paper, id = escape(paper.id), title = escape(paper.title);
      const available = row.document?.id && row.document.file_available;
      const retry = ['failed', 'metadata_only', 'version_available'].includes(row.status);
      const open = row.document?.id ? `<a href="${escape(readerLink(row.document))}">${available ? (row.status === 'version_available' ? '打开已有版本' : '打开阅读') : '查看题录'} ↗</a>` : '';
      return `<div class="d-queue-row">${icon('plan')}<div class="d-queue-copy"><h4 title="${title}">${title}</h4>
        <p>${providers[paper.provider]} · ${id}</p><p>${labels[row.status]}${row.existing_version ? ` · ${escape(row.existing_version)}` : ''}
        ${row.status === 'downloaded' && paper.provider === 'openalex' ? (row.download_source === 'cache' ? ' · OpenAlex 缓存' : ' · 公开来源') : ''}</p>
        ${row.message ? `<p>${escape(row.message)}</p>` : ''}
        ${available && row.document.rel_path ? `<p title="${escape(row.document.rel_path)}">${escape(row.document.rel_path)}</p>` : ''}
        ${open || retry ? `<div class="d-official-links">${open}${retry ? `<a href="${escape(sourceLink(paper))}" target="_blank" rel="noopener noreferrer">来源页 ↗</a><button class="d-link-button" type="button" data-retry-paper="${id}"${acquiring ? ' disabled' : ''}>${row.status === 'version_available' ? '另存此版本' : '重试'}</button>` : ''}</div>` : ''}</div>
        <button type="button" class="d-remove-paper" data-remove-paper="${id}" aria-label="移除 ${title}"${acquiring ? ' disabled' : ''}>${icon('close')}</button></div>`;
    }).join('') : `<div class="d-empty">${icon('plan')}<strong>获取队列为空</strong><p>点击论文旁的加号加入队列。</p></div>`;
  }
  function refreshSelection() {
    if (!results.hasAttribute('aria-busy') && papers.length) renderResults();
    renderQueue();
  }
  function toggle(id) {
    if (acquiring) return;
    if (queue.has(id)) queue.delete(id);
    else {
      const paper = papers.find(item => item.id === id);
      if (paper) queue.set(id, { paper, status: 'pending' });
    }
    refreshSelection();
  }

  const folder = document.createElement('select');
  folder.id = 'destination-real-folder';
  const folderLabel = document.createElement('label');
  folderLabel.htmlFor = folder.id; folderLabel.textContent = '工作空间目录';
  q('.d-folder-options').after(folderLabel, folder);
  q('.d-folder-options').hidden = true;
  q('#destination-vault').replaceChildren(new window.Option(workspace?.name ?? '选择工作空间', 'current'));
  q('#destination-vault').disabled = true;
  q('.d-acquisition-path').hidden = true;
  q('.d-destination-actions > div').hidden = true;
  q('#acquisition-form button[type=submit]').textContent = '开始获取';
  q('#acquisition-form > .d-field-help').textContent = '公开 PDF 会保存到所选目录。全文暂不可用时，保留题录和来源。';
  const workspaceURL = workspace ? `/api/workspaces/${encodeURIComponent(workspace.id)}` : '';
  function previewDestination() {
    q('#destination-preview').textContent = `${workspace.name} / ${folder.value || '根目录'}`;
  }
  async function openDestination() {
    if (!workspace) { notify('请先从侧栏打开一个本地工作空间。'); return; }
    if (loadingFolders || acquiring) return;
    loadingFolders = true; renderQueue();
    try {
      const tree = await space.request(`${workspaceURL}/files`);
      const previous = folder.value || space.directory || '';
      folder.replaceChildren(new window.Option('工作空间根目录', ''),
        ...tree.entries.filter(entry => entry.kind === 'folder').map(entry => new window.Option(entry.path, entry.path)));
      folder.value = previous;
      if (folder.selectedIndex < 0) folder.value = '';
      q('#acquisition-count').textContent = `本次选择 ${pendingRows().length} 篇`;
      previewDestination(); dialog.showModal(); folder.focus();
    } catch (error) { notify(error.message); }
    finally { loadingFolders = false; renderQueue(); }
  }
  async function startAcquisition(rows, directory, separateVersion = false) {
    if (!workspace || acquiring || !rows.length) return;
    acquiring = true; panel('queue'); refreshSelection();
    try {
      for (const row of rows) {
        if (lifecycle.signal.aborted) break;
        Object.assign(row, { directory, separateVersion, status: 'downloading', message: '', existing_version: null, document: null, download_source: null });
        renderQueue();
        try {
          const rowProvider = row.paper.provider;
          const answer = await space.request(`${workspaceURL}/discovery/${rowProvider}/acquire`, {
            method: 'POST', body: JSON.stringify({ id: row.paper.id, directory, separate_version: separateVersion }),
          });
          Object.assign(row, answer);
        } catch (error) { row.status = 'failed'; row.message = error.message; }
        status(`${row.paper.title} · ${labels[row.status]}`);
      }
    } finally { acquiring = false; refreshSelection(); }
  }

  on(q('#discovery-search-form'), 'submit', event => {
    event.preventDefault(); query = searchInput.value.trim(); panel('results'); void search();
  });
  on(pagination, 'click', event => {
    const button = event.target.closest('[data-live-page]');
    if (button && !button.disabled) void search(Number(button.dataset.livePage));
  });
  for (const field of [yearFrom, yearTo, pageSize, sort]) on(field, 'change', () => void search());
  on(q('#reset-discovery-filters'), 'click', () => {
    yearFrom.value = '1900'; yearTo.value = '2100'; sort.value = 'relevance'; void search();
  });
  for (const button of all('[data-workspace-tab]')) on(button, 'click', () => panel(button.dataset.workspaceTab));
  on(results, 'click', event => {
    const button = event.target.closest('[data-toggle-paper]');
    if (button) {
      const id = button.dataset.togglePaper;
      toggle(id);
      all('[data-toggle-paper]').find(item => item.dataset.togglePaper === id)?.focus();
    }
  });
  on(list, 'click', event => {
    const remove = event.target.closest('[data-remove-paper]'), retry = event.target.closest('[data-retry-paper]');
    if (remove) toggle(remove.dataset.removePaper);
    if (retry) {
      const row = queue.get(retry.dataset.retryPaper);
      if (row) void startAcquisition([row], row.directory, row.status === 'version_available' || row.separateVersion);
    }
  });
  on(confirm, 'click', openDestination);
  on(folder, 'change', previewDestination);
  on(dialog, 'close', () => confirm.focus());
  for (const button of dialog.querySelectorAll('[data-close-dialog]')) on(button, 'click', () => dialog.close());
  on(q('#acquisition-form'), 'submit', event => {
    event.preventDefault(); dialog.close();
    void startAcquisition(pendingRows(), folder.value);
  });
  const unregister = space.addSwitchGuard?.(() => !acquiring);

  searchInput.value = '';
  searchInput.placeholder = '输入关键词、标题或 arXiv 编号…';
  yearFrom.value = '1900'; yearTo.value = '2100';
  q('#filter-year-summary').textContent = '不限';
  q('.d-year-group summary > span').textContent = '提交年份';
  q('.d-year-visual').hidden = true;
  q('#discovery-year-precision').open = true;
  q('.d-types').closest('details').hidden = true;
  sort.querySelector('option[value=title]').remove();
  const source = q('.d-source-config');
  source.innerHTML = `<button type="button" class="d-config-button" id="source-settings" aria-haspopup="dialog">${icon('settings')}<span><strong>来源与凭据</strong><small id="source-settings-status"></small></span>${icon('chevron')}</button>`;
  const sourceButton = q('#source-settings');
  const sourceDialog = q('#source-config-dialog');
  sourceDialog.innerHTML = `<div class="dialog-heading"><h2 id="source-config-title">来源与凭据</h2><button type="button" data-close-dialog aria-label="关闭">${icon('close')}</button></div>
    <form id="live-source-form"><label for="live-discovery-source">检索来源</label>
    <select id="live-discovery-source"><option value="arxiv">arXiv</option><option value="openalex">OpenAlex</option></select>
    <div id="live-openalex-fields" hidden><label for="live-openalex-key">OpenAlex API Key</label>
    <input id="live-openalex-key" type="password" autocomplete="off" maxlength="256" aria-describedby="live-key-help">
    <p id="live-key-help" class="d-field-help">OpenAlex Key 加密保存到当前账号。每次检索使用自己的额度。</p>
    <div class="d-official-links"><a href="https://openalex.org/settings/api-key" target="_blank" rel="noopener noreferrer">获取免费 Key ↗</a><button id="live-remove-openalex-key" class="d-link-button" type="button" hidden>移除已保存的 Key</button></div></div>
    <p id="live-source-error" class="d-form-error" role="alert" hidden></p><div class="dialog-actions"><button type="submit" class="s-button">应用来源</button></div></form>`;
  const sourceChoice = q('#live-discovery-source'), keyInput = q('#live-openalex-key');
  const sourceError = q('#live-source-error'), applySource = q('#live-source-form button[type=submit]');
  const removeKey = q('#live-remove-openalex-key');
  function renderSource() {
    q('#source-settings-status').textContent = provider === 'arxiv' ? 'arXiv · 无需 API Key'
      : openAlexConfigured ? 'OpenAlex · Key 已配置' : 'OpenAlex · 请绑定 Key';
    q('.d-year-group summary > span').textContent = provider === 'arxiv' ? '提交年份' : '发表年份';
    searchInput.placeholder = provider === 'arxiv' ? '输入关键词、标题或 arXiv 编号…' : '输入关键词、标题、DOI 或 OpenAlex 编号…';
  }
  function sourceFields() {
    q('#live-openalex-fields').hidden = sourceChoice.value !== 'openalex';
    keyInput.placeholder = openAlexConfigured ? '已绑定。填入新 Key 可替换' : '粘贴 OpenAlex API Key';
    removeKey.hidden = !openAlexConfigured;
    sourceError.hidden = true;
  }
  function sourceProblem(message) {
    sourceError.textContent = message; sourceError.hidden = false;
  }
  function useProvider(nextProvider) {
    if (provider !== nextProvider) {
      provider = nextProvider; query = ''; renderSource(); void search();
    }
    if (sourcePreference) {
      try { window.localStorage.setItem(sourcePreference, provider); } catch { /* optional display preference */ }
    }
  }
  async function credentialRequest(options, busyText) {
    if (keyRequest) return null;
    keyRequest = new window.AbortController();
    const { signal } = keyRequest;
    applySource.disabled = true; removeKey.disabled = true; sourceChoice.disabled = true;
    applySource.textContent = busyText;
    try {
      const state = await space.request(credentialURL, { ...options, signal });
      if (signal.aborted) return null;
      openAlexConfigured = state.configured === true;
      renderSource(); sourceFields();
      return state;
    } catch (error) {
      if (!signal.aborted && sourceDialog.open) sourceProblem(error.message);
      return null;
    } finally {
      keyRequest = null; applySource.disabled = false; removeKey.disabled = false; sourceChoice.disabled = false;
      applySource.textContent = '应用来源';
    }
  }
  on(sourceButton, 'click', () => {
    sourceChoice.value = provider; keyInput.value = '';
    sourceFields(); sourceDialog.showModal(); sourceChoice.focus();
    void credentialRequest({}, '正在读取配置…');
  });
  on(sourceChoice, 'change', sourceFields);
  on(sourceDialog, 'close', () => { keyRequest?.abort(); keyInput.value = ''; sourceButton.focus(); });
  on(sourceDialog.querySelector('[data-close-dialog]'), 'click', () => sourceDialog.close());
  on(q('#live-source-form'), 'submit', async event => {
    event.preventDefault();
    if (applySource.disabled) return;
    const nextProvider = sourceChoice.value, entered = keyInput.value.trim();
    if (nextProvider === 'openalex' && !entered && !openAlexConfigured) {
      sourceProblem('请输入 OpenAlex API Key。'); keyInput.focus(); return;
    }
    if (nextProvider === 'openalex' && entered) {
      keyInput.value = ''; sourceError.hidden = true;
      const saved = await credentialRequest({ method: 'PUT', body: JSON.stringify({ key: entered }) }, '正在验证并保存…');
      if (!saved?.configured || !sourceDialog.open) return;
    }
    useProvider(nextProvider);
    sourceDialog.close();
    notify(`已选择 ${providers[provider]}。`);
  });
  on(removeKey, 'click', async () => {
    const removed = await credentialRequest({ method: 'DELETE' }, '正在移除…');
    if (!removed || removed.configured) return;
    useProvider('arxiv'); sourceChoice.value = 'arxiv'; keyInput.value = ''; sourceFields();
    sourceChoice.focus(); notify('已移除当前账号保存的 OpenAlex Key。');
  });
  on(window, 'lexivault:account-ended', () => {
    openAlexConfigured = false; keyInput.value = ''; keyRequest?.abort(); request?.abort();
  });
  renderSource();
  q('.d-queue-bottom > p').textContent = '选择当前工作空间中的文件夹，保存 PDF 并打开阅读。';
  renderResults(); renderPagination(); renderQueue();
  let previousSource;
  try { if (sourcePreference) previousSource = window.localStorage.getItem(sourcePreference); } catch {}
  if (previousSource === 'openalex') {
    void space.request(credentialURL, { signal: lifecycle.signal }).then(state => {
      if (lifecycle.signal.aborted || sourceDialog.open || query) return;
      openAlexConfigured = state.configured === true;
      if (openAlexConfigured) useProvider('openalex');
    }).catch(() => {});
  }
  return { destroy() { lifecycle.abort(); request?.abort(); keyRequest?.abort(); unregister?.(); clearTimeout(toastTimer); openAlexConfigured = false; keyInput.value = ''; } };
}
