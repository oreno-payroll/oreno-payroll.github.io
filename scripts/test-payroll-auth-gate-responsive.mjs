/** Microsoft auth-gate responsiveness regression; synthetic promises only, no live MSAL/Graph. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const auth=read('src/cloud/auth.ts'),css=read('public/styles/cloud.css');
const markup=auth.match(/panel\.innerHTML=`([\s\S]*?)`;/)?.[1];
assert.ok(markup,'auth dialog markup is present');
for(const id of ['payroll-cloud-checking','payroll-cloud-check-message','payroll-cloud-check-retry','payroll-cloud-check-reload'])
 assert.match(markup,new RegExp(`id="${id}"`));
assert.ok(markup.indexOf('id="payroll-cloud-checking"')<markup.indexOf('id="payroll-cloud-login-form"'),'checking state appears before the sign-in form');
assert.match(markup,/id="payroll-cloud-checking"[^>]*aria-live="polite"[^>]*hidden/);
assert.match(css,/\.payroll-cloud-checking\[hidden\]\{display:none!important\}/,'hide checking UI only when finished');
assert.match(css,/@media\(prefers-reduced-motion:reduce\)/,'reduced motion accessibility');
assert.match(auth,/ui\.loginForm\.hidden=state==='connected'\|\|state==='checking'/,'legacy sign-in state contract preserved');
assert.match(auth,/const currentCheck=\+\+checkVersion/);
assert.match(auth,/if\(!active\(\)\)return;/,'late completion must not override a manual user choice');
assert.match(auth,/checkSlowTimer=setTimeout\(/,'a slow connection gets an explicit progress update');
assert.match(auth,/ui\.reload\.addEventListener\('click',\(\)=>\{cancelCheck\(\);window\.location\.reload\(\);\}\)/);
const compile=s=>stripTypeScriptTypes(s,{mode:'strip'});
const showStart=auth.indexOf('function showAccount(ui:GateUI,');
const showEnd=auth.indexOf('\nasync function showRememberedOption(',showStart);
assert.ok(showStart>=0&&showEnd>showStart);
const showJs=compile(auth.slice(showStart,showEnd));
const makeUI=()=>{
 const el=()=>({hidden:false,disabled:false,textContent:'',value:'',isConnected:true,focus(){this.focused=true},addEventListener(type,fn){this.listeners??={};this.listeners[type]=fn}});
 return {panel:el(),checking:el(),checkMessage:el(),retry:el(),reload:el(),loginForm:el(),unlockForm:el(),login:el(),button:el(),remembered:el(),password:el(),loginError:el()};
};
const show={};runInNewContext(`${showJs}\nglobalThis.invoke=showAccount`,show);
{
 const ui=makeUI();
 show.invoke(ui,'checking');
 assert.equal(ui.checking.hidden,false);
 assert.equal(ui.loginForm.hidden,true);
 assert.equal(ui.unlockForm.hidden,true);
 assert.match(ui.checkMessage.textContent,/接続状態を確認/);
 show.invoke(ui,'temporary');
 assert.equal(ui.checking.hidden,true);
 assert.equal(ui.loginForm.hidden,false);
 assert.equal(ui.login.textContent,'接続を再確認');
 show.invoke(ui,'connected');
 assert.equal(ui.checking.hidden,true);
 assert.equal(ui.unlockForm.hidden,false);
 assert.equal(ui.loginForm.hidden,true);
}
// Run actual startup logic with synthetic MSAL promises and simulated elapsed time.
const helperStart=auth.indexOf(' let checkVersion=0;');
const helperEnd=auth.indexOf(' ui.settings.hidden=hasClientId;',helperStart);
const startupStart=auth.indexOf(" if(hasClientId) {\n  showAccount(ui,'checking');");
const startupEnd=auth.indexOf('\n return ready;',startupStart);
assert.ok(helperStart>=0&&helperEnd>helperStart&&startupStart>=0&&startupEnd>startupStart);
const startup=`${showJs}\nconst ui=globalThis.fakeUi;const hasClientId=true;\n${compile(auth.slice(helperStart,helperEnd))}\n${compile(auth.slice(startupStart,startupEnd))}`;
async function simulate(mode){
 const ui=makeUI();
 const callbacks=new Map();let msalResolve,msalReject;
 const msal=new Promise((resolve,reject)=>{msalResolve=resolve;msalReject=reject;});
 let loaded=0,reloads=0,remembered=0,errors=[];
 const ctx={fakeUi:ui,Promise,Error,
  getMsal:()=>msal,account:()=>({homeAccountId:'SYNTHETIC'}),token:async()=>{if(mode==='failure')throw new Error('simulated HTTP 503');return 'synthetic-token';},
  showRememberedOption:()=>{remembered++;return Promise.resolve();},
  clearGateError:e=>{e.hidden=true;e.textContent='';},
  showGateError:(e,m)=>{errors.push(m);e.hidden=false;e.textContent=m;},
  MicrosoftSignInRequiredError:class extends Error{},
  setTimeout:(f,ms)=>{assert.equal(ms,7000);callbacks.set(1,f);return 1;},
  clearTimeout:id=>callbacks.delete(id),
  window:{location:{reload:()=>{reloads++;}}},
 };
 runInNewContext(startup,ctx);
 assert.equal(ui.checking.hidden,false,'immediate status visible');
 assert.equal(ui.loginForm.hidden,true);
 assert.ok(callbacks.has(1));
 callbacks.get(1)();
 assert.match(ui.checkMessage.textContent,/時間がかかっています/,'slow MSAL must not leave a logo-only dialog');
 if(mode==='manual'){
  ui.retry.listeners.click();
  assert.equal(ui.checking.hidden,true);
  assert.equal(ui.loginForm.hidden,false,'manual option is visible');
  msalResolve({});
  await new Promise(setImmediate);
  assert.equal(ui.unlockForm.hidden,true,'a late automatic result may not override manual choice');
  assert.equal(remembered,0);
 }else if(mode==='reload'){
  ui.reload.listeners.click();
  assert.equal(reloads,1,'user can reload without resetting credentials');
  msalReject(new Error('synthetic slow MSAL failed'));
  await new Promise(setImmediate);
  assert.equal(ui.unlockForm.hidden,true);
  assert.equal(errors.length,0,'stale failure must not overwrite reload navigation');
 }else{
  msalResolve({});
  await new Promise(setImmediate);
  if(mode==='success'){
   assert.equal(ui.unlockForm.hidden,false,'successful MSAL opens the unlock form');
   assert.equal(ui.checking.hidden,true);
   assert.equal(remembered,1);
  }else{
   assert.equal(ui.loginForm.hidden,false,'failed MSAL reveals recovery action');
   assert.equal(ui.checking.hidden,true);
   assert.match(ui.loginError.textContent,/simulated HTTP 503/);
  }
 }
 assert.equal(loaded,0);
}
for(const scenario of ['manual','reload','success','failure'])await simulate(scenario);
console.log('PASS: immediately visible MSAL status, delayed-help copy, manual recovery/reload, late-result protection, success/error routing');
