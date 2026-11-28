import {noticeReason} from '../src/ui/notificationHistory.ts';
/** Execute the production upload click handler with deterministic UI and storage doubles. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const src=readFileSync(new URL('../src/upload.ts',import.meta.url),'utf8');
const begin=src.indexOf('function yieldSavePaint()');
const handler=src.indexOf('saveButton.addEventListener("click", async () => {',begin);
// Use the top-level handler's closing delimiter, not the next feature's comment.
const close=src.indexOf('\n});',handler);
assert.ok(begin>=0&&handler>begin&&close>handler,'save handler boundaries');
const end=close+4;
const recovery=src.slice(src.indexOf("uploadRecoveryRecheck.addEventListener('click'"),begin);
const code=stripTypeScriptTypes(recovery+src.slice(begin,end),{mode:'transform'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,10));
function fixture(mode,count=1){
 const events=[],ready=deferred();let calls=0,reads=0,redirects=0,stops=0,syncs=0,reconciles=0;
 const node=()=>({hidden:false,disabled:false,textContent:'',style:{},classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){},addEventListener(_,f){this.click=f;}});
 const entries=Array.from({length:count},(_,i)=>({id:String(i),file:new Blob(['%PDF-1.7 synthetic']),hash:'a'.repeat(64),status:'ready',employerId:'fixture',form:{job:'fixture',kind:'salary',paymentDate:'2026-11-25',workDays:1},pages:1}));
 const forms=entries.map(e=>e.form);
 const ctx={noticeReason,Error,Date,Uint8Array,Blob,setTimeout,clearTimeout,requestAnimationFrame:f=>setTimeout(()=>{events.push('paint');f();},0),saving:false,uploadSaveRecoveryRequired:false,uploadSaveRecoveryChecking:false,uploadSaveAttempt:[],uploadLockState:undefined,recoverAcrossMonths:false,leavingAfterSave:false,entries,
  saveButton:node(),zeroCheckbox:node(),zeroConsentFingerprint:'fingerprint',saveStatus:node(),saveFeedback:node(),saveStage:node(),saveProgress:node(),saveProgressFill:node(),saveGuidance:node(),saveButtonLabel:node(),uploadRecovery:node(),uploadRecoveryStatus:node(),uploadRecoveryRecheck:node(),saveDuplicates:node(),
  candidates:()=>entries,zeroCandidatesFingerprint:()=> 'fingerprint',captureOperationAuthorization:()=>()=>true,authEpoch:()=>1,
  clearInlineError:n=>{n.textContent='';},showInlineError:(n,t)=>{n.textContent=t;},beginSaveFeedback:()=>events.push('feedback'),updateSaveState:()=>{ctx.saveButton.disabled=ctx.saving||ctx.uploadSaveRecoveryRequired;},showSaveProgress:s=>events.push(s),
  refreshEmployerChoices:async()=>{reads++;events.push('directory');await ready.promise;return true;},
  cloudVault:async()=>({reconcileUploadLock:async()=>{reconciles++;events.push('reconcile');if(mode==='finance-unknown')throw Error('unsettled write');},syncIncome:async years=>{syncs++;events.push('finance');assert.deepEqual([...years],['2026']);}}),uploadRecoveryAttempt:e=>e,recordSignature:()=>'',inspectUploadRecovery:async()=>({saved:1,attempted:1,detached:mode==='finance-detached'?1:0,incomeUnsyncedYears:(mode==='finance'||mode==='finance-unknown'||mode==='finance-detached')&&!syncs?['2026']:[]}),requireSafeUploadRecovery:()=>{},uploadRecoveryMessage:()=> 'confirmed',notice:()=>{},
  formError:()=>false,validEmployerId:()=>true,hasReviewIssue:()=>false,isReviewed:()=>true,verifyPdfBytes:()=>{},zeroIntroducedWarnings:()=>[],ceilWorkDays:v=>v,prepareOptionalZeros:form=>({form}),storedPdfName:()=> 'synthetic.pdf',createPayrollSemantics:()=>({}),
  saveRecordsSkippingDuplicates:async(records,progress,state,_authorized,recover)=>{assert.equal(recover,ctx.recoverAcrossMonths);calls++;assert.equal(records.length,count);if(mode==='prewrite')throw Error('preflight failure');if(mode==='partial'||mode==='uncertain'||mode==='completed'||mode==='finance'||mode==='finance-unknown'||mode==='finance-detached'){state.attempted=true;state.uncertain=mode==='uncertain'||mode==='finance-unknown';state.completed=mode==='completed';state.payrollSaved=mode==='finance'||mode==='finance-unknown'||mode==='finance-detached';state.lock='held';throw Error('save failure');}return {saved:count,skipped:[]};},duplicated:()=>new Map(),describeUploadDuplicates:()=>[],updateSaveClock:()=>{},stopSaveClock:()=>{stops++;},appStatus:{clear(){}},recordNotification:()=>{},rememberNavigationNotice:()=>{},window:{location:{assign:()=>{redirects++;},reload:()=>{throw Error('reload forbidden');}}}};
 runInNewContext(code,ctx);
 return {ctx,events,ready,forms,stats:()=>({calls,reads,redirects,stops,syncs,reconciles})};
}
for(const mode of ['prewrite','partial','uncertain','completed','success'])for(const count of mode==='success'?[1,3]:[1]){
 const f=fixture(mode,count),c=f.ctx;
 const pending=c.saveButton.click();assert.equal(c.saving,true);assert.equal(c.saveButton.disabled,true);assert.deepEqual(f.events,['feedback']);assert.equal(f.stats().reads,0);
 await c.saveButton.click();await tick();assert.equal(f.stats().reads,1);assert.ok(f.events.indexOf('paint')<f.events.indexOf('directory'));
 f.ready.resolve();await pending;assert.equal(f.stats().calls,1);assert.equal(f.stats().stops,1);
 if(mode==='success'){assert.equal(f.stats().redirects,1);continue;}
 assert.equal(c.saving,false);assert.equal(c.entries.length,count);assert.equal(c.entries[0].form,f.forms[0]);
 if(mode==='prewrite'){assert.equal(c.saveButton.disabled,false);assert.equal(c.uploadSaveRecoveryRequired,false);assert.match(c.saveGuidance.textContent,/再試行/);}
 else{assert.equal(c.saveButton.disabled,true);assert.equal(c.uploadSaveRecoveryRequired,true);assert.match(c.uploadRecoveryStatus.textContent,mode==='partial'?/書き込み開始後/:mode==='uncertain'?/結果が不明/:/保存・照合は完了/);c.uploadRecoveryRecheck.click();await tick();assert.equal(c.uploadSaveRecoveryRequired,false);assert.equal(c.saveButton.disabled,false);assert.equal(c.recoverAcrossMonths,true);assert.equal(c.entries[0].form,f.forms[0]);}
}
for(const mode of ['finance','finance-detached']){
 const f=fixture(mode),c=f.ctx;const pending=c.saveButton.click();f.ready.resolve();await pending;
 assert.match(c.saveRecoveryStatus?.textContent??c.uploadRecoveryStatus.textContent,/給与明細は保存済み/);
 c.uploadRecoveryRecheck.click();await tick();
 assert.equal(f.stats().calls,1,'no second payroll save');assert.equal(f.stats().syncs,1);assert.equal(f.stats().reconciles,1);
 assert.ok(f.events.indexOf('reconcile')<f.events.indexOf('finance'));
 assert.equal(c.uploadSaveRecoveryRequired,false);assert.equal(c.entries[0].form,f.forms[0]);
}
{
 const f=fixture('finance-unknown'),c=f.ctx;const pending=c.saveButton.click();f.ready.resolve();await pending;
 c.uploadRecoveryRecheck.click();await tick();assert.equal(f.stats().syncs,0);assert.equal(f.stats().calls,1);
 assert.equal(c.uploadSaveRecoveryRequired,true);assert.equal(c.recoverAcrossMonths,false);assert.equal(c.entries[0].form,f.forms[0]);
}
console.log('PASS: immediate paint and double-click guard, 1/multiple save, pre-write retry, partial/unknown/completed recovery preserves drafts');
