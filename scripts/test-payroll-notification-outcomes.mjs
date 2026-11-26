/** Actual shared notification and one-time handoff, synthetic values only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAppStatus} from '../src/ui/appStatus.ts';
import {rememberNavigationNotice,takeNavigationNotice,navigationFeedback,clearNavigationNotice} from '../src/ui/navigationNotice.ts';
import {invalidateAuthSession,authEpoch} from '../src/cloud/snapshot.ts';
import {activateNotificationHistory,notificationHistory,recordNotification,confirmNotificationHistory,resetNotificationHistory,NOTICE_HISTORY_KEY} from '../src/ui/notificationHistory.ts';
const items=new Map();globalThis.sessionStorage={getItem:k=>items.get(k)??null,setItem:(k,v)=>items.set(k,String(v)),removeItem:k=>items.delete(k)};
const local=new Map();globalThis.localStorage={getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
const key='payroll-navigation-notice-v1';
activateNotificationHistory(()=>true);
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
rememberNavigationNotice(notice,authEpoch());invalidateAuthSession();assert.equal(items.has(key),false);assert.equal(items.has(NOTICE_HISTORY_KEY),false);activateNotificationHistory(()=>true);
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
 status.loading('保存中');assert.equal(el.dataset.state,'loading');assert.equal(timers.length,0);assert.equal(dismiss.hidden,false);
 dismiss.click();assert.equal(el.hidden,true);status.loading('進捗更新');assert.equal(el.hidden,true);
 status.success('警告という文字があっても成功');assert.equal(el.hidden,false);assert.equal(el.dataset.state,'success');assert.equal(timers.at(-1).ms,3500);
 const oldTimer=timers.at(-1);status.partial('保存は完了しました。連携未完了');assert.equal(el.dataset.state,'partial');assert.equal(timers.length,1);assert.equal(dismiss.hidden,false);
 oldTimer.fn();assert.equal(el.hidden,false,'stale timer must not hide newer result');
 dismiss.click();assert.equal(el.hidden,true);assert.equal(message.textContent,'');
 status.info('重複しているため新規保存なし');assert.equal(el.dataset.state,'info');
 status.warning('入力を確認してください');assert.equal(el.dataset.state,'warning');assert.equal(timers.at(-1).ms,9000);assert.equal(dismiss.hidden,false);
 const n=timers.length;status.error('処理失敗');assert.equal(el.dataset.state,'error');assert.equal(timers.length,n);assert.equal(dismiss.hidden,false);timers.at(-1).fn();assert.equal(el.hidden,false);dismiss.click();assert.equal(el.hidden,true);
 status.warning('復旧を確認してください',true);assert.equal(timers.length,n);assert.equal(dismiss.hidden,false);dismiss.click();assert.equal(el.hidden,true);
}finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
assert.match(read('src/upload.ts'),/function notice\(kind:Exclude<AppStatusKind,'loading'>,message: string\): void \{\s*appStatus\.show\(kind,message\);/);
assert.match(read('src/edit.ts'),/rememberNavigationNotice\(\{operation:'edit-saved'\},operationEpoch\)/);
assert.match(read('src/year-end-assist.ts'),/appStatus.show\('success',result.cleanupPending\?/);
console.log('PASS: actual toast states, explicit kinds, persistent error/partial, dismissal and timer isolation');
// Protected outcomes, explicit retry identities and history limits.
resetNotificationHistory();activateNotificationHistory(()=>true);
const protectedStatus=createAppStatus(new StubElement(),'settings');const protectedEl=protectedStatus.element;
const [protectedMessage,close]=protectedEl.children;
const scope=protectedStatus.begin('payroll-income-publish','same-target');
protectedStatus.show('partial','Synthetic partial',false,{scope});
const other=protectedStatus.begin('pdf-zip');
protectedStatus.show('loading','Synthetic loading',false,{scope:other});protectedStatus.info('Synthetic info');
protectedStatus.show('success','Synthetic unrelated success',false,{scope:other});protectedStatus.warning('Synthetic warning');protectedStatus.clear();
assert.equal(protectedMessage.textContent,'Synthetic partial');
assert.deepEqual(notificationHistory().entries.map(x=>x.kind),['warning','success','partial']);
protectedStatus.show('success','duplicate result',false,{scope:other});assert.equal(notificationHistory().entries.length,3);
const second=protectedStatus.begin('export-button');protectedStatus.show('error','Synthetic error',false,{scope:second});
assert.equal(protectedMessage.textContent,'Synthetic partial');close.click();assert.equal(protectedMessage.textContent,'Synthetic error');
assert.equal(notificationHistory().entries.filter(x=>!x.seen).length,3);close.click();assert.equal(protectedEl.hidden,true);
const fail=protectedStatus.begin('payroll-income-publish','same-target');protectedStatus.show('error','Synthetic failure',false,{scope:fail});
const different=protectedStatus.begin('payroll-income-publish','different-target');protectedStatus.show('success','Other target',false,{scope:different});assert.equal(protectedEl.dataset.state,'error');
const retry=protectedStatus.begin('payroll-income-publish','same-target');protectedStatus.show('success','Verified retry',false,{scope:retry});assert.equal(protectedEl.dataset.state,'success');assert.equal(notificationHistory().entries.filter(x=>x.kind==='error').length,2);
const progress=protectedStatus.begin('export-button');protectedStatus.show('loading','start',false,{scope:progress});close.click();protectedStatus.show('loading','update',false,{scope:progress});assert.equal(protectedEl.hidden,true);
const independent=protectedStatus.begin('export-button');protectedStatus.show('loading','next',false,{scope:independent});assert.equal(protectedEl.dataset.state,'loading');protectedStatus.clear(independent);
assert.equal(protectedEl.hidden,true);
protectedStatus.show('error','<img src=x onerror=alert(1)> synthetic-private-name'+'@'+'example.invalid');
assert.ok(!items.get(NOTICE_HISTORY_KEY).includes('synthetic-private-name'));assert.ok(!items.get(NOTICE_HISTORY_KEY).includes('<img'));
confirmNotificationHistory();assert.equal(notificationHistory().entries.filter(x=>!x.seen).length,0);assert.equal(protectedEl.dataset.state,'error');
for(let i=0;i<210;i++)recordNotification('general','warning');
assert.equal(notificationHistory().entries.length,200);assert.equal(notificationHistory().entries.every(x=>!x.seen),true);assert.ok(notificationHistory().omitted>=10);
const oldScope=protectedStatus.begin('settings');local.set('payroll-global-vault-lock-epoch-v1',crypto.randomUUID());
assert.equal(notificationHistory().entries.length,0);assert.equal(items.has(NOTICE_HISTORY_KEY),false);assert.equal(protectedEl.hidden,true);
protectedStatus.show('error','late old result',false,{scope:oldScope});assert.equal(protectedEl.hidden,true);
activateNotificationHistory(()=>true);protectedStatus.show('success','late old result',false,{scope:oldScope});assert.equal(notificationHistory().entries.length,0);
recordNotification('settings','success');const savedHistory=items.get(NOTICE_HISTORY_KEY);
const fresh=await import('../src/ui/notificationHistory.ts?reload=1');assert.equal(fresh.notificationHistory().entries.length,0);fresh.activateNotificationHistory(()=>true);assert.equal(fresh.notificationHistory().entries.length,1);
items.set(NOTICE_HISTORY_KEY,savedHistory.replace('settings','arbitrary-private-string'));const corrupt=await import('../src/ui/notificationHistory.ts?reload=2');corrupt.activateNotificationHistory(()=>true);assert.equal(corrupt.notificationHistory().entries.length,0);
items.set(NOTICE_HISTORY_KEY,savedHistory);local.set('payroll-global-vault-lock-epoch-v1',crypto.randomUUID());const switched=await import('../src/ui/notificationHistory.ts?reload=3');switched.activateNotificationHistory(()=>true);assert.equal(switched.notificationHistory().entries.length,0);
const oldStorage=globalThis.sessionStorage;globalThis.sessionStorage={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
const memory=await import('../src/ui/notificationHistory.ts?reload=4');memory.activateNotificationHistory(()=>true);memory.recordNotification('settings','error');assert.equal(memory.notificationHistory().entries.length,1);memory.resetNotificationHistory();assert.equal(memory.notificationHistory().entries.length,0);globalThis.sessionStorage=oldStorage;
console.log('PASS: protected outcomes, independent and related retry, no raw storage, confirmation, 200 cap, reload, epoch change, invalid storage, memory fallback');
// A restored BFCache page must reload the same-tab snapshot, not its stale memory.
items.delete(NOTICE_HISTORY_KEY);const win=new EventTarget();win.opener=null;globalThis.window=win;
const cached=await import('../src/ui/notificationHistory.ts?bfcache=1');cached.activateNotificationHistory(()=>true);cached.recordNotification('settings','error');
win.dispatchEvent(new Event('pagehide'));assert.equal(cached.notificationHistory().entries.length,0);cached.recordNotification('settings','success');
const nextPage=await import('../src/ui/notificationHistory.ts?bfcache=2');nextPage.activateNotificationHistory(()=>true);nextPage.recordNotification('edit-saved','success');
const returned=new Event('pageshow');Object.defineProperty(returned,'persisted',{value:true});win.dispatchEvent(returned);assert.equal(cached.notificationHistory().entries.length,2);
win.dispatchEvent(new Event('pagehide'));local.set('payroll-global-vault-lock-epoch-v1',crypto.randomUUID());win.dispatchEvent(returned);assert.equal(cached.notificationHistory().entries.length,0);assert.equal(items.has(NOTICE_HISTORY_KEY),false);
const parent=await import('../src/ui/notificationHistory.ts?opener=1');parent.activateNotificationHistory(()=>true);parent.recordNotification('settings','error');win.opener={};const child=await import('../src/ui/notificationHistory.ts?opener=2');child.activateNotificationHistory(()=>true);assert.equal(child.notificationHistory().entries.length,0);delete globalThis.window;
console.log('PASS: BFCache refresh, stale generation rejection, inherited opener storage discarded');
