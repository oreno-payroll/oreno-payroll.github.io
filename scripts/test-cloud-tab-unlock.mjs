/** OneDrive vault session usability regression tests. No real MS account or network. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {deriveKey,createSalt,encryptJson,decryptJson} from '../src/cloud/crypto.ts';
import {rememberTabUnlock,restoredTabUnlock,clearTabUnlock,TAB_TTL_MS} from '../src/cloud/session.ts';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const box=new Map();
globalThis.sessionStorage={
 getItem(name){return box.get(name)??null;},
 setItem(name,value){box.set(name,String(value));},
 removeItem(name){box.delete(name);},
};
const originalNow=Date.now;
assert.equal(TAB_TTL_MS, 2 * 60 * 60 * 1000, 'tab key TTL must be exactly two hours');
const scope='client-123:account-456';
const salt=createSalt();
const pass='test-passphrase-that-is-not-real';
try {
 const regular=await deriveKey(pass,salt);
 assert.equal(regular.extractable,false);
 assert.equal(box.size,0,'default memory-only unlock never writes the tab key');
 console.log('PASS: default remains memory-only; no implicit browser key persistence');

 let bytesForStorage;
 const remembered=await deriveKey(pass,salt,raw=>{bytesForStorage=new Uint8Array(raw);});
 assert.equal(remembered.extractable,false,'active AES-GCM key is non-extractable');
 assert.equal(bytesForStorage.length,32);
 const contents={format:'payroll-index-test',years:['2026']};
 const encrypted=await encryptJson('index',contents,remembered,salt);
 assert.deepEqual(await decryptJson('index',encrypted,regular),contents,'opt-in derivation is identical to the normal key');
 assert.equal(rememberTabUnlock(scope,bytesForStorage,salt),true);
 bytesForStorage.fill(0);
 assert.equal(box.size,1);
 const expiration=JSON.parse(box.values().next().value).expiresAt;
 assert.equal(box.values().next().value.includes(pass),false,'passphrase is never placed in tab storage');
 console.log('PASS: single PBKDF2 derivation, opt-in tab cache, no stored passphrase');

 const resumed=await restoredTabUnlock(scope);
 assert.equal(resumed.key.extractable,false,'restored operational key is non-extractable');
 assert.deepEqual(await decryptJson('index',encrypted,resumed.key),contents,'Ctrl+R restores the same AES key');
 console.log('PASS: page-reload-equivalent restore correctly decrypts an existing index');

 Date.now=()=>expiration-1;
 assert.ok(await restoredTabUnlock(scope),'works inside the time window');
 Date.now=()=>expiration+1;
 assert.equal(await restoredTabUnlock(scope),null,'strict expiration');
 assert.equal(box.size,0,'expired unlock deleted');
 console.log('PASS: strict 2-hour expiry removes stored secret');

 Date.now=originalNow;
 assert.equal(rememberTabUnlock(scope,new Uint8Array(32).fill(23),salt),true);
 assert.equal(await restoredTabUnlock('client-123:different-account'),null);
 assert.equal(box.size,0,'account change removes stale secret');
 console.log('PASS: account-scoped key never restores for a different account');

 assert.equal(rememberTabUnlock(scope,new Uint8Array(32).fill(42),salt),true);
 box.set([...box.keys()][0],'{invalid');
 assert.equal(await restoredTabUnlock(scope),null);
 assert.equal(box.size,0);
 assert.equal(rememberTabUnlock(scope,new Uint8Array(32).fill(7),salt),true);
 clearTabUnlock();assert.equal(box.size,0);
 console.log('PASS: corrupted cache and explicit lock clear the tab key');

 // 旧8時間キャッシュの残存時間が短くても、v2では再利用しない。
 box.set('payroll-ephemeral-tab-unlock-v1', JSON.stringify({version:1,scope,salt,key:'A'.repeat(43)+'=',expiresAt:originalNow()+1000}));
 assert.equal(await restoredTabUnlock(scope),null);
 assert.equal(box.has('payroll-ephemeral-tab-unlock-v1'),false);
 console.log('PASS: obsolete 8-hour session cache is rejected and removed');
 const sessionSource=readFileSync(new URL('../src/cloud/session.ts',import.meta.url),'utf8');
 assert.match(sessionSource,/const keyData:\s*ArrayBuffer\s*=\s*new ArrayBuffer\(32\)/,'CryptoKey import material must have explicit ArrayBuffer type for TypeScript 7');
 assert.match(sessionSource,/subtle\.importKey\('raw',keyData,/,'restore must import from ArrayBuffer, not Uint8Array<ArrayBufferLike>');
 console.log('PASS: Web Crypto importKey uses an explicit ArrayBuffer (TypeScript 7 compatibility)');
 const auth=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
 const vault=readFileSync(new URL('../src/cloud/vault.ts',import.meta.url),'utf8');
 const html=readFileSync(new URL('../public/styles/cloud.css',import.meta.url),'utf8');
 assert.match(auth,/ui\.remember\.checked\s*\?/,'tab persistence requires explicit opt-in');
 assert.match(auth,/restoredTabUnlock\(scope\)/,'page reload resumes without password');
 assert.match(auth,/installHomeLock\(scope\)/,'home provides manual lock action');
 assert.match(auth,/cacheLocation:'sessionStorage'/,'MSAL browser auth remains session-scoped');
 assert.match(vault,/onVerifiedMaterial/,'key captured only as part of a verified unlock');
 assert.match(html,/payroll-cloud-remember/);
 console.log('PASS: opt-in UI, manual lock, MSAL auth separation, and verification hook');
}finally{Date.now=originalNow;clearTabUnlock();}
