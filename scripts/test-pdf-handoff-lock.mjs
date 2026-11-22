/** Regression: the opener cannot transmit decrypted PDF bytes after vault lock or account switch. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const strip=source=>stripTypeScriptTypes(source,{mode:'strip'});
const auth=read('src/cloud/auth.ts');
const guardSource=auth.match(/export function capturePdfHandoffAuthorization\(\):\(\)=>boolean \{[\s\S]*?\n\}/)?.[0];
assert.ok(guardSource,'actual authorization guard must exist in auth.ts');
let epoch='initial',canAccess=true;
let current={isUnlocked:()=>true};
const guardContext={
 get vault(){return current;},
 tabLocks:{check:()=>canAccess,epoch:()=>epoch},
};
const capture=runInNewContext(strip(guardSource.replace(/^export /,''))+'\ncapturePdfHandoffAuthorization',guardContext);
const first=capture();
assert.equal(first(),true,'unlocked same-generation vault may transfer');
epoch='locked';
assert.equal(first(),false,'lock-epoch change invalidates in-flight handoff');
epoch='initial';current={isUnlocked:()=>true};
assert.equal(first(),false,'account/vault replacement invalidates in-flight handoff');
const second=capture();
assert.equal(second(),true);
current.isUnlocked=()=>false;
assert.equal(second(),false,'vault key disposal invalidates in-flight handoff');
current={isUnlocked:()=>true};
canAccess=false;
assert.equal(capture()(),false,'active lock fails closed');

class Channel {
 static instances=[];
 onmessage=null; closed=false; sent=[];
 constructor(name){this.name=name;Channel.instances.push(this);}
 postMessage(data){assert.equal(this.closed,false,'do not send after close');this.sent.push(data);}
 close(){this.closed=true;}
}
const handoff=runInNewContext(
 strip(read('src/pdf/handoff.ts').replace(/^export /gm,''))+'\npreparePdfHandoff',
 {BroadcastChannel:Channel,crypto:webcrypto,Blob,URL,setTimeout,clearTimeout},
);
const pdf=new Blob(['%PDF-1.7\nTEST ONLY'],{type:'application/pdf'});
const link=()=>({href:'https://payroll.example/view/index.html?id=42'});
const messages=channel=>channel.sent.map(message=>message.action);
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

// A successful handoff is unchanged.
let allowed=true;
const normal=link();
handoff(normal,42,async()=>({pdf,fileName:'test.pdf'}),()=>allowed);
let channel=Channel.instances.at(-1);
let ticket=new URL(normal.href).hash.slice('#handoff='.length);
channel.onmessage({data:{action:'ready',id:42,ticket}});
await tick();
assert.deepEqual(messages(channel),['loading','pdf']);
assert.equal(channel.sent[1].pdf,pdf);
assert.equal(channel.closed,true);

// Lock while original PDF awaits OneDrive: no plaintext may cross the channel.
allowed=true;
let finish,loadStarted=false;
const waiting=link();
handoff(waiting,42,()=>{loadStarted=true;return new Promise(resolve=>{finish=resolve;});},()=>allowed);
channel=Channel.instances.at(-1);ticket=new URL(waiting.href).hash.slice('#handoff='.length);
channel.onmessage({data:{action:'ready',id:42,ticket}});
assert.equal(loadStarted,true);
allowed=false;
finish({pdf,fileName:'private.pdf'});
await tick();
assert.deepEqual(messages(channel),['loading','error'],'lock rejects completed load before transfer');
assert.match(channel.sent.at(-1).message,/ロック/);
assert.equal(channel.sent.some(message=>message.pdf instanceof Blob),false);
assert.equal(channel.closed,true);

// Lock between click and receiver readiness: never even start a download.
allowed=true;
let loads=0;
const beforeReady=link();
handoff(beforeReady,42,async()=>{loads++;return {pdf,fileName:'private.pdf'};},()=>allowed);
channel=Channel.instances.at(-1);ticket=new URL(beforeReady.href).hash.slice('#handoff='.length);
allowed=false;
channel.onmessage({data:{action:'ready',id:42,ticket}});
await tick();
assert.equal(loads,0);
assert.deepEqual(messages(channel),['error']);
assert.equal(channel.closed,true);

// No channel is established if the click itself is no longer authorized.
const count=Channel.instances.length;
const denied=link();
handoff(denied,42,async()=>{throw new Error('must not load');},()=>false);
assert.equal(Channel.instances.length,count);
assert.equal(denied.href,'https://payroll.example/view/index.html?id=42');

assert.match(read('src/main.ts'),/capturePdfHandoffAuthorization\(\)/,'dashboard must bind the guard per click');
assert.match(read('src/view.ts'),/assertUnlocked\(startEpoch\)/,'receiver continues checking lock before display');
console.log('PASS: authenticated PDF transfer only; lock, identity switch and in-flight download cannot leak Blob');
