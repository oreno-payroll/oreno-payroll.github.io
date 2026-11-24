/** Run without OneDrive: simulate two browser tabs, storage events and BroadcastChannel. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createTabLockCoordinator} from '../src/cloud/tabLock.ts';

class MemoryStorage {
 constructor(map=new Map()) {this.map=map;}
 getItem(k){return this.map.get(k)??null;}
 setItem(k,v){this.map.set(k,String(v));}
 removeItem(k){this.map.delete(k);}
}
class Events {
 events=new Map();visibilityState='visible';
 addEventListener(type,handler){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push(handler);}
 emit(type,payload={}){for(const handler of this.events.get(type)??[])handler(payload);}
}
let next=1;
const globalMap=new Map();
const windows=[];
const posted=[];
function tab({receiveBroadcast=true,receiveStorage=true}={}) {
 const win=new Events(),doc=new Events();
 const individual=new MemoryStorage();
 const local={
  getItem:(key)=>globalMap.get(key)??null,
  setItem:(key,value)=>{
   globalMap.set(key,value);
   for(const other of windows)if(other.win!==win&&other.receiveStorage)other.win.emit('storage',{key,newValue:value});
  },
  removeItem:key=>globalMap.delete(key),
 };
 const channel={
  addEventListener:(type,cb)=>win.addEventListener('broadcast:'+type,cb),
  postMessage:data=>{
   posted.push(data);
   for(const other of windows)if(other.win!==win&&other.receiveBroadcast)other.win.emit('broadcast:message',{data});
  },
 };
 const record={win,doc,receiveBroadcast,receiveStorage};windows.push(record);
 let lockedCount=0;
 const manager=createTabLockCoordinator(()=>{lockedCount++;},{local,tab:individual,channel,windowEvents:win,documentEvents:doc,newId:()=>`${String(next++).padStart(8,'0')}-aaaa-bbbb-cccc-000000000000`});
 return {manager,win,doc,individual,get lockedCount(){return lockedCount;}};
}
const first=tab(),second=tab();
assert.equal(first.manager.canResume(),true,'fresh vault can use existing memory-session semantics');
assert.equal(second.manager.canResume(),true);
assert.equal(first.manager.acceptUnlock(first.manager.epoch()),true);
assert.equal(second.manager.acceptUnlock(second.manager.epoch()),true);
const previous=second.manager.epoch();
first.manager.broadcast();
assert.equal(first.manager.check(),false,'locking tab cannot silently resume');
assert.equal(second.lockedCount,1,'second tab receives lock immediately');
assert.equal(second.manager.check(),false,'second tab refuses key reuse');
assert.equal(second.manager.acceptUnlock(previous),false,'stale asynchronous unlock is rejected');
assert.equal(posted[0].type,'lock');
assert.deepEqual(Object.keys(posted[0]).sort(),['epoch','type'],'broadcast includes no credentials or salary values');
second.win.emit('focus');second.doc.emit('visibilitychange');
assert.equal(second.lockedCount,1,'multiple event paths invoke lock once');
console.log('PASS: simultaneous tabs lock; old keys and in-flight unlock are refused');

const storageOnly=tab({receiveBroadcast:false,receiveStorage:true});
assert.equal(storageOnly.manager.acceptUnlock(storageOnly.manager.epoch()),true);
// A tab changing the account/key also broadcasts a lock, without locking itself.
const storageInitiator=tab();
storageInitiator.manager.acceptUnlock(storageInitiator.manager.epoch());
storageInitiator.manager.broadcast(true);
assert.equal(storageOnly.lockedCount,1,'storage events work when BroadcastChannel delivery is unavailable');
assert.equal(storageInitiator.manager.canResume(),true);
console.log('PASS: storage-event fallback locks tabs without BroadcastChannel');

const late=tab();
assert.equal(late.manager.canResume(),false,'new tab after global lock cannot inherit old SharedWorker key');
const freshEpoch=late.manager.epoch();
assert.equal(late.manager.acceptUnlock(freshEpoch),true,'explicit user unlock enables navigation again');
assert.equal(late.manager.canResume(),true,'freshly verified tab can resume');
console.log('PASS: post-lock reauthentication is required before automatic key resume');

const dormant=tab({receiveBroadcast:false,receiveStorage:false});
assert.equal(dormant.manager.acceptUnlock(dormant.manager.epoch()),true);
late.manager.broadcast();
assert.equal(dormant.lockedCount,0,'dormant tab intentionally missed notification');
dormant.win.emit('pageshow',{persisted:true});
assert.equal(dormant.lockedCount,1,'BFCache restoration detects global epoch change');
assert.equal(dormant.manager.check(),false);
console.log('PASS: suspended/BFCache tab detects lock even if real-time events were missed');

const settings=tab();
const settingsEpoch=settings.manager.epoch();
assert.equal(settings.manager.acceptUnlock(settingsEpoch),true);
const remote=tab();
remote.manager.acceptUnlock(remote.manager.epoch());
settings.manager.broadcast(true);
assert.equal(settings.manager.check(),true,'account/key-changing tab may keep using its newly verified key');
assert.equal(settings.manager.canResume(),true);
assert.equal(remote.lockedCount,1,'other tab must still lock on account/key change');
console.log('PASS: account/key changes invalidate other tabs without breaking the initiating tab');

const auth=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
assert.match(auth,/createTabLockCoordinator/);
assert.match(auth,/document\.documentElement\.style\.visibility='hidden'/,'salary UI must be masked synchronously');
assert.match(auth,/vault\?\.lock\(\)/,'in-memory key must be invalidated');
assert.match(auth,/await clearAllKeys\(\)/,'global lock must clear all SharedWorker keys');
assert.match(auth,/tabLocks\.canResume\(\)/,'page reload must reject an old tab key');
assert.match(auth,/tabLocks\.acceptUnlock\(startEpoch\)/,'async unlock must recheck the lock generation');
assert.match(auth,/tabLocks\.broadcast\(\)/,'manual lock must be broadcast');
const worker=readFileSync(new URL('../public/payroll-cloud-session.js',import.meta.url),'utf8');
assert.match(worker,/action === 'clear-all'/,'SharedWorker must support clearing every account scope');
assert.match(worker,/sessions\.clear\(\)/);
// Exercise the actual SharedWorker message protocol, not just its source string.
const sandbox={Date,Map,crypto:globalThis.crypto,self:{}};
vm.runInNewContext(worker,sandbox,{filename:'payroll-cloud-session.js'});
const responses=[];
const port={postMessage:data=>responses.push(data),start(){},onmessage:null};
sandbox.self.onconnect({ports:[port]});
const cryptoKey={type:'secret',algorithm:{name:'AES-GCM'},extractable:false};
const portB={postMessage:data=>responses.push(data),start(){},onmessage:null};
sandbox.self.onconnect({ports:[portB]});
let serial=0;
const send=(target,action,scope,extra={})=>{target.onmessage({data:{id:++serial,action,scope,...extra}});return responses.at(-1).result;};
const generation=send(port,'generation','global');
assert.equal(send(port,'set','account-a',{key:cryptoKey,salt:'salt-a',generation}),true);
assert.equal(send(port,'set','account-b',{key:cryptoKey,salt:'salt-b',generation}),true);
assert.equal(send(portB,'clear-all','global'),true);
assert.equal(send(port,'set','account-a',{key:cryptoKey,salt:'salt-a',generation}),null,'delayed pre-lock registration must be rejected');
assert.equal(send(port,'get','account-a',{generation}),null);
const nextGeneration=send(portB,'generation','global');assert.notEqual(nextGeneration,generation);
assert.equal(send(portB,'get','account-a',{generation:nextGeneration}),null);
assert.equal(send(portB,'get','account-b',{generation:nextGeneration}),null);
assert.equal(send(portB,'set','account-b',{key:cryptoKey,salt:'salt-b',generation:nextGeneration}),true);
assert.equal(send(port,'get','account-b',{generation}),null,'old generation cannot obtain a newly registered key');
assert.equal(send(portB,'get','account-b',{generation:nextGeneration}).key,cryptoKey);
console.log('PASS: SharedWorker clears every account key and rejects delayed previous-generation get/set across ports');
console.log('PASS: auth flow masks plaintext, clears all shared keys and checks epoch across asynchronous unlock');
