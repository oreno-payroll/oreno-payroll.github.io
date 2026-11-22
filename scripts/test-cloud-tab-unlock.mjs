/** Regression: legacy tab-unlock key material must be purged, never restored. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clearTabUnlock,rememberKey,restoredKey} from '../src/cloud/session.ts';
const store=new Map([
 ['payroll-ephemeral-tab-unlock-v1','test-only-legacy-secret'],
 ['payroll-ephemeral-tab-unlock-v2','test-only-old-2h-secret'],
 ['unrelated-tab-preference','keep']]);
globalThis.sessionStorage={
 getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),
 removeItem:k=>store.delete(k),
};
clearTabUnlock();
assert.equal(store.has('payroll-ephemeral-tab-unlock-v1'),false);
assert.equal(store.has('payroll-ephemeral-tab-unlock-v2'),false);
assert.equal(store.get('unrelated-tab-preference'),'keep');
assert.equal(await restoredKey('test-account'),null,'no SharedWorker in test runtime');
assert.equal(await rememberKey('test-account',{} ,'salt'),false,'no material persists without SharedWorker');
const s=readFileSync(new URL('../src/cloud/session.ts',import.meta.url),'utf8');
const crypto=readFileSync(new URL('../src/cloud/crypto.ts',import.meta.url),'utf8');
const vault=readFileSync(new URL('../src/cloud/vault.ts',import.meta.url),'utf8');
const auth=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
assert.doesNotMatch(s,/export (?:async )?function (?:rememberTabUnlock|restoredTabUnlock)/);
assert.doesNotMatch(s,/sessionStorage\.setItem|\.deriveBits|\.exportKey/);
assert.doesNotMatch(crypto,/deriveBits|capture\??:/);
assert.doesNotMatch(vault,/onVerifiedMaterial|transient/);
assert.doesNotMatch(auth,/value="tab"|rememberTabUnlock|restoredTabUnlock|最長2時間/);
assert.match(auth,/clearTabUnlock\(\)/,'old keys get wiped');
console.log('PASS: old tab keys erased, no plaintext key capture/storage, SharedWorker remains memory-only');
