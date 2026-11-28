/** In-memory PDF handoff: no Microsoft network, secrets or user PDF required. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
const src=readFileSync(new URL('../src/pdf/handoff.ts',import.meta.url),'utf8');
const js=stripTypeScriptTypes(src,{mode:'strip'});
const moduleUrl='data:text/javascript;base64,'+Buffer.from(js).toString('base64');
const {preparePdfHandoff,receivePdfHandoff}=await import(moduleUrl);
const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const view=readFileSync(new URL('../src/view.ts',import.meta.url),'utf8');
const store=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
const pdf=new Blob(['%PDF-1.7\nsynthetic-only'],{type:'application/pdf'});
const link={href:'https://payroll.example/view/index.html#id=42'};
let fetches=0;
preparePdfHandoff(link,42,async()=>{fetches++;return {fileName:'test-only.pdf',pdf};},()=>true);
const ticket=new URLSearchParams(new URL(link.href).hash.slice(1)).get('handoff');
assert.match(ticket,/^[0-9a-f-]{36}$/i);
assert.equal(new URL(link.href).search,'');
assert.equal(new URLSearchParams(new URL(link.href).hash.slice(1)).get('id'),'42');
const data=await receivePdfHandoff(42,ticket);
assert.equal(data.fileName,'test-only.pdf');
assert.equal(await data.pdf.text(),await pdf.text());
assert.equal(fetches,1,'already-authenticated tab must fetch once');
await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(link.href,'https://payroll.example/view/index.html#id=42','stable link restored');
assert.equal(receivePdfHandoff(42,'not-a-ticket'),null,'malformed ticket must be rejected');
assert.match(main,/link\.rel = 'noopener noreferrer'/,'reverse-tabnabbing protection retained');
assert.match(main,/preparePdfHandoff\(link,\s*record\.id/,'handoff prepared only on source link activation');
assert.match(main,/capturePdfHandoffAuthorization\(\)/,'each click binds a fresh vault/lock-generation guard');
assert.match(view,/receivePdfHandoff\(id,ticket/,'viewer must prefer same-origin Blob transfer');
assert.match(view,/await getRecord\(id\)/,'direct URL still supports normal auth fallback');
assert.match(main,/pdf: await getOriginalForVerifiedEdit\(record\.id, recordSignature\(record\)\)/,'home viewing shares verified single-original path');
assert.match(store,/const pdf=await perf\.measure\('pdf-original',\(\)=>vault\.original\(record\)\)/,'PDF integrity-checked by unchanged OneDrive original()');
assert.doesNotMatch(src,/sessionStorage|localStorage|indexedDB|postMessage\(\{[^}]*token|postMessage\(\{[^}]*key/,'no auth secret or plaintext persistence in handoff');
console.log('PASS: second tab receives only the verified PDF Blob; no fresh login, unchanged noopener, direct URL fallback');

// Ordinary click explicitly opens a stable, ticket-bearing URL. The original
// anchor stays usable as a direct link and never retains the one-use ticket.
{
 let opened,prevented=false,removed=false;
 const anchor={click(){opened=this.href;},remove(){removed=true;}};
 const stable={href:'https://payroll.example/view/index.html#id=43',ownerDocument:{createElement:()=>anchor,body:{append(){}}}};
 const event={type:'click',button:0,preventDefault(){prevented=true;}};
 preparePdfHandoff(stable,43,async()=>({fileName:'fixture.pdf',pdf}),()=>true,event);
 assert.equal(prevented,true);assert.equal(removed,true);
 assert.equal(stable.href,'https://payroll.example/view/index.html#id=43');
 assert.equal(anchor.rel,'noopener noreferrer');assert.equal(anchor.target,'_blank');
 const ticket=new URLSearchParams(new URL(opened).hash.slice(1)).get('handoff');
 assert.ok(ticket);assert.equal(await (await receivePdfHandoff(43,ticket)).pdf.text(),await pdf.text());
 console.log('PASS: normal click explicitly navigates with ticket; stable direct link unchanged');
}

// Fixed sender statuses disclose neither the ticket nor the record identity.
{
 const statuses=[],stable={href:'https://payroll.example/view/index.html#id=44'};
 preparePdfHandoff(stable,44,async()=>({fileName:'fixture.pdf',pdf}),()=>false,undefined,s=>statuses.push(s));
 assert.deepEqual(statuses,['not-authorized']);
 preparePdfHandoff(stable,44,async()=>({fileName:'fixture.pdf',pdf}),()=>true,undefined,s=>statuses.push(s));
 const ticket=new URLSearchParams(new URL(stable.href).hash.slice(1)).get('handoff');
 await receivePdfHandoff(44,ticket);
 assert.deepEqual(statuses,['not-authorized','ticket-issued','receiver-ready','transferred']);
 assert.ok(statuses.every(s=>!s.includes(ticket)&&!s.includes('44')));
 // The diagnostics callback cannot break the transfer.
 const throwing={href:'https://payroll.example/view/index.html#id=45'};
 preparePdfHandoff(throwing,45,async()=>({fileName:'fixture.pdf',pdf}),()=>true,undefined,()=>{throw Error('synthetic');});
 await receivePdfHandoff(45,new URLSearchParams(new URL(throwing.href).hash.slice(1)).get('handoff'));
 console.log('PASS: sender diagnostics success/denial and non-interference');
}

// No sender acknowledgement: short timeout permits direct lookup; loading does
// not use that timeout. Use controlled timers, not real network/sleep.
{
 const {runInNewContext}=await import('node:vm');
 const timers=new Map();let seq=0;
 class Channel{static last;sent=[];closed=false;constructor(){Channel.last=this;}postMessage(data){this.sent.push(data);}close(){this.closed=true;}}
 const receive=runInNewContext(js.replace(/^export /gm,'')+'\nreceivePdfHandoff',{BroadcastChannel:Channel,Blob,setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)});
 const ticket='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id=46;
 const noSender=receive(id,ticket);let c=Channel.last;
 assert.equal([...timers.values()][0].ms,2000);[...timers.values()][0].fn();
 assert.equal(await noSender,null);assert.equal(c.closed,true);assert.deepEqual(c.sent.map(m=>m.action),['ready','cancel']);
 const pending=receive(id,ticket);c=Channel.last;c.onmessage({data:{action:'loading',ticket,id}});
 assert.equal([...timers.values()][0].ms,120000);assert.deepEqual(c.sent.map(m=>m.action),['ready','start']);
 c.onmessage({data:{action:'loading',ticket,id}});assert.equal(c.sent.length,2);
 c.onmessage({data:{action:'pdf',ticket,id,pdf,fileName:'fixture.pdf'}});assert.equal((await pending).pdf,pdf);assert.equal(timers.size,0);
 const denied=receive(id,ticket);c=Channel.last;c.onmessage({data:{action:'error',ticket,id,message:'locked'}});await assert.rejects(denied,/locked/);
 console.log('PASS: short unanswered timeout, acknowledged transfer deadline, explicit errors never fall back');
}
