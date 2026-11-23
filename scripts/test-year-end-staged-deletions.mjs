/** Saved-row X is local-only; one ETag batch commit; trash follows cutover. Synthetic records only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const ui=read('src/year-end-assist.ts'),html=read('public/year-end-assist/index.html');
assert.equal((html.match(/id="yea-download-pdfs"/g)??[]).length,1);
const listStart=html.indexOf('id="yea-files-heading"');
const zipButton=html.indexOf('id="yea-download-pdfs"');
const fileList=html.indexOf('id="yea-drafts"');
assert.ok(listStart<zipButton&&zipButton<fileList,'ZIP action belongs in the file-list header');
assert.doesNotMatch(html,/id="yea-pending-deletions"/,'pending deletions must not escape the scrollable file list');
assert.match(html,/year-end-assist\.js\?v=20261122-pending-ui-v2/,'new UI requires a fresh script URL');
assert.match(html,/year-end-assist\.css\?v=20261122-pending-ui-v2/,'new UI requires a fresh stylesheet URL');
assert.match(ui,/drafts\.append\(group\)/);
assert.match(ui,/pendingRecords\.length===1/);
assert.match(ui,/yea-pending-group__items/);
assert.match(ui,/pendingDeletions\.clear\(\);pendingGroupExpanded=false;updateDrafts\(\)/);
const css=read('public/styles/year-end-assist.css');
assert.match(css,/\.yea-pending-group__items\[hidden\]\{display:none\}/);
assert.doesNotMatch(css,/\.yea-pending-deletions\{/);
assert.match(ui,/pendingDeletions\.set\(r\.id,r\.revision\)/);
assert.match(ui,/pendingDeletions\.delete\(record\.id\)/);
const updatePart=ui.slice(ui.indexOf('function updateDrafts('),ui.indexOf('async function saveAllDocuments()'));
assert.doesNotMatch(updatePart,/repo\.deleteDocument\(/);
assert.doesNotMatch(updatePart,/window\.confirm\(/);
assert.match(ui,/pendingEdits\(\).*pendingDeletions\.size/);
const store=new Map();let sequence=0,yearWrites=0,deletedOriginals=0,failYear=false,failTrash=false;
const events=[];const pathKey=(path,name)=>[...path,name].join('/');
const graph={
 async read(path,name){const v=store.get(pathKey(path,name));return v?{...v}:null;},
 async write(path,name,text,expected){
  const k=pathKey(path,name),current=store.get(k);
  if(expected?(current?.etag!==expected.etag):!!current)throw Error('ETag collision');
  if(failYear&&path.includes('years'))throw Error('simulated competing annual write');
  store.set(k,{name,text,etag:`etag-${++sequence}`});
  if(path.includes('years')){events.push('year-commit');yearWrites++;}
 },
 async listFolder(path){return [...store.entries()].filter(([k])=>k.startsWith(path.join('/')+'/')).map(([k,v])=>({id:k,name:k.slice(path.join('/').length+1),folder:false,etag:v.etag,size:v.text.length}));},
 async trashFile(path,file){
  if(failTrash)throw Error('OneDrive recycle bin unavailable');
  events.push('trash');deletedOriginals++;store.delete(pathKey(path,file.name));
 }
};
const root=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const stableMockKey={}; // Synthetic key identity remains stable until an explicit simulated key rotation.
const sandbox={crypto:webcrypto,Blob,TextEncoder,TextDecoder,Uint8Array,Set,Map,Number,Date,Error,JSON,Buffer,Promise,
 cloudVault:async()=>({yearEndAccess:async()=>({path:root,key:stableMockKey,salt:'test',graph})}),
 encryptJson:async(_,obj)=>JSON.stringify(obj),decryptJson:async(_,str)=>JSON.parse(str),
 encryptBytes:async(_,bytes)=>Buffer.from(bytes).toString('base64'),decryptBytes:async(_,str)=>new Uint8Array(Buffer.from(str,'base64')),
 isCollision:err=>/collision/.test(err.message)};
const api=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/storage/fileNaming.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear})',sandbox);
const id=api.randomPersonId(),yid=api.randomDocumentId(),a=api.randomDocumentId(),b=api.randomDocumentId(),c=api.randomDocumentId();
const stamp='2026-11-22T00:00:00Z';
const doc=(documentId,month,kind,amount)=>({id:documentId,personId:id,kind,paymentDate:`2026-${month}-25`,targetMonth:`2026-${month}`,
 taxable:amount,gross:amount,transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
 fileName:`2026${month}_給与明細.pdf`,pdfSize:13,fileHash:documentId.replaceAll('-','').repeat(2),detectedName:null,
 confirmedAt:stamp,updatedAt:stamp,source:'pdf-reviewed',revision:1});
const docs=[doc(a,'01','salary',180000),doc(b,'02','salary',230000),doc(c,'06','bonus',350000)];
const year={...api.emptyYear(id,2026),documents:docs,estimates:[{month:'2026-03',amount:40000,method:'manual',references:[a],updatedAt:stamp}]};
const seed=(path,name,value)=>store.set(pathKey(path,name),{name,text:JSON.stringify(value),etag:`etag-${++sequence}`});
seed(root,'index.enc',{format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:stamp,updatedAt:stamp}]});
seed([...root,'persons',id],'profile.enc',{format:'payroll-year-end-person-v1',id,displayName:'テスト',alias:'',createdAt:stamp,updatedAt:stamp,yearFiles:{'2026':yid}});
seed([...root,'persons',id,'years'],yid+'.enc',year);
const originalPath=[...root,'persons',id,'originals'];
for(const d of docs)store.set(pathKey(originalPath,d.id+'.enc'),{name:d.id+'.enc',text:'encrypted sample',etag:`etag-${++sequence}`});
const repo=new api.YearEndRepository();
const deletion=(record)=>({documentId:record.id,expectedRevision:record.revision});
// Only deletion, no uploaded PDF. A single year write must precede recycle-bin cleanup.
const deleted=await repo.saveDocumentsBatch(id,2026,[],[],false,undefined,[deletion(docs[0]),deletion(docs[1])]);
assert.equal(deleted.data.documents.length,1);assert.equal(deleted.cleanupPending,0);
assert.equal(yearWrites,1);assert.equal(deletedOriginals,2);
assert.deepEqual(events,['year-commit','trash','trash']);
assert.equal(deleted.data.estimates.length,0,'a removed PDF cannot retain salary forecast references');
assert.ok(deleted.data.history.some(e=>e.kind==='document-deleted'&&e.documentId===a));
// A stale revision must fail before changing the annual file or originals.
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[],false,undefined,[deletion(docs[0])]),/更新されています/);
assert.equal(yearWrites,1);assert.equal(deletedOriginals,2);
// Failed annual ETag commit must NOT trash any original.
failYear=true;
await assert.rejects(repo.saveDocumentsBatch(id,2026,[],[],false,undefined,[deletion(docs[2])]),/年度データの保存に失敗/);
assert.equal(yearWrites,1);assert.equal(deletedOriginals,2);
failYear=false;
// A removal and new import are committed atomically, once, after verifying the PDF.
const incoming=Object.assign(new Blob(['%PDF-1.7 synthetic income sample'],{type:'application/pdf'}),{name:'march.pdf'});
const income={kind:'salary',paymentDate:'2026-03-25',targetMonth:'2026-03',taxable:245000,gross:245000,
 transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,detectedName:null,warnings:[]};
const beforeMixed=yearWrites;
const mixed=await repo.saveDocumentsBatch(id,2026,[],[{file:incoming,draft:income}],false,undefined,[deletion(docs[2])]);
assert.equal(yearWrites,beforeMixed+1,'a new PDF and pending deletion require one year commit');
assert.equal(mixed.data.documents.length,1);
assert.equal(mixed.data.documents[0].taxable,245000);
assert.equal(mixed.cleanupPending,0);
assert.equal(deletedOriginals,3);
// After successful annual commit, trash can fail without making a second save necessary.
failTrash=true;
const committed=await repo.saveDocumentsBatch(id,2026,[],[],false,undefined,[deletion(mixed.data.documents[0])]);
assert.equal(committed.cleanupPending,1);assert.equal(committed.data.documents.length,0);
assert.equal(yearWrites,3);assert.equal(deletedOriginals,3);
assert.equal((await repo.year(id,2026)).documents.length,0);
// Replace a complete year's source PDFs without intermediate saves. The exact
// same hashes MUST be allowed when their old records are staged for deletion.
failTrash=false;
const replacementFiles=Array.from({length:10},(_,i)=>{
 const month=String(i+1).padStart(2,'0');
 const file=Object.assign(new Blob([`%PDF-1.7 replacement payroll file for ${month}`],{type:'application/pdf'}),{name:`replacement-${month}.pdf`});
 const digest=createHash('sha256').update(Buffer.from(`%PDF-1.7 replacement payroll file for ${month}`)).digest('hex');
 const old=doc(api.randomDocumentId(),month,'salary',210000+i*1000);
 old.fileHash=digest;old.pdfSize=file.size;
 const draft={kind:'salary',paymentDate:`2026-${month}-25`,targetMonth:`2026-${month}`,taxable:old.taxable,gross:old.gross,
  transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,detectedName:null,warnings:[]};
 return {old,file,draft};
});
const currentYearFile=[...root,'persons',id,'years'];
seed(currentYearFile,yid+'.enc',{...api.emptyYear(id,2026),documents:replacementFiles.map(r=>r.old)});
for(const row of replacementFiles)seed(originalPath,row.old.id+'.enc','encrypted old original');
const beforeFull=yearWrites;
const fullReplacement=await repo.saveDocumentsBatch(id,2026,[],replacementFiles.map(({file,draft})=>({file,draft})),false,undefined,replacementFiles.map(r=>deletion(r.old)));
assert.equal(fullReplacement.data.documents.length,10);
assert.equal(fullReplacement.cleanupPending,0);
assert.equal(yearWrites,beforeFull+1,'10 removals + 10 imports are committed in one annual write');
assert.equal(JSON.stringify(fullReplacement.data.documents.map(r=>r.fileHash).sort()),JSON.stringify(replacementFiles.map(r=>r.old.fileHash).sort()));
assert.equal(deletedOriginals,13,'all ten old originals are recycled after the annual commit');
assert.equal((await repo.year(id,2026)).documents.length,10);
console.log('PASS: compact in-list deletion UX, local-only X, undo all, revision guard, one annual commit, safe trash order, cleanup failure');
