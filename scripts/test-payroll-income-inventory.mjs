/** Finance source-inventory regression: synthetic content and in-memory Graph only.
 * No real account, OAuth, PDF, localStorage, remote network or OneDrive writes. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const strip=source=>stripTypeScriptTypes(source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const textEncoder=new TextEncoder();
const yearList=['2023','2024','2025','2026'];
const path=(parts,name)=>[...parts,name].join('/');
const info={format:'payroll-index-v1',years:[...yearList],incomeYears:[]};
let seq=0;
const files=new Map();
const calls={read:[],meta:[],listed:[],write:[]};
const put=(parts,name,obj)=>{
 const k=path(parts,name),text=JSON.stringify(obj);
 files.set(k,{id:k,etag:`revision-${++seq}`,size:textEncoder.encode(text).length,text});
};
const salary=(id,month)=>({
 id,revision:1,savedAt:'2026-01-01',fileName:'synthetic.pdf',
 originalId:'00000000-0000-4000-8000-000000000001',originalMonth:month,
 pdfSize:128,pdfType:'application/pdf',fileHash:'a'.repeat(64),pages:1,
 form:{targetMonth:month,paymentDate:month+'-27',job:'main',kind:'salary',net:'100',gross:'120',taxable:'110'},
});
const replaceYear=(year,records)=>put(['payroll','statements'],`${year}.enc`,{format:'payroll-annual-v1',records,deleted:[]});
const base2026=[salary(2026,'2026-05')];
const initial=()=>{
 files.clear();seq=0;
 put(['payroll'],'index.enc',{...info});
 for(const year of yearList)replaceYear(year,year==='2026'?base2026:[salary(Number(year),`${year}-05`)]);
};
const reset=()=>{calls.read.length=0;calls.meta.length=0;calls.listed.length=0;calls.write.length=0;};
const graph={
 hookRead:null,hookList:null,hookAfterWrite:null,
 async read(parts,name){
  const k=path(parts,name);calls.read.push(k);
  if(this.hookRead)await this.hookRead(k);
  const file=files.get(k);return file?{...file}:null;
 },
 async metadata(parts,name){
  const k=path(parts,name);calls.meta.push(k);
  const file=files.get(k);return file?{id:file.id,etag:file.etag,size:file.size}:null;
 },
 async listFolder(parts){
  const parent=parts.join('/');calls.listed.push(parent);
  let entries=[...files.entries()].filter(([k])=>k.startsWith(parent+'/')&&!k.slice(parent.length+1).includes('/')).map(([k,v])=>({id:v.id,name:k.slice(parent.length+1),etag:v.etag,folder:false,size:v.size}));
  if(this.hookList)entries=await this.hookList(entries);
  return entries;
 },
 async write(parts,name,text,prior){
  const k=path(parts,name),old=files.get(k);calls.write.push(k);
  if(prior?old?.etag!==prior.etag:Boolean(old))throw new Error('ETag collision');
  const obj=JSON.parse(text);
  put(parts,name,obj);
  if(this.hookAfterWrite)await this.hookAfterWrite(k);
 },
};
const sandbox={
 crypto:webcrypto,Blob,TextEncoder,TextDecoder,Uint8Array,Map,Set,WeakMap,Promise,Number,Date,Error,JSON,Buffer,
 structuredClone,performance,
 envelopeSalt:()=> 'synthetic-salt',parseEnvelope:()=>({salt:'synthetic-salt'}),
 encryptJson:async(_,data)=>JSON.stringify(data),decryptJson:async(_,value)=>JSON.parse(value),
 clearNavigationSnapshot:()=>{},rememberNavigationSnapshot:async()=>{},restoredNavigationSnapshot:async()=>null,
 isCollision:error=>error?.message==='ETag collision',
 fiscalYearOfTargetMonth:month=>Number(month.slice(0,4)),isValidPayrollSemantics:()=>true,
 payrollPeriodKey:r=>r.form.paymentDate,toPublicIncomeRecord:undefined,
 MAX_RECORDS:10000,MAX_TOTAL_PDF_BYTES:1_000_000_000,
 beginPerfOperation:()=>({measure:async(_name,work)=>work(),finish:()=>{}}),
 PayrollPartialSuccessError:class PayrollPartialSuccessError extends Error{},
};
const api=runInNewContext(strip(read('src/cloud/income.ts'))+'\n'+strip(read('src/cloud/vault.ts'))+'\n({PayrollVault, toPublicIncomeRecord})',sandbox);
const vault=new api.PayrollVault(graph);
const unlock=()=>{
 vault.key={type:'synthetic-nonextractable'};vault.salt='synthetic-salt';vault.index={...info};
};
initial();unlock();
await vault.refresh({forceFresh:true});
assert.equal(calls.read.filter(x=>x.includes('/statements/')).length,4,'first load decrypts all four years');
reset();
await vault.syncIncome(new Set(['2026']));
assert.equal(calls.listed.length,3,'income source checked at start, immediately pre-write, and after write');
assert.ok(calls.listed.every(p=>p==='payroll/statements'));
assert.equal(calls.meta.filter(p=>p.includes('/statements/')).length,0,'bulk inventory avoids N per-file year metadata GETs');
assert.equal(calls.read.filter(x=>x.includes('/statements/')).length,0,'unchanged year bodies never redownload');
assert.deepEqual(calls.write,['payroll/income/2026.enc','payroll/index.enc']);
const published=JSON.parse(files.get('payroll/income/2026.enc').text);
assert.deepEqual(published.records.map(r=>r.id),[2026]);
console.log('PASS: 4 years × 3 checkpoints use 3 fresh folder listings, zero year metadata GETs/body downloads');
// A source changed after the first source check but BEFORE the income read.
// The prewrite listing catches it, retries, and publishes the new source.
initial();unlock();await vault.refresh({forceFresh:true});reset();
let raced=false;
graph.hookRead=async key=>{
 if(key==='payroll/income/2026.enc'&&!raced){
  raced=true;replaceYear('2026',[...base2026,salary(3001,'2026-06')]);
 }
};
await vault.syncIncome(new Set(['2026']));
graph.hookRead=null;
assert.equal(raced,true);
assert.deepEqual(JSON.parse(files.get('payroll/income/2026.enc').text).records.map(r=>r.id),[2026,3001]);
assert.equal(calls.write.filter(s=>s.includes('/income/')).length,1,'racing source never publishes the old candidate');
assert.equal(calls.read.filter(s=>s.includes('/statements/')).length,1,'only the changed source year is reloaded');
console.log('PASS: raced source year triggers authenticated body reload and fresh Finance publication');
// Unchanged remote years must never use a returned stale/malformed inventory.
for(const invalid of ['missing','duplicate','size','folder']){
 initial();unlock();await vault.refresh({forceFresh:true});reset();
 graph.hookList=async entries=>{
  if(invalid==='missing')return entries.filter(x=>x.name!=='2025.enc');
  if(invalid==='duplicate')return [...entries,entries.find(x=>x.name==='2025.enc')];
  if(invalid==='size')return entries.map(x=>x.name==='2025.enc'?{...x,size:0}:x);
  if(invalid==='folder')return entries.map(x=>x.name==='2025.enc'?{...x,folder:true}:x);
  return entries;
 };
 await assert.rejects(vault.syncIncome(new Set(['2026'])),/年度ファイルの一覧|年度メタデータ/);
 assert.equal(calls.write.length,0,`${invalid} inventory must not write Finance income`);
 graph.hookList=null;
}
console.log('PASS: missing/duplicate/zero-length/folder entries fail closed with no income write');
// Changing the generation of the encrypted index cannot reuse a previous year proof.
initial();unlock();await vault.refresh({forceFresh:true});reset();
graph.hookList=async entries=>{
 const idx=JSON.parse(files.get('payroll/index.enc').text);
 put(['payroll'],'index.enc',{...idx,generation:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
 graph.hookList=null;
 return entries;
};
await assert.rejects(vault.syncIncome(new Set(['2026'])),/保存世代/);
assert.equal(calls.write.length,0,'generation change prevents income write');
console.log('PASS: index generation change is rejected at next source validation');

// If a source changes between the folder listing and the actual read, the
// listed ETag and the decrypted document must agree or publication is blocked.
initial();unlock();await vault.refresh({forceFresh:true});reset();
// Make 2025 differ from its verified cache so refresh must download it.
replaceYear('2025',[salary(2025,'2025-05'),salary(4000,'2025-06')]);
let changedDuringRead=false;
graph.hookRead=async key=>{
 if(key==='payroll/statements/2025.enc'&&!changedDuringRead){
  changedDuringRead=true;
  replaceYear('2025',[salary(2025,'2025-05'),salary(4000,'2025-06'),salary(4001,'2025-07')]);
 }
};
await assert.rejects(vault.syncIncome(new Set(['2026'])),/一覧照合中に更新/);
graph.hookRead=null;
assert.equal(changedDuringRead,true);
assert.equal(calls.write.length,0,'mismatched list/body ETags must never publish');
console.log('PASS: ETag changed between directory listing and file download fails closed');
// Source years can be added by another tab. The encrypted index still dictates
// the complete set, including a new source year with the requested income year.
initial();unlock();await vault.refresh({forceFresh:true});reset();
const indexWithExtra={...info,years:[...yearList,'2027']};
put(['payroll'],'index.enc',indexWithExtra);
replaceYear('2027',[salary(5000,'2026-09')]);
await vault.syncIncome(new Set(['2026']));
assert.deepEqual(JSON.parse(files.get('payroll/income/2026.enc').text).records.map(r=>r.id),[2026,5000]);
assert.equal(calls.read.filter(k=>k.endsWith('2027.enc')&&k.includes('statements')).length,1);
console.log('PASS: newly indexed source year is fetched and its payroll income is included');

// A concurrent source change AFTER the income ETag write must trigger the
// mandatory postwrite revalidation and a retry with the newly observed source.
initial();unlock();await vault.refresh({forceFresh:true});reset();
let mutatedAfterCommit=false;
graph.hookAfterWrite=async key=>{
 if(key==='payroll/income/2026.enc'&&!mutatedAfterCommit){
  mutatedAfterCommit=true;replaceYear('2026',[...base2026,salary(6000,'2026-08')]);
 }
};
await vault.syncIncome(new Set(['2026']));
graph.hookAfterWrite=null;
assert.equal(mutatedAfterCommit,true);
assert.deepEqual(JSON.parse(files.get('payroll/income/2026.enc').text).records.map(r=>r.id),[2026,6000]);
assert.equal(calls.write.filter(k=>k.includes('/income/')).length,2,'postwrite source race must be corrected with a verified retry');
console.log('PASS: change after income write is caught by postwrite metadata and repaired via ETag-safe retry');

// Test adapters without the collection API preserve the previous metadata
// checks, rather than falling back to an unvalidated memory cache.
initial();unlock();await vault.refresh({forceFresh:true});reset();
const listing=graph.listFolder;
graph.listFolder=undefined;
try{
 await vault.syncIncome(new Set(['2026']));
 assert.equal(calls.listed.length,0);
 assert.equal(calls.meta.filter(k=>k.includes('/statements/')).length,12);
}finally{graph.listFolder=listing;}
console.log('PASS: unavailable folder listing uses the original 3×N metadata checks');

// The repository's old per-year metadata path remains available for every
// normal refresh and for test Graph adapters without listFolder.
initial();unlock();await vault.refresh({forceFresh:true});reset();
await vault.refresh({forceFresh:true,reuseVerifiedYears:true});
assert.equal(calls.meta.filter(s=>s.includes('/statements/')).length,4);
assert.equal(calls.listed.length,0,'ordinary reads are unaffected by the income-only optimization');
console.log('PASS: non-income refresh retains existing per-file ETag confirmation');
