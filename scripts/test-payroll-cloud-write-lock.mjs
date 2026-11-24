/** Production Graph lock protocol, with synthetic in-memory transport only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const src=readFileSync(new URL('../src/cloud/graph.ts',import.meta.url),'utf8');
const {PayrollGraph,PAYROLL_WRITE_LOCK_NAME:name}=runInNewContext(stripTypeScriptTypes(src.replace(/^import[^\n]*\n/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'})+'\n({PayrollGraph,PAYROLL_WRITE_LOCK_NAME})',{
 URL,Response,Request,Headers,TextEncoder,TextDecoder,Uint8Array,performance,crypto:webcrypto,setTimeout,clearTimeout,
 observeGraphTransfer:()=>{},observeGraphRetry:()=>{},MicrosoftSignInRequiredError:class extends Error{},MicrosoftTemporaryError:class extends Error{},
});
function fixture(){
 const state={lock:null,serial:0,writes:0,lostCreate:false,lostWrite:false,lostRelease:false,events:[]};
 const meta=()=>({name,id:state.lock.id,eTag:state.lock.etag,size:state.lock.text.length,'@microsoft.graph.downloadUrl':'https://storage.example.test/'+state.lock.id});
 const http=async(raw,init={})=>{
  const u=new URL(raw),method=init.method??'GET';
  if(u.hostname==='storage.example.test'){
   assert.equal(method,'GET');assert.equal(new Headers(init.headers).has('Authorization'),false);
   return state.lock&&u.pathname==='/'+state.lock.id?new Response(state.lock.text):new Response(null,{status:404});
  }
  assert.equal(u.origin,'https://graph.microsoft.com');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fixture');
  if(u.pathname.endsWith('/special/approot'))return Response.json({id:'root'});
  if(u.pathname.endsWith('/root:/'+name+':/content')&&method==='PUT'){
   assert.equal(u.searchParams.get('@microsoft.graph.conflictBehavior'),'fail');
   if(state.lock)return new Response(null,{status:409});
   state.lock={id:'lock-'+(++state.serial),etag:'etag-'+state.serial,text:new TextDecoder().decode(init.body)};
   assert.match(state.lock.text,/^[a-f0-9]{64}$/);state.events.push('acquire');
   if(state.lostCreate)throw Error('lost acquire response');return Response.json(meta(),{status:201});
  }
  if(u.pathname.endsWith('/root:/'+name)&&method==='GET'){
   if(!state.lock)return new Response(null,{status:404});
   return Response.json(meta());
  }
  if(method==='DELETE'&&u.pathname.includes('/items/lock-')){
   if(!state.lock||!u.pathname.endsWith('/'+state.lock.id))return new Response(null,{status:404});
   if(new Headers(init.headers).get('If-Match')!==state.lock.etag)return new Response(null,{status:412});
   state.lock=null;state.events.push('release');if(state.lostRelease)throw Error('lost release response');return new Response(null,{status:204});
  }
  if(u.pathname.endsWith('/synthetic-write')&&method==='POST'){
   assert.ok(state.lock);state.writes++;state.events.push('write');if(state.lostWrite)throw Error('lost write response');return Response.json({});
  }
  throw Error('unexpected synthetic request '+method+' '+u.pathname);
 };
 const graph=()=>new PayrollGraph('fixture',http);
 return {state,graph,write:g=>g.request('/synthetic-write',{method:'POST'})};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
{
 const f=fixture(),a=f.graph(),b=f.graph(),entered=deferred(),resume=deferred();
 await assert.rejects(f.write(a),/ロックを取得していない/);
 const pending=a.withWriteLock(async()=>{entered.resolve();await resume.promise;await f.write(a);return 42;});
 await entered.promise;
 await assert.rejects(b.withWriteLock(()=>f.write(b)),/他の端末/);
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/別の保存処理/);
 resume.resolve();assert.equal(await pending,42);assert.equal(f.state.lock,null);
 assert.deepEqual(f.state.events,['acquire','write','release']);
 await b.withWriteLock(()=>f.write(b));assert.equal(f.state.serial,2);assert.equal(f.state.writes,2);assert.equal(f.state.lock,null);
 console.log('PASS: default mutation guard, two clients, same client, verified release and reacquisition');
}
{
 const f=fixture(),a=f.graph();f.state.lostCreate=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/取得を確認できません/);assert.equal(f.state.writes,0);assert.ok(f.state.lock);
 await assert.rejects(f.graph().withWriteLock(async()=>{}),/他の端末/);
 console.log('PASS: ambiguous acquisition never writes or steals');
}
{
 const f=fixture(),a=f.graph();f.state.lostWrite=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/ロックが残っている可能性/);assert.equal(f.state.writes,1);assert.ok(f.state.lock);
 console.log('PASS: ambiguous mutation retains lock, no retry');
}
{
 const f=fixture(),a=f.graph();await assert.rejects(a.withWriteLock(async()=>{throw Error('validation failure');}),/validation failure/);assert.equal(f.state.lock,null);
 await assert.rejects(a.withWriteLock(async()=>{await f.write(a);throw Error('late failure');}),/ロックが残っている可能性/);assert.ok(f.state.lock);
 console.log('PASS: validation failure releases; post-write failure retains');
}
{
 const f=fixture(),a=f.graph();await assert.rejects(a.withWriteLock(async()=>{f.state.lock={id:'successor',etag:'new',text:'a'.repeat(64)};await f.write(a);}),/所有権/);assert.equal(f.state.writes,0);assert.equal(f.state.lock.id,'successor');
 console.log('PASS: changed owner blocks mutation and release');
}
{
 const f=fixture(),a=f.graph();f.state.lostRelease=true;
 await assert.rejects(a.withWriteLock(()=>f.write(a)),/解除を確認できません/);assert.equal(f.state.writes,1);assert.equal(f.state.lock,null);
 console.log('PASS: ambiguous release never reports success or retries mutation');
}
// S08: real AES-GCM originals; absent hash is not verified, even with correct bytes.
{
 const {encryptBytes,decryptBytes}=await import('../src/cloud/crypto.ts');
 const vaultSource=readFileSync(new URL('../src/cloud/vault.ts',import.meta.url),'utf8');
 const code=stripTypeScriptTypes(vaultSource.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
 const {PayrollVault}=runInNewContext(code+'\n({PayrollVault})',{crypto:webcrypto,structuredClone,Blob,TextDecoder,TextEncoder,Uint8Array,decryptBytes,encryptBytes});
 const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const bytes=new TextEncoder().encode('%PDF-1.7\nSynthetic original');
 const ciphertext=await encryptBytes('original',bytes,key),hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
 let reads=0;
 const v=new PayrollVault({read:async()=>{reads++;return {text:ciphertext,id:'original',etag:'e',size:ciphertext.length};}});
 v.key=key;v.salt='synthetic-salt';
 const record={originalMonth:'2026-04',originalId:'fixture-original',pdfSize:bytes.length,pdfType:'application/pdf'};
 await assert.rejects(v.original(record),/SHA-256/);assert.equal(reads,0);
 await assert.rejects(v.original({...record,fileHash:'invalid'}),/SHA-256/);assert.equal(reads,0);
 assert.equal(await v.legacyOriginalDigest(record),hash);assert.equal(reads,1);
 await assert.rejects(v.legacyOriginalDigest({...record,fileHash:'invalid'}),/ハッシュ/);
 assert.equal((await v.original({...record,fileHash:hash})).size,bytes.length);
 await assert.rejects(v.original({...record,fileHash:'0'.repeat(64)}),/SHA-256/);
 console.log('PASS: real encrypted original hash required, legacy digest restricted to duplicate detection');
}
