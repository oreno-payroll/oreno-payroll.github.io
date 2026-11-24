/** Actual shared notification and one-time handoff, synthetic values only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
// Bundle the real modules together, as test-navigation-session.mjs does.
// Native Node TypeScript loading does not resolve extensionless TS imports.
const built=await build({
 stdin:{contents:[
  "export {createAppStatus} from './src/ui/appStatus.ts'",
  "export {rememberNavigationNotice,takeNavigationNotice,navigationFeedback,clearNavigationNotice} from './src/ui/navigationNotice.ts'",
  "export {invalidateAuthSession,authEpoch} from './src/cloud/snapshot.ts'",
 ].join(';'),resolveDir:root,sourcefile:'notification-entry.ts',loader:'ts'},
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {createAppStatus,rememberNavigationNotice,takeNavigationNotice,navigationFeedback,clearNavigationNotice,invalidateAuthSession,authEpoch}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const items=new Map();globalThis.sessionStorage={getItem:k=>items.get(k)??null,setItem:(k,v)=>items.set(k,String(v)),removeItem:k=>items.delete(k)};
const key='payroll-navigation-notice-v1';
const notice={operation:'upload-saved',count:3};
rememberNavigationNotice(notice,authEpoch());
assert.deepEqual(JSON.parse(items.get(key)).notice,notice);
assert.deepEqual(takeNavigationNotice(authEpoch()),notice);
assert.equal(takeNavigationNotice(authEpoch()),null);
rememberNavigationNotice({operation:'edit-saved',privateField:'synthetic-value'},authEpoch());
assert.equal(items.has(key),false,'additional fields must never be stored');
for(const count of [0,31,-1,1.5,NaN,'2']){rememberNavigationNotice({operation:'upload-saved',count},authEpoch());assert.equal(items.has(key),false);}
rememberNavigationNotice({operation:'edit-income-partial'},authEpoch());
assert.equal(takeNavigationNotice('different-epoch'),null);
rememberNavigationNotice(notice,authEpoch());
const stale=JSON.parse(items.get(key));stale.created-=121000;items.set(key,JSON.stringify(stale));
assert.equal(takeNavigationNotice(authEpoch()),null);
items.set(key,'broken');assert.equal(takeNavigationNotice(authEpoch()),null);assert.equal(items.has(key),false);
rememberNavigationNotice(notice,authEpoch());invalidateAuthSession();assert.equal(items.has(key),false);
rememberNavigationNotice({operation:'delete-income-partial'},authEpoch());
assert.equal(navigationFeedback(takeNavigationNotice(authEpoch())).kind,'partial');
assert.match(navigationFeedback({operation:'delete-income-partial'}).message,/再削除は不要/);
assert.equal(navigationFeedback({operation:'edit-year-partial'}).kind,'partial');
rememberNavigationNotice({operation:'delete-original-partial'},authEpoch());
assert.match(navigationFeedback(takeNavigationNotice(authEpoch())).message,/原本の整理は未確認/);
assert.match(navigationFeedback(notice).message,/3件.*Finance/);
rememberNavigationNotice(notice,authEpoch());clearNavigationNotice();assert.equal(items.has(key),false);
console.log('PASS: bounded outcome-only tab handoff, one-time consume, expiry, account invalidation');
class StubElement{
 constructor(){this.hidden=true;this.dataset={};this.textContent='';this.classList={add(){}};this.children=[];this.handlers={};}
 setAttribute(){} removeAttribute(name){if(name==='data-state')delete this.dataset.state;}
 replaceChildren(...children){this.children=children;} addEventListener(event,fn){this.handlers[event]=fn;}
 click(){this.handlers.click?.();}
}
globalThis.document={createElement:()=>new StubElement()};
const el=new StubElement(),status=createAppStatus(el);
assert.equal(createAppStatus(el),status,'auth and page use the same controller');
const [message,dismiss]=el.children;
const timers=[];const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
globalThis.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};globalThis.clearTimeout=()=>{};
try{
 status.loading('保存中');assert.equal(el.dataset.state,'loading');assert.equal(timers.length,0);assert.equal(dismiss.hidden,true);
 status.success('警告という文字があっても成功');assert.equal(el.dataset.state,'success');assert.equal(timers.at(-1).ms,3500);
 const oldTimer=timers.at(-1);status.partial('保存は完了しました。連携未完了');assert.equal(el.dataset.state,'partial');assert.equal(timers.length,1);assert.equal(dismiss.hidden,false);
 oldTimer.fn();assert.equal(el.hidden,false,'stale timer must not hide newer result');
 dismiss.click();assert.equal(el.hidden,true);assert.equal(message.textContent,'');
 status.info('重複しているため新規保存なし');assert.equal(el.dataset.state,'info');
 status.warning('入力を確認してください');assert.equal(el.dataset.state,'warning');assert.equal(timers.at(-1).ms,9000);assert.equal(dismiss.hidden,true);
 const n=timers.length;status.error('処理失敗');assert.equal(el.dataset.state,'error');assert.equal(timers.length,n);assert.equal(dismiss.hidden,false);timers.at(-1).fn();assert.equal(el.hidden,false);dismiss.click();assert.equal(el.hidden,true);
 status.warning('復旧を確認してください',true);assert.equal(timers.length,n);assert.equal(dismiss.hidden,false);dismiss.click();assert.equal(el.hidden,true);
}finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
assert.match(read('src/upload.ts'),/function notice\(kind:Exclude<AppStatusKind,'loading'>,message: string\): void \{\s*appStatus\.show\(kind,message\);/);
assert.match(read('src/edit.ts'),/rememberNavigationNotice\(\{operation:'edit-saved'\},operationEpoch\)/);
assert.match(read('src/year-end-assist.ts'),/if\(result.cleanupPending\)appStatus.partial/);
console.log('PASS: actual toast states, explicit kinds, persistent error/partial, dismissal and timer isolation');
