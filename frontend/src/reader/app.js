import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { initSuite, icon } from '../suite.js';
import {renderPaperTree} from './tree.js';
import { annotationQuote, parseSelection, selectionRectangles } from './annotations.js';

initSuite();
// The build injects the matching, content-hashed worker asset to bypass stale module caches.
GlobalWorkerOptions.workerSrc = new URL(__PDFJS_WORKER_URL__, import.meta.url).href;
const $ = (selector) => document.querySelector(selector);
const noteInput = $('#reader-note');
const pdfScroll = $('#reader-pdf-scroll');
const pdfPage = $('#reader-pdf-page');
const textLayer = $('#reader-text-layer');
const annotationButton = $('#reader-add-annotation');
const annotationHighlight = $('#reader-annotation-highlight');
const status = (message) => { $('#reader-note-status').textContent = message; };
let token, workspace = null, documents = [], active = null, pdf = null;
let importing=false,creatingFolder=false,selectedFolder='',activePath='';
let folderDraft = null, folderCreatePromise = null;
let deletingEntry = false, pendingDelete = null;
const expandedFolders=new Set();
let pageNumber = 1, scale = null, renderTask = null, textTask = null, generation = 0;
let renderedPage = null, selectedPassage = null, textDrag = null;
let pendingSelection = null, highlightPage = null, highlightTimer;
let fittedWidth = null;
let revision = null, savedText = '', dirty = false, blocked = false, savePromise = null;
let debounce, socket, reconnect, refreshTimer, resizing;
let preview = false, historyMarkdown = null;
let treeEntries=[];
let stopped = false;
let navigating = false;
const libraryPreferenceKey = 'lexivault.reader.library-collapsed';
let libraryCollapsed = false;
try { libraryCollapsed = localStorage.getItem(libraryPreferenceKey) === 'true'; } catch {}

function updateLibraryVisibility() {
  const collapsed = libraryCollapsed && window.innerWidth > 950;
  $('.reading-workspace').dataset.libraryCollapsed = String(libraryCollapsed);
  const button = $('#reader-library-toggle');
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = collapsed ? '展开论文目录' : '隐藏论文目录';
  button.setAttribute('aria-label', button.title);
  // Mobile pane tabs remain available even when the desktop directory is hidden.
  $('#reader-library').inert = collapsed;
  if (collapsed) $('#reader-library').setAttribute('aria-hidden', 'true');
  else $('#reader-library').removeAttribute('aria-hidden');
}

function alert(message = '') {
  $('#reader-alert').hidden = !message;
  $('#reader-alert').textContent = message;
}
async function api(path, options = {}) {
  const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { 'X-LexiVault-Token': token } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.message || `请求失败（${response.status}），请检查本地服务。`);
    error.status = response.status; error.payload = payload;
    throw error;
  }
  return response.json();
}
const base = () => `/api/workspaces/${workspace.id}`;
const docBase = () => `${base()}/documents/${active.id}`;

