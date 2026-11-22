/** Sign-out regression tests: no network, account credentials or real payroll data. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {signOutLocallyFirst,LocalSignOutIncompleteError} from '../src/cloud/signOutFlow.ts';

async function scenario({workerError=false,browserError=false,microsoftError=false}={}) {
 const calls=[];
 let locked=false;
 const steps={
  lockImmediately(){calls.push('lock');locked=true;},
  async clearSharedWorkerKeys(){calls.push('worker');assert.equal(locked,true);if(workerError)throw Error('worker unavailable');},
  async clearRememberedBrowserKeys(){calls.push('indexeddb');assert.equal(locked,true);if(browserError)throw Error('indexeddb unavailable');},
  async logoutMicrosoft(){calls.push('msal');assert.equal(locked,true);if(microsoftError)throw Error('msal initialization failed');},
 };
 let error;
 try{await signOutLocallyFirst(steps);}catch(e){error=e;}
 return {calls,locked,error};
}
const good=await scenario();
assert.deepEqual(good.calls,['lock','worker','indexeddb','msal']);
assert.equal(good.error,undefined);
for(const [options,workerCleared,browserKeysCleared] of [
 [{workerError:true},false,true],
 [{browserError:true},true,false],
 [{workerError:true,browserError:true},false,false],
]){
 const result=await scenario(options);
 assert.deepEqual(result.calls,['lock','worker','indexeddb'],'both local clear attempts must run, but MSAL must not start');
 assert.equal(result.locked,true);
 assert.ok(result.error instanceof LocalSignOutIncompleteError);
 assert.equal(result.error.workerCleared,workerCleared);
 assert.equal(result.error.browserKeysCleared,browserKeysCleared);
}
const msalFailure=await scenario({microsoftError:true});
assert.deepEqual(msalFailure.calls,['lock','worker','indexeddb','msal']);
assert.equal(msalFailure.locked,true);
assert.match(msalFailure.error.message,/msal initialization failed/);
console.log('PASS: local-first sign-out, independent cleanup, and Microsoft failure isolation');

// Use fresh module instances because session.ts intentionally retains a Worker port.
let moduleId=0;
async function newSession(){
 return import(`../src/cloud/session.ts?signout-case=${++moduleId}`);
}
const originalWorker=globalThis.SharedWorker;
const originalSetTimeout=globalThis.setTimeout;
try {
 delete globalThis.SharedWorker;
 assert.equal(await (await newSession()).clearAllKeys(),undefined,'no SharedWorker support means no shared key cache');

 function fakeWorker(onRequest) {
  return class {
   port={onmessage:null,start(){},postMessage(message){onRequest(this,message);}};
  };
 }
 globalThis.SharedWorker=fakeWorker((port,message)=>{
  assert.equal(message.action,'clear-all');
  assert.equal(message.scope,'global');
  queueMicrotask(()=>port.onmessage({data:{id:message.id,result:true}}));
 });
 await (await newSession()).clearAllKeys();

 globalThis.SharedWorker=fakeWorker((port,message)=>{
  queueMicrotask(()=>port.onmessage({data:{id:message.id,result:false}}));
 });
 await assert.rejects((await newSession()).clearAllKeys(),/消去を確認できませんでした/);

 globalThis.SharedWorker=fakeWorker(()=>{throw Error('port closed');});
 await assert.rejects((await newSession()).clearAllKeys(),/消去を確認できませんでした/);

 globalThis.SharedWorker=class {constructor(){throw Error('worker unavailable');}};
 await assert.rejects((await newSession()).clearAllKeys(),/接続できず/);

 // Accelerate only the app's 1.8-second timeout while exercising its actual timer branch.
 globalThis.SharedWorker=fakeWorker(()=>{/* never acknowledge */});
 globalThis.setTimeout=(fn,ms,...args)=>originalSetTimeout(fn,ms===1800?15:ms,...args);
 await assert.rejects((await newSession()).clearAllKeys(),/消去を確認できませんでした/);
 console.log('PASS: SharedWorker clear-all requires an explicit acknowledgement (including timeout / errors)');
} finally {
 globalThis.setTimeout=originalSetTimeout;
 if(originalWorker===undefined)delete globalThis.SharedWorker;
 else globalThis.SharedWorker=originalWorker;
}

