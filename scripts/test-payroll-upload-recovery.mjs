/** Synthetic-only verification. No Graph, credentials, personal PDFs, or real cloud writes. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectUploadRecovery} from '../src/storage/uploadRecovery.ts';
import {incompleteDeleteIncomeNotice} from '../src/ui/deleteOutcome.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const signature=r=>JSON.stringify([r.id,r.fileHash,r.form.targetMonth,r.revision]);
const a='a'.repeat(64),b='b'.repeat(64);
const attempt=[{fileHash:a,targetMonth:'2026-11'},{fileHash:b,targetMonth:'2026-12'}];
const records=[{id:10,fileHash:a,form:{targetMonth:'2026-11'},revision:1}];
let inspections=0,verified=0,writes=0;
const mock=(data=records,originals=[],options={})=>({
 refresh:async()=>{inspections++;if(options.changeOnSecond&&inspections===2)return [...data,{id:99,fileHash:b,form:{targetMonth:'2026-12'},revision:1}];return data;},
 inspectDetachedOriginals:async()=>{if(options.newOrphan&&inspections>=2)return {originals:[{month:'2026-12'}]};return {originals};},
 original:async()=>{verified++;if(options.failOriginal)throw new Error('PDF_SHA_MISMATCH');return new Blob(['%PDF-SYNTHETIC']);},
 write:async()=>{writes++;throw new Error('Read-only recovery must not write');},
});
{
 inspections=0;verified=0;const r=await inspectUploadRecovery(mock(),attempt,signature);
 assert.deepEqual(r,{saved:1,attempted:2});
 assert.equal(inspections,2);assert.equal(verified,1);assert.equal(writes,0);
}
{
 inspections=0;verified=0;const r=await inspectUploadRecovery(mock(records,[{month:'2025-08'}]),attempt,signature);
 assert.equal(r.saved,1,'unrelated detached historical original does not block this attempted cohort');
}
{
 inspections=0;await assert.rejects(()=>inspectUploadRecovery(mock(records,[{month:'2026-11'}]),attempt,signature),/未参照PDF原本/);
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
await assert.rejects(()=>inspectUploadRecovery(mock(),[{fileHash:'INVALID',targetMonth:'2026-11'}],signature),/保存対象を確認できません/);
assert.match(incompleteDeleteIncomeNotice(),/明細の削除は完了しました/);
assert.match(incompleteDeleteIncomeNotice(),/もう一度削除する必要はありません/);
assert.match(incompleteDeleteIncomeNotice(),/Finance連携を更新/);
assert.doesNotMatch(incompleteDeleteIncomeNotice(),/削除できませんでした/);
const upload=read('src/upload.ts'),main=read('src/main.ts'),edit=read('src/edit.ts'),html=read('public/upload/index.html');
assert.match(upload,/saveButton\.disabled = saving \|\| uploadSaveRecoveryRequired/);
assert.match(upload,/uploadSaveRecoveryRequired=true;uploadSaveRecoveryChecked=false;uploadSaveAttempt=attempt/);
assert.match(upload,/await inspectUploadRecovery\(await cloudVault\(\),uploadSaveAttempt,recordSignature\);/);
assert.match(upload,/leavingAfterSave=true; \/\/ The user confirmed discarding drafts/);
assert.match(upload,/uploadRecoveryReload\.addEventListener\('click'/);
assert.match(html,/id="upload-save-recovery"/);
assert.match(html,/id="upload-save-recheck"/);
assert.match(html,/id="upload-save-reload" disabled/);
assert.match(html,/id="clear-files" hidden>選択したPDFをすべて外す/);
assert.match(read('public/year-end-assist/index.html'),/id="yea-download-pdfs"[^>]*>PDFをZIP保存/);
assert.match(main,/window\.alert\(incompleteDeleteIncomeNotice\(\)\)/);
assert.match(edit,/window\.alert\(incompleteDeleteIncomeNotice\(\)\)/);
assert.doesNotMatch(main,/window\.alert\(`明細の削除は完了していますが/);
assert.doesNotMatch(edit,/window\.alert\(`給与明細の削除は完了しました/);
console.log('PASS: fail-closed Payroll upload recovery, no writes, real original verification, cross-tab change, double inspection, unified partial-delete messages, upload/ZIP labels');
