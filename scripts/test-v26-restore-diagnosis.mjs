/** Synthetic, read-only regression checks for year-end backup post-restart recovery. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const read=(p)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const source=read('src/backup.ts');
const html=read('public/backup/index.html');
const diagnosisSource=source.slice(source.indexOf('async function diagnoseIncompleteYearEndRestore('),source.indexOf('\nfunction yearEndError('));
assert.ok(diagnosisSource.startsWith('async function diagnoseIncompleteYearEndRestore('));
assert.doesNotMatch(diagnosisSource,/完全性照合に合格した項目/,'metadata inspection cannot promise cryptographic verification');

async function diagnose(report,context='failure'){
 const resume={hidden:true},result={hidden:true,textContent:''};
 let checks=0, buttonUpdates=0;
 const scope={yearEndResume:resume,yearEndDiagnosis:result,
  yearEndRepo:{inspectRestoreOrphans:async()=>{checks++;if(report instanceof Error)throw report;return report;}},
  updateButtons:()=>{buttonUpdates++;}};
 const fn=runInNewContext(stripTypeScriptTypes(diagnosisSource,{mode:'strip'})+'\ndiagnoseIncompleteYearEndRestore',scope);
 const success=await fn({persons:[]},context);
 return {resume,result,success,checks,buttonUpdates};
}
const person={id:'synthetic-employee-uuid',label:'架空の従業員',state:'unindexed',originals:1,yearFiles:0,profile:false,inBackup:true,unexpectedFiles:0};
const resumable=await diagnose({items:[person],canAttemptResume:true});
assert.equal(resumable.success,true);
assert.equal(resumable.resume.hidden,false);
assert.match(resumable.result.textContent,/再開時にすべてのファイルを照合/);
assert.match(resumable.result.textContent,/一致しない場合は変更せず中断/);
assert.doesNotMatch(resumable.result.textContent,/照合に合格した/);
const blocked=await diagnose({items:[{...person,state:'deleting'}],canAttemptResume:false});
assert.equal(blocked.resume.hidden,true);
assert.match(blocked.result.textContent,/安全に再開できないデータ/);
assert.doesNotMatch(blocked.result.textContent,/バックアップと一致しない項目/);
const clean=await diagnose({items:[],canAttemptResume:false},'manual');
assert.equal(clean.success,true);
assert.equal(clean.resume.hidden,true);
assert.match(clean.result.textContent,/見つかりませんでした/);
assert.doesNotMatch(clean.result.textContent,/ネットワーク・競合状態を確認/);
const failure=await diagnose(new Error('通信断'),'manual');
assert.equal(failure.success,false);
assert.equal(failure.resume.hidden,true);
assert.match(failure.result.textContent,/確認に失敗/);
assert.equal(resumable.checks,1);
assert.equal(resumable.buttonUpdates,1);
console.log('PASS: metadata-only inspection never claims PDF integrity verification; blocked and network cases are accurately described');

// The secondary inspection is available only after a validated backup, not after a failed restore.
assert.match(html,/id="ye-restore-recheck"[^>]*hidden disabled>OneDriveの復元状態を確認/);
const verify=source.slice(source.indexOf("yearEndVerify.addEventListener('click'"),source.indexOf("yearEndCommit.addEventListener('click'"));
assert.match(verify,/readYearEndBackup\(decoded\)/);
assert.match(verify,/previewBackupRestore\(data\)/);
assert.match(verify,/yearEndPreview=data;[\s\S]*yearEndRecheck\.hidden=false/);
assert.match(source,/yearEndRecheck\.hidden=true;yearEndDiagnosis\.hidden=true/,'file/password changes must reset inspection');
const recheck=source.slice(source.indexOf("yearEndRecheck.addEventListener('click'"));
assert.match(recheck,/if\(busy\|\|!yearEndPreview\|\|yearEndRecheck\.hidden\)return/);
assert.match(recheck,/previewBackupRestore\(data\)/);
assert.match(recheck,/diagnoseIncompleteYearEndRestore\(data,'manual'\)/);
assert.match(recheck,/if\(!inspected\)[\s\S]*yearEndPlan=undefined/,'read error must disable normal restore');
assert.doesNotMatch(recheck,/restoreBackupSnapshot\(/,'inspection must never write cloud files');
const repository=read('src/yearEnd/repository.ts');
const inspect=repository.slice(repository.indexOf('async inspectRestoreOrphans('),repository.indexOf('private async verifiedRestoreFiles('));
assert.doesNotMatch(inspect,/this\.writeJson|\.graph\.write\(|\.graph\.trash/,'metadata inspection must remain read only');
console.log('PASS: after verification a non-destructive recovery check is available without initiating a failed restore');

// v25's duplicate fix must be bundled even if GitHub main is still at v24.
const yearend=read('src/year-end-assist.ts');
const saveBlock=yearend.slice(yearend.indexOf('function updateSaveState(){'),yearend.indexOf('function renderSelectedReview(){'));
assert.doesNotMatch(saveBlock,/item\.status==='error'\|\|item\.status==='duplicate'/,'duplicate must not disable valid upload saves');
assert.match(saveBlock,/item\.status==='duplicate'/,'duplicates still counted as exclusions');
console.log('PASS: integrated v25 continues to save valid PDFs while reporting duplicates');
