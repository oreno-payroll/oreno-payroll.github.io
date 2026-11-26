/** Execute the real dialog controller against a minimal synthetic DOM. Native focus and modal behavior are separately covered by Chromium E2E. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {confirmOperation,showOperationMessage,dismissOperationDialog} from '../src/ui/operationDialog.ts';
let focused,showFails=false;
class NodeStub extends EventTarget {
 constructor(tag){super();this.tag=tag;this.children=[];this.dataset={};this.style={};this.textContent='';this.value='';this.open=false;this.disabled=false;this.parent=null;}
 setAttribute(){}
 append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}
 replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
 get isConnected(){return this===body||Boolean(this.parent?.isConnected);}
 focus(){focused=this;}
 showModal(){if(showFails)throw new Error('synthetic modal unavailable');this.open=true;}
 close(){this.open=false;this.dispatchEvent(new Event('close'));}
 click(){this.dispatchEvent(new Event('click'));}
}
const body=new NodeStub('body'),trigger=new NodeStub('button');body.append(trigger);trigger.focus();
globalThis.HTMLElement=NodeStub;
globalThis.document={body,documentElement:new NodeStub('html'),get activeElement(){return focused;},createElement:tag=>new NodeStub(tag)};
globalThis.window=new EventTarget();
const req={title:'確認',subject:'<synthetic>',details:['影響の説明'],acceptLabel:'実行',tone:'danger'};
const find=(n,fn)=>fn(n)?n:n.children.map(c=>find(c,fn)).find(Boolean);
const dialog=()=>body.children.find(n=>n.tag==='dialog');
const button=label=>find(dialog(),n=>n.tag==='button'&&n.textContent===label);
const yes=()=>true;
let p=confirmOperation(req,yes);
assert.equal(dialog().open,true);assert.equal(focused,button('キャンセル'));
assert.equal(find(dialog(),n=>n.className==='operation-dialog__subject').textContent,'<synthetic>');
assert.equal(await confirmOperation(req,yes),false,'concurrent dialog must not authorize');
button('キャンセル').click();assert.equal(await p,false);assert.equal(dialog(),undefined);assert.equal(focused,trigger);
p=confirmOperation(req,yes);const d=dialog();const stale=button('実行');const esc=new Event('cancel',{cancelable:true});d.dispatchEvent(esc);
assert.equal(esc.defaultPrevented,true);assert.equal(await p,false);stale.click();assert.equal(dialog(),undefined);
p=confirmOperation(req,yes);button('実行').click();assert.equal(await p,true);
p=confirmOperation({...req,requiredText:'整理'},yes);const input=find(dialog(),n=>n.tag==='input');assert.equal(button('実行').disabled,true);
button('実行').click();assert.equal(dialog().open,true);
input.value='整理 ';input.dispatchEvent(new Event('input'));assert.equal(button('実行').disabled,true);
input.value='整理';input.dispatchEvent(new Event('input'));assert.equal(button('実行').disabled,false);button('実行').click();assert.equal(await p,true);assert.equal(input.value,'');
let valid=true;p=confirmOperation(req,()=>valid);valid=false;button('実行').click();assert.equal(await p,false);
assert.equal(await confirmOperation(req,()=>false),false);assert.equal(dialog(),undefined);
p=confirmOperation(req,yes);dismissOperationDialog();assert.equal(await p,false);assert.equal(dialog(),undefined);
p=confirmOperation(req,yes);window.dispatchEvent(new Event('pagehide'));assert.equal(await p,false);
showFails=true;assert.equal(await confirmOperation(req,yes),false);assert.equal(dialog(),undefined);showFails=false;
p=showOperationMessage({...req,acceptLabel:'閉じる'},yes);assert.equal(focused,button('×'));assert.equal(button('キャンセル'),undefined);button('×').click();assert.equal(await p,true);
// Only local statement routes can become links; an invalidated dialog cannot navigate.
let linkValid=true;
p=showOperationMessage({...req,acceptLabel:'閉じる',links:[{label:'<synthetic>',href:'./edit/index.html#id=3&mode=fiscal&year=2026&hintYear=2026'},{label:'blocked',href:'javascript:void(0)'}]},()=>linkValid);
const list=find(dialog(),n=>n.tag==='ul');assert.equal(list.children.length,1);
const link=find(dialog(),n=>n.tag==='a');assert.equal(link.textContent,'<synthetic>');
assert.equal(link.href,'./edit/index.html#id=3&mode=fiscal&year=2026&hintYear=2026');
linkValid=false;const linkClick=new Event('click',{cancelable:true});link.dispatchEvent(linkClick);assert.equal(linkClick.defaultPrevented,true);assert.equal(await p,false);assert.equal(dialog(),undefined);
// The file name and metadata are one native link, with text-only rendering and notes below.
p=showOperationMessage({title:'未入力',details:['未入力の明細：1件'],links:[{label:'<synthetic>.pdf',description:'2026年2月 · 本業 · <synthetic> · 賞与',href:'./edit/index.html#id=3&mode=calendar&year=2026&hintYear=2025'}],afterLinks:['見込みの算出不足：1件'],acceptLabel:'閉じる'},yes);
const structured=find(dialog(),n=>n.tag==='ul');assert.equal(structured.children.length,1);assert.equal(structured.children[0].children.length,1);
const structuredLink=structured.children[0].children[0];assert.equal(structuredLink.tag,'a');assert.equal(structuredLink.href,'./edit/index.html#id=3&mode=calendar&year=2026&hintYear=2025');
assert.equal(find(structuredLink,n=>n.className==='operation-dialog__link-label').textContent,'<synthetic>.pdf');
assert.equal(find(structuredLink,n=>n.className==='operation-dialog__link-description').textContent,'2026年2月 · 本業 · <synthetic> · 賞与');
assert.deepEqual(structured.parent.children.map(n=>n.tag),['p','ul','p']);button('×').click();assert.equal(await p,true);
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
for(const file of ['src/main.ts','src/edit.ts','src/upload.ts'])assert.doesNotMatch(read(file),/window\.(?:confirm|alert)\(/);
assert.match(read('src/main.ts'),/deletionMatches\(\)&&JSON\.stringify\(targets\)===JSON\.stringify\(pendingDeletion\.snapshot\(\)\)/);
assert.match(read('src/main.ts'),/saved\.some\(r=>r\.id===record\.id&&recordSignature\(r\)===recordSignature\(record\)\)/);
assert.match(read('src/edit.ts'),/JSON\.stringify\(applicablePayrollForm\(getValues\(\)\)\)!==JSON\.stringify\(formValues\)/);
assert.match(read('src/upload.ts'),/diagnosticAuthorized=\(\)=>authorized\(\)&&selectedEntry\(\)===entry/);
assert.match(read('src/upload.ts'),/if\(generation!==diagnosticGeneration\)return/);
assert.match(read('src/upload.ts'),/registerDiagnosticClose\(closeDiagnostic\)/);
assert.match(read('src/cloud/auth.ts'),/return \(\)=>tabLocks\.check\(\)&&tabLocks\.epoch\(\)===startEpoch&&authEpoch\(\)===identity&&clientId\(\)===id/);
assert.match(read('src/cloud/snapshot.ts'),/invalidateAuthSession\(\):void \{\s*dismissOperationDialog\(\)/);
// Run the actual authorization-capture function, not an imitation.
const captureSource=read('src/cloud/auth.ts').match(/export function captureOperationAuthorization\(\):\(\)=>boolean \{[\s\S]*?\n\}/)?.[0];
assert.ok(captureSource);
let lock='a',identity='a',client='a',unlocked=true;
const capture=runInNewContext(stripTypeScriptTypes(captureSource.replace('export ',''),{mode:'strip'})+'\ncaptureOperationAuthorization',{
 tabLocks:{epoch:()=>lock,check:()=>unlocked},authEpoch:()=>identity,clientId:()=>client,
});
for(const invalidate of [()=>{lock='b';},()=>{identity='b';},()=>{client='b';},()=>{unlocked=false;}]){
 lock=identity=client='a';unlocked=true;
 const guard=capture();assert.equal(guard(),true);
 p=confirmOperation(req,guard);invalidate();button('実行').click();assert.equal(await p,false);
}
console.log('PASS: shared modal cancellation, exact typed consent, concurrent/invalid consent rejection, cleanup, focus restore, pagehide, caller guards');

// Execute settings' real approval helper and restore handler, not a reimplementation.
const backup=read('src/backup.ts');
const helper=backup.slice(backup.indexOf('async function approveSettings('),backup.indexOf('let loadedDb'));
const restore=backup.slice(backup.indexOf("restoreButton.addEventListener('click'"),backup.indexOf('async function refreshBrowserKeyState'));
assert.ok(helper.startsWith('async function approveSettings('));
async function restoreScenario(change,approve=true){
 let click,request,release,writes=0,nav=0,valid=true;
 const context={busy:false,preview:{records:[{id:1}]},ack:{checked:true},initialSnapshot:{physical:'synthetic-record',directory:'[]',count:1,bytes:1},currentCount:1,
  restoreButton:{addEventListener:(_event,fn)=>{click=fn;}},captureOperationAuthorization:()=>()=>valid,
  confirmOperation:(req,guard)=>{request=req;assert.equal(guard(),true);return new Promise(resolve=>{release=()=>resolve(approve&&guard());});},
  selectSettingsOperation(code){assert.equal(code,'restore-button');},updateButtons(){},info(){},finishOperation(){},recordNotification(){},replaceAllRecords:async()=>{writes++;},window:{location:{assign(){nav++;}}},
  resetPreview(){},restorePreview:{},refreshCount:async()=>{},};
 runInNewContext(stripTypeScriptTypes(helper+'\n'+restore,{mode:'strip'}),context);
 const pending=click();assert.equal(writes,0);assert.equal(request.tone,'danger');assert.equal(request.acceptLabel,'置き換えて復元');
 if(change==='preview')context.preview={records:[]};
 if(change==='ack')context.ack.checked=false;
 if(change==='snapshot')context.initialSnapshot={physical:'changed',directory:'[]',count:1,bytes:1};
 if(change==='auth')valid=false;
 if(change==='busy')context.busy=true;
 release();await pending;
 return {writes,nav};
}
assert.deepEqual(await restoreScenario(null),{writes:1,nav:1});
assert.deepEqual(await restoreScenario(null,false),{writes:0,nav:0});
for(const change of ['preview','ack','snapshot','auth','busy'])assert.deepEqual(await restoreScenario(change),{writes:0,nav:0});
// Actual helper is also checked for invalidation after an affirmative dialog result.
let approved=true;
const approve=runInNewContext(stripTypeScriptTypes(helper,{mode:'strip'})+'\napproveSettings',{
 busy:false,captureOperationAuthorization:()=>()=>approved,confirmOperation:async()=>{approved=false;return true;},
});
assert.equal(await approve(req),false);
const yearend=read('src/year-end-assist.ts');
const captureDetail=yearend.slice(yearend.indexOf('function captureDetailConsent()'),yearend.indexOf('async function approveYearEnd('));
let authValid=true;
const queue={id:1,file:{},personId:'synthetic-person',year:2026,hash:'synthetic-hash',status:'ready',draft:{taxable:100},error:'',fieldErrors:new Set()};
const context={captureOperationAuthorization:()=>()=>authValid,selected:'synthetic-person',activeYear:2026,data:{},busy:false,
 fileQueue:[queue],memoInput:{value:''},memoDirty:false,forecastDirty:false,bonusDirty:false,captureForecastInput:()=>({method:'latest',months:{}}),
 bonusMonthInput:{value:''},bonusValueInput:{value:''},savedEdits:new Map(),pendingDeletions:new Map()};
const captureDetailFn=runInNewContext(stripTypeScriptTypes(captureDetail,{mode:'strip'})+'\ncaptureDetailConsent',context);
for(const change of [()=>{queue.draft.taxable++;},()=>{queue.file={};},()=>{queue.fieldErrors.add('gross');},()=>{context.activeYear++;},()=>{context.memoInput.value+='changed';},()=>{context.pendingDeletions.set('synthetic-doc',1);},()=>{authValid=false;}]){
 const current=captureDetailFn();assert.equal(current(),true);change();assert.equal(current(),false);
}
for(const source of [backup,yearend,read('src/cloud/auth.ts')])assert.doesNotMatch(source,/\b(?:window\.)?(?:confirm|prompt)\(/);
assert.match(backup,/requiredText:'整理'/);assert.match(backup,/requiredText:'原本整理'/);
assert.match(yearend,/requiredText:name/);
assert.match(read('src/cloud/auth.ts'),/await confirmOperation\(\{title:'暗号化保管庫を作成'[\s\S]*?stillCurrent\)\|\|!stillCurrent\(\)/);
console.log('PASS: real settings restore and year-end consent guards reject changed drafts, auth, plan, or cancellation; typed cleanup and creation checks retained');

// Actual additive restore button: an expired plan, cancellation or replaced approval never writes.
const addDescription=backup.slice(backup.indexOf('function describeAddPlan('),backup.indexOf("addInspect.addEventListener('click'"));
const addHandler=backup.slice(backup.indexOf("addButton.addEventListener('click'"),backup.indexOf('browserKeyRegister.addEventListener',backup.indexOf("addButton.addEventListener('click'")));
async function addScenario(change,approve=true){
 let click,request,release,writes=0,valid=true;
 const plan={signature:'synthetic-plan',add:1,samePdf:2,sameId:0,samePeriod:0,ambiguous:0,backupConflict:0,employersAdded:0};
 const context={busy:false,preview:{records:[{id:1}],unreviewedWarnings:0},ack:{checked:false},addPlan:plan,addPlanAuthorized:()=>valid,
  addButton:{addEventListener:(_event,fn)=>{click=fn;}},captureOperationAuthorization:()=>()=>valid,
  confirmOperation:(req,guard)=>{request=req;assert.equal(guard(),true);return new Promise(resolve=>{release=()=>resolve(approve&&guard());});},
  selectSettingsOperation(code){assert.equal(code,'restore-add-button');},updateButtons(){},info(){},finishOperation(){},restoreAdditiveRecords:async(_records,signature)=>{assert.equal(signature,plan.signature);writes++;return plan;},
  addPreview:{},refreshCount:async()=>{}};
 runInNewContext(stripTypeScriptTypes(helper+'\n'+addDescription+'\n'+addHandler,{mode:'strip'}),context);
 const pending=click();assert.equal(writes,0);assert.equal(request.acceptLabel,'明細を追加復元');
 if(change==='plan')context.addPlan={...plan,signature:'changed'};
 if(change==='preview')context.preview={records:[]};
 if(change==='auth')valid=false;
 if(change==='busy')context.busy=true;
 release();await pending;return writes;
}
assert.equal(await addScenario(null),1);
assert.equal(await addScenario(null,false),0);
for(const change of ['plan','preview','auth','busy'])assert.equal(await addScenario(change),0);
console.log('PASS: real additive restore button rejects stale plan, backup, auth and cancellation');

// Employee additive restore uses the same single modal and rejects stale plans.
const employeeHandler=backup.slice(backup.indexOf("yearEndCommit.addEventListener('click'"),backup.indexOf("yearEndResume.addEventListener('click'"));
async function employeeScenario(change,approve=true){
 let click,request,release,writes=0,valid=true;
 const plan={canRestore:true,restorable:1,skipped:2,sameNameCollisions:1};
 const context={busy:false,yearEndPreview:{persons:[{id:'fixture'}]},yearEndPlan:plan,
  yearEndCommit:{addEventListener:(_event,fn)=>{click=fn;}},captureOperationAuthorization:()=>()=>valid,
  confirmOperation:(req,guard)=>{request=req;assert.equal(guard(),true);return new Promise(resolve=>{release=()=>resolve(approve&&guard());});},
  selectSettingsOperation(code){assert.equal(code,'ye-restore-commit');},updateButtons(){},reportYearEnd(){},finishOperation(){},invalidateYearEndPreview(){},yearEndFile:{},
  yearEndRepo:{restoreBackupSnapshot:async()=>{writes++;return {restored:1,skipped:2};}}};
 // Await the actual async handler instead of the UI's fire-and-forget wrapper.
 const handler=employeeHandler.replace('()=>{void(async()=>{','async()=>{').replace('})()});','});');
 runInNewContext(stripTypeScriptTypes(helper+'\n'+handler,{mode:'strip'}),context);
 if(change==='blocked'){context.yearEndPlan={...plan,canRestore:false};await click();assert.equal(request,undefined);return writes;}
 if(change==='empty'){context.yearEndPlan={...plan,restorable:0};await click();assert.equal(request,undefined);return writes;}
 const pending=click();assert.equal(writes,0);assert.equal(request.acceptLabel,'従業員を追加復元');assert.ok(request.details.some(line=>line.includes('同名')));assert.ok(request.details.some(line=>line.includes('上書きせず')));
 if(change==='plan')context.yearEndPlan={...plan,restorable:2};
 if(change==='preview')context.yearEndPreview={persons:[]};
 if(change==='auth')valid=false;
 if(change==='busy')context.busy=true;
 release();await pending;return writes;
}
assert.equal(await employeeScenario(null),1);
assert.equal(await employeeScenario(null,false),0);
for(const change of ['plan','preview','auth','busy','blocked','empty'])assert.equal(await employeeScenario(change),0);
console.log('PASS: employee additive restore single confirmation, warnings, stale plan, backup, auth and cancellation');
