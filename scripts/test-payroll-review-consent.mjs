import {noticeReason} from '../src/ui/notificationHistory.ts';
/** Test the actual common review functions without a browser or any personal data. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {personalReviewRows,yearEndReviewRows,createDraftReviewConsent,renderReviewConfirmation,editedReviewRecord} from '../src/ui/payrollReview.ts';
import {documentAmountWarnings} from '../src/yearEnd/model.ts';
const rows=personalReviewRows({kind:'salary',gross:'250000',net:'205000',incomeTax:'40000'});
assert.deepEqual(rows.map(x=>x[1]),[250000,40000,210000,205000,5000]);
assert.deepEqual(personalReviewRows({kind:'salary',gross:'250000',net:'210000',incomeTax:'40000'}),[]);
assert.deepEqual(personalReviewRows({kind:'salary',gross:'',net:'0'}),[]);
assert.equal(personalReviewRows({kind:'bonus',gross:'10000',net:'9000',yearEndAdjustment:'1000'})[1][1],0,'inactive deduction must not be added');
const a={gross:250000,taxable:220000,nonTaxable:10000,transportation:null};
assert.deepEqual(yearEndReviewRows(a).map(x=>x[1]),[250000,220000,10000,230000,-20000]);
assert.deepEqual(yearEndReviewRows({...a,nonTaxable:null}),[],'missing non-taxable amount is not zero');
assert.deepEqual(yearEndReviewRows({...a,taxable:240000}),[]);
assert.deepEqual(yearEndReviewRows({...a,taxable:240000,transportation:12000}).map(x=>x[1]),[10000,12000,2000]);
const salary={kind:'salary',gross:'250000',net:'250000',taxable:'235000',nonTaxable:'10000',transportation:'10000',reimbursedExpenses:'2000'};
assert.deepEqual(personalReviewRows(salary).filter(([k])=>k.startsWith('差額')||k.startsWith('超過額')).map(x=>x[1]),[-5000,2000]);
assert.deepEqual(personalReviewRows({...salary,taxable:'240000',reimbursedExpenses:''}),[],'missing expense is not inferred as zero');
assert.equal(personalReviewRows({kind:'bonus',gross:'10000',net:'10000',bonusBase:'8000',performanceBonus:'3000'}).at(-1)[1],1000);
assert.equal(personalReviewRows({kind:'salary',gross:'10000',net:'10000',targetMonth:'2024-01',paymentDate:'2026-11-27'}).at(-1)[1],'34か月');
assert.equal(personalReviewRows({kind:'salary',gross:'10000',net:'10000',taxable:'11000'}).at(-1)[1],1000);
const oldReview={reviewedIssues:['previous warning'],reviewedAt:'2026-01-01T00:00:00Z',warningsAcknowledged:true};
assert.deepEqual(editedReviewRecord(oldReview,[],false,'2026-02-01'),{...oldReview,warningsAcknowledged:false});
assert.throws(()=>editedReviewRecord(oldReview,['new warning'],false,'2026-02-01'));
assert.deepEqual(editedReviewRecord(oldReview,['new warning'],true,'2026-02-01'),{reviewedIssues:['new warning'],reviewedAt:'2026-02-01',warningsAcknowledged:true});
assert.equal(oldReview.reviewedIssues[0],'previous warning');
const c=createDraftReviewConsent();const b={...a};
assert.equal(c.has(a),false);c.set(a,true);assert.equal(c.has(a),true);assert.equal(c.has(b),false);
a.taxable++;assert.equal(c.has(a),false);c.set(a,false);a.taxable--;assert.equal(c.has(a),false,'an explicit edit revocation cannot be restored by reverting the amount');
c.set(a,true);c.set(b,true);c.set(a,false);assert.equal(c.has(a),false);assert.equal(c.has(b),true,'another draft remains reviewed');
class Stub{constructor(tag){this.tag=tag;this.children=[];this.textContent='';}append(...children){this.children.push(...children);}replaceChildren(){this.children=[];}}
const list=new Stub('ul'),details=new Stub('dl'),panel={querySelector:s=>s==='[data-review-warnings]'?list:details};const checkbox={};
globalThis.document={createElement:tag=>new Stub(tag)};
renderReviewConfirmation(panel,checkbox,{required:true,approved:false,disabled:false,warnings:['<synthetic>'],rows});
assert.equal(panel.hidden,false);assert.equal(checkbox.disabled,false);assert.equal(checkbox.checked,false);assert.equal(list.children[0].textContent,'<synthetic>');assert.equal(details.children.at(-1).children[1].textContent,'5,000円');
renderReviewConfirmation(panel,checkbox,{required:true,approved:true,disabled:true,warnings:[],rows:[]});assert.equal(checkbox.checked,true);assert.equal(checkbox.disabled,true);assert.equal(list.children.length,0);
renderReviewConfirmation(panel,checkbox,{required:false,approved:true,disabled:false,warnings:['synthetic'],rows});assert.equal(panel.hidden,true);assert.equal(checkbox.checked,false);assert.equal(checkbox.disabled,true);assert.equal(details.children.length,0);
// Test real year-end write entry, with two changed drafts and a stub for the remote boundary.
const ui=readFileSync(new URL('../src/year-end-assist.ts',import.meta.url),'utf8');
const start=ui.indexOf('async function saveAllDocuments()'),end=ui.indexOf('function bind()',start);
assert.ok(start>=0&&end>start);const source=stripTypeScriptTypes(ui.slice(start,end),{mode:'strip'});
const d1={...a},d2={...a},consent=createDraftReviewConsent();
const records=[{id:'one',revision:1},{id:'two',revision:1}],drafts=new Map([['one',{draft:d1}],['two',{draft:d2}]]);
let writes=0,controlUpdates=0;const calls=[];
const ctx={noticeReason,captureOperationAuthorization:()=>()=>true,setTimeout,clearTimeout,requestAnimationFrame:f=>setTimeout(f,0),busy:false,savingDocuments:false,saveAll:{disabled:false},selected:'synthetic',activeYear:2026,data:{documents:records},savedEdits:drafts,pendingDeletions:new Map(),fileQueue:[],isChanged:()=>true,validateSavedEdit:()=>null,validateQueueItem:()=>null,
 requiresAmountApproval:d=>documentAmountWarnings(d).length>0&&!consent.has(d),documentAmountWarnings,structuredClone,say:m=>calls.push(m),saveResult:{replaceChildren(){}},uploadAccordion:{},showBusy(){},updateYearControls(){controlUpdates++;assert.equal(ctx.busy,true);},updateSaveState(){},
 repo:{saveDocumentsBatch:async(...args)=>{writes++;assert.equal(args[4],true);assert.notEqual(args[2][0].draft,d1);const approved=args[2][0].draft.taxable;d1.taxable++;await Promise.resolve();assert.equal(args[2][0].draft.taxable,approved,'in-flight edits cannot change the approved payload');throw new Error('synthetic stop at remote boundary');}},
 appStatus:{error(){},partial(){},begin(){return {};},show(){}},recoveryNoticeTarget:undefined,saveRecoveryRequired:null,saveRecovery:{},saveRecoveryStatus:{},updateDrafts(){},updateForecastSaveState(){},updateBonusSaveState(){},
};
// Isolate the save path through the awaited repository call, without executing unrelated rendering/error handlers.
const boundary=source.indexOf('  if(selected!==id||activeYear!==year||!authorized())');assert.ok(boundary>0);
const run=runInNewContext(source.slice(0,boundary)+'\n }catch(error){if(error.message!=="synthetic stop at remote boundary")throw error;}finally{busy=false;}\n}\nsaveAllDocuments',ctx);
await run();assert.equal(writes,0);consent.set(d1,true);await run();assert.equal(writes,0,'one approval cannot authorize both drafts');consent.set(d2,true);d2.taxable++;await run();assert.equal(writes,0,'changed amount invalidates approval at actual save boundary');consent.set(d2,true);await run();assert.equal(writes,1);assert.equal(controlUpdates,1,"only the approved save may enter the busy state");
console.log('PASS: shared review rows, blank vs zero, isolated draft approval, DOM render and year-end save boundary');
// Actual click/catch/finally path: a failed pre-write attempt remains editable.
for(const mode of ['prewrite','lock','partial','uncertain','completed']){
 const approved={...a};const edit={draft:approved};const map=new Map([['one',edit]]);
 const f={...ctx,busy:false,savingDocuments:false,saveAll:{disabled:false},data:{documents:[{id:'one',revision:1}]},savedEdits:map,pendingDeletions:new Map(),fileQueue:[],
  requiresAmountApproval:()=>false,saveRecoveryRequired:null,saveRecovery:{hidden:true},saveRecoveryStatus:{},saveReload:{},
  updateYearControls(){},updateDrafts(){f.updateSaveState();},updateSaveState(){f.saveAll.disabled=f.busy||Boolean(f.saveRecoveryRequired);},repo:{async saveDocumentsBatch(...args){const state=args[7];assert.ok(state);if(mode==='lock')state.lock='unknown';if(['partial','uncertain','completed'].includes(mode)){state.attempted=true;state.lock='held';state.uncertain=mode==='uncertain';state.completed=mode==='completed';}throw Error('synthetic failure');}}};
 const save=runInNewContext(source+'\nsaveAllDocuments',f);const pending=save();assert.equal(f.busy,true);assert.equal(f.saveAll.disabled,true);await pending;
 assert.equal(f.busy,false);assert.equal(f.savedEdits.get('one'),edit);assert.equal(f.savedEdits.get('one').draft,approved);assert.equal(Boolean(f.saveRecoveryRequired),mode!=='prewrite');assert.equal(f.saveAll.disabled,mode!=='prewrite');
 if(mode==='lock')assert.match(f.saveRecoveryStatus.textContent,/書き込みは開始していません/);
 if(mode==='completed')assert.match(f.saveRecoveryStatus.textContent,/保存は完了/);
}
console.log('PASS: year-end pre-write retry, lock/partial/unknown/complete distinctions, drafts retained');
