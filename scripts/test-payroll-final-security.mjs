/** Actual crypto, Graph and cache code with synthetic data only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {PayrollGraph} from '../src/cloud/graph.ts';
import {encryptJson,decryptJson,parseEnvelope,createSalt} from '../src/cloud/crypto.ts';
import {fiscalYearOfTargetMonth} from '../src/forecast/payrollCalendar.ts';
import {validEmployerId} from '../src/storage/employerIdentity.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'transform'});
const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),salt=createSalt();
const rec={id:1,originalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',originalMonth:'2026-03',pdfSize:10,fileName:'fixture.pdf',form:{targetMonth:'2026-03',paymentDate:'2026-04-01',job:'main',kind:'salary',gross:'1000',net:'800'}};
const doc={format:'payroll-annual-v1',records:[rec],deleted:[]};
{
 let cached=null,cleared=0;
 const {PayrollVault,validateDoc}=runInNewContext(strip(read('src/cloud/vault.ts'))+'\n({PayrollVault,validateDoc})',{crypto,structuredClone,TextEncoder,TextDecoder,parseEnvelope,decryptJson,fiscalYearOfTargetMonth,validEmployerId,isValidPayrollSemantics:()=>true,isValidPayrollZeroResolution:()=>true,mutationEpoch:()=> 'fixture',restoredNavigationSnapshot:async()=>cached,clearNavigationSnapshot(){cleared++;}});
 const text=await encryptJson('year',doc,key,salt);
 const vault=new PayrollVault({read:async()=>({text,id:'fixture',etag:'fixture'})});
 vault.key=key;vault.salt=salt;
 assert.equal((await vault.readYear('2025')).doc.records[0].id,1);
 await assert.rejects(vault.readYear('2026'),/対象年度/);
 for(const [name,value] of [['paymentDate','2026-02-30'],['targetMonth','2026-13'],['job','unknown'],['gross','Infinity'],['net','1.2'],['gross',1000]]){
  const bad=structuredClone(doc);bad.records[0].form[name]=value;assert.throws(()=>validateDoc(bad,'2025'));
 }
 const legacy=structuredClone(doc);delete legacy.records[0].form.gross;assert.equal(validateDoc(legacy,'2025').records.length,1);
 vault.setNavigationScope('fixture');cached={data:{index:{format:'payroll-index-v1',years:['2026'],incomeYears:[]},years:[['2026',doc]]},expires:Date.now()+1000};
 assert.equal(await vault.resumeFromSnapshot(key,salt),false);assert.equal(cleared,1);
 cached={data:{index:{format:'payroll-index-v1',years:['2025'],incomeYears:[]},years:[['2025',doc]]},expires:Date.now()+1000};
 assert.equal(await vault.resumeFromSnapshot(key,salt),true);
}
// Same-size concurrent replacement cannot poison the encrypted read cache.
{
 const signed='https://storage.example.invalid/fixture',content='synthetic';let tag='A',race=true,downloads=0,conditional=0,oversized=false,cancelled=false;
 const graph=new PayrollGraph('fixture',async(url,init={})=>{
  if(url===signed){assert.equal(new Headers(init.headers).has('authorization'),false);downloads++;if(race){tag='B';race=false;}
   if(oversized)return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(100));},cancel(){cancelled=true;}}));
   return new Response(content);
  }
  const path=new URL(url).pathname;
  if(path.endsWith('/special/approot'))return Response.json({id:'root'});
  if(path.endsWith('/items/root:/payroll'))return Response.json({id:'folder'});
  assert.match(path,/\/items\/folder:\/2026.enc$/);
  if(new Headers(init.headers).get('if-none-match')===tag){conditional++;return new Response(null,{status:304});}
  return Response.json({id:'item',eTag:tag,size:content.length,'@microsoft.graph.downloadUrl':signed});
 }, undefined, undefined, undefined, false);
 await assert.rejects(graph.read(['payroll'],'2026.enc',20),/世代が変更/);
 assert.equal((await graph.read(['payroll'],'2026.enc',20)).etag,'B');assert.equal(downloads,2);
 assert.equal((await graph.read(['payroll'],'2026.enc',20)).etag,'B');assert.equal(conditional,1);assert.equal(downloads,2);
 tag='C';oversized=true;await assert.rejects(graph.read(['payroll'],'2026.enc',20),/ダウンロードサイズ超過/);assert.equal(cancelled,true);
}
// Two independent tab session stores, one shared local store; deliberately no storage events.
{
 const storage=()=>{const map=new Map();return {map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
 const shared=storage();
 const tab=()=>{const sessionStorage=storage();const api=runInNewContext(strip(read('src/cloud/snapshot.ts'))+'\n({rememberNavigationSnapshot,restoredNavigationSnapshot,invalidateNavigationSnapshot,mutationEpoch})',{crypto,encryptJson,decryptJson,sessionStorage,localStorage:shared});return {api,sessionStorage};};
 const a=tab(),b=tab();
 for(const channel of ['dashboard','people']){await b.api.rememberNavigationSnapshot('fixture',salt,key,{fixture:channel},channel);assert.equal((await b.api.restoredNavigationSnapshot('fixture',salt,key,channel)).data.fixture,channel);}
 const old=b.api.mutationEpoch();a.api.invalidateNavigationSnapshot();
 for(const channel of ['dashboard','people'])assert.equal(await b.api.restoredNavigationSnapshot('fixture',salt,key,channel),null);
 assert.equal(b.sessionStorage.map.size,0);assert.equal(shared.map.size,1);assert.match([...shared.map.values()][0],/^[\da-f-]{36}$/);
 await b.api.rememberNavigationSnapshot('fixture',salt,key,{fixture:true},'dashboard',old);assert.equal(b.sessionStorage.map.size,0);
 const saving=b.api.rememberNavigationSnapshot('fixture',salt,key,{fixture:true});a.api.invalidateNavigationSnapshot();await saving;assert.equal(b.sessionStorage.map.size,0);
}
{
 const source=read('src/view.ts'),start=source.indexOf('const locks=createTabLockCoordinator('),end=source.indexOf('function assertUnlocked',start);assert.ok(start>=0&&end>start);
 let cb,removed=false,revoked=false;const document={title:'fixture.pdf'},reader={title:'fixture.pdf',hidden:false,removeAttribute(n){assert.equal(n,'src');removed=true;}};
 runInNewContext(source.slice(start,end),{document,reader,locked:false,fallbackUrl:'blob:fixture',URL:{revokeObjectURL(){revoked=true;}},appStatus:{error(){}},createTabLockCoordinator(fn){cb=fn;return {};}});cb();
 assert.equal(document.title,'Payroll | PDF原本');assert.equal(reader.title,'PDF原本');assert.equal(reader.hidden,true);assert.equal(removed,true);assert.equal(revoked,true);
 assert.doesNotMatch(read('src/main.ts'),/console\.error\([^\n]*,\s*error\s*\)/);
}
console.log('PASS: real encrypted annual identity and schema, Graph generation and stream cancellation, cross-tab encrypted cache epoch, PDF lock cleanup');
