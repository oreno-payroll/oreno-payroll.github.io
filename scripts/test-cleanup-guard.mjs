/** OneDriveやブラウザの保存データを変更しない、旧領域の整理・誤削除防止の結合テスト。 */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=new URL('../',import.meta.url).pathname;
const built=await build({stdin:{contents:"export {PayrollVault} from './src/cloud/vault.ts'; export {GraphError} from './src/cloud/graph.ts';",resolveDir:root,sourcefile:'test-cleanup.ts',loader:'ts'},bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
const {PayrollVault,GraphError}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
class CloudMock {
  files=new Map(); reads=[];deleted=[]; changed=false;
  key(parts,name){return [...parts,name].join('/');}
  async read(parts,name){const k=this.key(parts,name);this.reads.push(k);return this.files.has(k)?{...this.files.get(k)}:null;}
  async metadata(parts,name){const file=this.files.get(this.key(parts,name));return file?{id:file.id,etag:file.etag,size:file.size}:null;}
  async write(parts,name,text,prior,limit){const k=this.key(parts,name);const old=this.files.get(k);if(prior&&(!old||old.etag!==prior.etag))throw new GraphError(412,'conflict');if(!prior&&old)throw new GraphError(409,'conflict');const size=new TextEncoder().encode(text).byteLength;if(size>limit)throw new Error('limit');this.files.set(k,{id:k,etag:'tag'+crypto.randomUUID(),size,text});}
  listFolderSync(parts){const prefix=parts.join('/')+'/',children=new Map();for(const path of this.files.keys()){
    if(!path.startsWith(prefix))continue;
    const after=path.slice(prefix.length),name=after.split('/')[0];
    const folder=after.includes('/');
    const key=prefix+name;
    const old=children.get(name);
    if(!old||folder){children.set(name,{id:key,name,etag:folder?'etag-folder-'+key:this.files.get(key)?.etag,folder,size:folder?0:this.files.get(key)?.size??0});}
  }
  return [...children.values()];}
  async listFolder(parts){if(this.changed){this.changed=false;this.files.set('payroll/versions/external-change/extra.txt',{id:'external',etag:'external',size:1,text:'x'});}
    return this.listFolderSync(parts);
  }
  async trashFolder(parts,item){const list=this.listFolderSync(parts);const actual=list.find(x=>x.name===item.name);if(!actual||actual.id!==item.id||actual.etag!==item.etag||!actual.folder)throw new Error('changed');const prefix=actual.id+'/';for(const name of [...this.files.keys()])if(name.startsWith(prefix))this.files.delete(name);this.deleted.push(actual.id);}
}
const sample=async()=>{const data=new TextEncoder().encode('%PDF-1.7\nmock cleanup');const h=await crypto.subtle.digest('SHA-256',data);return {id:151,fileName:'pdf.pdf',originalFileName:'pdf.pdf',pdf:new Blob([data],{type:'application/pdf'}),fileHash:Buffer.from(h).toString('hex'),pages:1,revision:1,warningsAcknowledged:true,savedAt:new Date().toISOString(),form:{targetMonth:'2026-11',paymentDate:'2026-11-27',job:'main',kind:'salary',net:'180000',gross:'230000'}};};
async function prepared(){const g=new CloudMock(),v=new PayrollVault(g);await v.unlock('current-passphrase-1234',true);await v.saveBatch([await sample()]);const {generation}=await v.changePassphrase('current-passphrase-1234','new-passphrase-123456');return {g,v,generation};}
{
 const {g,v,generation}=await prepared();
 const plan=await v.inspectOldEncryptedData();
 assert.equal(plan.generation,generation);
 assert.ok(plan.targets.some(t=>t.parent.join('/')==='payroll'&&t.item.name==='statements'));
 assert.ok(plan.targets.some(t=>t.item.name==='recovery'));
 assert.ok(plan.targets.every(t=>t.item.name!==generation));
 assert.ok(plan.targets.every(t=>!(t.parent.join('/')==='payroll'&&t.item.name==='income')),'Finance legacy income must be preserved');
 const removed=await v.cleanupOldEncryptedData(plan);
 assert.equal(removed,plan.targets.length);
 assert.equal(g.deleted.length,removed);
 assert.ok(!g.deleted.some(v=>v.includes('/'+generation+'/statements')||v.endsWith('/'+generation)));
 assert.ok([...g.files.keys()].some(path=>/^payroll\/income\/\d{4}\.enc$/.test(path)),'legacy Finance income must remain');
 assert.equal((await v.refresh()).length,1);
 assert.ok((await v.original(v.records()[0])).size>0);
 const after=await v.inspectOldEncryptedData();assert.equal(after.targets.length,0);
 console.log('PASS: current generation preserved; old root/recovery moved to bin; active PDF still readable');
}
{
 const {g,v}=await prepared(),plan=await v.inspectOldEncryptedData();
 const original=g.files.get('payroll/index.enc');g.files.set('payroll/index.enc',{...original,etag:'external-index'});
 await assert.rejects(v.cleanupOldEncryptedData(plan),/変わりました|再確認/);
 assert.equal(g.deleted.length,0);
 console.log('PASS: modified index ETag prevents any deletion');
}
{
 const {g,v,generation}=await prepared();
 g.files.set(`payroll/versions/${generation}/recovery/extra.txt`,{id:'extra',etag:'tag',size:1,text:'extra'});
 await assert.rejects(v.inspectOldEncryptedData(),/想定外/);
 assert.equal(g.deleted.length,0);
 console.log('PASS: unknown file in recovery rejects cleanup');
}
{
 const g=new CloudMock(),v=new PayrollVault(g);await v.unlock('current-passphrase-1234',true);
 await assert.rejects(v.inspectOldEncryptedData(),/変更履歴/);
 assert.equal(g.deleted.length,0);
 console.log('PASS: never delete unrotated active legacy storage');
}
{
 const local=readFileSync(new URL('../src/storage/payrollStore.ts',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../public/backup/index.html',import.meta.url),'utf8');
 const code=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
 for(const id of ['cloud-cleanup-check','cloud-cleanup-delete','cloud-cleanup-status','legacy-cleanup-check','legacy-cleanup-delete','legacy-cleanup-status']){
  assert.equal((ui.match(new RegExp('id="'+id+'"','g'))??[]).length,1);
  assert.ok(code.includes(id));
 }
 assert.match(local,/inspectLegacyIndexedDb/);
 assert.match(local,/export async function deleteLegacyIndexedDb\(/);
 const localCleanup=local.slice(local.indexOf('export async function deleteLegacyIndexedDb('));
 assert.doesNotMatch(localCleanup,/cloudVault\(|vault\.|recordSignature\(/,'local cleanup must not use OneDrive');
 assert.match(localCleanup,/indexedDB\.deleteDatabase\('payroll-local-v1'\)/);
 assert.doesNotMatch(localCleanup,/indexedDB\.deleteDatabase\(\s*[^'"\s]/);
 assert.match(code,/prompt\('削除するには/);
 console.log('PASS: cleanup controls and safe known-DB-only checks');
}
