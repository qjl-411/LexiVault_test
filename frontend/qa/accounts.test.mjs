import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const script = fs.readFileSync(new URL('../src/account-client.js',import.meta.url),'utf8');

async function until(predicate) {
  for (let i=0;i<100;i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
  assert.fail('Account UI did not finish');
}

function fixture(t, {businessPage=false, signedIn=false}={}) {
  const dom = new JSDOM('<button id="account-button"><span class="lv-avatar"></span><span class="lv-account-copy"></span></button><div id="account-menu"></div>',{url:'http://localhost/'+(businessPage?'reader.html':'index.html'),runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const w=dom.window, calls=[];
  w.Headers=Headers;
  let logged=signedIn, lastSettings={theme:'dark',font_size:18};
  w.fetch=async(url,options={})=>{
    calls.push({url,options});
    let data;
    if(url==='/api/session') data={token:'local-csrf-token'};
    else if(url==='/api/auth/register') data={user:{id:'user'}};
    else if(url==='/api/auth/email-code') data={accepted:true};
    else if(url==='/api/auth/password-reset/confirm') { logged=false; data={password_reset:true}; }
    else if(url==='/api/auth/login') { logged=true; data={user:{id:'user'},csrf_token:'account-csrf-token'}; }
    else if(url==='/api/auth/logout') { logged=false; data={signed_out:true}; }
    else if(url==='/api/auth/me') data=logged?{user:{id:'user',email:'student@example.com',nickname:'<img src=x>'},csrf_token:'account-csrf-token',settings:lastSettings}:{user:null};
    else if(url==='/api/auth/settings') { lastSettings={...lastSettings,...JSON.parse(options.body)}; data=lastSettings; }
    else if(url==='/api/auth/password-reset') return {ok:false,status:503,async json(){return {code:'mailUnavailable',message:'邮件尚未配置'};}};
    else if(url==='/api/workspaces')data=[];
    else throw new Error('Unexpected '+url);
    return {ok:true,status:200,async json(){return data;}};
  };
  w.eval(script);
  return {w,calls,setLogged(value){logged=value;}};
}

test('account adapter sends only credentials to same-origin endpoints and never persists secrets',async t=>{
  const {w,calls}=fixture(t);
  await w.lexivaultAuth.requestEmailCode({email:'student@example.com',purpose:'register'});
  await w.lexivaultAuth.signUp({email:'student@example.com',password:'TestingPassword2026',code:'0042'});
  const result=await w.lexivaultAuth.signIn({email:'student@example.com',password:'TestingPassword2026',remember:true,untrusted:'extra'});
  assert.equal(result.redirectTo,'./home.html');
  const login=calls.find(call=>call.url==='/api/auth/login');
  assert.deepEqual(JSON.parse(login.options.body),{email:'student@example.com',password:'TestingPassword2026',remember:true});
  assert.equal(login.options.headers['X-LexiVault-Token'],'local-csrf-token');
  assert.equal(login.options.credentials,'same-origin');
  assert.equal(JSON.parse(calls.find(call=>call.url==='/api/auth/register').options.body).code,'0042');
  await w.lexivaultAuth.confirmPasswordReset({email:'student@example.com',password:'NewPassword2026',code:'0007'});
  assert.equal(JSON.parse(calls.find(call=>call.url==='/api/auth/password-reset/confirm').options.body).code,'0007');
  const storage=JSON.stringify({...w.localStorage,...w.sessionStorage});
  assert.doesNotMatch(storage,/TestingPassword2026|NewPassword2026|0042|0007|local-csrf-token|account-csrf-token/);
  assert.ok(calls.every(call=>call.url.startsWith('/api/')));
});

test('account menu safely displays the real identity, restores preferences and logs out with CSRF',async t=>{
  const {w,calls}=fixture(t);
  await w.lexivaultAuth.signIn({email:'student@example.com',password:'TestingPassword2026'});
  w.document.dispatchEvent(new w.CustomEvent('lexivault:authenticated'));
  await until(()=>w.document.querySelector('#account-button').textContent.includes('<img src=x>'));
  assert.equal(w.document.querySelector('#account-button img'),null);
  assert.match(w.document.querySelector('#account-button').textContent,/<img src=x>/);
  assert.equal(w.document.documentElement.dataset.theme,'dark');
  assert.equal(w.document.documentElement.style.getPropertyValue('--reader-note-font-size'),'18px');
  assert.doesNotMatch(w.document.querySelector('#account-menu').textContent,/迁移/);
  assert.deepEqual([...w.document.querySelectorAll('#account-menu button')].map(button=>button.textContent),['退出账号']);
  await w.lexivaultAuth.signOut();
  assert.equal(calls.find(call=>call.url==='/api/auth/logout').options.headers['X-Account-CSRF'],'account-csrf-token');
  assert.match(w.document.querySelector('#account-menu').textContent,/未登录/);
  await assert.rejects(()=>w.lexivaultAuth.requestPasswordReset({email:'student@example.com'}),error=>error.code==='mailUnavailable');
});

test('business requests pin the account and refuse stale page headers',async t=>{
  const {w,calls}=fixture(t,{businessPage:true,signedIn:true});
  await w.lexivaultAuth.ready;
  await w.fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(calls.at(-1).options.headers.get('X-LexiVault-User'),'user');
  const count=calls.length;
  await assert.rejects(w.fetch('/api/workspaces',{headers:{'X-LexiVault-User':'previous-user'}}),/账号已切换/);
  assert.equal(calls.length,count);
  assert.equal(w.lexivaultAuth.locked,true);
  assert.equal(w.document.body.hidden,true);
});

test('other-tab account changes immediately lock old content and prevent writes',async t=>{
  const {w,calls}=fixture(t,{businessPage:true,signedIn:true});await w.lexivaultAuth.ready;
  w.dispatchEvent(new w.StorageEvent('storage',{key:'lexivault.account.changed',newValue:'changed'}));
  const count=calls.length;
  await assert.rejects(w.fetch('/api/workspaces',{method:'POST',body:'{}'}),/请先登录/);
  assert.equal(calls.length,count);assert.equal(w.document.body.hidden,true);
});

test('logout waits for unsaved work and keeps the session when its guard refuses',async t=>{
  const {w,calls}=fixture(t,{signedIn:true});await w.lexivaultAuth.ready;
  w.LexiVaultSpace={canLeave:async()=>false};
  assert.equal(await w.lexivaultAuth.signOut(),false);
  assert.equal(calls.some(c=>c.url==='/api/auth/logout'),false);
  assert.equal(w.lexivaultAuth.userId,'user');
});