// Execute the exact exported auth entrypoint, not a handwritten duplicate.
// Its body is TypeScript-free; use VM injection instead of project-specific
// transpiler APIs so the test runs on both TypeScript 7/macOS and Node 22.
const authSource=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
const authStart=authSource.indexOf('export async function signOutMicrosoftAccount(');
assert.ok(authStart>0,'sign-out entrypoint must exist');
const authBody=authSource.slice(authStart).trim().replace(/^export /,'').replace('(onRedirectReady?:()=>void):Promise<void>', '(onRedirectReady)')
 .replaceAll('import.meta.url',JSON.stringify('file:///__payroll_signout_test__/auth.ts'));
async function realAuthScenario({workerError=false,browserError=false,msalError=false}={}) {
 const calls=[];
 const style={};
 Object.defineProperty(style,'visibility',{set(value){if(value==='hidden')calls.push('mask');}});
 const context={
  signOutLocallyFirst,
  document:{documentElement:{style}},
  tabLocks:{broadcast(){calls.push('broadcast');}},
  clearTabUnlock(){calls.push('clear-tab');},
  invalidateAuthSession(){calls.push('invalidate');},
  clearNavigationSnapshot(){calls.push('snapshot');},
  vault:{lock(){calls.push('lock-vault');}},unlocking:undefined,
  tokenCache:undefined,tokenPending:undefined,mustRefreshToken:false,
  clientId(){return 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';},
  rememberedAccountKey(){return 'pinned-account';},
  localStorage:{removeItem(){calls.push('unpin');}},
  async clearAllKeys(){calls.push('worker');if(workerError)throw Error('shared worker timeout');},
  async forgetAllRememberedBrowserKeys(){calls.push('indexeddb');if(browserError)throw Error('indexeddb unavailable');},
  async getMsal(){
   calls.push('msal-initialize');
   if(msalError)throw Error('msal initialize failed');
   return {async logoutRedirect(){calls.push('msal-redirect');}};
  },
  URL,
 };
 const fn=vm.runInNewContext(`(${authBody})`,context,{filename:'auth-signout-extracted.js'});
 let error;
 try{await fn(()=>{calls.push('redirect-ready');});}catch(e){error=e;}
 return {calls,error,context};
}
const normalAuth=await realAuthScenario();
assert.equal(normalAuth.error,undefined);
assert.deepEqual(normalAuth.calls,[
 'mask','broadcast','clear-tab','invalidate','snapshot','lock-vault','unpin',
 'worker','indexeddb','msal-initialize','unpin','redirect-ready','msal-redirect',
]);
assert.equal(normalAuth.context.vault,undefined,'vault must be forgotten synchronously');
const authMsalError=await realAuthScenario({msalError:true});
assert.match(authMsalError.error.message,/msal initialize failed/);
assert.ok(authMsalError.calls.includes('worker')&&authMsalError.calls.includes('indexeddb'));
assert.ok(authMsalError.calls.indexOf('msal-initialize')>authMsalError.calls.indexOf('indexeddb'));
for(const options of [{workerError:true},{browserError:true},{workerError:true,browserError:true}]){
 const outcome=await realAuthScenario(options);
 assert.ok(outcome.error instanceof LocalSignOutIncompleteError);
 assert.ok(outcome.calls.includes('worker')&&outcome.calls.includes('indexeddb'));
 assert.ok(!outcome.calls.includes('msal-initialize'),'MSAL must not start if key revocation was not confirmed');
 assert.ok(!outcome.calls.includes('redirect-ready'));
 assert.equal(outcome.context.vault,undefined);
}
const backupSource=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
assert.match(backupSource,/signOutMicrosoftAccount\(\(\)=>\{logoutRedirectReady=true;\}\)/);
assert.match(backupSource,/if\(busy&&!logoutRedirectReady\)/,'navigation warning must remain until local key deletion is complete');
assert.match(backupSource,/logoutRedirectReady=false;busy=false;updateButtons\(\)/,'failure reload must not trigger an unrelated busy warning');
console.log('PASS: real auth entrypoint masks UI, revokes local keys before MSAL, and fails closed');
