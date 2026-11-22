/** No real Graph access: unreferenced PDF audit/retrieve/trash safeguards. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function load(relative){
 const result=await build({entryPoints:[new URL('../'+relative,import.meta.url).pathname],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const {PayrollVault}=await load('src/cloud/vault.ts');
const {encryptBytes}=await load('src/cloud/crypto.ts');
const active='11111111-1111-4111-8111-111111111111';
const orphan='22222222-2222-4222-8222-222222222222';
const path=['payroll','originals','2026','11'];
async function fixture(){
 const key=await crypto.subtle.importKey('raw',new Uint8Array(32),{name:'AES-GCM'},false,['encrypt','decrypt']);
 const cipher=await encryptBytes('original',new TextEncoder().encode('%PDF-1.4\nbody'),key);
 const state={yearEtag:'y1',indexEtag:'i1',otherYear:false,referenceOrphan:false,deletes:[],reads:0};
 const index={format:'payroll-index-v1',years:['2026'],incomeYears:[]};
 const graph={
  async listFolder(p){if(p.at(-1)==='statements')return [{name:'2026.enc',folder:false,etag:state.yearEtag},...(state.otherYear?[{name:'2025.enc',folder:false,etag:'orphan-year'}]:[])];throw new Error('unexpected listFolder');},
  async read(p,name){assert.deepEqual(p,path);assert.equal(name,`${orphan}.enc`);state.reads++;return {id:'cloud-orphan',etag:'o1',size:cipher.length,text:cipher};},
  async metadata(_,name){assert.equal(name,'2026.enc');return {id:'year-file',etag:state.yearEtag};},
  async trashPayrollOriginal(p,item){assert.deepEqual(p,path);assert.equal(item.name,`${orphan}.enc`);state.deletes.push(item);},
 };
 const vault=new PayrollVault(graph);
 vault.key=key;vault.index=index;vault.salt='salt';
 vault.readIndex=async()=>({index,file:{id:'root',etag:state.indexEtag}});
 vault.readYear=async()=>({doc:{format:'payroll-annual-v1',records:[{
  id:7,form:{targetMonth:'2026-11',paymentDate:'2026-11-25'},
  originalMonth:'2026-11',originalId:state.referenceOrphan?orphan:active,pdfSize:13,fileName:'a.pdf',
 }],deleted:[]},file:{etag:state.yearEtag}});
 vault.listOriginalFiles=async()=>[
  {id:'cloud-active',month:'2026-11',uuid:active,path,name:`${active}.enc`,etag:'a1',size:100},
  {id:'cloud-orphan',month:'2026-11',uuid:orphan,path,name:`${orphan}.enc`,etag:'o1',size:cipher.length},
 ];
 return {vault,state};
}
{
 const {vault,state}=await fixture();
 const report=await vault.inspectDetachedOriginals();
 assert.equal(report.originals.length,1);
 assert.equal(report.originals[0].uuid,orphan);
 const pdf=await vault.retrieveDetachedOriginal(report,report.originals[0]);
 assert.equal(pdf.type,'application/pdf');
 assert.equal(await pdf.text(),'%PDF-1.4\nbody');
 await vault.trashDetachedOriginal(report,report.originals[0]);
 assert.equal(state.deletes.length,1);
}
{
 const {vault,state}=await fixture();
 const report=await vault.inspectDetachedOriginals();
 state.referenceOrphan=true;
 await assert.rejects(vault.trashDetachedOriginal(report,report.originals[0]),/再検査|確認/);
 assert.equal(state.deletes.length,0,'an original newly referenced by a statement must never be trashed');
}
{
 const {vault,state}=await fixture();
 const report=await vault.inspectDetachedOriginals();
 state.yearEtag='y2';
 await assert.rejects(vault.trashDetachedOriginal(report,report.originals[0]),/再検査|変更/);
 assert.equal(state.deletes.length,0,'a changed annual ETag blocks a stale deletion');
}
{
 const {vault,state}=await fixture();state.otherYear=true;
 await assert.rejects(vault.inspectDetachedOriginals(),/索引に登録されていない年度/);
 assert.equal(state.deletes.length,0);
}
console.log('PASS: unreferenced PDF readable and recoverable; cross-tab changes and orphan years block trash');
