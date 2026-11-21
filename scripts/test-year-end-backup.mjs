/** Synthetic third-party backup roundtrip and fail-closed OneDrive restore. Never uses personal data. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=code=>stripTypeScriptTypes(code.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const ctx={crypto:webcrypto,Blob,File,TextEncoder,TextDecoder,Uint8Array,DataView,Map,Set,Date,Number,JSON,Promise,Error,Buffer,
 MAX_ARCHIVE_BYTES:512*1024*1024,MAX_MANIFEST_BYTES:8*1024*1024};
const zip=runInNewContext(strip(read('src/storage/zipArchive.ts'))+'\n({writeZip,readZip})',ctx);
const model=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n({randomPersonId,randomDocumentId,emptyYear,validateYear,validateIndex,validateProfile,validYear,asPersonId,asDocumentId})',ctx);
const verifyPdfBytes=bytes=>{assert.ok(bytes.length>5);assert.equal(new TextDecoder().decode(bytes.slice(0,5)),'%PDF-');};
let parsedPdf=0;
const api=runInNewContext(strip(read('src/yearEnd/backup.ts'))+'\n({createYearEndBackup,readYearEndBackup})',
 {...ctx,...zip,...model,verifyPdfBytes,verifyPdfWithPdfJs:async()=>{parsedPdf++;}});
const id=model.randomPersonId(),yearFile=model.randomDocumentId(),documentId=model.randomDocumentId();
const at='2026-11-21T00:00:00Z';
const pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic salary PDF\n');
const hash=[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',pdf))].map(v=>v.toString(16).padStart(2,'0')).join('');
const profile={format:'payroll-year-end-person-v1',id,displayName:'架空テスト従業員',alias:'検証用',createdAt:at,updatedAt:at,yearFiles:{'2026':yearFile}};
const doc={id:documentId,personId:id,kind:'salary',paymentDate:'2026-10-25',targetMonth:'2026-10',taxable:220000,
 gross:225000,transportation:5000,nonTaxable:5000,healthInsurance:0,pension:0,employmentInsurance:0,incomeTax:0,residentTax:0,
 fileName:'sample.pdf',pdfSize:pdf.length,fileHash:hash,confirmedAt:at,updatedAt:at,source:'pdf-reviewed',revision:1};
const year={...model.emptyYear(id,2026),documents:[doc],memo:'架空の年度メモ',estimates:[{month:'2026-11',amount:220000,method:'manual',references:[],updatedAt:at}],bonusEstimates:[{month:'2026-12',amount:10000,method:'manual',references:[],updatedAt:at}]};
const dataset={exportedAt:at,persons:[{profile,years:[year],originals:[{id:documentId,bytes:pdf}]}]};
const archive=await api.createYearEndBackup(dataset);
const encryption=runInNewContext(strip(read('src/storage/encryptedBackup.ts'))+'\n({encryptBackup,decryptBackup,isEncryptedBackup})',{...ctx});
const encrypted=await encryption.encryptBackup(archive,'synthetic-passphrase-2026');
assert.equal(await encryption.isEncryptedBackup(encrypted),true);
assert.notEqual(Buffer.from(await encrypted.arrayBuffer()).includes(Buffer.from('架空テスト従業員')),true,
 'plaintext employee name must not appear in encrypted backup');
await assert.rejects(encryption.decryptBackup(encrypted,'incorrect-password-2026'),/復号できません/);
const restored=await api.readYearEndBackup(await encryption.decryptBackup(encrypted,'synthetic-passphrase-2026'));
assert.equal(parsedPdf,1);assert.equal(restored.persons.length,1);
assert.equal(restored.persons[0].years[0].memo,'架空の年度メモ');
assert.equal(restored.persons[0].years[0].estimates[0].amount,220000);
assert.equal(restored.persons[0].years[0].bonusEstimates[0].amount,10000);
assert.equal(Buffer.from(restored.persons[0].originals[0].bytes).toString('hex'),Buffer.from(pdf).toString('hex'));
const archiveFiles=zip.readZip(await archive.arrayBuffer());
const changed=zip.writeZip([{name:'manifest.json',data:archiveFiles.get('manifest.json')},
 {name:'pdf/000001.pdf',data:new TextEncoder().encode('%PDF-1.7\nTAMPERED\n')}]);
await assert.rejects(api.readYearEndBackup(changed),/SHA-256|サイズ|容量不一致/);
await assert.rejects(api.readYearEndBackup(zip.writeZip([{name:'manifest.json',data:new TextEncoder().encode('{"app":"Payroll","schemaVersion":1}')}])) ,/年末調整専用/);

const remote=new Map();let writes=0,serial=0;
const path=(parts,name)=>[...parts,name].join('/');
const graph={
 async read(parts,name){const r=remote.get(path(parts,name));return r?{...r}:null;},
 async metadata(parts,name){const r=remote.get(path(parts,name));return r?{etag:r.etag,id:r.id}:null;},
 async write(parts,name,text,prior){const key=path(parts,name),old=remote.get(key);
  if(prior ? !old||old.etag!==prior.etag : !!old)throw new Error('ETag collision');
  remote.set(key,{text,etag:`etag-${++serial}`,id:`file-${serial}`});writes++;
 },
 async listFolder(parts){const prefix=parts.join('/')+'/';const names=new Set([...remote.keys()].filter(key=>key.startsWith(prefix)).map(k=>k.slice(prefix.length).split('/')[0]));return [...names].map(name=>({name,id:prefix+name,folder:true}));},
};
const access={path:['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'],key:{},salt:'testing',graph};
const sandbox={...ctx,...model,cloudVault:async()=>({yearEndAccess:async()=>access}),
 encryptJson:async(_kind,data)=>JSON.stringify(data),decryptJson:async(_kind,data)=>JSON.parse(data),
 encryptBytes:async(_kind,bytes)=>Buffer.from(bytes).toString('base64'),
 decryptBytes:async(_kind,data)=>new Uint8Array(Buffer.from(data,'base64')),
 isCollision:error=>/collision/.test(error.message)};
const repoApi=runInNewContext(strip(read('src/yearEnd/repository.ts'))+'\n({YearEndRepository})',sandbox);
const repo=new repoApi.YearEndRepository();
const initialRestore=await repo.restoreBackupSnapshot(restored);
assert.equal(initialRestore.restored,1);
assert.ok(writes>=4,'original, year, profile and index must all be persisted');
const index=JSON.parse(remote.get(path(access.path,'index.enc')).text);
assert.equal(index.persons.length,1,'index is committed last after every original');
const fromCloud=await repo.exportBackupSnapshot();
assert.equal(fromCloud.persons[0].years[0].memo,year.memo);
assert.equal(fromCloud.persons[0].originals[0].bytes.length,pdf.length);
const before=writes;
const duplicate=await repo.restoreBackupSnapshot(restored);
assert.equal(duplicate.restored,0);assert.equal(duplicate.skipped,1);
assert.equal(writes,before,'restore must never overwrite active employees');
const currentIndex=JSON.parse(remote.get(path(access.path,'index.enc')).text);
currentIndex.persons[0].state='deleted';
const root=[...access.path,'persons',id].join('/')+'/';
for(const key of [...remote.keys()])if(key.startsWith(root))remote.delete(key);
remote.set(path(access.path,'index.enc'),{text:JSON.stringify(currentIndex),etag:`etag-${++serial}`,id:`file-${serial}`});
const recovered=await repo.restoreBackupSnapshot(restored);
assert.equal(recovered.restored,1,'deleted employee must be recoverable');
assert.equal(JSON.parse(remote.get(path(access.path,'index.enc')).text).persons[0].state,'active');
console.log('PASS: isolated year-end PDF, memo and forecasts roundtrip, tamper rejection, encrypted OneDrive restore, non-destructive guard');
