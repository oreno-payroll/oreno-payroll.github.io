/** Payroll second-round performance/security regression. Fake Graph only, no credentials or writes. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {validateEmployerDirectory,employerAssignmentSignature,employerDirectorySignature} from '../src/storage/employerDirectory.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const enc=new TextEncoder(),salt='synthetic-salt',key={opaqueKey:true};
const hash='b'.repeat(64);
const toFile=(p,value,etag)=>{const text=JSON.stringify(value);return {id:p,etag,size:enc.encode(text).length,text};};
const years=['2023','2024','2025','2026'];
const files=new Map();let seq=0;
const put=(p,value)=>{const file=toFile(p,value,'etag-'+(++seq));files.set(p,file);return file;};
const baseRecord=(id,year)=>({id,revision:1,savedAt:'2026-01-01',fileName:`synthetic-${year}.pdf`,originalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',originalMonth:`${year}-05`,pdfSize:23,pdfType:'application/pdf',fileHash:String(id).padStart(64,'0'),pages:1,warningsAcknowledged:true,form:{targetMonth:`${year}-05`,paymentDate:`${year}-06-01`,job:'main',kind:'salary',net:'100',gross:'120'}});
const annual=records=>({format:'payroll-annual-v1',records,deleted:[]});
const index={format:'payroll-index-v1',years:[...years],incomeYears:[]};
put('payroll/index.enc',index);
for(const y of years)put(`payroll/statements/${y}.enc`,annual([baseRecord(Number(y),y)]));
const calls={read:[],meta:[],list:[]},reset=()=>{for(const v of Object.values(calls))v.length=0;};
const graph={
 async withWriteLock(operation){return operation();},
 async read(parts,name){const p=[...parts,name].join('/');calls.read.push(p);return files.get(p)??null;},
 async metadata(parts,name){const p=[...parts,name].join('/');calls.meta.push(p);const f=files.get(p);return f?{id:f.id,etag:f.etag,size:f.size}:null;},
 async listFolder(parts){const p=parts.join('/')+'/';calls.list.push(p);return [...files.entries()].filter(([n])=>n.startsWith(p)&&!n.slice(p.length).includes('/')).map(([name,f])=>({name:name.slice(p.length),folder:false,id:f.id,etag:f.etag,size:f.size}));},
 async write(){throw Error('No real or fake write must happen; commit is explicitly mocked.');}
};
const common={validateEmployerDirectory,employerAssignmentSignature,employerDirectorySignature,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,Buffer,Blob,Promise,Map,Set,WeakMap,structuredClone,performance,
 envelopeSalt:()=>salt,parseEnvelope:()=>({salt}),decryptJson:async(_kind,value)=>JSON.parse(value),encryptJson:async(_kind,value)=>JSON.stringify(value),decryptBytes:async()=>new Uint8Array(),
 fiscalYearOfTargetMonth:v=>Number(v.slice(0,4)),isValidPayrollSemantics:()=>true,validEmployerId:v=>v===undefined||(typeof v==='string'&&/^emp_[0-9a-f]{32}$/.test(v)),
 isCollision:()=>false,beginPerfOperation:()=>({measure:async(_,fn)=>fn(),finish(){}}),
 SNAPSHOT_TTL_MS:600_000,mutationEpoch:()=>'fixture-epoch',clearNavigationSnapshot:()=>{},rememberNavigationSnapshot:async()=>{},restoredNavigationSnapshot:async()=>null,
 MAX_RECORDS:2000,MAX_TOTAL_PDF_BYTES:500e6,toPublicIncomeRecord:()=>{},PayrollPartialSuccessError:class extends Error{},setTimeout};
const {PayrollVault}=runInNewContext(strip(read('src/storage/payrollValidation.ts'))+'\n'+strip(read('src/cloud/income.ts'))+'\n'+strip(read('src/cloud/vault.ts'))+'\n({PayrollVault})',common);
const vault=new PayrollVault(graph);vault.key=key;vault.salt=salt;vault.index=index;
await vault.refresh({forceFresh:true});reset();
// Only a positively absent previously authenticated unrelated year may be omitted.
const readOptions={forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:2026};
const missing=files.get('payroll/statements/2023.enc');
files.delete('payroll/statements/2023.enc');
const partial=await vault.refresh(readOptions);
assert.equal(partial.length,1);assert.equal(partial[0].id,2026);
assert.equal(vault.records().length,4,'partial read does not overwrite the full inventory');
await assert.rejects(vault.refresh({...readOptions,recordId:2023}),/明細ファイルがありません/);
await assert.rejects(vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true}),/年度ファイルの一覧/);
files.set('payroll/statements/2023.enc',missing);
const moved={...baseRecord(2026,'2023'),revision:2};
put('payroll/statements/2023.enc',annual([moved]));
assert.equal((await vault.refresh(readOptions))[0].revision,2,'changed foreign year may contain a newer moved record');
put('payroll/statements/2023.enc',annual([{...moved,revision:1}]));
await assert.rejects(vault.refresh(readOptions),/最新版を確認できません/);
put('payroll/statements/2023.enc',annual([baseRecord(2023,'2023')]));
await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});reset();
console.log('PASS: unrelated absence, target absence, ambiguous duplicates and full mutation paths');
// Ordinary scoped inventory authenticates the locked physical baseline itself.
const lockedBaseline=vault.records();reset();
const inventory=await vault.inspectDetachedOriginals(true,['2026-08'],lockedBaseline);
assert.equal(inventory.originals.length,0);
assert.equal(calls.read.filter(p=>p.includes('/statements/')).length,0);
assert.equal(calls.list.filter(p=>p==='payroll/statements/').length,1);
put('payroll/statements/2023.enc',annual([{...baseRecord(2023,'2023'),originalId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]));
await assert.rejects(vault.inspectDetachedOriginals(true,['2026-08'],lockedBaseline),/明細が照合中に変更/);
put('payroll/statements/2023.enc',annual([baseRecord(2023,'2023')]));
await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});reset();
console.log('PASS: scoped inventory proves full physical baseline and rejects foreign-year reference change');

let commits=0;
let reusedIncomeSource,knownExistingYear;
vault.storeOriginal=async()=>{};
vault.syncIncomeUnderLock=async(_years,_guard,reuse)=>{reusedIncomeSource=reuse;};
vault.commit=async(year,doc,_checkRemote,_checkIndex,known)=>{
 knownExistingYear=known;commits++;
 const next=put(`payroll/statements/${year}.enc`,doc),valid=structuredClone(doc);
 vault.shards.set(year,valid);
 vault.shardVersions.set(year,{id:next.id,etag:next.etag,size:next.size});
};
const input={...baseRecord(9876,'2026'),fileHash:hash,form:{...baseRecord(9876,'2026').form,targetMonth:'2026-08',paymentDate:'2026-09-27'},pdf:new Blob(['%PDF-1.7 synthetic no cloud'],{type:'application/pdf'})};
delete input.pdfSize;delete input.pdfType;delete input.originalId;delete input.originalMonth;
await vault.saveBatch([input]);
assert.equal(commits,1);
assert.equal(knownExistingYear,true,'batch must reuse just-verified existing year at commit entry');
assert.equal(reusedIncomeSource,true,'saveBatch passes its verified post-commit source to Finance');
assert.equal(calls.list.length,2,'one live inventory after originals and one after the annual commit');
assert.equal(calls.read.filter(p=>p.includes('/statements/')).length,0,'no unchanged annual ciphertext GET across both boundaries');
assert.equal(calls.read.filter(p=>p==='payroll/index.enc').length,2,'each remaining check must re-read the live root index');
assert.ok(vault.records().some(r=>r.id===9876));
console.log('PASS 1: saveBatch retains two fresh index + four-year ETag checks, zero unchanged annual downloads');
// A foreign-year collision after originals are verified must block commit and not downgrade to cached data.
const collision={...baseRecord(9999,'2024'),fileHash:'c'.repeat(64)};
const candidate={...input,id:9998,fileHash:collision.fileHash};
vault.storeOriginal=async()=>{const p='payroll/statements/2024.enc',current=JSON.parse(files.get(p).text);put(p,annual([...current.records,collision]));};
reset();const beforeCommit=commits;
await assert.rejects(vault.saveBatch([candidate]),/同じ明細またはID|同じ給与/);
assert.equal(commits,beforeCommit,'cross-year duplicate must be rejected before commit');
assert.equal(calls.read.filter(p=>p==='payroll/statements/2024.enc').length,1,'only modified year is downloaded and decrypted');
console.log('PASS 1: concurrent foreign-year duplicate fails closed after refreshing only changed annual JSON');
// Deleted indexed file aborts before a candidate is saved.
vault.storeOriginal=async()=>{files.delete('payroll/statements/2023.enc');};
reset();await assert.rejects(vault.saveBatch([{...input,id:9997,fileHash:'d'.repeat(64),form:{...input.form,targetMonth:'2026-11',paymentDate:'2026-12-27'}}]),/年度ファイルの一覧|年度メタデータ|年度ファイル/);
assert.equal(commits,beforeCommit);console.log('PASS 1: incomplete remote inventory fails closed, no annual commit');

// Old clients may bypass the lock while a target year is being committed.
// The remaining post-commit all-year boundary must still detect this change.
put('payroll/statements/2023.enc',annual([baseRecord(2023,'2023')]));
vault.storeOriginal=async()=>{};
await vault.refresh({forceFresh:true});
const baseline=vault.records(),commitOriginal=vault.commit;
let incomeCalled=false;vault.syncIncomeUnderLock=async()=>{incomeCalled=true;};
vault.commit=async(year,doc)=>{
 await commitOriginal(year,doc);
 const p='payroll/statements/2023.enc',foreign=JSON.parse(files.get(p).text);
 foreign.records[0].revision++;foreign.records[0].form.gross='121';put(p,foreign);
};
await assert.rejects(vault.saveBatch([{...input,id:9996,fileHash:'e'.repeat(64),form:{...input.form,targetMonth:'2026-10',paymentDate:'2026-11-27'}}],undefined,baseline),/明細または認証状態が変更/);
assert.equal(incomeCalled,false,'foreign-year change after commit must stop income publication');
console.log('PASS 1: foreign-year change during commit is caught by the post-commit boundary');


// 3: Dashboard download must call the edit-style pre/post signature + SHA-256 path.
const main=read('src/main.ts'),start=main.indexOf("download.addEventListener('click', async () =>"),end=main.indexOf("const edit = document.createElement('a')",start);
assert.ok(start>=0&&end>start);
const handler=main.slice(start,end);
assert.match(handler,/getOriginalForVerifiedEdit\(record\.id, recordSignature\(record\)\)/);
assert.doesNotMatch(handler,/\bgetRecord\(/);
assert.match(handler,/safePdfFileName\(record\.fileName\)/);
const store=read('src/storage/payrollStore.ts');
const checked=store.slice(store.indexOf('export async function getOriginalForVerifiedEdit('),store.indexOf('export async function getRecord('));
assert.equal((checked.match(/vault\.refresh\(\{forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,recordId:id\}\)/g)||[]).length,2);
assert.match(checked,/recordSignature\(latest\)!==expectedSignature/);
assert.match(checked,/vault\.original\(record\)/);
console.log('PASS 3: dashboard uses signed, pre/post ETag-checked, SHA-256-verified original download');

// 2 + 4: Actual YearEndRepository logic with an authenticated in-memory fake Graph.
const yfiles=new Map(),ycall={index:0,profile:0,annual:0,writes:0},yroot=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const ypath=(parts,name)=>[...parts,name].join('/');
const yput=(parts,name,value)=>{const p=ypath(parts,name);yfiles.set(p,toFile(p,value,'y-'+(++seq)));};
const yg={
 async withWriteLock(operation){return operation();},
 async read(parts,name){const p=ypath(parts,name);if(name==='index.enc')ycall.index++;else if(name==='profile.enc')ycall.profile++;else if(parts.includes('years'))ycall.annual++;return yfiles.get(p)??null;},
 async metadata(parts,name){const f=yfiles.get(ypath(parts,name));return f?{id:f.id,etag:f.etag,size:f.size}:null;},
 async listFolder(){return [];},
 async write(){ycall.writes++;throw new Error('test forbids all writes');}
};
const access={path:yroot,key,salt,graph:yg};let unlocked=true;
const sampleReplacement='%PDF-1.7 synthetic replacement';
const replacementHash=Buffer.from(await webcrypto.subtle.digest('SHA-256',enc.encode(sampleReplacement))).toString('hex');
const ycommon={...common,cloudVault:async()=>({yearEndAccess:async()=>access,isUnlocked:()=>unlocked,sessionKey:()=>({key,salt})}),
 encryptBytes:async()=>{throw new Error('must never upload an original');},
};
const api=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear})',ycommon);
const id=api.randomPersonId(),yearId=api.randomDocumentId(),foreignId=api.randomDocumentId(),docId=api.randomDocumentId(),otherDocId=api.randomDocumentId();
const stamp='2026-11-23T00:00:00Z';
const single=(rid,year,hash)=>({id:rid,personId:id,kind:'salary',paymentDate:`${year}-05-25`,targetMonth:`${year}-05`,taxable:200000,gross:200000,transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
 fileName:'synthetic.pdf',pdfSize:50,fileHash:hash,confirmedAt:stamp,updatedAt:stamp,source:'pdf-reviewed',revision:1,detectedName:null});
yput(yroot,'index.enc',{format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:stamp,updatedAt:stamp}]});
yput([...yroot,'persons',id],'profile.enc',{format:'payroll-year-end-person-v1',id,displayName:'合成氏名',alias:'',createdAt:stamp,updatedAt:stamp,yearFiles:{'2025':foreignId,'2026':yearId}});
yput([...yroot,'persons',id,'years'],yearId+'.enc',{...api.emptyYear(id,2026),documents:[single(docId,2026,'a'.repeat(64))]});
yput([...yroot,'persons',id,'years'],foreignId+'.enc',{...api.emptyYear(id,2025),documents:[single(otherDocId,2025,replacementHash)]});
const repo=new api.YearEndRepository();
const resetYear=()=>{Object.keys(ycall).forEach(k=>ycall[k]=0);};
resetYear();const view=await repo.yearWithOtherYearNames(id,2026);
assert.equal(view.data.documents.length,1);
assert.deepEqual([...await view.otherYearNames()],[]);
assert.equal(ycall.index,1,'only one live active-index read');
assert.equal(ycall.profile,1,'only one profile body GET for year + background names');
assert.equal(ycall.annual,2,'read current and foreign year once each');
console.log('PASS 2: year display + deferred detected-name compare share active index/profile without extra remote GET');
// No key use after vault is locked.
resetYear();const lockedView=await repo.yearWithOtherYearNames(id,2026);const beforeLocked={...ycall};unlocked=false;
await assert.rejects(lockedView.otherYearNames(),/ロック|変更/);
assert.equal(ycall.annual,beforeLocked.annual,'locked background job must not read other years');unlocked=true;
// 4: The replacement path must not call year() for every foreign year.
const repositorySource=read('src/yearEnd/repository.ts');
const replacementSection=repositorySource.slice(repositorySource.indexOf(' async updateDocument('),repositorySource.indexOf(' /** Delete one saved record'));
assert.match(replacementSection,/foreign\.slice\(offset,offset\+3\)\.map/);
assert.match(replacementSection,/validateYear\(remote\.value,id,Number\(y\)\)/);
assert.doesNotMatch(replacementSection,/this\.year\(/);
// Test actual duplicate rejection before encrypted upload; hash is synthetically computed.
const draft={kind:'salary',paymentDate:'2026-05-25',targetMonth:'2026-05',taxable:210000,gross:210000,transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,detectedName:null,warnings:[]};
const file=Object.assign(new Blob([sampleReplacement],{type:'application/pdf'}),{name:'replacement.pdf'});
resetYear();await assert.rejects(repo.updateDocument(id,2026,docId,draft,file),/別年度に同じPDF/);
assert.equal(ycall.index,1,'no per-year repeated employee-index loads during duplicate check');
assert.equal(ycall.profile,1,'no per-year repeated employee-profile loads during duplicate check');
assert.equal(ycall.annual,2,'both current year and foreign year must be authenticated');
assert.equal(ycall.writes,0,'duplicate must block original upload');
console.log('PASS 4: replacement detects foreign-year same PDF, one active index/profile read, no uploads');
const foreignPath=ypath([...yroot,'persons',id,'years'],foreignId+'.enc');
const savedForeign=yfiles.get(foreignPath);yfiles.delete(foreignPath);
resetYear();await assert.rejects(repo.updateDocument(id,2026,docId,draft,file),/別年度ファイルが見つかりません/);
assert.equal(ycall.writes,0,'missing foreign year must block replacement before original upload');
yfiles.set(foreignPath,savedForeign);
console.log('PASS 4: missing foreign-year file stops the replacement before any write');
console.log('PASS: Payroll second-round four-target synthetic audit completed');

// Real Finance sync with an unchanged registered year. A fresh pre/post
// source check is still required; the initial source and no-op registration
// are unnecessary after a verified payroll commit.
{
 const financeIndex={...index,incomeYears:['2026']};
 put('payroll/index.enc',financeIndex);
 put('payroll/statements/2026.enc',annual([baseRecord(2026,'2026')]));
 const financeVault=new PayrollVault(graph);financeVault.key=key;financeVault.salt=salt;financeVault.index=financeIndex;
 await financeVault.refresh({forceFresh:true});
 const expected={format:'payroll-income-v1',year:'2026',records:[{id:2026,paymentDate:'2026-06-01',targetMonth:'2026-05',job:'main',kind:'salary',netPaymentYen:100,grossPaymentYen:120,revision:1}]};
 put('payroll/income/2026.enc',expected);
 const sourceChecks=[];
 const refreshFinance=financeVault.refresh.bind(financeVault);
 financeVault.refresh=async options=>{sourceChecks.push({...options});return refreshFinance(options);};
 reset();await financeVault.syncIncomeUnderLock(new Set(['2026']),undefined,true);
 assert.equal(sourceChecks.length,2,'only the fresh pre/post source checks remain');
 for(const opts of sourceChecks){assert.equal(opts.forceFresh,true);assert.equal(opts.reuseVerifiedYears,true);assert.equal(opts.bulkYearMetadata,true);}
 assert.equal(sourceChecks[0].rememberNavigation,false,'prewrite must not serialize the navigation snapshot');
 assert.notEqual(sourceChecks[1].rememberNavigation,false,'final verification can publish the navigation snapshot');
 assert.equal(calls.list.length,2,'Finance pre/post source boundaries remain');
 assert.equal(calls.read.filter(p=>p==='payroll/index.enc').length,2,'no repeated initial source or registered-index no-op');
 // Simulate a change while Finance reads its previous projection. The next
 // source check must catch it before dispatching any stale write.
 const readGraph=graph.read,writeGraph=graph.write;let raced=false,writes=[];
 graph.read=async(parts,name)=>{const result=await readGraph(parts,name);if(!raced&&parts.includes('income')){raced=true;const next=baseRecord(2026,'2026');next.revision=2;next.form.gross='130';put('payroll/statements/2026.enc',annual([next]));}return result;};
 graph.write=async(parts,name,text,prior)=>{const p=[...parts,name].join('/');assert.equal(files.get(p)?.etag,prior?.etag);writes.push(JSON.parse(text));put(p,JSON.parse(text));};
 try{
  await financeVault.syncIncomeUnderLock(new Set(['2026']),undefined,true);
  assert.equal(writes.length,1);assert.equal(writes[0].records[0].revision,2);assert.equal(writes[0].records[0].grossPaymentYen,130);
 }finally{graph.read=readGraph;graph.write=writeGraph;}
 console.log('PASS: verified Finance source reuse keeps both fresh boundaries and retries changed source before writing');
 // Single-year deletion uses the original locked snapshot for its first year.
 await financeVault.refresh({forceFresh:true});
 financeVault.commit=async(year,doc,checkRemote,_checkIndex,known)=>{assert.equal(known,true);const current=JSON.parse(files.get(`payroll/statements/${year}.enc`).text);checkRemote(current);put(`payroll/statements/${year}.enc`,doc);};
 financeVault.syncIncomeUnderLock=async(_years,guard,reuse)=>{assert.equal(reuse,true);guard();};
 graph.markUploadCheckpoint=async()=>{};
 reset();await financeVault.removeBatch([{id:2026,matches:row=>row.revision===2}]);
 assert.equal(calls.list.length,2,'single-year delete needs initial and final full inventory, not a duplicate first inventory');
 assert.equal(financeVault.records().some(row=>row.id===2026),false);
 console.log('PASS: deletion reuses its initial locked inventory and retains post-commit validation');
}

// Actual approval planning, using an in-memory source. An intervening change
// after preview must stop before entering the write-lock path.
{
 const entry={id:'emp_'+'a'.repeat(32),name:'Synthetic employer',role:'main',current:true};
 const directory=[entry],signature=employerDirectorySignature(directory);
 let row=baseRecord(2026,'2026'),reads=0,writes=0,authorized=true;
 const fake={async refresh(options){reads++;assert.equal(options.forceFresh,true);assert.equal(options.rememberNavigation,false);options.onEmployerDirectory(directory);return [structuredClone(row)];},assertEmployerAssignmentConsistency(){},async assignEmployerBatch(){writes++;return [row];}};
 const start=store.indexOf('export function recordSignature('),end=store.indexOf('const conflicts=',start);
 const a=store.indexOf('async function planEmployerAssignment('),b=store.indexOf('/** Read-only additive restore plan',a);
 const c=store.indexOf('const physicalRestoreSnapshot='),d=store.indexOf('async function planAdditiveRestore',c);
 const api=runInNewContext(strip(store.slice(start,end)+store.slice(a,b)+store.slice(c,d))+'\n({recordSignature,inspectEmployerAssignment,assignEmployers})',{MAX_RECORDS:2000,employerAssignmentSignature,cloudVault:async()=>fake});
 const targets=[{id:row.id,signature:api.recordSignature(row)}],guard=()=>authorized;
 const plan=await api.inspectEmployerAssignment(targets,entry.id,signature,guard);
 assert.equal(reads,1,'one pre-consent inventory');assert.equal(writes,0);
 row={...row,revision:2};await assert.rejects(api.assignEmployers(targets,entry.id,signature,plan.signature,guard),/対象明細が変更/);assert.equal(writes,0);
 row=baseRecord(2026,'2026');await api.assignEmployers(targets,entry.id,signature,plan.signature,guard);assert.equal(writes,1);assert.equal(reads,3);
 authorized=false;await assert.rejects(api.assignEmployers(targets,entry.id,signature,plan.signature,guard),/認証状態/);assert.equal(writes,1);
 console.log('PASS: one preview refresh, fresh post-consent check, changed revision and authorization refusal');
}
// Full real assignment and Finance sync (mock Graph only). Keep the final
// observation after the Finance identity sweep, but skip intermediate snapshots.
{
 const entry={id:'emp_'+'b'.repeat(32),name:'Synthetic employer',role:'main',current:true};
 const directory=[entry],assignmentIndex={...index,incomeYears:['2026'],employers:directory};
 put('payroll/index.enc',assignmentIndex);
 for(const y of years)put(`payroll/statements/${y}.enc`,annual([baseRecord(Number(y),y)]));
 const assignmentVault=new PayrollVault(graph);assignmentVault.key=key;assignmentVault.salt=salt;assignmentVault.index=assignmentIndex;
 const initial=await assignmentVault.refresh({forceFresh:true});
 const observations=[],originalRefresh=assignmentVault.refresh.bind(assignmentVault),originalWrite=graph.write;
 assignmentVault.refresh=async options=>{observations.push({...options});return originalRefresh(options);};
 assignmentVault.commit=async(year,doc,checkRemote,checkIndex)=>{
  const path=`payroll/statements/${year}.enc`;checkRemote(JSON.parse(files.get(path).text));checkIndex(assignmentIndex);
  const next=put(path,doc);assignmentVault.shards.set(year,structuredClone(doc));assignmentVault.shardVersions.set(year,{id:next.id,etag:next.etag,size:next.size});
 };
 graph.write=async(parts,name,text,prior)=>{const p=[...parts,name].join('/');assert.equal(files.get(p)?.etag,prior?.etag);put(p,JSON.parse(text));};
 try{
  const result=await assignmentVault.assignEmployerBatch(initial,[2026],entry.id,employerDirectorySignature(directory),()=>true);
  assert.equal(result.find(r=>r.id===2026).employerId,entry.id);assert.equal(result.find(r=>r.id===2026).revision,2);
  assert.equal(observations.length,5,'locked baseline, post-commit, Finance pre/postwrite and final observation');
  assert.ok(observations.slice(0,3).every(o=>o.rememberNavigation===false));assert.notEqual(observations[3].rememberNavigation,false);assert.equal(observations[4].rememberNavigation,true);
  assert.equal(JSON.parse(files.get('payroll/income/2026.enc').text).records[0].employerId,entry.id);
  // A legacy writer can change an annual file during the final Finance
  // identity sweep without changing the root index. The last source check
  // must still detect it, not report the previous result as successful.
  put('payroll/statements/2026.enc',annual([baseRecord(2026,'2026')]));
  const baseline=await assignmentVault.refresh({forceFresh:true});
  const originalMetadata=graph.metadata;let raced=false,incomeMetadata=0;
  graph.metadata=async(parts,name)=>{
   const result=await originalMetadata(parts,name);
   if(!raced&&parts.includes('income')&&++incomeMetadata===2){
    raced=true;const path='payroll/statements/2026.enc',live=JSON.parse(files.get(path).text);
    live.records[0].revision++;live.records[0].form.gross='140';put(path,live);
   }
   return result;
  };
  try{await assert.rejects(assignmentVault.assignEmployerBatch(baseline,[2026],entry.id,employerDirectorySignature(directory),()=>true));assert.equal(raced,true);}
  finally{graph.metadata=originalMetadata;}
 }finally{graph.write=originalWrite;}
 console.log('PASS: assignment skips intermediate snapshots and retains final authenticated source observation');
}

// A real existing-year commit keeps a fresh conditional proof, but need not
// download unchanged annual ciphertext a second time before writing.
{
 put('payroll/index.enc',index);
 for(const y of years)put(`payroll/statements/${y}.enc`,annual([baseRecord(Number(y),y)]));
 const writer=new PayrollVault(graph);writer.key=key;writer.salt=salt;writer.index=index;
 await writer.refresh({forceFresh:true});reset();
 let probes=0,writes=0;
 const savedWrite=graph.write;
 graph.readIfChanged=async(parts,name,_limit,proof,direct)=>{
  if(parts.includes("statements")){assert.equal(direct,true);probes++;}
  const live=files.get([...parts,name].join('/'));
  return live&&live.id===proof.id&&live.etag===proof.etag&&live.size===proof.size?undefined:live??null;
 };
 graph.write=async(parts,name,text,prior)=>{
  const p=[...parts,name].join('/');assert.equal(prior.etag,files.get(p).etag);writes++;put(p,JSON.parse(text));
 };
 try{
  const next=annual([{...baseRecord(2026,'2026'),revision:2,form:{...baseRecord(2026,'2026').form,gross:'140'}}]);
  await writer.commit('2026',next,undefined,undefined,true);
  assert.equal(probes,1);assert.equal(writes,1);
  assert.equal(calls.read.filter(p=>p.includes('/statements/')).length,1,'only the mandatory postwrite readback downloads the year');
  assert.equal(writer.records().find(r=>r.id===2026).form.gross,'140');
  reset();
  const live=JSON.parse(files.get('payroll/statements/2026.enc').text);live.records[0].revision=3;put('payroll/statements/2026.enc',live);
  await assert.rejects(writer.commit('2026',next,remote=>{if(remote.records[0].revision!==2)throw Error('synthetic remote changed');},undefined,true),/synthetic remote changed/);
  assert.equal(writes,1,'a changed live year is validated before any write');
 }finally{graph.write=savedWrite;delete graph.readIfChanged;}
 console.log('PASS: annual commit reuses only a freshly matched version, retains conditional write and authenticated readback');
}

// R13: actual removal and move source use the existing conditional-year
// path, and a changed source after the target write must not be removed.
{
 const oldWrite=graph.write;
 try{
  for(const mode of ['remove','batch','move','move-race']){
   put('payroll/index.enc',index);
   for(const y of years)put(`payroll/statements/${y}.enc`,annual([baseRecord(Number(y),y)]));
   const v=new PayrollVault(graph);v.key=key;v.salt=salt;v.index=index;
   v.syncIncomeUnderLock=async()=>{};
   let probes=[],writes=[];
   graph.readIfChanged=async(parts,name,_limit,proof,direct)=>{
    if(parts.includes('statements')){assert.equal(direct,true);probes.push(name);}
    const live=files.get([...parts,name].join('/'));
    return live&&live.id===proof.id&&live.etag===proof.etag&&live.size===proof.size?undefined:live??null;
   };
   graph.write=async(parts,name,text,prior)=>{
    const path=[...parts,name].join('/');assert.equal(prior.etag,files.get(path).etag);writes.push(name);put(path,JSON.parse(text));
    if(mode==='move-race'&&name==='2025.enc'){
     const source=JSON.parse(files.get('payroll/statements/2026.enc').text);source.records[0].revision=9;put('payroll/statements/2026.enc',source);
    }
   };
   const expected=r=>r.revision===1;
   if(mode==='remove')await v.remove(2026,expected);
   else if(mode==='batch')await v.removeBatch([{id:2026,matches:expected}]);
   else{
    const row=baseRecord(2026,'2026');const next={...row,revision:2,form:{...row.form,targetMonth:'2025-05'}};
    if(mode==='move-race')await assert.rejects(v.save(next,undefined,expected),/year-move/);
    else await v.save(next,undefined,expected);
   }
   assert.ok(probes.includes('2026.enc'),'source commit uses fresh conditional year observation');
   const source=JSON.parse(files.get('payroll/statements/2026.enc').text);
   if(mode==='move-race'){assert.deepEqual(writes,['2025.enc']);assert.equal(source.records[0].revision,9);}
   else {assert.ok(writes.includes('2026.enc'));assert.equal(source.records.length,0);assert.ok(source.deleted.includes(2026));}
  }
 }finally{graph.write=oldWrite;delete graph.readIfChanged;}
 console.log('PASS R13: actual remove, removeBatch and move source conditional checks, source race preserves changed record');
}
