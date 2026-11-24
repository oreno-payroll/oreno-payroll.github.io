/** Regression test for audit remediation. Synthetic names/salary values only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=src=>stripTypeScriptTypes(src.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const files=new Map(),root=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const key=(p,n)=>[...p,n].join('/');
let etag=0,originalWrites=0,yearWrites=0;
const graph={
 async withWriteLock(operation){return operation();},
 async read(p,n){return files.get(key(p,n))??null;},
 async write(p,n,text,prior){const k=key(p,n),old=files.get(k);if(prior?old?.etag!==prior.etag:!!old)throw new Error('ETag collision');
  files.set(k,{text,etag:`e${++etag}`});if(p.includes('originals'))originalWrites++;if(p.includes('years'))yearWrites++;},
 async listFolder(p){return [...files.keys()].filter(k=>k.startsWith(p.join('/')+'/')).map(k=>({name:k.split('/').at(-1),folder:false}));},
 async trashFile(p,file){files.delete(key(p,file.name));},
};
const access={path:root,key:{},salt:'synthetic',graph};
const sandbox={crypto:webcrypto,Blob,TextDecoder,Uint8Array,Number,Set,Map,Date,Error,JSON,Buffer,Promise,
 cloudVault:async()=>({yearEndAccess:async()=>access}),
 encryptJson:async(_,v)=>JSON.stringify(v),decryptJson:async(_,s)=>JSON.parse(s),
 encryptBytes:async(_,v)=>Buffer.from(v).toString('base64'),decryptBytes:async(_,v)=>new Uint8Array(Buffer.from(v,'base64')),
 isCollision:e=>e.message.includes('collision')};
const api=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+
 '\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear,validateYear,documentAmountWarnings,inconsistentDetectedNames})',sandbox);
const id=api.randomPersonId(),yearId=api.randomDocumentId();
const at='2026-11-19T00:00:00Z';
const profile={format:'payroll-year-end-person-v1',id,displayName:'ニックネーム',alias:'',createdAt:at,updatedAt:at,yearFiles:{'2026':yearId}};
const legacyDeletedId=api.randomDocumentId();
const initial={...api.emptyYear(id,2026),noPaymentMonths:['2026-08'],history:[{at,kind:'document-deleted',month:'2026-05',oldValue:777777,newValue:0,documentId:legacyDeletedId}]};
files.set(key(root,'index.enc'),{text:JSON.stringify({format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:at,updatedAt:at}]}),etag:`e${++etag}`});
files.set(key([...root,'persons',id],'profile.enc'),{text:JSON.stringify(profile),etag:`e${++etag}`});
files.set(key([...root,'persons',id,'years'],yearId+'.enc'),{text:JSON.stringify(initial),etag:`e${++etag}`});
const repo=new api.YearEndRepository();
const file=(str)=>Object.assign(new Blob([str],{type:'application/pdf'}),{name:'synthetic.pdf'});
const draft=(kind,date,taxable,gross=taxable,nonTaxable=0,name='架空花子')=>({kind,paymentDate:date,targetMonth:date.slice(0,7),taxable,gross,nonTaxable,
 transportation:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,detectedName:name,warnings:[]});
assert.equal(api.inconsistentDetectedNames(['架空 花子','架空花子']),false,'whitespace does not create a mismatch');
assert.equal(api.inconsistentDetectedNames(['架空花子','架空太郎',null]),true,'distinct PDF names warn');
assert.equal(api.inconsistentDetectedNames(['架空花子',null]),false,'unknown extracted names do not falsely mismatch');
assert.equal(api.documentAmountWarnings({taxable:999999,gross:200000,nonTaxable:0,transportation:0}).length,2);
assert.equal(api.documentAmountWarnings({taxable:240000,gross:250000,nonTaxable:null,transportation:null}).length,0,'unknown subtotal is not treated as zero');
const bad=draft('bonus','2026-09-20',999999,200000,0);
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[{file:file('%PDF-1.7 bad test'),draft:bad}]),/矛盾/);
assert.equal(originalWrites,0,'unacknowledged discrepancy must not upload an original');
const bonus=draft('bonus','2026-08-20',90000,90000,0);
const saved=await repo.saveDocumentsBatch(id,2026,[],[{file:file('%PDF-1.7 bonus test'),draft:bonus}]);
assert.ok(saved.data.noPaymentMonths.includes('2026-08'),'bonus must not clear old salary non-payment month');
assert.equal(saved.data.documents[0].detectedName,'架空花子','parsed name stored only in encrypted year data');
const legacy=await repo.year(id,2026);
assert.equal(legacy.history.find(e=>e.documentId===legacyDeletedId)?.oldValue,undefined,'legacy deleted salary amount scrubbed on write');
const changed=draft('bonus','2026-08-20',999999,200000,0);
await assert.rejects(repo.saveDocumentsBatch(id,2026,[{documentId:saved.data.documents[0].id,expectedRevision:1,draft:changed}],[]),/矛盾/);
assert.equal(originalWrites,1,'unacknowledged correction must not write original');
await repo.saveDocumentsBatch(id,2026,[{documentId:saved.data.documents[0].id,expectedRevision:1,draft:changed}],[],true);
const after=await repo.year(id,2026);
assert.equal(after.documents[0].taxable,999999,'explicit acknowledgement permits intentional unusual record');
assert.ok(after.noPaymentMonths.includes('2026-08'));
const deleted=await repo.deleteDocument(id,2026,after.documents[0].id);
assert.equal(deleted.cleanupPending,true);
const final=await repo.year(id,2026);
assert.ok(final.noPaymentMonths.includes('2026-08'));
const history=final.history.filter(e=>e.documentId===after.documents[0].id);
assert.ok(history.length===1&&history[0].kind==='document-deleted');
assert.equal(history[0].oldValue,undefined);
assert.equal(history[0].newValue,undefined);
assert.equal(yearWrites,3,'bonus save, correction and deletion use one annual write each');
console.log('PASS: PDF-only name comparison, mismatch acknowledgement, bonus-only legacy marker, deleted-value redaction');
