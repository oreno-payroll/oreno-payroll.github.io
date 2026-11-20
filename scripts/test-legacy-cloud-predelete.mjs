/** Protect against deletion of local-only personal payroll before encrypted cloud verification. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
const begin=source.indexOf('export async function verifyLegacyIndexedDbCloudBeforeDelete(');
const end=source.indexOf('/** 削除前に既知の旧DBだけを照合する。',begin);
assert.ok(begin>0&&end>begin);
const body=stripTypeScriptTypes(source.slice(begin,end).replace(/\bexport\s+/g,''),{mode:'strip'});
const blob=new Blob(['synthetic-pdf']);
const digest=Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(n=>n.toString(16).padStart(2,'0')).join('');
const record={id:42,fileHash:digest,pdf:blob,form:{}};
const remote={id:42,fileHash:record.fileHash};
let local=[record],cloud=[remote],actualPdf=record.pdf,rev=0,forcedReads=0;
const database={objectStoreNames:{contains:()=>true},close(){},transaction(){return {objectStore(){return {getAll(){const req={result:local};queueMicrotask(()=>req.onsuccess?.());return req;}};}};}};
const indexedDB={open(){const req={result:database};queueMicrotask(()=>req.onsuccess?.());return req;}};
const vault={async refresh(options){assert.equal(options.forceFresh,true);forcedReads++;return cloud;},async original(){return actualPdf;}};
const sandbox={indexedDB,Promise,Blob,Number,JSON,
 inspectLegacyIndexedDb:async()=>({exists:true,count:local.length}),
 cloudVault:async()=>vault,
 recordSignature:r=>JSON.stringify([r.id,r.fileHash]),
 payrollSnapshot:rs=>rs.map(r=>JSON.stringify([r.id,r.fileHash])),
 assertValid:()=>{},
 pdfSha256:async blob=>Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(n=>n.toString(16).padStart(2,'0')).join('')};
const api=runInNewContext(body+'\n({verifyLegacyIndexedDbCloudBeforeDelete})',sandbox);
assert.equal(await api.verifyLegacyIndexedDbCloudBeforeDelete(1),1);
assert.ok(forcedReads>=2,'remote metadata refreshed before and after PDF comparison');
await assert.rejects(api.verifyLegacyIndexedDbCloudBeforeDelete(2),/件数/);
cloud=[];
await assert.rejects(api.verifyLegacyIndexedDbCloudBeforeDelete(1),/一致しない明細/);
cloud=[remote]; actualPdf=new Blob(['different-pdf']);
await assert.rejects(api.verifyLegacyIndexedDbCloudBeforeDelete(1),/PDF原本/);
console.log('PASS: count, metadata, encrypted original bytes and fresh remote snapshot gate legacy DB deletion');