function pane(name) {
  $('.reading-workspace').dataset.pane = name;
  document.querySelectorAll('[data-reader-pane]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.readerPane === name)));
}
function showConflict(message) {
  blocked = true;
  clearTimeout(debounce);
  $('#reader-conflict').hidden = false;
  $('#reader-conflict-message').textContent = message;
  status('有冲突 · 草稿已保留');
}
function draftKey() { const user=window.LexiVaultSpace?.userId;return active && workspace ? `lexivault.reader.draft.${user?user+'.':''}${workspace.id}.${active.id}` : null; }
function rememberDraft() {
  const key = draftKey();
  if (!key) return;
  try {
    if (dirty) localStorage.setItem(key, JSON.stringify({ markdown: noteInput.value, revision }));
    else localStorage.removeItem(key);
  } catch { alert('浏览器无法保存应急草稿，请保持页面打开，或下载当前草稿。'); }
}
function setNote(note) {
  revision = note.revision; savedText = note.markdown;
  noteInput.value = note.markdown; dirty = false; blocked = false;
  $('#reader-conflict').hidden = true;
  $('#reader-note-path').textContent = note.path || '首次保存时创建 Markdown 文件';
  $('#reader-note-destination').value=note.path ? (treeEntries.find(e=>e.plan_id===note.id)?.path || note.path) : note.suggested_path || '';
  $('#reader-note-destination').readOnly=note.revision!=='uncreated';
  status(note.revision==='uncreated'?'尚未创建笔记文件':note.missing ? '本地文件已删除' : '已载入本地文件');
  if (note.missing) showConflict('本地笔记文件已被删除。可以保存草稿副本，或在确认后重新创建笔记。');
  drawNotes();
}
function noteEdited() {
  dirty = noteInput.value !== savedText;
  rememberDraft(); drawNotes();
  if (blocked) return;
  status(dirty ? '待保存…' : '已保存');
  clearTimeout(debounce);
  if (dirty) debounce = setTimeout(() => void flush(), 700);
}
async function flush() {
  clearTimeout(debounce);
  if (savePromise) await savePromise;
  if (!active || !dirty) return !blocked;
  if (blocked) return false;
  const path = `${docBase()}/note`, body = noteInput.value, identity = active.id;
  status('保存中…');
  savePromise = (async () => {
    try {
      const note = await api(path, { method: 'PUT', body: JSON.stringify({ markdown: body, expected_revision: revision,...(revision==='uncreated'?{path:$('#reader-note-destination').value}:{}) }) });
      if (active?.id !== identity) return false;
      revision = note.revision; savedText = body;
      $('#reader-note-destination').readOnly=true;
      dirty = noteInput.value !== savedText;
      $('#reader-note-path').textContent = note.path;
      rememberDraft(); status(dirty ? '待保存…' : '已保存到本地');
      return true;
    } catch (error) {
      rememberDraft();
      if (error.status === 409) showConflict(error.message);
      else { status('保存失败 · 草稿已保留'); alert(error.message); }
      return false;
    }
  })();
  const okay = await savePromise;
  savePromise = null;
  if (okay && dirty) return flush();
  return okay;
}
async function canLeave() {
  if (blocked) { alert('请先处理笔记冲突，保存草稿副本或下载草稿后再切换。'); pane('note'); return false; }
  if (!await flush()) { pane('note'); return false; }
  return true;
}
function selectFolder(path){
  selectedFolder=path;
  if(window.LexiVaultSpace)window.LexiVaultSpace.directory=path;
  $('#reader-import-folder').value=path;
  $('#reader-root').textContent=workspace?workspace.name+' / '+(path||'根目录'):'尚未选择工作空间';
  $('#reader-root').title=workspace?workspace.path+(path?' / '+path:''):'';
  $('#reader-tree-root').classList.toggle('is-selected',!path);
}
function drawList(){
  let entries=treeEntries;
  if(workspace?.layout!=='files'){
    entries=documents.filter(d=>d.file_available).map(d=>({path:d.rel_path||d.title+'.pdf',name:d.filename||d.title+'.pdf',kind:'pdf',document_id:d.id}));
    const parents=new Set();entries.forEach(e=>{const parts=e.path.split('/');parts.pop();while(parts.length){parents.add(parts.join('/'));parts.pop();}});
    entries=[...parents].map(path=>({path,name:path.split('/').pop(),kind:'folder'})).concat(entries);
  }
  $('#reader-count').textContent=`${documents.length} 篇`;
  // Keep the actual input node and its IME/caret state during filesystem polling.
  if (folderDraft) { validateFolderDraft(); return; }
  renderPaperTree($('#reader-documents'),{entries,documents,query:$('#reader-search').value,activeId:active?.id,activePath,expanded:expandedFolders,selectedFolder,
    onFolder:selectFolder,onToggle:()=>{},onOpen:(item,path)=>void openDocument(item,{path}),onTrash:workspace?.layout==='files'?requestTrash:null});
}
const insidePath = (path, parent) => !!path && (path === parent || path.startsWith(parent + '/'));
function currentNoteRelativePath() {
  if (!active || revision === 'uncreated') return '';
  const path = $('#reader-note-path').textContent.replaceAll('\\','/');
  const root = workspace.path.replaceAll('\\','/').replace(/\/$/,'');
  return path.toLocaleLowerCase().startsWith(root.toLocaleLowerCase()+'/') ? path.slice(root.length+1) : path;
}
function requestTrash(path) {
  if (workspace?.layout !== 'files' || importing || creatingFolder || deletingEntry || navigating || folderDraft) return;
  const entry = treeEntries.find(item => item.path === path && ['folder','pdf'].includes(item.kind));
  if (!entry) return;
  pendingDelete = {identity:workspace.id,path,kind:entry.kind};
  $('#reader-delete-path').textContent = path;
  $('#reader-delete-description').textContent = entry.kind === 'folder'
    ? '文件夹及其中的所有文件会一起移入电脑的系统回收站，需要时可在电脑回收站恢复。'
    : 'PDF 原件会移入电脑的系统回收站，保存在其他位置的阅读笔记会保留。';
  $('#reader-delete-error').hidden = true;
  $('#reader-delete-dialog').showModal();
}
function setDeleteBusy(value) {
  deletingEntry = value;
  $('#reader-delete-dialog').querySelectorAll('button').forEach(button => { button.disabled = value; });
}
async function confirmTrash() {
  if (!pendingDelete || !$('#reader-delete-dialog').open || deletingEntry || workspace?.id !== pendingDelete.identity) return;
  const target = {...pendingDelete};
  setDeleteBusy(true);
  try {
    if (!await canLeave()) { $('#reader-delete-dialog').close(); return; }
    const closesPaper = insidePath(activePath || active?.rel_path, target.path) || insidePath(currentNoteRelativePath(), target.path);
    await api(`${base()}/files/delete`,{method:'POST',body:JSON.stringify({path:target.path})});
    $('#reader-delete-status').textContent = `已删除：${target.path.split('/').pop()}。可在电脑系统回收站恢复。`;
    $('#reader-delete-status').hidden = false;
    $('#reader-import-status').hidden = true;
    if (closesPaper) await clearPaper();
    if (insidePath(selectedFolder,target.path)) selectFolder(target.path.split('/').slice(0,-1).join('/'));
    for (const folder of expandedFolders) if (insidePath(folder,target.path)) expandedFolders.delete(folder);
    $('#reader-delete-dialog').close(); pendingDelete = null;
    await refreshDocuments();
  } catch (error) {
    if ($('#reader-delete-dialog').open) {
      $('#reader-delete-error').textContent = error.message; $('#reader-delete-error').hidden = false;
    } else alert(`目录刷新失败，请刷新页面：${error.message}`);
  } finally { setDeleteBusy(false); }
}
function siblingExists(parent, name) {
  const path = [parent, name].filter(Boolean).join('/').toLocaleLowerCase();
  return treeEntries.find(entry => entry.path.toLocaleLowerCase() === path);
}
function defaultFolderName(parent, excluded = new Set()) {
  let number = 0;
  while (siblingExists(parent, number === 0 ? '未命名' : `未命名${number}`) || excluded.has(number === 0 ? '未命名' : `未命名${number}`)) number++;
  return number === 0 ? '未命名' : `未命名${number}`;
}
function positionFolderFeedback() {
  if (!folderDraft || folderDraft.feedback.hidden) return;
  const {feedback, input} = folderDraft, row = input.parentElement.getBoundingClientRect();
  const bounds = feedback.getBoundingClientRect(), center = row.left + row.width / 2;
  const left = Math.max(12, Math.min(center - bounds.width / 2, window.innerWidth - bounds.width - 12));
  const above = row.bottom + 10 + bounds.height > window.innerHeight - 12;
  feedback.style.left = `${left}px`;
  feedback.style.top = `${above ? Math.max(12,row.top - bounds.height - 10) : row.bottom + 10}px`;
  feedback.style.setProperty('--reader-folder-arrow-left',`${Math.max(16,Math.min(center - left,bounds.width - 16))}px`);
  feedback.dataset.placement = above ? 'above' : 'below';
}
function validateFolderDraft() {
  const draft = folderDraft;
  if (!draft || draft.composing || creatingFolder) return null;
  const name = draft.input.value.trim(), sibling = name && siblingExists(draft.parent, name);
  let message = draft.requestError || '';
  if (!message && draft.parent && !treeEntries.some(e => e.kind === 'folder' && e.path === draft.parent)) message = '上级文件夹已不存在，请按 Esc 取消后重新创建。';
  if (!message && name && (name.startsWith('.') || /[\\/<>:"|?*\x00-\x1f]/.test(name) || name.endsWith('.'))) message = '文件夹名称不能包含路径或特殊字符，也不能以点开头或结尾。';
  const invalid = !!message;
  if (!message && sibling) message = sibling.kind === 'folder' ? '已经存在同名文件夹' : '已经存在同名文件';
  if (draft.feedback.textContent !== message) draft.feedback.textContent = message;
  draft.feedback.hidden = !message;
  draft.input.setAttribute('aria-invalid', String(!!message));
  positionFolderFeedback();
  return {name, duplicate:!!sibling, invalid};
}
function cancelFolderDraft() {
  if (!folderDraft || creatingFolder) return;
  const draft = folderDraft;
  folderDraft = null;
  draft.element.remove(); draft.feedback.remove();
  drawList();
}
function beginFolderDraft() {
  if (workspace?.layout !== 'files' || creatingFolder || importing || deletingEntry) return;
  if (folderDraft) { folderDraft.input.focus(); return; }
  const parent = selectedFolder;
  $('#reader-search').value = '';
  const parts = parent.split('/').filter(Boolean);
  while (parts.length) { expandedFolders.add(parts.join('/')); parts.pop(); }
  drawList();
  const tree = $('#reader-documents');
  const container = parent ? [...tree.querySelectorAll('[data-folder-children]')].find(node => node.dataset.folderChildren === parent) : tree;
  if (!container) return;
  tree.querySelector('.reader-tree-empty')?.remove();
  const element = document.createElement('div'); element.className = 'reader-folder-draft';
  const row = document.createElement('div'); row.className = 'reader-folder-input-row';
  const chevron = document.createElement('span'); chevron.className = 'reader-tree-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden','true');
  row.append(chevron); row.insertAdjacentHTML('beforeend',icon('folder'));
  const input = document.createElement('input'); input.id = 'reader-folder-name'; input.type = 'text'; input.maxLength = 200; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('aria-label','新文件夹名称'); input.setAttribute('aria-describedby','reader-folder-error reader-folder-hint'); input.value = defaultFolderName(parent);
  const feedback = document.createElement('p'); feedback.id = 'reader-folder-error'; feedback.setAttribute('role','alert'); feedback.hidden = true;
  const hint = document.createElement('span'); hint.id = 'reader-folder-hint'; hint.className = 's-sr-only'; hint.textContent = 'Enter 创建文件夹，Esc 取消；重名时按 Enter 使用默认名称。';
  row.append(input); element.append(row, hint); document.body.append(feedback);
  folderDraft = {parent, identity:workspace.id, element, input, feedback, composing:false, requestError:''};
  input.addEventListener('input', () => { if (folderDraft) folderDraft.requestError = ''; validateFolderDraft(); });
  input.addEventListener('compositionstart', () => { if (folderDraft) folderDraft.composing = true; });
  input.addEventListener('compositionend', () => { if (folderDraft) folderDraft.composing = false; validateFolderDraft(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || folderDraft?.composing) return;
    if (event.key === 'Enter') { event.preventDefault(); void commitFolderDraft(true); }
    if (event.key === 'Escape') { event.preventDefault(); cancelFolderDraft(); $('#reader-new-folder').focus(); }
  });
  input.addEventListener('blur', () => { if (folderDraft?.input === input && !folderDraft.composing) void commitFolderDraft(false); });
  container.prepend(element);
  input.focus(); input.select(); element.scrollIntoView?.({block:'nearest'});
}
async function commitFolderDraft(useDefaultForDuplicate = true) {
  if (creatingFolder) return folderCreatePromise || false;
  const draft = folderDraft;
  if (!draft || draft.composing) return !draft;
  draft.requestError = '';
  const validation = validateFolderDraft();
  if (validation.invalid || (validation.duplicate && !useDefaultForDuplicate)) return false;
  let name = validation.duplicate || !validation.name ? defaultFolderName(draft.parent) : validation.name;
  const path = `${base()}/files`, rejected = new Set();
  creatingFolder = true; draft.input.readOnly = true; draft.element.setAttribute('aria-busy','true');
  folderCreatePromise = (async () => {
    try {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await api(path,{method:'POST',body:JSON.stringify({parent:draft.parent,name,kind:'folder'})}); break; }
        catch (error) {
          if (error.status !== 409 || attempt === 2) throw error;
          rejected.add(name);
          await refreshLocations();
          name = defaultFolderName(draft.parent, rejected);
        }
      }
      if (workspace?.id !== draft.identity) return false;
      if (!treeEntries.some(entry => entry.path === result.path)) treeEntries.push({kind:'folder',path:result.path,name:result.path.split('/').pop()});
      const options = $('#reader-import-folder');
      if (![...options.options].some(option => option.value === result.path)) options.add(new Option(result.path,result.path));
      folderDraft = null; draft.element.remove(); draft.feedback.remove();
      selectFolder(result.path); expandedFolders.add(result.path); drawList();
      $('#reader-import-status').textContent = `已创建文件夹：${result.path}。导入 PDF 将保存到此处。`;
      $('#reader-import-status').hidden = false;
      $('#reader-documents').querySelector('.reader-folder.is-selected')?.focus();
      return true;
    } catch (error) {
      draft.requestError = error.message; return false;
    } finally {
      creatingFolder = false; folderCreatePromise = null;
      draft.input.readOnly = false; draft.element.removeAttribute('aria-busy'); validateFolderDraft();
    }
  })();
  return folderCreatePromise;
}
async function refreshLocations(){
  if(workspace?.layout!=='files')return;
  const data=await api(`${base()}/files`);treeEntries=data.entries||[];
  if(selectedFolder&&!treeEntries.some(e=>e.kind==='folder'&&e.path===selectedFolder))selectFolder('');
  const folder=$('#reader-import-folder'),previous=selectedFolder;
  folder.replaceChildren(new Option('工作空间根目录',''));treeEntries.filter(e=>e.kind==='folder').forEach(e=>folder.add(new Option(e.path,e.path)));folder.value=previous;if(folder.selectedIndex<0)folder.value='';
  const existing=$('#reader-existing-note'),selected=existing.value;existing.replaceChildren(new Option('请选择已有笔记',''));treeEntries.filter(e=>e.kind==='markdown').forEach(e=>existing.add(new Option(e.path,e.path)));existing.value=selected;if(existing.selectedIndex<0)existing.value='';
}
async function refreshDocuments() {
  if (!workspace) return;
  const id = workspace.id, list = await api(`${base()}/documents`);
  if (workspace?.id !== id) return;
  await refreshLocations();
  documents = list; drawList();
}
function setEnabled(enabled) {
  for (const id of ['reader-note', 'reader-save', 'reader-history','reader-note-settings-open','reader-note-destination','reader-existing-note','reader-link-note']) $(`#${id}`).disabled = !enabled;
  document.querySelectorAll('#reader-note-tools button').forEach(button => { button.disabled = !enabled; });
}
async function clearPaper() {
  generation++;
  renderedPage = null; pendingSelection = null; textDrag = null;
  dismissAnnotationButton(); clearAnnotationHighlight();
  renderTask?.cancel(); textTask?.cancel();
  const previous = pdf; pdf = null;
  if (previous) await previous.destroy();
  active = null;activePath='';$('#reader-note-document').textContent='尚未选择论文';$('#reader-note-document').title=''; revision = null; savedText = ''; dirty = false; blocked = false;
  noteInput.value = ''; $('#reader-note-preview').replaceChildren(); $('#reader-citations').replaceChildren();
  $('#reader-conflict').hidden = true; $('#reader-download').hidden = true;
  $('#reader-pdf-page').hidden = true; $('#reader-pdf-status').hidden = false;
  const emptyTitle=document.createElement('h3');emptyTitle.textContent='从一篇论文开始';const emptyHint=document.createElement('p');emptyHint.textContent='在左侧展开文件夹，点击 PDF 打开原文。阅读时可以在右侧记录想法。';$('#reader-pdf-status').replaceChildren(emptyTitle,emptyHint);
  $('#reader-title').textContent = '选择一篇论文'; $('#reader-pages').textContent = '/ 0';
  $('#reader-note-path').textContent = ''; status('尚未选择论文'); setEnabled(false); updatePdfTools();
}
async function openDocument(item, options = {}) {
  if (navigating || deletingEntry) return;
  navigating = true;
  try { await loadDocument(item, options); }
  finally { navigating = false; }
}
async function loadDocument(item, options = {}) {
  if (active?.id === item.id && !options.page && (pdf || !item.file_available)) {activePath=options.path||activePath;if(activePath&&!activePath.startsWith('document:'))selectFolder(activePath.split('/').slice(0,-1).join('/'));drawList();pane('paper');return;}
  if (!await canLeave()) return;
  await clearPaper(); alert(); active = item;activePath=options.path||item.rel_path||'';
  if(activePath&&!activePath.startsWith('document:')){const parts=activePath.split('/');parts.pop();selectFolder(parts.join('/'));while(parts.length){expandedFolders.add(parts.join('/'));parts.pop();}}
  $('#reader-note-document').textContent=item.title;$('#reader-note-document').title=item.title;
  const currentGeneration = generation, id = item.id;
  $('#reader-title').textContent = item.title; drawList(); pane('paper');
  // Notes remain available even if the original PDF is missing or damaged.
  try {
    const note = await api(`${docBase()}/note`);
    if (generation !== currentGeneration) return;
    setNote(note); setEnabled(true);
    let draft;
    try { draft = JSON.parse(localStorage.getItem(draftKey())); } catch {}
    if (draft && typeof draft.markdown === 'string' && draft.markdown !== note.markdown) {
      noteInput.value = draft.markdown; dirty = true;
      if (draft.revision !== note.revision) showConflict('找到未保存草稿，但本地文件也已更新，请先保存副本再处理。');
      else { status('已恢复未保存草稿'); debounce = setTimeout(() => void flush(), 700); }
      drawNotes();
    }
  } catch (error) { alert(error.message); status('笔记暂不可读'); }
  const fileURL = `${docBase()}/file?revision=${encodeURIComponent(item.sha256)}`;
  const link = $('#reader-download'); link.href = fileURL; link.download = item.filename; link.hidden = !item.file_available;
  if (!item.file_available) {
    $('#reader-pdf-status').textContent = item.fulltext_status === 'metadata_only' ? '已收藏文献信息，尚未获取全文。导入一份 PDF 可为当前条目补充原文，阅读笔记可以先记录。' : 'PDF 原件已被移动或删除，请恢复原文件。笔记仍然保留。';
    return;
  }
  $('#reader-pdf-status').textContent = '正在打开 PDF 原文…';
  try {
    const response = await fetch(fileURL, { credentials: 'same-origin' });
    if (!response.ok) throw new Error((await response.json()).message || '原件不可用。');
    const loading = getDocument({ data: new Uint8Array(await response.arrayBuffer()), cMapUrl: '/vendor/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/standard_fonts/', isEvalSupported: false, enableXfa: false });
    const opened = await loading.promise;
    if (generation !== currentGeneration || active?.id !== id) { await opened.destroy(); return; }
    pdf = opened; pageNumber = Math.max(1, Math.min(options.page || item.last_page, pdf.numPages)); scale = null;
    await renderPage({ selection: options.selection });
  } catch (error) {
    if (generation === currentGeneration) { $('#reader-pdf-status').hidden = false; $('#reader-pdf-status').textContent = `无法打开原文：${error.message}。阅读笔记仍可使用。`; }
  }
}
function updatePdfTools() {
  const ready = !!pdf;
  $('#reader-prev').disabled = !ready || pageNumber <= 1;
  $('#reader-next').disabled = !ready || pageNumber >= pdf.numPages;
  for (const id of ['reader-page', 'reader-fit', 'reader-zoom-in', 'reader-zoom-out']) $(`#${id}`).disabled = !ready;
  $('#reader-page').value = pageNumber;
  $('#reader-pages').textContent = `/ ${pdf?.numPages || 0}`;
}
let renderSequence = 0;
async function renderPage({ preserveScroll = false, selection } = {}) {
  if (!pdf) return;
  const sequence = ++renderSequence, identity = generation, currentPDF = pdf;
  const targetPage = pageNumber, canvas = $('#reader-canvas');
  const previousHeight = parseFloat(canvas.style.height) || 1;
  const relativeTop = pdfScroll.scrollTop / previousHeight;
  if (selection !== undefined) pendingSelection = selection ? { page: targetPage, rectangles: selection } : null;
  if (pendingSelection?.page !== targetPage) pendingSelection = null;
  if (highlightPage !== targetPage || selection === null) clearAnnotationHighlight();
  renderedPage = null; dismissAnnotationButton();
  renderTask?.cancel(); textTask?.cancel();
  try {
    const page = await currentPDF.getPage(targetPage);
    if (sequence !== renderSequence || identity !== generation) return;
    const viewport0 = page.getViewport({ scale: 1 });
    const padding=getComputedStyle(pdfScroll);
    fittedWidth = pdfScroll.clientWidth;
    const availableWidth=fittedWidth-parseFloat(padding.paddingLeft||0)-parseFloat(padding.paddingRight||0);
    const fit = Math.max(0.25, (availableWidth-2) / viewport0.width);
    const actualScale = Math.min(scale || fit, 3);
    const viewport = page.getViewport({ scale: actualScale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    pdfPage.style.width = `${viewport.width}px`; pdfPage.style.height = `${viewport.height}px`;
    textLayer.replaceChildren();
    textLayer.style.setProperty('--scale-factor', actualScale); textLayer.style.setProperty('--total-scale-factor', actualScale);
    pdfPage.hidden = false; $('#reader-pdf-status').hidden = true;
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    await renderTask.promise;
    if (sequence !== renderSequence || identity !== generation) return;
    const content = await page.getTextContent();
    if (sequence !== renderSequence || identity !== generation) return;
    textTask = new TextLayer({ textContentSource: content, container: textLayer, viewport });
    await textTask.render();
    if (sequence !== renderSequence || identity !== generation) return;
    $('#reader-zoom').textContent = `${Math.round(actualScale * 100)}%`;
    renderedPage = targetPage;
    updatePdfTools();
    pdfScroll.scrollTop = preserveScroll ? relativeTop * viewport.height : 0;
    if (pendingSelection) {
      showAnnotationHighlight(pendingSelection.rectangles);
      pendingSelection = null;
    }
    await api(`${docBase()}/position`, { method: 'PUT', body: JSON.stringify({ page: targetPage }) });
  } catch (error) {
    if (['RenderingCancelledException', 'AbortException'].includes(error.name) || sequence !== renderSequence || identity !== generation) return;
    alert(`页面显示或阅读位置保存失败：${error.message}`);
  }
}
function citation(page = pageNumber) { return `[文件第 ${page} 页](paper://${active.id}?revision=${active.sha256}&page=${page})`; }
function scheduleFit() {
  clearTimeout(resizing);
  if (scale || !pdf || !pdfScroll.clientWidth || fittedWidth === pdfScroll.clientWidth) return;
  resizing = setTimeout(() => {
    // Rebuilding the text layer would collapse any selection still being made or annotated.
    if (!scale && pdf && pdfScroll.clientWidth && fittedWidth !== pdfScroll.clientWidth && !textDrag && !selectedPassage) {
      void renderPage({ preserveScroll: true });
    }
  }, 200);
}
function clearAnnotationHighlight() {
  clearTimeout(highlightTimer);
  annotationHighlight.replaceChildren();
  highlightPage = null;
}
function showAnnotationHighlight(rectangles) {
  clearAnnotationHighlight();
  highlightPage = renderedPage;
  const markers = rectangles.map(([left, top, right, bottom]) => {
    const marker = document.createElement('span');
    Object.assign(marker.style, {
      left: `${left * 100}%`, top: `${top * 100}%`, width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%`,
    });
    return marker;
  });
  annotationHighlight.append(...markers);
  const page = pdfPage.getBoundingClientRect(), scroller = pdfScroll.getBoundingClientRect();
  const [left, top, right, bottom] = rectangles[0];
  const x = page.left + (left + right) / 2 * page.width;
  const y = page.top + (top + bottom) / 2 * page.height;
  pdfScroll.scrollLeft += x - scroller.left - pdfScroll.clientWidth / 2;
  pdfScroll.scrollTop += y - scroller.top - pdfScroll.clientHeight / 2;
  highlightTimer = setTimeout(clearAnnotationHighlight, 2600);
}
function dismissAnnotationButton() {
  selectedPassage = null;
  annotationButton.hidden = true;
}
function pdfCaret(x, y) {
  const position = document.caretPositionFromPoint?.(x, y);
  const range = position ? null : document.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  if (node?.nodeType === Node.TEXT_NODE && textLayer.contains(node)) {
    return { node, offset: position?.offset ?? range.startOffset };
  }
  return null;
}
function updateAnnotationButton() {
  const selection = window.getSelection();
  if (!active || !pdf || renderedPage !== pageNumber || textDrag || navigating || noteInput.disabled ||
      !pdfScroll.clientWidth || !selection?.rangeCount || selection.isCollapsed ||
      !textLayer.contains(selection.anchorNode) || !textLayer.contains(selection.focusNode)) {
    dismissAnnotationButton(); return;
  }
  const text = selection.toString().trim();
  const range = selection.getRangeAt(0);
  const viewport = pdfScroll.getBoundingClientRect();
  const viewRight = viewport.left + pdfScroll.clientWidth, viewBottom = viewport.top + pdfScroll.clientHeight;
  const rect = [...range.getClientRects()].find(rect => rect.width && rect.height &&
    rect.bottom > viewport.top && rect.top < viewBottom && rect.right > viewport.left && rect.left < viewRight);
  if (!text || !rect) { dismissAnnotationButton(); return; }
  selectedPassage = { range: range.cloneRange(), text };
  annotationButton.hidden = false;
  const gap = 6, width = annotationButton.offsetWidth, height = annotationButton.offsetHeight;
  const left = Math.max(viewport.left + gap, Math.min(rect.left, viewRight - width - gap));
  const top = rect.bottom + height + 2 * gap <= viewBottom ? rect.bottom + gap : Math.max(viewport.top + gap, rect.top - height - gap);
  annotationButton.style.left = `${left - viewport.left + pdfScroll.scrollLeft}px`;
  annotationButton.style.top = `${top - viewport.top + pdfScroll.scrollTop}px`;
}
function addSelectionAnnotation() {
  updateAnnotationButton();
  if (!selectedPassage) return;
  const { range, text } = selectedPassage;
  const rectangles = selectionRectangles(range, pdfPage.getBoundingClientRect());
  if (!rectangles.length) { dismissAnnotationButton(); alert('无法定位这段选文，请重新选择后再添加批注。'); return; }
  let number = 1;
  for (const [, label, url] of noteInput.value.matchAll(citationPattern)) {
    const match = /^\[([1-9]\d{0,8})\]/.exec(citationLabel(label));
    if (match && url.includes('&selection=')) number = Math.max(number, Number(match[1]) + 1);
  }
  const target = `paper://${active.id}?revision=${active.sha256}&page=${pageNumber}&selection=${rectangles.join('.')}`;
  const label = `[\\[${number}\\] · 第 ${pageNumber} 页]`;
  const end = noteInput.value.length;
  const spacer = !end || noteInput.value.endsWith('\n\n') ? '' : noteInput.value.endsWith('\n') ? '\n' : '\n\n';
  dismissAnnotationButton(); window.getSelection()?.removeAllRanges();
  scheduleFit();
  noteInput.setSelectionRange(end, end);
  insertText(`${spacer}${label}(${target})\n\n${annotationQuote(text)}\n\n`);
  noteInput.scrollTop = noteInput.scrollHeight;
}
function insertText(text) {
  if (noteInput.disabled) return;
  noteInput.setRangeText(text, noteInput.selectionStart, noteInput.selectionEnd, 'end');
  noteEdited(); if (preview) setPreview(false); pane('note'); noteInput.focus();
}
function setPreview(value) {
  preview = value; $('#reader-note-preview').hidden = !value; noteInput.hidden = value;
  $('#reader-note-tools').hidden = value;
  $('#reader-edit-tab').setAttribute('aria-pressed', String(!value));
  $('#reader-preview-tab').setAttribute('aria-pressed', String(value)); drawNotes();
}
const citationPattern = /\[((?:\\.|[^\\\]\r\n])+)\]\((paper:\/\/[a-f0-9]+\?revision=[a-f0-9]{64}&page=\d+(?:&selection=[\d.,]+)?)\)/g;
const citationLabel = (label) => label.replace(/\\([\\\[\]])/g, '$1');
function drawNotes() {
  const raw = noteInput.value;
  if (preview) {
    const html = marked.parse(raw.replace(/==([^=\n]+)==/g, '<mark>$1</mark>'), { async: false });
    $('#reader-note-preview').innerHTML = DOMPurify.sanitize(html, {
      FORBID_TAGS: ['img', 'iframe', 'video', 'audio', 'style', 'form', 'input'],
      FORBID_ATTR: ['style'], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|paper):|#)/i
    });
    $('#reader-note-preview').querySelectorAll('a').forEach(a => { if (!a.getAttribute('href')?.startsWith('paper:')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } });
  }
  const links = $('#reader-citations');links.hidden=preview; links.replaceChildren();
  for (const match of raw.matchAll(citationPattern)) {
    const a = document.createElement('a'); a.href = match[2]; a.textContent = citationLabel(match[1]); links.append(a);
  }
}
async function followCitation(event) {
  const a = event.target.closest('a');
  if (!a?.getAttribute('href')?.startsWith('paper:')) return;
  event.preventDefault();
  try {
    const url = new URL(a.getAttribute('href'));
    const page = Number(url.searchParams.get('page')), hash = url.searchParams.get('revision');
    const encoded = url.searchParams.get('selection');
    const selection = encoded === null ? null : parseSelection(encoded);
    const item = documents.find(d => d.id === url.hostname) ||
      (selection && documents.find(d => d.sha256 === hash && d.file_available));
    if (!item?.file_available || hash !== item.sha256 || !Number.isInteger(page) || page < 1 || page > item.page_count || (encoded !== null && !selection)) {
      throw new Error(selection ? '此批注的 PDF 版本或原文位置已不可用，仍可查看笔记中的摘录。' : '引用的文献、版本或位置已不可用。');
    }
    alert();
    if (active?.id === item.id && active.sha256 === hash && pdf) { pageNumber = page; pane('paper'); await renderPage({ selection }); }
    else await openDocument(item, { page, selection });
  } catch (error) { alert(error.message); }
}
async function syncCurrent() {
  if (!workspace || deletingEntry) return;
  try {
    await refreshDocuments();
    if (!active || savePromise || noteInput.disabled) return;
    const identity = active.id, version = revision, note = await api(`${docBase()}/note`);
    if (active?.id !== identity || savePromise || revision !== version) return;
    if (note.revision === revision) return;
    if (dirty || blocked) showConflict('外部编辑器或其他页面修改了同一笔记。请先保留当前草稿，再载入本地版本。');
    else { setNote(note); status(note.missing ? '本地文件已删除' : '已更新外部修改'); }
  } catch (error) { alert(error.message); if (active) status('文件同步暂不可用'); }
}
function connectEvents() {
  clearTimeout(reconnect);
  if (socket) { socket.onclose = null; socket.close(); }
  if (!workspace) return;
  const identity = workspace.id;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${base()}/events`);
  socket.onopen = () => { $('#reader-connection').textContent = '本地文件已连接'; void syncCurrent(); };
  socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.type === 'watcher_error') alert('文件监听已停止，请重启本地服务；当前笔记仍可保存。'); else if (message.type !== 'heartbeat') void syncCurrent(); };
  socket.onclose = () => {
    if (stopped || workspace?.id !== identity) return;
    $('#reader-connection').textContent = '正在重新连接文件监听…';
    reconnect = setTimeout(connectEvents, 2500);
  };
}
async function loadWorkspace(space){
  if(!await canLeave())return;
  cancelFolderDraft();
  await clearPaper();workspace=space;documents=[];treeEntries=[];expandedFolders.clear();
  pendingDelete = null; $('#reader-delete-status').hidden = true;
  $('#reader-files').disabled=!workspace;
  $('#reader-new-folder').disabled=workspace?.layout!=='files';
  $('#reader-file-destination').hidden=workspace?.layout!=='files';$('#reader-note-location').hidden=workspace?.layout!=='files';
  $('#reader-tree-name').textContent=workspace?.name||'选择工作空间';
  selectFolder(window.LexiVaultSpace?.directory||'');
  if(workspace){await refreshDocuments();if(selectedFolder){let parts=selectedFolder.split('/');while(parts.length){expandedFolders.add(parts.join('/'));parts.pop();}drawList();}}
  else drawList();
  connectEvents();
}
function exportDraft() {
  const blob = new Blob([noteInput.value], { type: 'text/markdown;charset=utf-8' }), url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${active?.title || '阅读笔记'}-草稿.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function action(handler) { return (...args) => Promise.resolve(handler(...args)).catch(error => alert(error.message)); }

setEnabled(false);
updateLibraryVisibility();
$('#reader-library-toggle').addEventListener('click', () => {
  libraryCollapsed = !libraryCollapsed;
  try { localStorage.setItem(libraryPreferenceKey, String(libraryCollapsed)); } catch {}
  updateLibraryVisibility();
});
window.addEventListener('resize', updateLibraryVisibility);
window.addEventListener('resize', positionFolderFeedback);
window.addEventListener('scroll', positionFolderFeedback, true);
document.querySelectorAll('[data-reader-pane]').forEach(button => button.addEventListener('click', () => pane(button.dataset.readerPane)));
document.querySelectorAll('[data-reader-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('#reader-search').addEventListener('input',drawList);
$('#reader-tree-root').addEventListener('click',()=>{selectFolder('');drawList();});
$('#reader-refresh').addEventListener('click',action(syncCurrent));
$('#reader-new-folder').addEventListener('click', beginFolderDraft);
$('#reader-delete-confirm').addEventListener('click', () => void confirmTrash());
$('#reader-delete-dialog').addEventListener('cancel', event => { if (deletingEntry) event.preventDefault(); });
$('#reader-documents').addEventListener('keydown', event => {
  if (event.key !== 'Delete' || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.target.closest('input,textarea,[contenteditable=true]')) return;
  const row = event.target.closest('[data-paper-path]');
  if (!row) return;
  event.preventDefault(); requestTrash(row.dataset.paperPath);
});
$('#reader-documents').addEventListener('click', event => {
  if (event.target === event.currentTarget || event.target.classList.contains('reader-tree-empty')) { selectFolder(''); drawList(); }
});
$('#reader-import-open').addEventListener('click',action(async()=>{
  if (deletingEntry) return;
  if (folderDraft && !await commitFolderDraft(true)) { folderDraft?.input.focus(); return; }
  $('#reader-import-dialog').showModal();
}));
$('#reader-note-settings-open').addEventListener('click',()=>$('#reader-note-settings').showModal());
$('#reader-open').addEventListener('click',action(async()=>{
  if(!await canLeave()||importing)return;
  const button=$('#reader-open');button.disabled=true;navigating=true;
  try{
    const space=await api('/api/workspaces/choose',{method:'POST'});if(space.cancelled)return;
    await window.LexiVaultSpace?.select(space);
    try{localStorage.setItem('lexivault.active-workspace.changed',Date.now()+':'+space.id);}catch{}
    $('#reader-import-dialog').close();await loadWorkspace(space);
  }finally{button.disabled=false;navigating=false;}
}));
$('#reader-files').addEventListener('change', action(async event => {
  if (!workspace || !await canLeave()) return;
  const files = [...event.target.files], identity = workspace.id, path = base(), directory = $('#reader-import-folder').value;
  const supplement = active?.fulltext_status === 'metadata_only' ? active.id : null;
  if (supplement && files.length > 1) { event.target.value = ''; throw new Error('为当前文献补充全文时，请一次选择一份 PDF。'); }
  event.target.disabled = true;importing=true;$('#reader-import-dialog').close();$('#reader-import-status').hidden=false;
  let last;
  try {
    for (const [index, file] of files.entries()) {
      if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MiB。`);
      $('#reader-import-status').textContent = `正在导入 ${index + 1}/${files.length}：${file.name}`;
      const form = new FormData(); form.append('file', file);form.append('directory',directory);
      if (supplement) form.append('document_id', supplement);
      last = await api(`${path}/imports`, { method: 'POST', body: form });
      $('#reader-import-status').textContent = `${file.name}：${last.duplicate ? '已存在，未重复导入' : '已保存 PDF 原件'}`;
    }
  } finally {
    event.target.value = ''; event.target.disabled = false;importing=false;
    if (workspace?.id === identity) { await refreshDocuments(); if (last) await openDocument(last); }
  }
}));
$('#reader-import-folder').addEventListener('change',event=>{selectFolder(event.target.value);drawList();});
$('#reader-link-note').addEventListener('click',action(async()=>{
  if(!active || !await canLeave())return;
  const path=$('#reader-existing-note').value;if(!path)throw new Error('请先选择已有笔记。');
  const note=await api(`${base()}/files/documents/${active.id}/note`,{method:'POST',body:JSON.stringify({path})});setNote(note);
}));
noteInput.addEventListener('input', noteEdited);
$('#reader-save').addEventListener('click', () => void flush());
$('#reader-edit-tab').addEventListener('click', () => setPreview(false));
$('#reader-preview-tab').addEventListener('click', () => setPreview(true));
document.querySelectorAll('[data-note-format]').forEach(button => button.addEventListener('click', () => {
  const selected = noteInput.value.slice(noteInput.selectionStart, noteInput.selectionEnd);
  insertText(({ heading: `\n## ${selected || '标题'}\n`, bold: `**${selected || '重点'}**`, highlight: `==${selected || '重点'}==`, list: `\n- ${selected || '内容'}\n` })[button.dataset.noteFormat]);
}));
$('#reader-cite').addEventListener('click', () => { if (active && pdf) insertText(` ${citation()} `); else alert('请先打开 PDF 原文。'); });
textLayer.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch' || event.button !== 0) return;
  const { clientX: x, clientY: y, pointerId } = event;
  textDrag = { x, y, pointerId, caret: pdfCaret(x, y) };
  dismissAnnotationButton();
});
for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, event => {
  if (!textDrag || textDrag.pointerId !== event.pointerId) return;
  const drag = textDrag;
  textDrag = null;
  const { clientX: x, clientY: y } = event;
  requestAnimationFrame(() => {
    const selection = window.getSelection();
    // Some browsers leave selections across the PDF's positioned text spans collapsed.
    if (type === 'pointerup' && !textDrag && selection?.isCollapsed && drag.caret &&
        textLayer.contains(drag.caret.node) && Math.hypot(x - drag.x, y - drag.y) > 4) {
      const end = pdfCaret(x, y);
      if (end) selection.setBaseAndExtent(drag.caret.node, drag.caret.offset, end.node, end.offset);
    }
    updateAnnotationButton(); scheduleFit();
  });
});
document.addEventListener('selectionchange', () => {
  const wasSelected = !!selectedPassage;
  updateAnnotationButton();
  if (wasSelected && !selectedPassage) scheduleFit();
});
pdfScroll.addEventListener('scroll', updateAnnotationButton, { passive: true });
annotationButton.addEventListener('pointerdown', event => event.preventDefault());
annotationButton.addEventListener('click', addSelectionAnnotation);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !annotationButton.hidden) {
    dismissAnnotationButton(); window.getSelection()?.removeAllRanges(); scheduleFit();
  }
});
$('#reader-excerpt').addEventListener('mousedown', event => event.preventDefault());
$('#reader-excerpt').addEventListener('click', () => {
  const selection = window.getSelection(), layer = $('#reader-text-layer');
  if (!pdf || !selection?.rangeCount || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode) || !selection.toString().trim()) { alert('请先在中间 PDF 页面中选中文字；扫描图片暂不能摘录。'); return; }
  const quote = selection.toString().trim().slice(0, 30000).split('\n').map(line => `> ${line}`).join('\n');
  insertText(`\n${quote}\n\n${citation()}\n`);
});
$('#reader-citations').addEventListener('click', action(followCitation)); $('#reader-note-preview').addEventListener('click', action(followCitation));
$('#reader-prev').addEventListener('click', () => { if (pdf && pageNumber > 1) { pageNumber--; void renderPage(); } });
$('#reader-next').addEventListener('click', () => { if (pdf && pageNumber < pdf.numPages) { pageNumber++; void renderPage(); } });
$('#reader-page').addEventListener('change', () => { const value = Number($('#reader-page').value); if (pdf && Number.isInteger(value) && value >= 1 && value <= pdf.numPages) { pageNumber = value; void renderPage(); } else updatePdfTools(); });
for (const [id, delta] of [['reader-zoom-in', .15], ['reader-zoom-out', -.15]]) $(`#${id}`).addEventListener('click', () => { if (!pdf) return; scale = Math.max(.25, Math.min(3, (scale || parseInt($('#reader-zoom').textContent) / 100 || 1) + delta)); void renderPage(); });
$('#reader-fit').addEventListener('click', () => { scale = null; void renderPage(); });
$('#reader-export-draft').addEventListener('click', exportDraft);
$('#reader-reload').addEventListener('click', action(async () => {
  if (dirty && !confirm('载入本地版本会放弃当前编辑器草稿。建议先保存副本或下载草稿，是否继续？')) return;
  const note = await api(`${docBase()}/note`); setNote(note);
  if (note.missing) {
    if (confirm('本地笔记已删除，是否重新创建空白笔记？')) { blocked = false; dirty = true; await flush(); }
  }
  rememberDraft();
}));
$('#reader-keep-copy').addEventListener('click', action(async () => {
  const copy = await api(`${docBase()}/conflicts`, { method: 'POST', body: JSON.stringify({ markdown: noteInput.value, expected_revision: revision }) });
  const note = await api(`${docBase()}/note`); setNote(note); rememberDraft(); alert(`草稿副本已保存：${copy.path}`);
}));
$('#reader-history').addEventListener('click', action(async () => {
  const history = await api(`${docBase()}/history`), target = $('#reader-history-list'); target.replaceChildren();
  historyMarkdown = null; $('#reader-history-use').disabled = true; $('#reader-history-text').value = '';
  if (!history.length) target.textContent = '暂无历史快照。笔记发生修改后，之前的保存版本会出现在这里。';
  for (const version of history) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'reader-history-item';
    button.textContent = new Date(version.modified_at * 1000).toLocaleString();
    button.addEventListener('click', action(async () => {
      historyMarkdown = (await api(`${docBase()}/history/${version.id}`)).markdown;
      $('#reader-history-text').value = historyMarkdown; $('#reader-history-use').disabled = false;
    }));target.append(button);
  }
  $('#reader-history-dialog').showModal();
}));
$('#reader-history-use').addEventListener('click', () => {
  if (historyMarkdown === null || (dirty && !confirm('要用历史版本替换当前草稿吗？'))) return;
  noteInput.value = historyMarkdown; noteEdited(); $('#reader-history-dialog').close();
});
window.addEventListener('beforeunload', event => { if (dirty) { rememberDraft(); event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(reconnect); clearInterval(refreshTimer); socket?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; connectEvents(); } });
window.addEventListener('focus', () => void syncCurrent());
new ResizeObserver(scheduleFit).observe(pdfScroll);

(async () => {
  try {
    const session=await api('/api/session');token=session.token;
    const currentSpace=window.LexiVaultSpace?await window.LexiVaultSpace.ready:await api('/api/workspace/current');
    window.LexiVaultSpace?.addSwitchGuard?.(async()=>{
      if(navigating||importing||creatingFolder||deletingEntry){alert('请等待当前文件操作完成后再切换工作空间。');return false;}
      return canLeave();
    });
    await loadWorkspace(currentSpace);
    const requestedDocument = new URL(location.href).searchParams.get('document');
    if (requestedDocument) { const item = documents.find(d => d.id === requestedDocument); if (item) await openDocument(item); }
    $('#reader-connection').textContent = workspace ? '本地文件已连接' : '本地服务已连接';
    refreshTimer = setInterval(() => { if (!document.hidden) void syncCurrent(); }, 5000);
  } catch (error) {
    $('#reader-connection').textContent = '需要本地阅读服务';
    alert('阅读页需要后端服务。请在项目根目录运行 backend\\.venv\\Scripts\\python -m backend，再打开服务显示的地址。');
  }
})();
