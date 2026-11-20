import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const script=fs.readFileSync(new URL('../src/workspace-client.js',import.meta.url),'utf8');
async function setup(t){
 const dom=new JSDOM(fs.readFileSync(new URL('../dist/knowledge.html',import.meta.url),'utf8'),{url:'http://localhost/knowledge.html',runScripts:'outside-only'}),w=dom.window;
 t.after(()=>w.close());w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const spaces=[{id:'a',name:'当前课题',path:'D:/A'},{id:'b',name:'已有空间 <script>',path:'D:/B'}],calls=[];let current=spaces[0],fail=false,cancelCreate=false,choice={id:'opened',name:'磁盘上的工作空间',path:'D:/Existing'};
 w.fetch=async(path,options={})=>{
  calls.push({path,options});let data;
  if(path==='/api/session')data={token:'test-token',data_dir:'D:/Local'};
  else if(path==='/api/workspace/current')data=current;
  else if(path.endsWith('/assistant'))data={state:{conversations:[]}};
  else if(path==='/api/workspaces' && !options.method)data=structuredClone(spaces);
  else if(fail)return {ok:false,status:500,json:async()=>({message:'磁盘不可写'})};
  else if(path==='/api/workspaces/choose'){data=choice;if(!choice.cancelled){current=choice;if(!spaces.some(s=>s.id===choice.id))spaces.push(choice);}}
  else if(path.endsWith('/open'))data=current=spaces.find(s=>s.id===path.split('/').at(-2));
  else if(path==='/api/workspaces'){
   if(cancelCreate)data={cancelled:true};
   else{const {name}=JSON.parse(options.body);data=current={id:'new',name,path:'E:/科研资料/'+name};spaces.push(data);}
  }
  else throw new Error('Unexpected request '+path);
  return {ok:true,json:async()=>structuredClone(data)};
 };
 w.eval(script);await w.LexiVaultSpace.ready;
 return {w,d:w.document,api:w.LexiVaultSpace,calls,spaces,setFail(value){fail=value;},setChoice(value){choice=value;},cancelCreation(){cancelCreate=true;}};
}
test('picker lists registered spaces safely, marks current, and ends with create action',async t=>{
 const {d}=await setup(t);assert.equal(d.querySelectorAll('[data-workspace-id]').length,2);assert.equal(d.querySelector('[data-workspace-id=a]').getAttribute('aria-pressed'),'true');
 assert.equal(d.querySelector('[data-workspace-id=b] script'),null);assert.match(d.querySelector('[data-workspace-id=b]').textContent,/<script>/);
 assert.equal(d.querySelector('#workspace-menu').lastElementChild.id,'new-workspace');assert.equal(d.querySelector('#workspace-menu a'),null);
 assert.equal(d.querySelector('#open-workspace').textContent,'打开工作空间');assert.equal(d.querySelector('#open-workspace').nextElementSibling.id,'new-workspace');
 d.querySelector('#new-workspace').click();assert.equal(d.querySelector('#sidebar-workspace-dialog').open,true);assert.equal(d.activeElement.id,'sidebar-space-name');assert.match(d.querySelector('#sidebar-space-location').textContent,/选择的位置下新建同名文件夹/);
 assert.equal(d.querySelector('#sidebar-space-submit').textContent,'选择保存位置');
});
test('switch waits for page guard before opening space and persists shared selection',async t=>{
 const {api,calls,d,w}=await setup(t);let saved=false;api.addSwitchGuard(async()=>{await Promise.resolve();saved=true;return true;});
 const space=await api.switchTo('b',{navigate:false});assert.ok(saved);assert.equal(space.id,'b');assert.equal(api.current.id,'b');assert.equal(d.querySelector('#workspace-selector [data-workspace-name]').textContent,'已有空间 <script>');
 const open=calls.find(c=>c.path==='/api/workspaces/b/open');assert.equal(open.options.method,'POST');assert.equal(open.options.headers['X-LexiVault-Token'],'test-token');assert.match(w.localStorage.getItem('lexivault.active-workspace.changed'),/:b$/);
 const before=calls.length;await api.switchTo('b',{navigate:false});assert.equal(calls.length,before);
});
test('failed save prevents switching, creating and opening a workspace',async t=>{
 const {api,calls,d}=await setup(t);const remove=api.addSwitchGuard(()=>false);
 assert.equal(await api.switchTo('b',{navigate:false}),null);assert.equal(await api.create('新课题',{navigate:false}),null);assert.equal(await api.open({navigate:false}),null);assert.equal(api.current.id,'a');assert.equal(calls.filter(c=>c.options.method==='POST').length,0);assert.match(d.querySelector('#workspace-menu-status').textContent,/尚未处理/);
 remove();assert.equal((await api.switchTo('b',{navigate:false})).id,'b');
});
test('opening a directory waits for saving and shares the opened workspace across pages',async t=>{
 const {api,calls,d,w}=await setup(t);let saved=false,changed;
 api.addSwitchGuard(async()=>{await Promise.resolve();saved=true;return true;});
 w.addEventListener('lexivault:workspace-changed',event=>{changed=event.detail;});
 const space=await api.open({navigate:false});assert.ok(saved);assert.equal(space.id,'opened');assert.equal(api.current.id,'opened');assert.equal(changed.id,'opened');
 const request=calls.find(c=>c.path==='/api/workspaces/choose');assert.equal(request.options.method,'POST');assert.equal(request.options.headers['X-LexiVault-Token'],'test-token');
 assert.equal(d.querySelector('[data-workspace-id=opened]').getAttribute('aria-pressed'),'true');assert.match(w.localStorage.getItem('lexivault.active-workspace.changed'),/:opened$/);
 assert.equal(d.querySelector('#open-workspace').disabled,false);
});
test('cancelling the folder picker preserves the current workspace and sends no change event',async t=>{
 const {api,d,w,setChoice}=await setup(t);setChoice({cancelled:true});let changes=0;w.addEventListener('lexivault:workspace-changed',()=>changes++);
 d.querySelector('#workspace-menu').hidden=false;
 assert.equal(await api.open({navigate:false}),null);assert.equal(api.current.id,'a');assert.equal(changes,0);assert.equal(w.localStorage.getItem('lexivault.active-workspace.changed'),null);
 assert.equal(d.querySelector('#workspace-menu').hidden,false);assert.equal(d.querySelector('#open-workspace').disabled,false);
});
test('open menu action reports a folder-picker error and preserves the original selection',async t=>{
 const {api,d,setFail}=await setup(t);setFail(true);d.querySelector('#open-workspace').click();
 for(let i=0;i<40&&d.querySelector('#workspace-menu-status').hidden;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.match(d.querySelector('#workspace-menu-status').textContent,/磁盘不可写/);assert.equal(api.current.id,'a');assert.equal(d.querySelector('#open-workspace').disabled,false);
});
test('create registers and opens the new workspace, errors preserve original selection',async t=>{
 const ui=await setup(t);ui.setFail(true);await assert.rejects(ui.api.create('新空间',{navigate:false}),/磁盘不可写/);assert.equal(ui.api.current.id,'a');assert.equal(ui.d.querySelector('#new-workspace').disabled,false);
 ui.setFail(false);const space=await ui.api.create(' 新空间 ',{navigate:false});assert.equal(space.name,'新空间');assert.equal(ui.api.current.id,'new');assert.ok(ui.d.querySelector('[data-workspace-id=new]'));assert.equal(ui.d.querySelector('[data-workspace-id=new]').getAttribute('aria-pressed'),'true');
 assert.equal(space.path,'E:/科研资料/新空间');assert.equal(ui.calls.filter(c=>c.options.method==='POST').at(-1).path,'/api/workspaces');
});
test('cancelling the creation location leaves the name dialog and current workspace in place',async t=>{
 const {api,d,w,cancelCreation}=await setup(t);cancelCreation();
 d.querySelector('#new-workspace').click();
 const name=d.querySelector('#sidebar-space-name');name.value='保留的名称';
 d.querySelector('#sidebar-space-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 for(let i=0;i<40&&name.disabled;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(name.disabled,false);assert.equal(name.value,'保留的名称');
 assert.equal(d.querySelector('#sidebar-workspace-dialog').open,true);
 assert.equal(d.querySelector('#sidebar-space-error').hidden,true);assert.equal(api.current.id,'a');
});
