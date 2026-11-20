/** Local-only legacy DB cleanup must work without MSAL, OneDrive, or prior "inspect" button. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../',import.meta.url);
const storeCode=readFileSync(new URL('src/storage/payrollStore.ts',root),'utf8');
const first=storeCode.indexOf('export async function inspectLegacyIndexedDb(');
const second=storeCode.indexOf('/** 現行OneDriveとは独立して',first);
const third=storeCode.indexOf('export async function deleteLegacyIndexedDb(',second);
assert.ok(first>=0&&second>first&&third>second,'expected cleanup functions must exist');
// Extract only the two local IndexedDB functions, avoiding any cloud/auth import.
const source=storeCode.slice(first,second)+'\n'+storeCode.slice(third);
const url='data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'strip'})).toString('base64');
const {inspectLegacyIndexedDb,deleteLegacyIndexedDb}=await import(url);
function fakeDatabase(initialCount=3,correctSchema=true){
 let exists=true,count=initialCount,deleted=0;
 const actions=[];
 const client={
  objectStoreNames:{contains:(name)=>correctSchema&&name==='payroll-records'},
  close:()=>actions.push('db.close'),
  transaction(name){
   assert.equal(name,'payroll-records');
   return {objectStore(store){assert.equal(store,'payroll-records');return {count(){
    const req={result:count};queueMicrotask(()=>req.onsuccess?.());return req;
   }};}};
  }
 };
 const indexedDB={
  async databases(){actions.push('databases');return exists?[{name:'payroll-local-v1'}]:[];},
  open(name){assert.equal(name,'payroll-local-v1');actions.push('open');const req={result:client};queueMicrotask(()=>req.onsuccess?.());return req;},
  deleteDatabase(name){assert.equal(name,'payroll-local-v1');actions.push('deleteDatabase');deleted++;
   const req={};queueMicrotask(()=>{exists=false;req.onsuccess?.();});return req;
  },
 };
 globalThis.indexedDB=indexedDB;globalThis.window.indexedDB=indexedDB;
 return {actions,setCount(v){count=v;},get deleted(){return deleted;}};
}
globalThis.window={addEventListener(){}};
{
 const db=fakeDatabase(4);
 const result=await inspectLegacyIndexedDb();assert.deepEqual(result,{exists:true,count:4});
 const messages=[];
 assert.equal(await deleteLegacyIndexedDb(result.count,text=>messages.push(text)),4);
 assert.equal(db.deleted,1);
 assert.deepEqual(await inspectLegacyIndexedDb(),{exists:false,count:0});
 assert.ok(messages.some(x=>x.includes('IndexedDB')));
 console.log('PASS: low-level cleanup targets only payroll-local-v1; UI requires cloud verification first');
}
{
 const db=fakeDatabase(6); db.setCount(7);
 await assert.rejects(deleteLegacyIndexedDb(6),/件数が変わりました/);
 assert.equal(db.deleted,0);
 await assert.rejects(deleteLegacyIndexedDb(-1),/件数が不正/);
 assert.equal(db.deleted,0);
 console.log('PASS: count changes or invalid expected counts block deletion');
}
{
 const db=fakeDatabase(2,false);
 await assert.rejects(deleteLegacyIndexedDb(2),/保存形式が想定と異なります/);
 assert.equal(db.deleted,0);
 console.log('PASS: unknown DB schema cannot be deleted');
}
{
 const db=fakeDatabase(0);
 assert.equal(await deleteLegacyIndexedDb(0),0);
 assert.equal(db.deleted,1);
 console.log('PASS: empty old DB may be removed');
}
const view=readFileSync(new URL('../public/backup/index.html',import.meta.url),'utf8');
const ui=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
const store=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
assert.match(view,/id="legacy-cleanup-delete"[^>]*>旧DBを削除<\/button>/);
assert.doesNotMatch(view,/id="legacy-cleanup-delete"[^>]*(?:hidden|disabled)/);
assert.ok(view.indexOf('id="legacy-cleanup-delete"')<view.indexOf('id="migrate-legacy-cloud"'),'cleanup should be first');
assert.doesNotMatch(ui,/oldLocalCount/);
assert.match(view,/id="backup-cloud-load"[^>]*hidden/);
assert.match(ui,/if\(legacyExists\)/);
assert.match(ui,/if\(legacyExists\)\{appStatus\.clear\(\);return;\}/);
assert.match(ui,/cloudLoad\.addEventListener/);
const handler=ui.slice(ui.indexOf("localDelete.addEventListener('click'"));
assert.match(handler,/deleteLegacyIndexedDb\(result.count/);
assert.match(handler,/await verifyLegacyIndexedDbCloudBeforeDelete\(result.count/, 'UI must verify cloud metadata and originals before deleting');
assert.ok(handler.indexOf('verifyLegacyIndexedDbCloudBeforeDelete')<handler.indexOf('deleteLegacyIndexedDb(result.count'));
assert.doesNotMatch(handler,/cloudVault\(|loadRecords\(|vault\./);
assert.match(handler,/window\.confirm/);
const fn=store.slice(store.indexOf('export async function deleteLegacyIndexedDb('));
assert.doesNotMatch(fn,/cloudVault\(|vault\.|original\(/);
console.log('PASS: safe cleanup UI confirms, compares OneDrive and PDFs, then deletes local DB only');
