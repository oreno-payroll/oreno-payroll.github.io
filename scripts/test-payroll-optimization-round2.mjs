/** Payroll second-round performance/security regression. Fake Graph only, no credentials or writes. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
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
 async read(parts,name){const p=[...parts,name].join('/');calls.read.push(p);return files.get(p)??null;},
 async metadata(parts,name){const p=[...parts,name].join('/');calls.meta.push(p);const f=files.get(p);return f?{id:f.id,etag:f.etag,size:f.size}:null;},
 async listFolder(parts){const p=parts.join('/')+'/';calls.list.push(p);return [...files.entries()].filter(([n])=>n.startsWith(p)&&!n.slice(p.length).includes('/')).map(([name,f])=>({name:name.slice(p.length),folder:false,id:f.id,etag:f.etag,size:f.size}));},
 async write(){throw Error('No real or fake write must happen; commit is explicitly mocked.');}
};
const common={crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,Buffer,Blob,Promise,Map,Set,WeakMap,structuredClone,performance,
 envelopeSalt:()=>salt,parseEnvelope:()=>({salt}),decryptJson:async(_kind,value)=>JSON.parse(value),encryptJson:async(_kind,value)=>JSON.stringify(value),decryptBytes:async()=>new Uint8Array(),
 fiscalYearOfTargetMonth:v=>Number(v.slice(0,4)),isValidPayrollSemantics:()=>true,payrollPeriodKey:r=>r.paymentDate,
 isCollision:()=>false,beginPerfOperation:()=>({measure:async(_,fn)=>fn(),finish(){}}),
 clearNavigationSnapshot:()=>{},rememberNavigationSnapshot:async()=>{},restoredNavigationSnapshot:async()=>null,
 MAX_RECORDS:2000,MAX_TOTAL_PDF_BYTES:500e6,toPublicIncomeRecord:()=>{},PayrollPartialSuccessError:class extends Error{},setTimeout};
const {PayrollVault}=runInNewContext(strip(read('src/cloud/vault.ts'))+'\n({PayrollVault})',common);
const vault=new PayrollVault(graph);vault.key=key;vault.salt=salt;vault.index=index;
await vault.refresh({forceFresh:true});reset();
let commits=0;
vault.storeOriginal=async()=>{};
vault.syncIncome=async()=>{};
vault.commit=async(year,doc)=>{
 commits++;
 const next=put(`payroll/statements/${year}.enc`,doc),valid=structuredClone(doc);
 vault.shards.set(year,valid);
 vault.shardVersions.set(year,{id:next.id,etag:next.etag,size:next.size});
};
const input={...baseRecord(9876,'2026'),fileHash:hash,form:{...baseRecord(9876,'2026').form,targetMonth:'2026-08',paymentDate:'2026-09-27'},pdf:new Blob(['%PDF-1.7 synthetic no cloud'],{type:'application/pdf'})};
delete input.pdfSize;delete input.pdfType;delete input.originalId;delete input.originalMonth;
await vault.saveBatch([input]);
assert.equal(commits,1);
assert.equal(calls.list.length,3,'three independent live all-year inventory boundaries must remain');
assert.equal(calls.read.filter(p=>p.includes('/statements/')).length,0,'no unchanged annual ciphertext GET across all three boundaries');
assert.equal(calls.read.filter(p=>p==='payroll/index.enc').length,3,'each check must re-read the live root index');
assert.ok(vault.records().some(r=>r.id===9876));
console.log('PASS 1: saveBatch retains three fresh index + four-year ETag checks, zero unchanged annual downloads');
// A foreign-year collision after originals are verified must block commit and not downgrade to cached data.
const collision={...baseRecord(9999,'2024'),fileHash:'c'.repeat(64),form:{...baseRecord(9999,'2024').form,targetMonth:'2026-10',paymentDate:'2026-10-27'}};
const candidate={...input,id:9998,fileHash:collision.fileHash,form:collision.form};
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

// 3: Dashboard download must call the edit-style pre/post signature + SHA-256 path.
const main=read('src/main.ts'),start=main.indexOf("download.addEventListener('click', async () =>"),end=main.indexOf("const edit = document.createElement('a')",start);
assert.ok(start>=0&&end>start);
const handler=main.slice(start,end);
assert.match(handler,/getOriginalForVerifiedEdit\(record\.id, recordSignature\(record\)\)/);
assert.doesNotMatch(handler,/\bgetRecord\(/);
assert.match(handler,/safePdfFileName\(record\.fileName\)/);
const store=read('src/storage/payrollStore.ts');
const checked=store.slice(store.indexOf('export async function getOriginalForVerifiedEdit('),store.indexOf('export async function getRecord('));
assert.equal((checked.match(/vault\.refresh\(\{forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true\}\)/g)||[]).length,2);
assert.match(checked,/recordSignature\(latest\)!==expectedSignature/);
assert.match(checked,/vault\.original\(record\)/);
console.log('PASS 3: dashboard uses signed, pre/post ETag-checked, SHA-256-verified original download');

// 2 + 4: Actual YearEndRepository logic with an authenticated in-memory fake Graph.
const yfiles=new Map(),ycall={index:0,profile:0,annual:0,writes:0},yroot=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const ypath=(parts,name)=>[...parts,name].join('/');
const yput=(parts,name,value)=>{const p=ypath(parts,name);yfiles.set(p,toFile(p,value,'y-'+(++seq)));};
const yg={
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
