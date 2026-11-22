/** Browser-remembered non-extractable key, simulated IndexedDB and cross-tab lock tests.
 * No live Microsoft authentication, real payroll data or remote writes. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {deriveKey,createSalt,encryptJson,decryptJson} from '../src/cloud/crypto.ts';
import {BROWSER_KEY_DB,readRememberedBrowserKey,saveRememberedBrowserKey,forgetRememberedBrowserKey,forgetAllRememberedBrowserKeys} from '../src/cloud/rememberedBrowser.ts';
import {createTabLockCoordinator} from '../src/cloud/tabLock.ts';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const files=new Map();let calls=0;
// Minimal IndexedDB transaction simulation: preserve structured-cloned CryptoKeys across sessions.
const storage={
 open(dbName,version){
  calls++;
  const req={},has=files.has(dbName);
  if(!has)files.set(dbName,new Map());
  const records=files.get(dbName);
  const db={
   objectStoreNames:{contains(name){return name==='keys';}},
   createObjectStore(name,options){assert.equal(name,'keys');assert.equal(options.keyPath,'scope');},
   transaction(name,mode){
    assert.equal(name,'keys');assert.ok(['readonly','readwrite'].includes(mode));
    const tx={objectStore(){return {
     get(scope){const r={};queueMicrotask(()=>{r.result=records.has(scope)?structuredClone(records.get(scope)):undefined;r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return r;},
     put(value){assert.equal(mode,'readwrite');records.set(value.scope,structuredClone(value));queueMicrotask(()=>tx.oncomplete?.());return {};},
     delete(scope){assert.equal(mode,'readwrite');records.delete(scope);queueMicrotask(()=>tx.oncomplete?.());return {};},
     clear(){assert.equal(mode,'readwrite');records.clear();queueMicrotask(()=>tx.oncomplete?.());return {};},
    };}};
    return tx;
   },close(){} ,onversionchange:null,
  };
  req.result=db;queueMicrotask(()=>{if(!has)req.onupgradeneeded?.();req.onsuccess?.();});return req;
 },
};
globalThis.indexedDB=storage;
const scope='11111111-1111-1111-1111-111111111111:account-A';
const otherScope='11111111-1111-1111-1111-111111111111:account-B';
const salt=createSalt();
const key=await deriveKey('only-a-test-strong-passphrase',salt);
assert.equal(key.extractable,false);
await assert.rejects(()=>crypto.subtle.exportKey('raw',key));
await saveRememberedBrowserKey(scope,key,salt,null);
assert.deepEqual([...files.keys()],[BROWSER_KEY_DB],'keys stay in a dedicated DB');
const entry=files.get(BROWSER_KEY_DB).get(scope);
assert.deepEqual(Object.keys(entry).sort(),['generation','key','salt','scope','vault','version']);
assert.equal(entry.key.extractable,false);
assert.ok(!JSON.stringify(entry).includes('only-a-test-strong-passphrase'),'stored metadata has no passphrase');
assert.equal(await readRememberedBrowserKey(otherScope),null,'another Microsoft account must not inherit the key');
const reopened=await readRememberedBrowserKey(scope);
assert.ok(reopened?.key);
const encrypted=await encryptJson('index',{format:'payroll-index-v1',years:['2026'],incomeYears:[]},key,salt);
assert.deepEqual(await decryptJson('index',encrypted,reopened.key),{format:'payroll-index-v1',years:['2026'],incomeYears:[]});
console.log('PASS: opt-in non-extractable CryptoKey is structured-cloned in Payroll-only IndexedDB, scoped to Microsoft account');

// Browser/OS restart equivalent: a fresh module instance still gets the stored key.
const cold=await import('../src/cloud/rememberedBrowser.ts?cold-restart');
const originalNow=Date.now;
try {Date.now=()=>originalNow()+365*24*3600*1000;
 const again=await cold.readRememberedBrowserKey(scope);
 assert.ok(again?.key,'no independent 2h or annual expiry');
 assert.deepEqual(await decryptJson('index',encrypted,again.key),{format:'payroll-index-v1',years:['2026'],incomeYears:[]});
}finally{Date.now=originalNow;}
console.log('PASS: fresh page/browser/OS session can use the key with no proprietary expiration');

// A corrupt stored record is removed, without ever touching salary data or other scopes.
files.get(BROWSER_KEY_DB).set(scope,{version:1,scope,vault:'payroll',key:'invalid',salt,generation:null});
assert.equal(await readRememberedBrowserKey(scope),null);
assert.equal(files.get(BROWSER_KEY_DB).has(scope),false);
await saveRememberedBrowserKey(scope,key,salt,null);
const old=globalThis.indexedDB;
globalThis.indexedDB={open(){throw new Error('Private browsing storage is unavailable');}};
await assert.rejects(()=>readRememberedBrowserKey(scope),/Private browsing/);
assert.ok(files.get(BROWSER_KEY_DB).has(scope),'temporary storage error must not erase the key');
globalThis.indexedDB=old;
await forgetRememberedBrowserKey(scope);
assert.equal(await readRememberedBrowserKey(scope),null);
console.log('PASS: malformed key is invalidated, transient storage errors retain key, explicit forget deletes key');

// Salt/key changes invalidate old decryption, without modifying a remote index.
await saveRememberedBrowserKey(scope,key,salt,null);
const nextSalt=createSalt();
const replacement=await deriveKey('another-test-new-passphrase',nextSalt);
const rotated=await encryptJson('index',{format:'payroll-index-v1',years:[],incomeYears:[],generation:'88888888-8888-4888-8888-888888888888'},replacement,nextSalt);
assert.notEqual((await readRememberedBrowserKey(scope)).salt,nextSalt);
await assert.rejects(()=>decryptJson('index',rotated,key),'old key must not decrypt new generation');
await saveRememberedBrowserKey(scope,replacement,nextSalt,'88888888-8888-4888-8888-888888888888');
const newEntry=await readRememberedBrowserKey(scope);
assert.equal(newEntry.generation,'88888888-8888-4888-8888-888888888888');
assert.deepEqual((await decryptJson('index',rotated,newEntry.key)).years,[]);
console.log('PASS: rotation rejects old key; verified new generation can replace it');
// A corrupt OneDrive index MUST NOT be interpreted as permission to erase a
// well-formed browser record. Only an explicit sign-out clears all scopes.
const failedRemoteIndex=JSON.parse(rotated);
failedRemoteIndex.data=failedRemoteIndex.data[0]==='A'?'B'+failedRemoteIndex.data.slice(1):'A'+failedRemoteIndex.data.slice(1);
await assert.rejects(()=>decryptJson('index',JSON.stringify(failedRemoteIndex),replacement));
assert.ok((await readRememberedBrowserKey(scope))?.key,'damaged remote ciphertext must not alter a locally valid saved key');
await saveRememberedBrowserKey(otherScope,key,salt,null);
const beforeExplicitLogout=files.get(BROWSER_KEY_DB).size;
assert.equal(beforeExplicitLogout,2);
const temporarilyBlocked=globalThis.indexedDB;
globalThis.indexedDB={open(){throw new Error('Storage blocked');}};
await assert.rejects(()=>forgetAllRememberedBrowserKeys(),/Storage blocked/);
assert.equal(files.get(BROWSER_KEY_DB).size,beforeExplicitLogout,'failed purge must not report success or mutate keys');
globalThis.indexedDB=temporarilyBlocked;
await forgetAllRememberedBrowserKeys();
assert.equal(await readRememberedBrowserKey(scope),null);
assert.equal(await readRememberedBrowserKey(otherScope),null);
assert.equal(files.get(BROWSER_KEY_DB).size,0,'shared-device logout removes all account-scoped saved keys');
console.log('PASS: remote index failure preserves saved key, explicit full logout removes all saved keys');

const global=new Map();let n=1;
const env=()=>({
 local:{getItem:k=>global.get(k)??null,setItem:(k,v)=>global.set(k,String(v)),removeItem:k=>global.delete(k)},
 tab:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},channel:null,windowEvents:null,documentEvents:null,
 newId:()=>`${String(n++).padStart(8,'0')}-aaaa-bbbb-cccc-000000000000`,
});
const first=createTabLockCoordinator(()=>{},env());
assert.equal(first.canAutoResumePersistent(),false,'consent required before any auto unlock');
const firstEpoch=first.epoch();
assert.equal(first.acceptUnlock(firstEpoch),true);
assert.equal(first.permitPersistentAutoResume(firstEpoch),true);
const restarted=createTabLockCoordinator(()=>{},env());
assert.equal(restarted.canAutoResumePersistent(),true,'new tab/browser sees durable explicit permission');
first.broadcast();
const blocked=createTabLockCoordinator(()=>{},env());
assert.equal(blocked.canAutoResumePersistent(),false,'manual lock persists across restart');
assert.equal(blocked.canResume(),false,'SharedWorker key is not automatically inherited');
const userEpoch=blocked.epoch();
assert.equal(blocked.acceptUnlock(userEpoch),true,'explicit remembered-key button can open');
assert.equal(blocked.permitPersistentAutoResume(userEpoch),true);
assert.equal(createTabLockCoordinator(()=>{},env()).canAutoResumePersistent(),true);
const beforeRotation=blocked.epoch();blocked.broadcast(true);
assert.notEqual(beforeRotation,blocked.epoch());
assert.equal(blocked.canAutoResumePersistent(),false,'key generation change revokes old auto permission');
assert.equal(blocked.permitPersistentAutoResume(blocked.epoch()),true,'new key reconsent can enable auto permission');
blocked.suspendPersistentAutoResume();
assert.equal(createTabLockCoordinator(()=>{},env()).canAutoResumePersistent(),false);
console.log('PASS: explicit consent, manual lock, cold restart, explicit reopen and key rotation obey separate lock epochs');

const src=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const auth=src('src/cloud/auth.ts'),vault=src('src/cloud/vault.ts'),backup=src('src/backup.ts'),page=src('public/backup/index.html'),css=src('public/styles/cloud.css');
assert.match(auth,/cacheLocation:'localStorage'/,'MSAL v5 now manages its cache in localStorage');
assert.doesNotMatch(auth,/ui\.remember\.checked|rememberTabUnlock|restoredTabUnlock/,'2h session key path removed');
assert.match(auth,/readRememberedBrowserKey\(scope\)/);
assert.match(auth,/await candidate\.unlockWithKey\(stored\.key,stored\.salt\)/,'a fresh remote index must be decrypted');
assert.match(auth,/tabLocks\.canAutoResumePersistent\(\)/);
assert.match(auth,/if\(previousVault\)throw new Error\('以前に記憶したPayroll保管庫の索引が見つかりません/,'remote 404 with a remembered key must not create a replacement vault');
assert.match(auth,/tabLocks\.permitPersistentAutoResume\(startEpoch\)/);
assert.match(auth,/tabLocks\.broadcast\(\)/,'manual lock remains global');
assert.match(auth,/refreshSessionAfterKeyRotation\(\)/);
assert.match(vault,/RememberedKeyMismatchError/);
assert.match(auth,/catch\s*\{\s*\/\* Graph\/MSAL\/IndexedDB temporary errors must not erase a valid saved key/);
assert.doesNotMatch(auth,/if\(error instanceof RememberedKeyMismatchError\)\s*\{[^}]*forgetRememberedBrowserKey/s,'remote index mismatch must not revoke a valid browser key');
assert.match(auth,/clearRememberedBrowserKeys:\(\)=>forgetAllRememberedBrowserKeys\(\)/,'explicit logout must revoke all browser memories');
assert.match(src('src/cloud/signOutFlow.ts'),/await steps\.clearRememberedBrowserKeys\(\)/,'logout must await durable key erasure');
assert.match(auth,/await app\.logoutRedirect\(\{postLogoutRedirectUri:/,'server sign-out must use MSAL');
assert.match(auth,/tabLocks\.broadcast\(\);\s*clearTabUnlock\(\);invalidateAuthSession\(\);clearNavigationSnapshot\(\)/,'logout must lock other Payroll tabs before MSAL redirect');
assert.match(backup,/signOutMicrosoftAccount\(\(\)=>\{logoutRedirectReady=true;\}\)/);
assert.equal((page.match(/id="backup-cloud-logout"/g)??[]).length,1);
assert.match(backup,/rememberCurrentBrowser/);
assert.match(backup,/forgetCurrentBrowser\(\);busy=false;window\.location\.reload\(\)/,'forget reload must not trigger the busy beforeunload confirmation');
assert.match(page,/remember-browser-forget/);
assert.match(css,/payroll-cloud-retention/);
assert.doesNotMatch(src('src/cloud/rememberedBrowser.ts'),/localStorage\.setItem|sessionStorage\.setItem|exportKey\(/);
assert.doesNotMatch(auth,/localStorage\.setItem\([^)]*(?:accessToken|refreshToken)/,'Payroll never stores OAuth tokens itself');
console.log('PASS: OAuth, non-extractable browser key, memory worker, settings, lock and fresh remote index remain separate');
