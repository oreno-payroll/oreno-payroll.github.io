/** Synthetic-only verification. No Graph, credentials, personal PDFs, or real cloud writes. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectUploadRecovery,requireSafeUploadRecovery,uploadRecoveryMessage} from '../src/storage/uploadRecovery.ts';
import {incompleteDeleteIncomeNotice,incompleteDeleteOriginalNotice} from '../src/ui/deleteOutcome.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const signature=r=>JSON.stringify([r.id,r.fileHash,r.form,r.employerId,r.revision]);
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
const form=(month,year='2026')=>({targetMonth:month,paymentDate:`${year}-12-25`,job:'main',kind:'salary'});
const attempt=[{fileHash:a,targetMonth:'2026-11',paymentYear:'2026',job:'main',kind:'salary'},
 {fileHash:b,targetMonth:'2026-12',paymentYear:'2027',job:'main',kind:'salary'}];
const records=[{id:10,fileHash:a,form:form('2026-11'),revision:1}];
let inspections=0,verified=0,writes=0,years=[];
const mock=(data=records,originals=[],options={})=>({
 refresh:async()=>{inspections++;if(options.changeOnSecond&&inspections===2)return [...data,{id:99,fileHash:b,form:form('2026-12','2027'),revision:1}];return data;},
 inspectDetachedOriginals:async()=>({generation:'',indexEtag:'synthetic-index',years:[],originals:options.newOrphan&&inspections>=2?[{month:'2026-12',hash:b}]:originals}),
 inspectDetachedUploadMatches:async(report,pending)=>report.originals.filter(o=>pending.some(p=>p.fileHash===o.hash)).map(o=>({targetMonth:o.month,fileHash:o.hash})),
 inspectIncomeConsistency:async requested=>{years=[...requested].sort();return options.staleYears??[];},
 original:async()=>{verified++;if(options.failOriginal)throw new Error('PDF_SHA_MISMATCH');return new Blob(['%PDF-SYNTHETIC']);},
 write:async()=>{writes++;throw new Error('Read-only recovery must not write');},
});
{
 inspections=0;verified=0;const r=await inspectUploadRecovery(mock(),attempt,signature);
 assert.deepEqual(r,{saved:1,attempted:2,originalsVerified:1,detached:0,incomeUnsyncedYears:[]});
 assert.equal(inspections,2);assert.equal(verified,1);assert.equal(writes,0);
 assert.deepEqual(years,['2026','2027'],'payment year, not target year');
 requireSafeUploadRecovery(r);
}
{
 inspections=0;verified=0;const r=await inspectUploadRecovery(mock(records,[{month:'2026-11',hash:c}]),attempt,signature);
 requireSafeUploadRecovery(r);assert.equal(r.saved,1,'unrelated retained original in same month is not a duplicate');
}
{
 inspections=0;const r=await inspectUploadRecovery(mock(records,[{month:'2025-01',hash:b}]),attempt,signature);
 assert.equal(r.originalsVerified,2);assert.equal(r.saved,1);assert.equal(r.detached,1);
 assert.throws(()=>requireSafeUploadRecovery(r),/未参照原本/);
 requireSafeUploadRecovery(r,true);
}
{
 inspections=0;const r=await inspectUploadRecovery(mock([{...records[0],form:form('2026-10')}]),attempt,signature);
 assert.equal(r.saved,0,'same PDF hash in the wrong month cannot count as saved');
}
{
 inspections=0;const r=await inspectUploadRecovery(mock([{...records[0],employerId:'emp_'+'d'.repeat(32)}]),attempt,signature);
 assert.equal(r.saved,0,'wrong employer cannot count as saved');
}
{
 inspections=0;const r=await inspectUploadRecovery(mock(records,[],{staleYears:['2026']}),attempt,signature);
 assert.equal(r.saved,1);assert.deepEqual(r.incomeUnsyncedYears,['2026']);
 assert.throws(()=>requireSafeUploadRecovery(r),/Finance連携/);
 assert.match(uploadRecoveryMessage(r),/PDF原本.*給与明細.*Finance連携：未同期/);
}
{
 inspections=0;await assert.rejects(()=>inspectUploadRecovery(mock(records,[],{failOriginal:true}),attempt,signature),/PDF_SHA_MISMATCH/);
}
{
 inspections=0;await assert.rejects(()=>inspectUploadRecovery(mock(records,[],{changeOnSecond:true}),attempt,signature),/照合中に変更/);
}
{
 inspections=0;await assert.rejects(()=>inspectUploadRecovery(mock(records,[],{newOrphan:true}),attempt,signature),/PDF原本の一覧が照合中に変更/);
}
{
 inspections=0;let evidence;
 const result=await inspectUploadRecovery(mock(),attempt,signature,undefined,records,value=>{evidence=value;});
 assert.equal(inspections,1,'locked baseline replaces redundant initial refresh');
 assert.equal(result.saved,1);assert.deepEqual(evidence.matches,[]);
 assert.equal(evidence.inventory.indexEtag,'synthetic-index');
}
{
 inspections=0;let evidence;
 const vault=mock();vault.inspectIncomeConsistency=async()=>{throw new Error('Finance must not be read before payroll commit');};
 vault.inspectDetachedUploadMatches=async()=>{throw new Error('Empty inventory must not trigger another read');};
 await inspectUploadRecovery(vault,attempt,signature,undefined,records,value=>{evidence=value;},false);
 assert.deepEqual(evidence.candidateIncomeYears,['2026']);
}
{
 let scans=0;const vault=mock();vault.inspectDetachedOriginals=async()=>({generation:'',indexEtag:'synthetic-index',years:[],originals:++scans===1?[{month:'2025-01',hash:c}]:[{month:'2026-12',hash:b}]});
 await assert.rejects(()=>inspectUploadRecovery(vault,attempt,signature,undefined,records,undefined,false),/PDF原本の一覧が照合中に変更/);
 assert.equal(scans,2);
}
{
 let scans=0;const vault=mock();inspections=0;
 const original=vault.inspectDetachedOriginals;
 vault.inspectDetachedOriginals=async()=>{assert.equal(inspections,1,'clean inventory follows latest record verification');scans++;return original();};
 await inspectUploadRecovery(vault,attempt,signature,undefined,records,undefined,false);
 assert.equal(scans,1,'clean locked upload scans the full original tree once');
}
{
 let scans=0;const vault=mock(records,[{month:'2025-01',hash:b}]);
 const original=vault.inspectDetachedOriginals;vault.inspectDetachedOriginals=async()=>{scans++;return original();};
 const result=await inspectUploadRecovery(vault,attempt,signature,undefined,records,undefined,false);
 assert.equal(scans,2);assert.equal(result.detached,1,'cross-month recovery still scans twice');
}
await assert.rejects(()=>inspectUploadRecovery(mock(),[{...attempt[0],fileHash:'INVALID'}],signature),/保存対象を確認できません/);
assert.equal(writes,0);
assert.match(incompleteDeleteIncomeNotice(),/明細の削除は完了しました/);
assert.match(incompleteDeleteIncomeNotice(),/もう一度削除する必要はありません/);
assert.match(incompleteDeleteIncomeNotice(),/連携データを再生成/);
assert.doesNotMatch(incompleteDeleteIncomeNotice(),/削除できませんでした/);
assert.match(incompleteDeleteOriginalNotice(),/もう一度削除する必要はありません/);
assert.match(incompleteDeleteOriginalNotice(),/未参照PDF原本の管理/);
const upload=read('src/upload.ts'),main=read('src/main.ts'),edit=read('src/edit.ts'),html=read('public/upload/index.html');
assert.match(upload,/saveButton\.disabled = saving \|\| uploadSaveRecoveryRequired/);
assert.match(upload,/uploadSaveRecoveryRequired=writeState\.attempted\|\|writeState\.uncertain\|\|writeState\.completed/);
assert.match(upload,/requireSafeUploadRecovery\(report,true\);/);
assert.match(read('src/storage/payrollStore.ts'),/await inspectUploadRecovery\(vault,records\.map\(uploadRecoveryAttempt\),recordSignature,report,baseline,/,'preflight survives reload');
assert.match(upload,/uploadSaveRecoveryRequired=false;uploadSaveAttempt=\[\];uploadRecovery\.hidden=true/);
assert.doesNotMatch(upload,/uploadRecoveryReload|window\.location\.reload\(\)/,'recovery keeps the in-memory PDF and drafts');
assert.match(html,/id="upload-save-recovery"/);
assert.match(html,/id="upload-save-recheck"/);
assert.doesNotMatch(html,/id="upload-save-reload"/);
assert.match(html,/id="clear-files" hidden>すべて削除/);
assert.match(read('public/year-end-assist/index.html'),/id="yea-download-pdfs"[^>]*>PDFをZIP保存/);
assert.match(main,/await showOperationMessage\(\{title:'明細削除・一部完了',details:\[incompleteDeleteIncomeNotice\(\)\]/);
assert.match(edit,/await showOperationMessage\(\{title:'明細削除・一部完了',details:\[incompleteDeleteIncomeNotice\(\)\]/);
assert.doesNotMatch(main,/window\.alert\(`明細の削除は完了していますが/);
assert.doesNotMatch(edit,/window\.alert\(`給与明細の削除は完了しました/);
console.log('PASS: fail-closed Payroll upload recovery, no writes, real original verification, cross-tab change, double inspection, unified partial-delete messages, upload/ZIP labels');
