/** Platform-independent synthetic check for core CE behavior. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const root=process.argv[2]??fileURLToPath(new URL('../',import.meta.url));
const src=p=>readFileSync(`${root}/${p}`,'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const salt='synthetic-salt',key={nonExtractable:true},years=['2023','2024','2025','2026'];
const enc=new TextEncoder(),pdf=enc.encode('%PDF-1.7\nSynthetic data\n%%EOF');
const hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',pdf)).toString('hex');
const make=(id,year,revision=1)=>({id,revision,form:{targetMonth:`${year}-05`,paymentDate:`${year}-06-01`,job:'main',kind:'salary'},savedAt:'2026-01-01',fileName:'test.pdf',originalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',originalMonth:'2026-05',pdfSize:pdf.length,pdfType:'application/pdf',fileHash:hash,pages:1,warningsAcknowledged:true});
const index={format:'payroll-index-v1',years:[...years],incomeYears:[]};
const files=new Map();let serial=0,cache=null;
const doc=records=>({format:'payroll-annual-v1',records,deleted:[]});
const put=(p,obj)=>{const text=typeof obj==='string'?obj:JSON.stringify(obj);files.set(p,{id:p,etag:`r-${++serial}`,size:enc.encode(text).length,text})};
put('payroll/index.enc',index);
for(const year of years)put(`payroll/statements/${year}.enc`,doc([make(Number(year),year)]));
put('payroll/originals/2026/05/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.enc','pdf-cipher-placeholder');
const calls={read:[],meta:[],list:[]};
const graph={
 async read(parts,name){const p=[...parts,name].join('/');calls.read.push(p);return files.get(p)??null},
 async metadata(parts,name){const p=[...parts,name].join('/');calls.meta.push(p);const row=files.get(p);return row?{id:row.id,etag:row.etag,size:row.size}:null},
 async listFolder(parts){const prefix=parts.join('/')+'/';calls.list.push(prefix);return [...files.entries()].filter(([p])=>p.startsWith(prefix)&&!p.slice(prefix.length).includes('/')).map(([p,v])=>({id:v.id,name:p.slice(prefix.length),etag:v.etag,size:v.size,folder:false}))},
 async write(){throw Error('no mutation allowed')}
};
const common={crypto:webcrypto,structuredClone,TextEncoder,TextDecoder,Uint8Array,Buffer,Blob,Map,Set,WeakMap,Promise,console,performance,
 envelopeSalt:()=>salt,parseEnvelope:()=>({salt}),decryptJson:async(_,t)=>JSON.parse(t),encryptJson:async(_,v)=>JSON.stringify(v),decryptBytes:async()=>pdf,
 isCollision:()=>false,clearNavigationSnapshot:()=>{cache=null},rememberNavigationSnapshot:async(_scope,_salt,_key,data)=>{cache=data},
 restoredNavigationSnapshot:async(_scope,_salt,_key)=>cache?{data:cache,expires:Date.now()+120000}:null,
 fiscalYearOfTargetMonth:v=>Number(v.slice(0,4)),isValidPayrollSemantics:()=>true,validEmployerId:v=>v===undefined||(typeof v==='string'&&/^emp_[0-9a-f]{32}$/.test(v)),payrollPeriodKey:rec=>rec.form.paymentDate,
 beginPerfOperation:()=>({measure:async(_,fun)=>fun(),finish(){}}),
 MAX_RECORDS:2000,MAX_TOTAL_PDF_BYTES:1e9,PayrollPartialSuccessError:class extends Error{},
 toPublicIncomeRecord:()=>{throw Error('not called')},
 setTimeout,
};
const {PayrollVault}=runInNewContext(strip(src('src/cloud/vault.ts'))+'\n({PayrollVault})',common);
let current;
const api=runInNewContext(strip(src('src/storage/payrollStore.ts'))+'\n({getRecordSummary,getOriginalForVerifiedEdit,recordSignature})',{
 ...common,cloudVault:async()=>current,PayrollPartialSuccessError:class extends Error{},validatePayrollForm:()=>({errors:[],warnings:[]}),
 isValidPayrollSemantics:()=>true,MAX_PDF_SIZE:50e6,toPublicIncomeRecord:()=>{},
});
const reset=()=>{calls.read.length=0;calls.meta.length=0;calls.list.length=0};
const first=new PayrollVault(graph);first.key=key;first.salt=salt;first.index=index;first.setNavigationScope('client:synthetic');
await first.refresh({forceFresh:true});assert.equal(calls.read.filter(p=>p.includes('statements')).length,4);
assert.equal(cache.versions.length,4,'verified ETags must be placed inside snapshot payload');
const after=new PayrollVault(graph);after.setNavigationScope('client:synthetic');assert.equal(await after.resumeFromSnapshot(key,salt),true);current=after;
reset();const record=await api.getRecordSummary(2026,'2026');assert.equal(record.id,2026);
assert.equal(calls.read.filter(p=>p.includes('statements')).length,0);
assert.equal(calls.list.length,1);assert.equal(calls.read.filter(p=>p.includes('index.enc')).length,1);
reset();const b=await api.getOriginalForVerifiedEdit(2026,api.recordSignature(record));
assert.equal(b.size,pdf.length);assert.equal(calls.list.length,2);assert.equal(calls.read.filter(p=>p.includes('statements')).length,0);
console.log('PASS: fresh index/list before and after PDF; warm edit zero year downloads');
// Move same ID to another year with higher revision.
put('payroll/statements/2025.enc',doc([make(2025,'2025'),make(2026,'2025',2)]));
reset();const relocated=await api.getRecordSummary(2026,'2026');assert.equal(relocated.form.targetMonth,'2025-05');
assert.equal(calls.read.filter(p=>p.includes('statements')).length,1);
await assert.rejects(api.getOriginalForVerifiedEdit(2026,api.recordSignature(record)),/更新|再読み込み/);
console.log('PASS: cross-year record movement follows higher revision; stale PDF rejected');
// Untrusted hint not used to select a record, only request priority.
reset();const fallback=await api.getRecordSummary(2026,'2023');assert.equal(api.recordSignature(fallback),api.recordSignature(relocated));
assert.equal(calls.list.length,1);assert.equal(calls.read.filter(p=>p.includes('statements')).length,0);
console.log('PASS: untrusted hint cannot redirect record selection');
// Legacy snapshot with no meta versions must fetch all year bodies.
cache={index,years:years.map(y=>[y,doc(y==='2025'?[make(2025,'2025'),make(2026,'2025',2)]:[make(Number(y),y)])])};
const old=new PayrollVault(graph);old.setNavigationScope('client:synthetic');assert.equal(await old.resumeFromSnapshot(key,salt),true);current=old;
reset();await api.getRecordSummary(2026,'2023');assert.equal(calls.read.filter(p=>p.includes('statements')).length,4);
console.log('PASS: legacy snapshot without ETags falls back to full authenticated read');
