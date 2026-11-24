/** F: cross-page read-only exports reuse an authenticated encrypted annual snapshot.
 * Purely synthetic: no login, no Graph network, no real PDF, no cloud writes.
 * Uses Node's TypeScript stripper rather than esbuild for this test.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(root+p,'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const salt='only-synthetic-salt',key={nonExtractable:true},scope='client:synthetic-id';
const years=['2023','2024','2025','2026'];
const encoder=new TextEncoder(),pdf=encoder.encode('%PDF-1.7\nF entirely synthetic\n%%EOF');
const hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',pdf)).toString('hex');
const form=year=>({targetMonth:`${year}-05`,paymentDate:`${year}-06-01`,job:'side',kind:'salary',net:'220000',gross:'250000',taxable:'250000'});
const originalId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const record=(year,revision=1)=>({id:Number(year),revision,form:form(year),savedAt:'2026-06-01',fileName:`synthetic-${year}.pdf`,
 originalId,originalMonth:'2026-05',pdfSize:pdf.length,pdfType:'application/pdf',fileHash:hash,pages:1,warningsAcknowledged:true});
const index={format:'payroll-index-v1',years:[...years],incomeYears:[]};
const document=records=>({format:'payroll-annual-v1',records,deleted:[]});
const files=new Map();let serial=0,snapshot=null;
const put=(path,content)=>{const text=typeof content==='string'?content:JSON.stringify(content);
 files.set(path,{id:path,etag:'etag-'+(++serial),size:encoder.encode(text).length,text});};
put('payroll/index.enc',index);
for(const year of years)put(`payroll/statements/${year}.enc`,document([record(year)]));
put(`payroll/originals/2026/05/${originalId}.enc`,'encrypted-only-synthetic-pdf');
const calls={read:[],metadata:[],inventory:[],write:0};let originalHook=null,inventoryHook=null;
const graph={
 async read(parts,name){const path=[...parts,name].join('/');calls.read.push(path);
  if(path.includes('/originals/')&&originalHook)await originalHook(path);
  const file=files.get(path);return file?{...file}:null;},
 async metadata(parts,name){const path=[...parts,name].join('/');calls.metadata.push(path);
  const file=files.get(path);return file?{id:file.id,etag:file.etag,size:file.size}:null;},
 async listFolder(parts){const prefix=parts.join('/')+'/';calls.inventory.push(prefix);
  let result=[...files.entries()].filter(([path])=>path.startsWith(prefix)&&!path.slice(prefix.length).includes('/'))
   .map(([path,file])=>({name:path.slice(prefix.length),id:file.id,etag:file.etag,size:file.size,folder:false}));
  if(inventoryHook)result=await inventoryHook(result);
  return result;},
 async write(){calls.write++;throw new Error('read-only test must never write');}
};
const reset=()=>{calls.read.length=0;calls.metadata.length=0;calls.inventory.length=0;calls.write=0;};
const countAnnual=()=>calls.read.filter(path=>path.includes('/statements/')).length;
const countIndex=()=>calls.read.filter(path=>path==='payroll/index.enc').length;
const countPdf=()=>calls.read.filter(path=>path.includes('/originals/')).length;
const common={crypto:webcrypto,structuredClone,TextEncoder,TextDecoder,Uint8Array,Buffer,Blob,Map,Set,WeakMap,Promise,console,performance,
 envelopeSalt:()=>salt,parseEnvelope:()=>({salt}),decryptJson:async(_kind,text)=>JSON.parse(text),encryptJson:async(_kind,data)=>JSON.stringify(data),decryptBytes:async()=>pdf,
 isCollision:()=>false,clearNavigationSnapshot:()=>{snapshot=null},rememberNavigationSnapshot:async(s,t,k,data)=>{snapshot={s,t,k,data,expires:Date.now()+120000}},
 restoredNavigationSnapshot:async(s,t,k)=>snapshot&&snapshot.s===s&&snapshot.t===t&&snapshot.k===k&&snapshot.expires>Date.now()?snapshot:null,
 fiscalYearOfTargetMonth:v=>Number(v.slice(0,4)),isValidPayrollSemantics:()=>true,validEmployerId:v=>v===undefined||/^emp_[0-9a-f]{32}$/.test(v),payrollPeriodKey:r=>r.form.paymentDate,
 beginPerfOperation:()=>({measure:async(_,fn)=>fn(),finish(){}}),MAX_RECORDS:2000,MAX_TOTAL_PDF_BYTES:1e9,
 PayrollPartialSuccessError:class extends Error{},toPublicIncomeRecord:()=>{throw Error('not needed')},setTimeout};
const {PayrollVault}=runInNewContext(strip(read('src/cloud/vault.ts'))+'\n({PayrollVault})',common);
let current;
const api=runInNewContext(strip(read('src/storage/payrollStore.ts'))+'\n({loadRecordSummaries,loadRecords,recordSignature})',{
 ...common,cloudVault:async()=>current,validatePayrollForm:()=>({errors:[],warnings:[]}),MAX_PDF_SIZE:50e6,
});
const first=new PayrollVault(graph);first.key=key;first.salt=salt;first.index=index;first.setNavigationScope(scope);
await first.refresh({forceFresh:true});
assert.equal(countAnnual(),4);assert.equal(snapshot?.data.versions.length,4,'CE verified ETags are embedded in the encrypted snapshot');
const returned=new PayrollVault(graph);returned.setNavigationScope(scope);
assert.equal(await returned.resumeFromSnapshot(key,salt),true);current=returned;
reset();
const homeList=await api.loadRecordSummaries();
assert.equal(homeList.length,4);
assert.deepEqual({index:countIndex(),annual:countAnnual(),inventory:calls.inventory.length,pdf:countPdf(),writes:calls.write},{index:1,annual:0,inventory:1,pdf:0,writes:0},
 'F: side ZIP source check revalidates index + all annual ETags, no unchanged annual downloads');
console.log('PASS F: home side-ZIP before/after source check reuses verified ETags after navigation');
reset();const stages=[];
const exported=await api.loadRecords((done,total)=>stages.push(`${done}/${total}`));
assert.equal(exported.length,4);assert.equal(stages.length,4);
assert.ok(exported.every(row=>row.pdf instanceof Blob&&row.pdf.size===pdf.length));
assert.deepEqual({index:countIndex(),annual:countAnnual(),inventory:calls.inventory.length,pdf:countPdf(),writes:calls.write},
 {index:2,annual:0,inventory:2,pdf:4,writes:0},
 'F: backup must check global ETags twice but reuse unchanged annual JSON; PDFs still authenticated');
console.log('PASS F: backup checks all years before/after, downloads all PDF originals, no unchanged annual JSON');
// During PDF retrieval a second device modifies only one annual JSON; reject the backup.
let updated=false;
originalHook=async()=>{if(updated)return;updated=true;put('payroll/statements/2024.enc',document([{
 ...record('2024',2),form:{...form('2024'),net:'190000'},
}]));};
reset();
await assert.rejects(api.loadRecords(),/バックアップ中に明細が更新/);
assert.equal(updated,true);assert.equal(countAnnual(),1,'only the changed year must be read and decrypted');
assert.equal(calls.inventory.length,2,'both consistency boundaries must run');assert.equal(calls.write,0);
originalHook=null;
console.log('PASS F: cross-device mid-backup update fails closed even if only one year changes');
// A removed indexed year must block download before any original is returned.
inventoryHook=async rows=>rows.filter(item=>item.name!=='2025.enc');reset();
await assert.rejects(api.loadRecords(),/年度ファイルの一覧|年度メタデータ/);
assert.equal(countPdf(),0);assert.equal(calls.write,0);inventoryHook=null;
console.log('PASS F: incomplete annual inventory aborts before any PDF export');
// Old pre-CE encrypted snapshots contain no proof of annual IDs / ETags; full fallback required.
const legacy={index,years:years.map(year=>[year,document([year==='2024'?{
 ...record('2024',2),form:{...form('2024'),net:'190000'},
}:record(year)])])};
snapshot={s:scope,t:salt,k:key,data:legacy,expires:Date.now()+120000};
const old=new PayrollVault(graph);old.setNavigationScope(scope);
assert.equal(await old.resumeFromSnapshot(key,salt),true);current=old;reset();
assert.equal((await api.loadRecordSummaries()).length,4);
assert.equal(countAnnual(),4,'legacy snapshot must NOT bypass any annual decrypt');
assert.equal(calls.inventory.length,0,'without verified ETags the safe per-year read path is used');
console.log('PASS F: legacy snapshot without verified year versions falls back to full cloud reads');
// Another account cannot reuse an account-scoped snapshot. Lock invalidates it.
const wrong=new PayrollVault(graph);wrong.setNavigationScope('client:another-account');
assert.equal(await wrong.resumeFromSnapshot(key,salt),false);
old.lock();assert.equal(snapshot,null);
reset();await assert.rejects(api.loadRecords(),/解除|保管庫/);assert.equal(countPdf(),0);
console.log('PASS F: wrong account and locked vault cannot reuse old decrypted state');
// Mutating paths keep independent live checks, never use the read-only shortcut.
const source=read('src/storage/payrollStore.ts');
assert.match(source,/async function cloudSummaries\(\):Promise<CloudRecord\[]> \{\s*const vault=await cloudVault\(\);return vault\.refresh\(\);/);
assert.match(source,/await vault\.refresh\(\{forceFresh:true\}\)/);
assert.equal(source.match(/vault\.refresh\(freshReadOnlyOptions\)/g)?.length,3);
assert.doesNotMatch(source.slice(source.indexOf('export async function saveRecordsSkippingDuplicates'),source.indexOf('export async function updateRecordMetadata')),/freshReadOnlyOptions/);
console.log('PASS F: mutation paths remain separate, and no shared persistent caches, tokens or cloud writes were added');
