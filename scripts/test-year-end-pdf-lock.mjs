/** Viewer must remain a Payroll tab and close plaintext iframe on global lock. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=code=>stripTypeScriptTypes(code.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const ui=read('src/year-end-assist.ts');
assert.match(ui,/openYearEndPdf\(id,/);
assert.doesNotMatch(ui,/window\.open\(url|tab\.location\.replace\(url|URL\.createObjectURL\(blob\)/);
assert.match(read('src/view.ts'),/createTabLockCoordinator\(/);

const buckets=new Map();
class Channel {
 onmessage=null;name;closed=false;
 constructor(name){this.name=name;const list=buckets.get(name)??[];list.push(this);buckets.set(name,list);}
 postMessage(data){for(const peer of buckets.get(this.name)??[]){if(peer===this||peer.closed)continue;queueMicrotask(()=>peer.onmessage?.({data}));}}
 close(){this.closed=true;}
}
let epoch='initial';const links=[];
const sandbox={crypto:webcrypto,Blob,URL,encodeURIComponent,BroadcastChannel:Channel,
 localStorage:{getItem:()=>epoch},setTimeout,clearTimeout,
 document:{body:{append(){}},createElement:()=>({href:'',target:'',rel:'',click(){links.push({href:this.href,rel:this.rel,target:this.target});},remove(){}})}};
const handoff=runInNewContext(strip(read('src/pdf/yearEndHandoff.ts'))+'\n({openYearEndPdf,receiveYearEndPdf})',sandbox);
const id=webcrypto.randomUUID(),pdf=new Blob(['%PDF-1.7\nSAMPLE'],{type:'application/pdf'});
handoff.openYearEndPdf(id,async()=>({pdf,fileName:'架空従業員.pdf'}));
const link=links.at(-1);assert.match(link.href,/view\/index\.html\?yearend=/);
assert.equal(link.target,'_blank');assert.match(link.rel,/noopener/);
const ticket=new URL(link.href,'https://example.test/year-end-assist/index.html').hash.slice('#handoff='.length);
const got=await handoff.receiveYearEndPdf(id,ticket);
assert.equal(got.pdf,pdf);assert.equal(got.fileName,'架空従業員.pdf');
let proceed;
handoff.openYearEndPdf(id,()=>new Promise(resolve=>{proceed=()=>resolve({pdf,fileName:'private.pdf'});}));
const next=new URL(links.at(-1).href,'https://example.test/year-end-assist/index.html').hash.slice('#handoff='.length);
const pending=handoff.receiveYearEndPdf(id,next);
for(let i=0;i<10&&!proceed;i++)await Promise.resolve();
assert.equal(typeof proceed,'function');
epoch='locked';proceed();
await assert.rejects(pending,/ロック/);

// Exercise the actual PDF view controller with a stand-in DOM.
const reader={src:'',hidden:true,title:'',removeAttribute(name){if(name==='src')this.src='';}};
const status={hidden:false,textContent:'',dataset:{},classList:{add(){}},setAttribute(){},removeAttribute(){}};
let remoteLock,revoked='';
const location={href:`https://example.test/view/index.html?yearend=${id}#handoff=${ticket}`,search:`?yearend=${id}`,hash:`#handoff=${ticket}`};
const mock={Blob,URL:class extends URL{static createObjectURL(file){assert.equal(file,pdf);return 'blob:private';}static revokeObjectURL(url){revoked=url;}},
 URLSearchParams,location,navigator:{serviceWorker:{getRegistration:async()=>null}},
 window:{addEventListener(){},history:{state:null,replaceState(){}},location},
 document:{title:'',getElementById:key=>key==='pdf-status'?status:key==='pdf-reader'?reader:null},
 createTabLockCoordinator:callback=>{remoteLock=callback;return {check:()=>true,epoch:()=>''};},
 receiveYearEndPdf:async()=>({pdf,fileName:'架空従業員.pdf'}),
 getRecord:async()=>{throw new Error('personal data should not load');},
 console,setTimeout,clearTimeout};
const app=strip(read('src/ui/appStatus.ts'))+'\n'+strip(read('src/view.ts'));
runInNewContext(app,mock,{filename:'year-end-view.ts'});
for(let i=0;i<20&&!reader.src;i++)await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(reader.src,'blob:private');
assert.equal(reader.hidden,false);
assert.equal(mock.document.title,'架空従業員.pdf');
remoteLock();
assert.equal(reader.hidden,true);
assert.equal(reader.src,'');
assert.equal(revoked,'blob:private');
assert.match(status.textContent,/ロック/);
console.log('PASS: one-use year-end PDF handoff, no naked blob tab, lock during transfer, viewer iframe teardown');
