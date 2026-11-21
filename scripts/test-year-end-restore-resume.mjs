/** Synthetic interruption recovery. No credentials, names or PDFs from real employees. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=code=>stripTypeScriptTypes(code.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const ctx={crypto:webcrypto,Blob,File,TextEncoder,TextDecoder,Uint8Array,Map,Set,Date,Number,JSON,Promise,Error,Buffer};
const model=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n({randomPersonId,randomDocumentId,emptyYear,emptyIndex,validateYear,validateIndex,validateProfile,validYear,asPersonId,asDocumentId})',ctx);
const at='2026-11-21T00:00:00Z';
const id=model.randomPersonId(),yearFile=model.randomDocumentId(),documentId=model.randomDocumentId();
const pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic salary statement only\n');
const digest=async data=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');
const fileHash=await digest(pdf);
const profile={format:'payroll-year-end-person-v1',id,displayName:'架空の検証用従業員',alias:'架空テスト',createdAt:at,updatedAt:at,yearFiles:{'2026':yearFile}};
const doc={id:documentId,personId:id,kind:'salary',paymentDate:'2026-10-25',targetMonth:'2026-10',taxable:220000,
 gross:225000,transportation:5000,nonTaxable:5000,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
 fileName:'synthetic.pdf',pdfSize:pdf.length,fileHash,confirmedAt:at,updatedAt:at,source:'pdf-reviewed',revision:1};
const year={...model.emptyYear(id,2026),documents:[doc],memo:'架空の年度メモ',estimates:[],bonusEstimates:[]};
const dataset={exportedAt:at,persons:[{profile,years:[year],originals:[{id:documentId,bytes:pdf}]}]};
const path=(parts,name)=>[...parts,name].join('/');
function env(){
 const remote=new Map();let serial=0,writing=0,interruptAt=0,trashCalls=0;
 const graph={
  async read(parts,name){const r=remote.get(path(parts,name));return r?{...r}:null;},
  async metadata(parts,name){const r=remote.get(path(parts,name));return r?{etag:r.etag,id:r.id}:null;},
  async write(parts,name,text,prior){
   const key=path(parts,name),old=remote.get(key);
   if(prior ? !old||old.etag!==prior.etag : !!old)throw new Error('ETag collision');
   writing++;
   if(writing===interruptAt)throw new Error('synthetic connection drop');
   remote.set(key,{text,etag:`etag-${++serial}`,id:`file-${serial}`});
  },
  async listFolder(parts){
   const prefix=parts.join('/')+'/';
   const names=new Set([...remote.keys()].filter(key=>key.startsWith(prefix)).map(key=>key.slice(prefix.length).split('/')[0]));
   return [...names].map(name=>({name,id:prefix+name,etag:'folder-etag',folder:[...remote.keys()].some(key=>key.startsWith(prefix+name+'/'))}));
  },
  async trashFile(){trashCalls++;throw new Error('must not delete');},
  async trashFolder(){trashCalls++;throw new Error('must not delete');},
 };
 const access={path:['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'],key:{},salt:'synthetic',graph};
 const sandbox={...ctx,...model,cloudVault:async()=>({yearEndAccess:async()=>access}),
  encryptJson:async(_kind,data)=>JSON.stringify(data),decryptJson:async(_kind,data)=>JSON.parse(data),
  encryptBytes:async(_kind,bytes)=>Buffer.from(bytes).toString('base64'),
  decryptBytes:async(_kind,data)=>new Uint8Array(Buffer.from(data,'base64')),
  isCollision:e=>/collision/.test(e.message)};
 const {YearEndRepository}=runInNewContext(strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository})',sandbox);
 return {remote,access,repo:new YearEndRepository(),get writes(){return writing;},set interruptAt(v){interruptAt=v;},get trashCalls(){return trashCalls;}};
}
const first=env();first.interruptAt=2;
await assert.rejects(first.repo.restoreBackupSnapshot(dataset),/synthetic connection drop/);
assert.equal(first.remote.has(path(first.access.path,'index.enc')),false,'index is not published on failure');
const writesAtInspection=first.writes;
const report=await first.repo.inspectRestoreOrphans(dataset);
assert.equal(first.writes,writesAtInspection,'diagnosis is read-only');
assert.equal(report.items.length,1);assert.equal(report.canAttemptResume,true);
assert.equal(report.items[0].originals,1);assert.equal(report.items[0].yearFiles,0);
assert.equal(report.items[0].profile,false);assert.equal(report.items[0].inBackup,true);
await assert.rejects(first.repo.restoreBackupSnapshot(dataset),/索引未登録/);
first.interruptAt=0;
const before=first.writes;
const done=await first.repo.restoreBackupSnapshot(dataset,()=>{},{resumeVerifiedOrphans:true});
assert.equal(done.restored,1);assert.equal(done.skipped,0);
assert.equal(first.writes-before,3,'only missing year, profile and index must be written, not existing PDF');
assert.equal(JSON.parse(first.remote.get(path(first.access.path,'index.enc')).text).persons[0].state,'active');
assert.equal((await first.repo.inspectRestoreOrphans(dataset)).items.length,0);
const second=await first.repo.restoreBackupSnapshot(dataset);
assert.equal(second.restored,0);assert.equal(second.skipped,1);
assert.equal(first.trashCalls,0);
console.log('PASS: interrupted first restore, read-only diagnosis, explicit verified resume, and no deletion');

const commitFail=env();commitFail.interruptAt=4;
await assert.rejects(commitFail.repo.restoreBackupSnapshot(dataset),/synthetic/);
const fullyWritten=await commitFail.repo.inspectRestoreOrphans(dataset);
assert.equal(fullyWritten.items[0].profile,true);
assert.equal(fullyWritten.items[0].originals,1);
assert.equal(fullyWritten.items[0].yearFiles,1);
commitFail.interruptAt=0;
const beforeCommitRetry=commitFail.writes;
assert.equal((await commitFail.repo.restoreBackupSnapshot(dataset,()=>{},{resumeVerifiedOrphans:true})).restored,1);
assert.equal(commitFail.writes-beforeCommitRetry,1,'all files are reused; only index is written');
console.log('PASS: interruption at final index commit resumes without rewriting any employee files');

const tamper=env();tamper.interruptAt=2;
await assert.rejects(tamper.repo.restoreBackupSnapshot(dataset),/synthetic/);
tamper.interruptAt=0;
const pdfKey=path([...tamper.access.path,'persons',id,'originals'],documentId+'.enc');
tamper.remote.get(pdfKey).text=Buffer.from('%PDF-1.7\nTAMPERED\n').toString('base64');
const beforeTamper=tamper.writes;
await assert.rejects(tamper.repo.restoreBackupSnapshot(dataset,()=>{},{resumeVerifiedOrphans:true}),/一致しません/);
assert.equal(tamper.writes,beforeTamper);assert.equal(tamper.trashCalls,0);
console.log('PASS: existing PDF mismatch blocks resume before any writes');

const extra=env();extra.interruptAt=2;
await assert.rejects(extra.repo.restoreBackupSnapshot(dataset),/synthetic/);
extra.interruptAt=0;
extra.remote.set(path([...extra.access.path,'persons',id,'originals'],'unexpected.enc'),{text:'other',etag:'etag-other',id:'other'});
const extraInspection=await extra.repo.inspectRestoreOrphans(dataset);
assert.equal(extraInspection.canAttemptResume,false);
const beforeExtra=extra.writes;
await assert.rejects(extra.repo.restoreBackupSnapshot(dataset,()=>{},{resumeVerifiedOrphans:true}),/異なる項目/);
assert.equal(extra.writes,beforeExtra);assert.equal(extra.trashCalls,0);
console.log('PASS: unknown orphan content is reported and never deleted or overwritten');

const deleted=env();deleted.interruptAt=2;
await assert.rejects(deleted.repo.restoreBackupSnapshot(dataset),/synthetic/);
deleted.interruptAt=0;
// Use the authoritative model shape so the deleted tombstone is validated.
const tombstone={...model.emptyIndex(),persons:[{id,state:'deleted',createdAt:at,updatedAt:at}]};
deleted.remote.set(path(deleted.access.path,'index.enc'),{text:JSON.stringify(tombstone),etag:'etag-tombstone',id:'file-tombstone'});
assert.equal((await deleted.repo.inspectRestoreOrphans(dataset)).items[0].state,'deleted');
assert.equal((await deleted.repo.restoreBackupSnapshot(dataset,()=>{},{resumeVerifiedOrphans:true})).restored,1);
assert.equal(JSON.parse(deleted.remote.get(path(deleted.access.path,'index.enc')).text).persons[0].state,'active');
assert.equal(deleted.trashCalls,0);
console.log('PASS: an exactly matching deleted-profile folder can be restored without deleting its files');

const race=env();race.interruptAt=2;
await assert.rejects(race.repo.restoreBackupSnapshot(dataset),/synthetic/);
race.interruptAt=0;
const originalMetadata=race.access.graph.metadata;
race.access.graph.metadata=async(parts,name)=>{
 const result=await originalMetadata(parts,name);
 if(name===documentId+'.enc'&&result)return {...result,etag:'changed-by-another-tab'};
 return result;
};
await assert.rejects(race.repo.restoreBackupSnapshot(dataset,()=>{},{resumeVerifiedOrphans:true}),/別タブ/);
assert.equal(race.remote.has(path(race.access.path,'index.enc')),false);
assert.equal(race.trashCalls,0);
console.log('PASS: concurrent alteration of a resumed file blocks final index publication');

const unrelated=env();unrelated.interruptAt=2;
await assert.rejects(unrelated.repo.restoreBackupSnapshot(dataset),/synthetic/);
unrelated.interruptAt=0;
const otherId=model.randomPersonId();
unrelated.remote.set(path([...unrelated.access.path,'persons',otherId],'profile.enc'),{text:'other',etag:'etag-other',id:'other'});
assert.equal((await unrelated.repo.inspectRestoreOrphans(dataset)).canAttemptResume,false);
await assert.rejects(unrelated.repo.restoreBackupSnapshot(dataset,()=>{},{resumeVerifiedOrphans:true}),/索引未登録/);
console.log('PASS: unrelated orphan folders cannot be claimed using another backup');

const ui=read('src/backup.ts');const html=read('public/backup/index.html');
assert.match(ui,/diagnoseIncompleteYearEndRestore\(data\)/);
assert.match(ui,/resumeVerifiedOrphans:\s*true/);
assert.match(html,/id="ye-restore-diagnosis"/);
assert.match(html,/id="ye-restore-resume"[^>]*hidden disabled/);
console.log('PASS: diagnosis and opt-in resume UI are connected');

// Preview is read-only and separates prospective restores from existing employees.
const fresh=env();const freshWrites=fresh.writes;
const startPlan=await fresh.repo.previewBackupRestore(dataset);
assert.equal(startPlan.restorable,1);assert.equal(startPlan.skipped,0);assert.equal(startPlan.blocked,0);
assert.equal(startPlan.canRestore,true);assert.equal(fresh.writes,freshWrites);
const orphanPlan=await extra.repo.previewBackupRestore(dataset);
assert.equal(orphanPlan.canRestore,false);assert.equal(orphanPlan.blocked,1);
const currentPlan=await first.repo.previewBackupRestore(dataset);
assert.equal(currentPlan.restorable,0);assert.equal(currentPlan.skipped,1);
assert.equal(currentPlan.items[0].status,'skip');
// Same display name with a different UUID is a separate record and must be disclosed.
const shadowId=model.randomPersonId();
const sameNameBackup={exportedAt:at,persons:[{profile:{...profile,id:shadowId,yearFiles:{}},years:[],originals:[]}]};
const namePlan=await first.repo.previewBackupRestore(sameNameBackup);
assert.equal(namePlan.canRestore,true);
assert.equal(namePlan.restorable,1);
assert.equal(namePlan.sameNameCollisions,1);
assert.equal(namePlan.items[0].sameNameCollision,true);
assert.match(namePlan.items[0].reason,/同名の別データが追加されます/);
assert.equal(currentPlan.sameNameCollisions,0,'same UUID already registered must be skipped without warning');
const differentNameBackup={exportedAt:at,persons:[{profile:{...profile,id:shadowId,displayName:'別の架空従業員',yearFiles:{}},years:[],originals:[]}]};
assert.equal((await first.repo.previewBackupRestore(differentNameBackup)).sameNameCollisions,0);
assert.equal(first.trashCalls,0);
console.log('PASS: a different UUID sharing an active employee name warns before restore, without writes or deletion');

// All orphan original reports are metadata-only and never attempt cleanup.
const beforeInspection=first.writes;
const healthy=await first.repo.inspectUnreferencedOriginals(id);
assert.equal(healthy.unreferenced,0);assert.equal(healthy.missing,0);assert.equal(healthy.referenced,1);
first.remote.set(path([...first.access.path,'persons',id,'originals'],'unexpected.enc'),{text:'opaque',etag:'orphan-tag',id:'orphan-id'});
const foundOrphan=await first.repo.inspectUnreferencedOriginals(id);
assert.equal(foundOrphan.unreferenced,1);assert.equal(foundOrphan.missing,0);
assert.equal(first.writes,beforeInspection);assert.equal(first.trashCalls,0);
console.log('PASS: read-only employee restore preview; unreferenced PDF remains untouched and prevents blind retry');
