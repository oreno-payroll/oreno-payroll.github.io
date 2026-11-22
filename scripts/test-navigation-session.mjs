/** Cross-page encrypted navigation cache + account controls. No actual OneDrive data. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const base=fileURLToPath(new URL('../',import.meta.url));
const built=await build({
 stdin:{contents:[
  "export {PayrollVault} from './src/cloud/vault.ts'",
  "export {PayrollGraph} from './src/cloud/graph.ts'",
  "export {encryptJson} from './src/cloud/crypto.ts'",
  "export {rememberNavigationSnapshot,restoredNavigationSnapshot,invalidateNavigationSnapshot,invalidateAuthSession,authEpoch,mutationEpoch,SNAPSHOT_TTL_MS} from './src/cloud/snapshot.ts'",
 ].join(';'),resolveDir:base,sourcefile:'navigation-entry.ts',loader:'ts'},
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const api=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const {PayrollVault,PayrollGraph,encryptJson,rememberNavigationSnapshot,restoredNavigationSnapshot,invalidateNavigationSnapshot,invalidateAuthSession,authEpoch,mutationEpoch,SNAPSHOT_TTL_MS}=api;
class TabStore{
 constructor(){this.map=new Map()}
 getItem(k){return this.map.get(k)??null}
 setItem(k,v){this.map.set(k,String(v))}
 removeItem(k){this.map.delete(k)}
}
const tab=new TabStore();globalThis.sessionStorage=tab;
const scope='00000000-0000-0000-0000-000000000000:account-a';
const pass='test-only-strong-passphrase-for-mock';
const enc=new TextEncoder();
class FakeCloud{
 files=new Map();reads=0;
 path(parts,name){return [...parts,name].join('/')}
 read(parts,name){this.reads++;return Promise.resolve(this.files.get(this.path(parts,name))??null)}
 put(path,text){this.files.set(path,{id:path,etag:'etag-test',text,size:enc.encode(text).length})}
 async write(parts,name,text){this.put(this.path(parts,name),text)}
}
const cloud=new FakeCloud(),first=new PayrollVault(cloud);
first.setNavigationScope(scope);
await first.unlock(pass,true);
const {key,salt}=first.sessionKey();
const one={
 id:101,fileName:'sample-not-private.pdf',originalId:crypto.randomUUID(),originalMonth:'2026-09',
 pdfSize:352,pdfType:'application/pdf',fileHash:'a'.repeat(64),pages:1,revision:1,
 savedAt:'2026-10-01',warningsAcknowledged:true,
 form:{targetMonth:'2026-09',paymentDate:'2026-10-01',job:'main',kind:'salary'},
};
cloud.put('payroll/statements/2026.enc',await encryptJson('year',{format:'payroll-annual-v1',records:[one],deleted:[]},key,salt));
cloud.put('payroll/index.enc',await encryptJson('index',{format:'payroll-index-v1',years:['2026'],incomeYears:[]},key,salt));
await first.unlockWithKey(key,salt);
assert.equal((await first.refresh({dashboardStartup:true})).length,1);
const encrypted=tab.getItem('payroll-navigation-snapshot-v1');
assert.ok(encrypted&&encrypted.length>100);
assert.doesNotMatch(encrypted,/sample-not-private\.pdf|targetMonth|paymentDate/,'salary plaintext in tab cache');
const reads=cloud.reads;
const returning=new PayrollVault(cloud);returning.setNavigationScope(scope);
assert.equal(await returning.resumeFromSnapshot(key,salt),true,'valid snapshot restores');
assert.equal(returning.navigationDeadline()>Date.now(),true,'expiry exposed to UI');
assert.equal(cloud.reads,reads,'restore needs no OneDrive calls');
assert.equal((await returning.refresh({dashboardStartup:true})).length,1);
assert.equal(cloud.reads,reads,'dashboard navigation needs no OneDrive calls');
assert.equal(returning.isShowingSnapshot(),true);
await returning.refresh({dashboardStartup:true,forceFresh:true});
assert.ok(cloud.reads>reads,'explicit refresh must use remote index and annual records');
assert.equal(returning.isShowingSnapshot(),false);
console.log('PASS: warm navigation uses encrypted snapshot; manual refresh revalidates OneDrive');

// The index/records must be validated again after decrypting the cached snapshot.
const second=new PayrollVault(cloud);second.setNavigationScope('client:another-account');
assert.equal(await second.resumeFromSnapshot(key,salt),false,'different account must not reuse snapshot');
assert.equal(tab.getItem('payroll-navigation-snapshot-v1'),null,'scope mismatch discards snapshot');
await first.refresh();
await rememberNavigationSnapshot(scope,salt,key,{index:{format:'bad-format'},years:[]});
const malformed=new PayrollVault(cloud);malformed.setNavigationScope(scope);
assert.equal(await malformed.resumeFromSnapshot(key,salt),false,'invalid data shape must not be trusted');
invalidateNavigationSnapshot();
await first.refresh();
const old=tab.getItem('payroll-navigation-snapshot-v1');
tab.setItem('payroll-navigation-snapshot-v1',old.slice(0,-17));
assert.equal(await restoredNavigationSnapshot(scope,salt,key),null,'tampered encrypted cache rejected');
console.log('PASS: account, shape and ciphertext tampering are rejected');

await first.refresh();
const epochBefore=mutationEpoch();
// Mutation starts while the encryption promise is still pending.
const pending=rememberNavigationSnapshot(scope,salt,key,{index:{old:true}});
invalidateNavigationSnapshot();await pending;
assert.notEqual(mutationEpoch(),epochBefore);
assert.equal(tab.getItem('payroll-navigation-snapshot-v1'),null,'in-flight cache write cannot recreate stale data');
console.log('PASS: write epoch invalidates even an in-flight encrypted snapshot');
const previousAuth=authEpoch();invalidateAuthSession();
assert.notEqual(authEpoch(),previousAuth,'account switch changes the BFCache identity token');

await first.refresh();
// Simulated real Graph PUT must call the mutation hook even though read caching uses one tab.
const remote=async(url,init={})=>{
 const method=init.method??'GET';const path=new URL(url).pathname;
 if(method==='GET'&&path.endsWith('/me/drive/special/approot'))return Response.json({id:'root-id'});
 if(method==='GET'&&path.includes('root-id:/payroll'))return Response.json({id:'payroll-folder-id',folder:{}});
 if(method==='PUT'&&path.includes('payroll-folder-id:/test.enc:/content'))
  return Response.json({id:'item-created',size:init.body.byteLength});
 throw Error('Unexpected fake request');
};
const graph=new PayrollGraph('test-only-access-token',remote,invalidateNavigationSnapshot);
await graph.write(['payroll'],'test.enc','encrypted-bytes',null,200);
assert.equal(tab.getItem('payroll-navigation-snapshot-v1'),null,'actual Graph writes invalidate snapshot');
console.log('PASS: Graph write prevents using old display data after save');

await first.refresh();
const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
try {
 await rememberNavigationSnapshot(scope,salt,key,{index:{format:'test'}});
 now+=SNAPSHOT_TTL_MS+1;
 assert.equal(await restoredNavigationSnapshot(scope,salt,key),null);
 assert.equal(tab.getItem('payroll-navigation-snapshot-v1'),null);
}finally{Date.now=originalNow;}
console.log('PASS: strict two-minute lifetime');

const html=readFileSync(new URL('../public/backup/index.html',import.meta.url),'utf8');
const auth=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
const backup=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
const home=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
for(const id of ['backup-cloud-status','backup-cloud-login','backup-cloud-client-id','backup-cloud-save','backup-cloud-redirect-uri']) {
 assert.equal((html.match(new RegExp(`id="${id}"`,'g'))??[]).length,1,'missing or duplicate id: '+id);
 assert.ok(backup.includes(id),'event handler missing: '+id);
}
assert.match(auth,/const redirectUri=\(\)=>new URL\('\.\/auth\/redirect\.html',import\.meta\.url\)\.href/,'MSAL v5 uses a dedicated redirect bridge');
assert.match(backup,/cloudConnectionState\(\)/,'Microsoft account status without forced unlock');
assert.match(auth,/sessionScope\(clientId\(\),user\)/,'account-scoped keys');
assert.match(home,/event\.persisted && \(dashboardMutationEpoch!==mutationEpoch\(\)/,'no automatic full fetch on unchanged back navigation');
assert.match(home,/refreshDashboard\(true\)/,'explicit refresh bypasses cache');
assert.match(auth,/if\(event\.persisted && authEpoch\(\)!==pageAuthEpoch\)window\.location\.reload\(\)/,'bfcache identity change forces a new authentication context');
console.log('PASS: backup account settings and BFCache navigation contract');
