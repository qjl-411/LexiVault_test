/* Optional research backend: window.lexivaultWorkspace = {
     models: [{id:'local', label:'本地模型', online:false}],
     ask: async ({question, conversationId, messages, scope, documentIds, modelId, signal}) =>
       ({message:'...', citations:[{documentId:'...'}]})
   }.
   Navigation can be handled by preventing the cancelable lexivault:navigate event.
   This view never invents a live model response or an original-paper excerpt. */
(async () => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const root = document.documentElement;
  const shell = $('#workspace-shell');
  const demoMarkup = $('#conversation').innerHTML;
  const fileHandles = new Map();
  const issuedURLs = new Set();
  let activeRequest = null;
  let busy = false;
  let toastTimer;
  let renameId = null;
  let currentModule = null;
  let editingNoteId = null;
  let requestGeneration = 0;
  const uid = () => window.crypto?.randomUUID?.() || `lv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
  const spaceClient = window.LexiVaultSpace;
  const space = spaceClient ? await spaceClient.ready : null;
  const scopeKey = 'lexivault.assistant.' + (spaceClient?.userId ? spaceClient.userId+'.' : '') + (space?.id || 'unselected');
  let serverVersion = 0, savingState = Promise.resolve(), saveError = false, saveSequence = 0;
  const seedDocuments = [];
  const initialState = () => ({version:1,activeId:null,workspaceName:space?.name || '选择工作空间',scope:'vault',modelId:'local',context:[],documents:[],notes:[],conversations:[]});
  function readSaved() { try { return JSON.parse(localStorage.getItem(scopeKey)); } catch (_) { return null; } }
  function validState(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.conversations) || !Array.isArray(value.documents) || !Array.isArray(value.notes)) return false;
    if (value.conversations.length > 100 || value.documents.length > 1000 || value.notes.length > 500) return false;
    const validId = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
    const validText = (text,max) => typeof text === 'string' && text.length <= max;
    if (['conversations','documents','notes'].some(key=>new Set(value[key].map(item=>item?.id)).size!==value[key].length)) return false;
    return value.conversations.every(c=>c&&validId(c.id)&&validText(c.title,120)&&Array.isArray(c.messages)&&c.messages.length<=150&&c.messages.every(m=>m&&validId(m.id)&&['user','assistant'].includes(m.role)&&validText(m.text,50000)))
      && value.documents.every(d=>d&&validId(d.id)&&validText(d.title,300)&&['example','local'].includes(d.source))
      && value.notes.every(n=>n&&validId(n.id)&&validText(n.title,160)&&validText(n.content,100000));
  }
  function normalize(value) {
    const fallback = initialState();
    if (!validState(value)) return fallback;
    return {
      version:1, activeId:value.conversations.some(c=>c.id===value.activeId)?value.activeId:value.conversations[0]?.id || null,
      workspaceName:typeof value.workspaceName==='string'?value.workspaceName.slice(0,80):fallback.workspaceName,
      scope:value.scope==='selected'?'selected':'vault',modelId:typeof value.modelId==='string'?value.modelId:'local',
      context:[...new Set((Array.isArray(value.context)?value.context:fallback.context).filter(id=>value.documents.some(d=>d.id===id)))].slice(0,30),
      documents:value.documents.map(d=>({id:d.id,title:d.title,shortTitle:typeof d.shortTitle==='string'?d.shortTitle.slice(0,100):d.title,source:d.source,kind:['pdf','md','txt'].includes(d.kind)?d.kind:'pdf',size:Number(d.size)||0,lastModified:Number(d.lastModified)||0,keywords:typeof d.keywords==='string'?d.keywords.slice(0,300):''})),
      notes:value.notes.map(n=>({id:n.id,title:n.title,content:n.content})),
      conversations:value.conversations.map(c=>({id:c.id,title:c.title,demo:c.demo===true&&c.id==='seed-comparison',liked:!!c.liked,messages:c.messages.map(m=>({id:m.id,role:m.role,text:m.text,service:!!m.service,citations:Array.isArray(m.citations)?m.citations.filter(id=>value.documents.some(d=>d.id===id)):[]}))}))
    };
  }
  let state = initialState();
  if (space) {
    try {
      const saved = await spaceClient.request(`/api/workspaces/${space.id}/assistant`);
      serverVersion = saved.version;
      state = normalize({...initialState(),...saved.state});
      const docs = await spaceClient.request(`/api/workspaces/${space.id}/documents`);
      state.documents = docs.map(d=>({id:d.id,title:d.title,shortTitle:d.title,source:'local',kind:'pdf'}));
      state.context = state.context.filter(id=>state.documents.some(d=>d.id===id));
    } catch (error) { saveError=true; toast(error.message); }
  }
  state.workspaceName=space?.name || '选择工作空间';
  const conversation = () => state.conversations.find(c=>c.id===state.activeId);
  function save() {
    if (!space || saveError) { toast(space?'对话未保存，请保留草稿并刷新重试。':'请先在文献阅读页打开工作空间。'); return false; }
    const snapshot=JSON.parse(JSON.stringify(state));
    const sequence=++saveSequence;
    try { localStorage.setItem(scopeKey,JSON.stringify(snapshot)); } catch {}
    savingState=savingState.then(async()=>{
      if(saveError) return;
      try {
        const result=await spaceClient.request(`/api/workspaces/${space.id}/assistant`,{method:'PUT',body:JSON.stringify({expected_version:serverVersion,state:snapshot})});
        serverVersion=result.version;
        if(sequence===saveSequence) { try { localStorage.removeItem(scopeKey); } catch {} }
      } catch(error) { saveError=true; toast(error.message+' 草稿保留在当前浏览器。'); }
    });
    return true;
  }
  spaceClient?.addSwitchGuard?.(async()=>{
    if(busy){toast('请先停止当前回答，再切换工作空间。');return false;}
    if($('#question').value.trim()){toast('输入框还有未发送的问题，请先发送或清空后再切换。');return false;}
    await savingState;
    if(saveError){toast('对话尚未保存，草稿已保留，请处理后再切换工作空间。');return false;}
    return true;
  });
  function toast(text) { clearTimeout(toastTimer); const node=$('#workspace-toast'); node.textContent=text;node.hidden=false;toastTimer=setTimeout(()=>{node.hidden=true;},4200); }
  function el(tag,className,text) {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function icon(name,className='icon') {const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class',className);svg.setAttribute('aria-hidden','true');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href',`#i-${name}`);svg.append(use);return svg;}
  function button(text,className,handler) {const node=el('button',className,text);node.type='button';if(handler)node.addEventListener('click',handler);return node;}
  function scrollBottom() { const node=$('#conversation-scroll'); if(typeof node.scrollTo==='function')node.scrollTo({top:node.scrollHeight,behavior:'smooth'});else node.scrollTop=node.scrollHeight; }

  function setTheme(theme) {window.LexiVaultSidebar.setTheme(theme);}
  function closePopovers(returnFocus=false) {
    $$('.popover').forEach(node=>{node.hidden=true;});
    $$('[aria-expanded="true"]').filter(node=>node.getAttribute('aria-controls')!=='sidebar'&&!node.hasAttribute('data-sidebar-toggle')).forEach(node=>{node.setAttribute('aria-expanded','false');if(returnFocus)node.focus();});
    $$('.history-menu').forEach(node=>node.remove());
  }
  function bindPopover(buttonId,menuId) {
    const trigger=$(`#${buttonId}`), menu=$(`#${menuId}`);
    trigger.addEventListener('click',event=>{event.stopPropagation();const wasHidden=menu.hidden;closePopovers();menu.hidden=!wasHidden;trigger.setAttribute('aria-expanded',String(wasHidden));});
    trigger.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();closePopovers();menu.hidden=false;trigger.setAttribute('aria-expanded','true');menu.querySelector('button,a')?.focus();}});
    menu.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp'].includes(event.key))return;const nodes=[...menu.querySelectorAll('button:not(:disabled),a')];const index=nodes.indexOf(document.activeElement);event.preventDefault();nodes[(index+(event.key==='ArrowDown'?1:-1)+nodes.length)%nodes.length]?.focus();});
  }
  function closeSidebar(returnFocus=false) {window.LexiVaultSidebar.closeMobile(returnFocus);}

  function renderHistory() {
    const list=$('#history-list');list.replaceChildren();
    if(!state.conversations.length)list.append(el('p','lv-history-empty','还没有对话'));
    state.conversations.forEach(item=>{
      const row=el('div',`history-row${item.id===state.activeId?' is-selected':''}`);
      const title=button(item.title,'history-title',()=>selectConversation(item.id));title.dataset.conversation=item.id;title.title=item.title;
      if(item.id===state.activeId)title.setAttribute('aria-current','true');
      const more=button('','history-more icon-button',event=>{event.stopPropagation();historyMenu(item,row,more);});more.dataset.historyMenu=item.id;more.setAttribute('aria-label',`${item.title}的更多选项`);more.setAttribute('aria-expanded','false');more.append(icon('more'));
      row.append(title,more);list.append(row);
    });
  }
  function historyMenu(item,row,trigger) {
    const open=!row.querySelector('.history-menu');closePopovers();if(!open)return;
    trigger.setAttribute('aria-expanded','true');
    const menu=el('div','popover history-menu');
    menu.append(button('重命名','popover-item',()=>{renameId=item.id;$('#rename-input').value=item.title;closePopovers();$('#rename-dialog').showModal();$('#rename-input').focus();}),button('删除对话','popover-item',()=>{
      if(busy&&item.id===state.activeId){toast('请先停止当前回答。');return;}
      state.conversations=state.conversations.filter(c=>c.id!==item.id);
      if(state.activeId===item.id)state.activeId=state.conversations[0]?.id || null;
      // New workspaces stay empty until the user creates a conversation.else{save();renderAll();}
    }));row.append(menu);
  }
  function newConversation(focus=true) {
    if(!space){toast('请先在文献阅读页打开工作空间。');return;}
    if(busy){toast('请先停止当前回答。');return;}
    const item={id:uid(),title:'新对话',demo:false,messages:[],liked:false};
    state.conversations.unshift(item);state.conversations=state.conversations.slice(0,100);state.activeId=item.id;
    $('#question').value='';resizeQuestion();save();renderAll();closeSidebar();if(focus)$('#question').focus();
  }
  function selectConversation(id) {
    if(busy){toast('请先停止当前回答，再切换对话。');return;}
    if(!state.conversations.some(c=>c.id===id))return;state.activeId=id;save();renderAll();closeSidebar();
  }
  function renderContext() {
    const list=$('#context-list');list.replaceChildren();
    state.context.forEach(id=>{
      const doc=state.documents.find(d=>d.id===id);if(!doc)return;
      const chip=el('span','context-chip');chip.dataset.context=id;chip.append(icon('file'),el('span','',doc.shortTitle||doc.title));
      const remove=button('','remove-context icon-button',()=>{state.context=state.context.filter(value=>value!==id);save();renderContext();});remove.dataset.removeContext=id;remove.setAttribute('aria-label',`移除 ${doc.title}`);remove.append(icon('close'));chip.append(remove);list.append(chip);
    });
  }
  function renderConversation() {
    const current=conversation();const container=$('#conversation');container.replaceChildren();
    $('#conversation-title').textContent=current?.title || '新对话';
    if(!current){container.append(el('p','empty-conversation',space?'还没有对话，从一个研究问题开始。':'请先打开或创建工作空间。'));return;}
    if(current.demo)container.innerHTML=demoMarkup; // Constant, authored markup; never model or user input.
    current.messages.forEach(message=>{
      if(message.role==='user'){const node=el('div','message user-message');node.append(el('p','',message.text));container.append(node);return;}
      const article=el('article',`message assistant-message dynamic-message${message.service?' service-message':''}`);article.dataset.messageId=message.id;article.append(icon('logo','assistant-mark'));
      const body=el('div','assistant-body');body.append(el('p','assistant-name','LexiVault'));
      const content=el('div','answer-content',message.text);body.append(content);
      if(message.citations?.length){const citations=el('div','citation-list');message.citations.forEach((id,index)=>{const doc=state.documents.find(d=>d.id===id);if(!doc)return;const chip=button('','citation-chip',()=>showSource(id));chip.append(icon('file'),el('span','',`[${index+1}] ${doc.title}`));citations.append(chip);});body.append(citations);}
      if(!message.service){const actions=el('div','answer-actions');const copy=button('','icon-button',()=>copyAnswer(article));copy.setAttribute('aria-label','复制回答');copy.append(icon('copy'));actions.append(copy);body.append(actions);}
      article.append(body);container.append(article);
    });
    if(!current.demo&&!current.messages.length)container.append(el('p','empty-conversation','从一个研究问题开始。明确资料范围，再把你的疑问交给 LexiVault。'));
    const like=$('[data-like-answer]');if(like)like.setAttribute('aria-pressed',String(current.liked));
  }
  function renderScope() {
    $$('.workspace-name').forEach(node=>{node.textContent=state.workspaceName;});
    $('#scope-label').textContent=state.scope==='selected'?'范围：已选文献':`范围：${state.workspaceName}`;
    $$('[data-scope]').forEach(node=>node.setAttribute('aria-checked',String(node.dataset.scope===state.scope)));
  }
  function modelOptions() {
    const extra=window.lexivaultWorkspace?.models;
    const items=Array.isArray(extra)?extra.filter(m=>typeof m.id==='string'&&typeof m.label==='string').slice(0,20):[];
    return [{id:'local',label:'本地模型',online:false},...items.filter(m=>m.id!=='local')];
  }
  function renderModels() {
    const models=modelOptions();if(!models.some(m=>m.id===state.modelId))state.modelId='local';
    const selected=models.find(m=>m.id===state.modelId);$('#model-label').textContent=selected.label;
    const menu=$('#model-menu');menu.querySelectorAll('[data-model]').forEach(node=>node.remove());
    const hint=$('#model-hint');hint.textContent=typeof window.lexivaultWorkspace?.ask==='function'?'使用当前配置的模型回答':'当前尚未连接模型服务';
    models.forEach(model=>{const item=button('','popover-item',()=>{if(busy){toast('请在当前回答结束后切换模型。');return;}state.modelId=model.id;save();renderModels();closePopovers();});item.dataset.model=model.id;item.setAttribute('role','menuitemradio');item.setAttribute('aria-checked',String(model.id===state.modelId));item.append(el('span','',model.label),icon('check'));menu.insertBefore(item,hint);});
    const mode=$('.local-mode');mode.replaceChildren(el('i','status-dot'),document.createTextNode(selected.online?'在线模式':'本地模式'));
  }
  function renderAll() {renderHistory();renderConversation();renderContext();renderScope();renderModels();}
  function resizeQuestion() {const input=$('#question');input.style.height='';if(input.scrollHeight)input.style.height=`${Math.min(input.scrollHeight,160)}px`;}
  function setBusy(value) {busy=value;$('#composer-form').setAttribute('aria-busy',String(value));$('#send-button').setAttribute('aria-label',value?'停止生成':'发送研究问题');$('#send-button use').setAttribute('href',value?'#i-stop':'#i-up');}
  function stopRequest() {requestGeneration++;activeRequest?.abort();activeRequest=null;setBusy(false);toast('已停止当前请求。');}
  async function sendQuestion(event) {
    event?.preventDefault();if(busy){stopRequest();return;}
    const question=$('#question').value.trim();if(!question){$('#question').focus();toast('先写下你的研究问题。');return;}
    if(state.scope==='selected'&&!state.context.length){toast('请先从文献库选择用于回答的文献。');return;}
    if(!space || saveError){toast('请先打开工作空间，或刷新恢复连接。');return;}
    if(!conversation())newConversation(false);
    const current=conversation();if(!current)return;
    if(current.messages.length>=148){toast('这段对话已较长，请新建对话继续。');return;}
    current.messages.push({id:uid(),role:'user',text:question});
    if(current.title==='新对话')current.title=question.slice(0,22);
    $('#question').value='';resizeQuestion();save();renderHistory();renderConversation();scrollBottom();
    if(typeof window.lexivaultWorkspace?.ask!=='function'){
      current.messages.push({id:uid(),role:'assistant',text:'模型服务尚未连接。连接后可继续研究。',service:true});
      save();renderConversation();scrollBottom();return;
    }
    const controller=new AbortController();activeRequest=controller;const generation=++requestGeneration;let timer;let timedOut=false;
    setBusy(true);
    try {
      const result=await Promise.race([
        Promise.resolve().then(()=>window.lexivaultWorkspace.ask({question,conversationId:current.id,messages:current.messages.filter(m=>!m.service).map(m=>({role:m.role,text:m.text})),scope:state.scope,workspaceName:state.workspaceName,documentIds:state.scope==='selected'?[...state.context]:state.documents.map(d=>d.id),contextDocumentIds:[...state.context],modelId:state.modelId,signal:controller.signal})),
        new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('timeout'));controller.abort();},30000);}),
        new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))
      ]);
      if(generation!==requestGeneration)return;
      const text=typeof result==='string'?result:result?.message;
      if(typeof text!=='string'||!text.trim())throw new Error('empty');
      const citations=Array.isArray(result?.citations)?result.citations.map(c=>c.documentId).filter(id=>state.documents.some(d=>d.id===id)):[];
      current.messages.push({id:uid(),role:'assistant',text:text.slice(0,50000),citations});
    } catch(error) {
      if(generation!==requestGeneration)return;
      current.messages.push({id:uid(),role:'assistant',service:true,text:timedOut?'模型响应超时。问题已保存，可以稍后继续。':'暂时无法完成回答。问题已保存，请检查模型连接后继续。'});
    } finally {
      clearTimeout(timer);if(generation===requestGeneration){activeRequest=null;setBusy(false);save();renderConversation();scrollBottom();}
    }
  }
  async function copyAnswer(article) {
    let text=article.querySelector('.answer-content')?.innerText || article.querySelector('.answer-content')?.textContent || '';
    if(article.classList.contains('demo-answer')){
      const lines=[...article.querySelectorAll('.comparison-table tr')].map(row=>[...row.querySelectorAll('th,td')].map(cell=>cell.textContent.trim()).join('\t'));
      text=[article.querySelector('.answer-content > p').textContent,...lines,article.querySelector('.evidence-note').textContent,...seedDocuments.map((d,i)=>`[${i+1}] ${d.title}`)].join('\n');
    }
    try {
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
      else {const input=el('textarea','sr-only',text);document.body.append(input);input.select();const success=document.execCommand?.('copy');input.remove();if(!success)throw new Error('clipboard');}
      toast('已复制回答。');
    }catch(_){toast('当前浏览器无法自动复制，请选择文本复制。');}
  }

  function documentRow(doc) {
    const row=button('','document-row',()=>showSource(doc.id));row.append(icon('file'));
    const text=el('span');text.append(el('span','document-row-title',doc.title),el('span','document-row-meta',doc.source==='example'?'示例条目 · 尚未附原文':fileHandles.has(doc.id)?'本次会话可预览 · 尚未索引':'原文需重新选择 · 已保留条目'));
    row.append(text);return row;
  }
  function documentList(container,query='') {
    container.replaceChildren();const search=query.trim().toLocaleLowerCase();
    const docs=state.documents.filter(d=>`${d.title} ${d.keywords||''}`.toLocaleLowerCase().includes(search));
    if(!docs.length){container.append(el('p','panel-empty','没有找到匹配的文献。'));return;}
    docs.forEach(doc=>{
      const entry=el('div','document-entry');entry.append(documentRow(doc));
      const selected=state.context.includes(doc.id);
      const add=button(selected?'已在研究上下文':'用于当前对话','document-context-action',()=>{if(state.context.length>=30){toast('当前对话最多选择 30 份文献。');return;}state.context.push(doc.id);save();renderContext();documentList(container,query);});add.disabled=selected;entry.append(add);container.append(entry);
    });
  }
  function openModule(name) {
    if(name==='assistant'){closeSidebar();return;}
    const event=new CustomEvent('lexivault:navigate',{detail:{module:name},cancelable:true});
    if(!document.dispatchEvent(event))return;
    closePopovers();closeSidebar();currentModule=name;
    const titles={search:'文献检索',library:'文献库',notes:'阅读笔记',graph:'概念图谱',tasks:'任务中心',settings:'设置'};
    $('#module-title').textContent=titles[name]||'工作空间';
    const body=$('#module-content');body.replaceChildren();
    if(name==='search'){
      body.append(el('p','panel-description','在当前知识库的文献条目中检索。'));
      const label=el('label','sr-only','搜索题名或关键词');label.htmlFor='literature-search';
      const input=el('input','panel-search');input.id='literature-search';input.type='search';input.placeholder='搜索题名或关键词…';
      const list=el('div','document-list');input.addEventListener('input',()=>documentList(list,input.value));body.append(label,input,list);documentList(list);
    }else if(name==='library'){
      body.append(el('p','panel-description','集中管理文献原文与附件。支持 PDF、Markdown 和纯文本。'));
      const actions=el('div','panel-actions');actions.append(button('导入文献','panel-primary',()=>$('#literature-input').click()));body.append(actions);
      const list=el('div','document-list');documentList(list);body.append(list,el('p','quiet-note','当前页面保留文献条目。本次选择的原文可直接预览；刷新后需重新选择文件，全文解析与索引需连接项目服务。'));
    }else if(name==='notes')renderNotes(body);
    else if(name==='graph'){
      const empty=el('div','panel-empty');empty.append(icon('graph'),el('p','','还没有可用的概念关联。'),el('p','quiet-note','文献解析并建立关联后，这里会呈现论文、概念和笔记之间的关系及来源。'));body.append(empty);
    }else if(name==='tasks'){
      body.append(el('p','panel-description','查看已导入材料的后续处理状态。'));
      const docs=state.documents.filter(d=>d.source==='local');
      if(!docs.length)body.append(el('p','panel-empty','当前没有待处理的导入任务。'));
      docs.forEach(doc=>{const row=el('div','task-row');row.append(el('strong','',doc.title),el('p','quiet-note','原文条目已保存 · 等待连接解析与索引服务'));body.append(row);});
    }else if(name==='settings'){
      body.append(el('p','panel-description','管理当前工作空间的模型连接与本地数据。'));
      [['工作空间',state.workspaceName],['模型',modelOptions().find(m=>m.id===state.modelId)?.label||'本地模型'],['模型接口',typeof window.lexivaultWorkspace?.ask==='function'?'已配置':'尚未连接'],['数据位置',space?.path || '尚未打开工作空间']].forEach(([key,value])=>{const row=el('div','settings-line');row.append(el('span','',key),el('span','',value));body.append(row);});
      body.append(el('h3','panel-section-heading','备份与恢复'),el('p','quiet-note','备份包含对话、笔记和文献条目，不包含原文文件。导入时合并内容，保留当前已有记录。'));
      const actions=el('div','panel-actions');actions.append(button('导出工作空间','panel-primary',exportBackup),button('导入备份','panel-secondary',()=>$('#backup-input').click()));body.append(actions);
    }
    if(!$('#module-dialog').open)$('#module-dialog').showModal();
  }
  function renderNotes(body) {
    body.append(el('p','panel-description','记录你对原文的理解，把结论、证据与疑问分开。'));
    if(state.notes.length){const list=el('div','document-list');state.notes.forEach(note=>list.append(button(note.title,'note-list-item',()=>{editingNoteId=note.id;openModule('notes');})));body.append(list);}
    const existing=state.notes.find(n=>n.id===editingNoteId);
    const form=el('form','note-editor');
    const titleLabel=el('label','panel-label','笔记标题');titleLabel.htmlFor='note-title';const title=el('input','panel-input');title.id='note-title';title.maxLength=160;title.placeholder='给这份思考一个名字';title.value=existing?.title||'';
    const contentLabel=el('label','panel-label','笔记内容');contentLabel.htmlFor='note-content';const content=el('textarea','panel-textarea');content.id='note-content';content.maxLength=100000;content.placeholder='作者的主张\n原文证据\n自己的理解\n尚未解决的问题';content.value=existing?.content||'';
    const actions=el('div','panel-actions');const submit=button('保存笔记','panel-primary');submit.type='submit';actions.append(submit,button('新建笔记','panel-secondary',()=>{editingNoteId=null;openModule('notes');}));
    form.append(titleLabel,title,contentLabel,content,actions);
    form.addEventListener('submit',event=>{event.preventDefault();if(!title.value.trim()&&!content.value.trim()){title.focus();return;}const note={id:existing?.id||uid(),title:title.value.trim()||'未命名笔记',content:content.value};if(existing)Object.assign(existing,note);else if(state.notes.length<500)state.notes.unshift(note);else {toast('笔记数量已达当前页面上限，请先导出。');return;}editingNoteId=note.id;if(save())toast('笔记正在保存到当前工作空间。');openModule('notes');});body.append(form);
  }
  async function showSource(id) {
    const doc=state.documents.find(d=>d.id===id);if(!doc)return;
    window.location.href='reader.html?document='+encodeURIComponent(doc.id); return;
    $('#source-title').textContent=doc.title;
    const body=$('#source-content');body.replaceChildren();
    const file=fileHandles.get(id);
    if(!file){body.append(el('span','source-status',doc.source==='example'?'示例引用 · 原文未关联':'原文未关联'),el('p','panel-description',doc.source==='example'?'这条引用用于展示科研对话的排版。当前尚未附上对应原文，不能作为已核验的研究证据。':'已保留文献条目。重新选择对应文件后即可预览原文。'));}
    else if(doc.kind==='pdf'){
      const url=URL.createObjectURL(new Blob([file],{type:'application/pdf'}));issuedURLs.add(url);const frame=el('iframe');frame.src=url;frame.title=doc.title;body.append(frame);
    }else{
      if(file.size>2_000_000){body.append(el('p','quiet-note','此文本较大，请在本地编辑器中打开。'));}
      else {const pre=el('div','source-text','正在读取原文…');body.append(pre);try{pre.textContent=await file.text();}catch(_){pre.textContent='无法读取此文件，请重新选择。';}}
    }
    if(!$('#source-dialog').open)$('#source-dialog').showModal();
    document.dispatchEvent(new CustomEvent('lexivault:open-source',{detail:{documentId:id,document:doc,file:file||null}}));
  }
  function exportBackup() {
    const data=JSON.stringify({format:'LexiVaultWorkspace',exportedAt:new Date().toISOString(),state},null,2);
    const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));const link=el('a');link.href=url;link.download=`LexiVault-workspace-${new Date().toISOString().slice(0,10)}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('工作空间备份已生成。');
  }
  function mergeBackup(value) {
    if(value?.format!=='LexiVaultWorkspace'||!validState(value.state))return false;
    const incoming=normalize(value.state);
    for(const [key,limit] of [['conversations',100],['documents',1000],['notes',500]]){
      const ids=new Set(state[key].map(item=>item.id));state[key]=[...state[key],...incoming[key].filter(item=>!ids.has(item.id))].slice(0,limit);
    }
    save();renderAll();return true;
  }

  $('#new-chat').addEventListener('click',event=>{event.preventDefault();newConversation();});
  $$('button[data-module]').forEach(node=>node.addEventListener('click',()=>openModule(node.dataset.module)));
  $('#settings-button').addEventListener('click',()=>openModule('settings'));
  $('#help-button').addEventListener('click',()=>$('#help-dialog').showModal());
  [['scope-button','scope-menu'],['model-button','model-menu']].forEach(args=>bindPopover(...args));
  $('#current-workspace')?.addEventListener('click',()=>closePopovers());
  $$('[data-scope]').forEach(node=>node.addEventListener('click',()=>{if(busy){toast('请在当前回答结束后调整范围。');return;}state.scope=node.dataset.scope;save();renderScope();closePopovers();}));
  $('#composer-form').addEventListener('submit',sendQuestion);
  $('#question').addEventListener('input',resizeQuestion);
  $('#question').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!busy)sendQuestion();}});
  $('#conversation').addEventListener('click',event=>{
    const source=event.target.closest('[data-source]');if(source){showSource(source.dataset.source);return;}
    const copy=event.target.closest('[data-copy-answer]');if(copy){copyAnswer(copy.closest('.assistant-message'));return;}
    const like=event.target.closest('[data-like-answer]');if(like){const current=conversation();current.liked=!current.liked;like.setAttribute('aria-pressed',String(current.liked));save();}
  });
  $('#rename-form').addEventListener('submit',event=>{event.preventDefault();const item=state.conversations.find(c=>c.id===renameId);const title=$('#rename-input').value.trim();if(item&&title){item.title=title.slice(0,60);save();renderHistory();$('#conversation-title').textContent=conversation()?.title||'新对话';$('#rename-dialog').close();}});
  $$('[data-close-dialog]').forEach(node=>node.addEventListener('click',()=>node.closest('dialog').close()));
  $$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}));
  $('#source-dialog').addEventListener('close',()=>{issuedURLs.forEach(url=>URL.revokeObjectURL(url));issuedURLs.clear();$('#source-content').replaceChildren();});
  document.addEventListener('click',event=>{if(!event.target.closest('.popover-anchor')&&!event.target.closest('.history-more')&&!event.target.closest('.history-menu'))closePopovers();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePopovers(true);if(shell.classList.contains('is-sidebar-open'))closeSidebar(true);}});
  $('#literature-input').addEventListener('change',event=>{toast('请在文献阅读页导入 PDF。');event.target.value='';return;

    const files=[...(event.target.files||[])];let imported=0;
    files.forEach(file=>{const kind=file.name.split('.').pop().toLowerCase();if(!['pdf','md','txt'].includes(kind)||state.documents.length>=1000)return;let doc=state.documents.find(d=>d.source==='local'&&d.title===file.name&&d.size===file.size&&d.lastModified===file.lastModified);if(!doc){doc={id:uid(),title:file.name,shortTitle:file.name,source:'local',kind,size:file.size,lastModified:file.lastModified};state.documents.push(doc);}fileHandles.set(doc.id,file);imported++;});
    event.target.value='';save();if(currentModule==='library')openModule('library');toast(imported?'原文已可预览。全文解析与索引等待连接。':'请选择 PDF、Markdown 或 TXT 文件。');
  });
  $('#backup-input').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>10_000_000)throw new Error('size');const value=JSON.parse(await file.text());if(!mergeBackup(value))throw new Error('format');toast('备份内容已合并，原有记录已保留。');if(currentModule==='settings')openModule('settings');}catch(_){toast('无法导入这份备份，请选择有效的 LexiVault 工作空间文件。');}finally{event.target.value='';}});
  window.addEventListener('pagehide',()=>{clearTimeout(toastTimer);activeRequest?.abort();issuedURLs.forEach(url=>URL.revokeObjectURL(url));});
  // New workspaces stay empty until the user creates a conversation.
  setTheme(root.dataset.theme);renderAll();
  const recovery=readSaved();
  if(space && !saveError && validState(recovery)) {
    const bar=el('div','quiet-note','检测到此工作空间有尚未保存的浏览器草稿。');
    const recover=button('合并恢复草稿','panel-secondary',()=>{
      for(const incoming of normalize(recovery).conversations){
        const existing=state.conversations.find(c=>c.id===incoming.id);
        if(existing){const ids=new Set(existing.messages.map(m=>m.id));existing.messages.push(...incoming.messages.filter(m=>!ids.has(m.id)));}
        else if(state.conversations.length<100)state.conversations.push(incoming);
      }
      if(!state.activeId)state.activeId=state.conversations[0]?.id || null;
      save();renderAll();bar.remove();
    });
    bar.append(recover);$('#conversation').before(bar);
  }
  // A common sidebar action can enter a new or previously saved conversation.
  try {if(window.location?.href){const url=new URL(window.location.href);if(url.searchParams.get('new')==='1'){newConversation(false);url.searchParams.delete('new');window.history?.replaceState(null,'',url);}else if(url.searchParams.has('chat'))selectConversation(url.searchParams.get('chat'));}}catch(_){}
})();
