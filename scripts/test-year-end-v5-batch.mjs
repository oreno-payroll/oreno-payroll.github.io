/** Test real repository batch logic against an in-memory ETag/Graph stand-in. No personal data. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const strip=src=>stripTypeScriptTypes(src.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const files=new Map();let seq=0,annualWrites=0,originalWrites=0,originalReads=0;
const key=(path,name)=>[...path,name].join('/');
const graph={
 async read(path,name){const row=files.get(key(path,name));if(name.endsWith('.enc')&&path.includes('originals'))originalReads++;return row?{...row}:null;},
 async write(path,name,text,prior){const k=key(path,name),row=files.get(k);
  if(prior ? !row||row.etag!==prior.etag : row)throw new Error('ETag collision');
  const next={text,etag:`etag-${++seq}`};files.set(k,next);
  if(path.includes('years'))annualWrites++;
  if(path.includes('originals'))originalWrites++;
 },
 async listFolder(){return [];}
};
const parent=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const access={path:parent,key:{},salt:'testing',graph};
const sandbox={
 crypto:webcrypto,Blob,TextDecoder,TextEncoder,Uint8Array,Number,Set,Map,Date,Error,JSON,Buffer,Promise,
 cloudVault:async()=>({yearEndAccess:async()=>access}),
 encryptJson:async(_,value)=>JSON.stringify(value),decryptJson:async(_,text)=>JSON.parse(text),
 encryptBytes:async(_,bytes)=>Buffer.from(bytes).toString('base64'),
 decryptBytes:async(_,text)=>new Uint8Array(Buffer.from(text,'base64')),
 isCollision:err=>/collision/.test(err.message),
};
const api=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear,validateYear})',sandbox);
const id=api.randomPersonId(),docId=api.randomDocumentId(),yearId=api.randomDocumentId();
const now='2026-11-19T00:00:00Z';
const profile={format:'payroll-year-end-person-v1',id,displayName:'検証',alias:'',createdAt:now,updatedAt:now,yearFiles:{'2026':yearId}};
const original={id:docId,personId:id,kind:'salary',paymentDate:'2026-10-25',targetMonth:'2026-10',taxable:200000,
 gross:205000,transportation:5000,nonTaxable:5000,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
 fileName:'base.pdf',pdfSize:50,fileHash:'a'.repeat(64),confirmedAt:now,updatedAt:now,source:'pdf-reviewed',revision:1};
const year={...api.emptyYear(id,2026),documents:[original]};
files.set(key(parent,'index.enc'),{text:JSON.stringify({format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:now,updatedAt:now}]}),etag:`etag-${++seq}`});
files.set(key([...parent,'persons',id],'profile.enc'),{text:JSON.stringify(profile),etag:`etag-${++seq}`});
files.set(key([...parent,'persons',id,'years'],yearId+'.enc'),{text:JSON.stringify(year),etag:`etag-${++seq}`});
const repo=new api.YearEndRepository();
const draft=(kind,date,taxable)=>({kind,paymentDate:date,targetMonth:date.slice(0,7),taxable,gross:taxable,
 transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,detectedName:null,warnings:[]});
const makeFile=(name,content)=>Object.assign(new Blob([content],{type:'application/pdf'}),{name});
const one=makeFile('new-salary.pdf','%PDF-1.7 synthetic PDF A');
const two=makeFile('new-bonus.pdf','%PDF-1.7 synthetic PDF B');
const result=await repo.saveDocumentsBatch(id,2026,[{documentId:docId,expectedRevision:1,draft:draft('salary','2026-10-25',225000)}],
 [{file:one,draft:draft('salary','2026-11-25',250000)},{file:two,draft:draft('bonus','2026-12-20',350000)}]);
assert.equal(annualWrites,1,'two PDFs + one edit must update annual JSON just once');
assert.equal(originalWrites,2,'both encrypted original files written');
assert.equal(originalReads,2,'both originals read back and SHA-256 verified');
assert.equal(result.data.documents.length,3);
assert.equal(result.data.documents.find(d=>d.id===docId).revision,2);
assert.equal(result.data.documents.reduce((sum,d)=>sum+d.taxable,0),825000);
assert.deepEqual(JSON.parse(JSON.stringify(result.yearFiles)),{'2026':yearId});
assert.equal((await repo.year(id,2026)).documents.length,3);
await assert.rejects(repo.saveDocumentsBatch(id,2026,[{documentId:docId,expectedRevision:1,draft:draft('salary','2026-10-25',300000)}],[]),/他の画面/);
assert.equal(annualWrites,1,'stale revision does not overwrite data');
const sameMonth=makeFile('dup-salary.pdf','%PDF-1.7 synthetic PDF C');
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[{file:sameMonth,draft:draft('salary','2026-11-28',200000)}]),/重複/);
assert.equal(originalWrites,2,'duplicate month rejected before uploading PDF');
// V6: salary + bonus estimates are committed with exactly one encrypted annual-file write.
const current=await repo.year(id,2026);
const preview=await repo.preview(id,2026,'latest',['2026-12'],{'2026-12':0});
const before=annualWrites;
await repo.replaceIncomeForecasts(id,2026,'latest',['2026-12'],{'2026-12':0},current.estimates,current.noPaymentMonths,
 preview.references,current.bonusEstimates,{month:'2026-09',amount:80000});
assert.equal(annualWrites,before+1,'salary and bonus forecast must share one annual write');
const after=await repo.year(id,2026);
assert.equal(after.estimates.find(x=>x.month==='2026-12')?.amount,0);
assert.equal(after.bonusEstimates.find(x=>x.month==='2026-09')?.amount,80000);
assert.deepEqual(JSON.parse(JSON.stringify(after.noPaymentMonths)),[]);
await assert.rejects(repo.replaceIncomeForecasts(id,2026,'manual',[],{},current.estimates,current.noPaymentMonths,
 [],current.bonusEstimates),/別の画面で見込みが変更/);
assert.equal(annualWrites,before+1,'stale bonus snapshot must reject overwrite');

console.log('PASS: 2 encrypted PDFs + 1 edit => one ETag annual write; SHA-256 readback, stale revision and duplicates guarded');
