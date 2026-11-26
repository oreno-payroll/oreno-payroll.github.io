/** Real encrypted index, readback, ETag and backup metadata tests; synthetic labels only. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({stdin:{contents:`export {PayrollVault} from './src/cloud/vault.ts'; export {GraphError} from './src/cloud/graph.ts'; export {decryptJson} from './src/cloud/crypto.ts'; export {validateEmployerDirectory,mergeEmployerDirectories,upsertEmployer} from './src/storage/employerDirectory.ts'; export {toPublicIncomeRecord} from './src/cloud/income.ts'; export {createBackup,readBackup} from './src/storage/payrollBackup.ts'; export {readZip,writeZip} from './src/storage/zipArchive.ts'; export {encryptBackup,decryptBackup} from './src/storage/encryptedBackup.ts';`,resolveDir:root,loader:'ts',sourcefile:'employer-directory-entry.ts'},plugins:[{name:'no-pdf-in-directory-only-backup-test',setup(ctx){ctx.onResolve({filter:/^\.\/pdfIntegrity$/},()=>({path:'no-pdf',namespace:'synthetic'}));ctx.onLoad({filter:/.*/,namespace:'synthetic'},()=>({contents:'export function verifyPdfBytes(){throw new Error("Unexpected PDF in directory-only fixture")};export async function verifyPdfWithPdfJs(){throw new Error("Unexpected PDF in directory-only fixture")}',loader:'js'}));}}],bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent'});
const {PayrollVault,GraphError,decryptJson,validateEmployerDirectory,mergeEmployerDirectories,upsertEmployer,toPublicIncomeRecord,createBackup,readBackup,readZip,writeZip,encryptBackup,decryptBackup}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const A='emp_'+'a'.repeat(32),B='emp_'+'b'.repeat(32),C='emp_'+'c'.repeat(32);
const a={id:A,name:'架空勤務先A',role:'main',current:true},b={id:B,name:'架空勤務先B',role:'main',current:false},c={id:C,name:'架空勤務先C',role:'side',current:true};
const enc=new TextEncoder();
class FakeGraph{
 async withWriteLock(operation){return operation();}
 files=new Map();writes=0;discard=false;conflictOnce=false;serial=0;
 path(parts,name){return [...parts,name].join('/');}
 async read(parts,name){const item=this.files.get(this.path(parts,name));return item?{...item}:null;}
 async metadata(parts,name){return this.read(parts,name);}
 async listFolder(){return [];}
 async write(parts,name,text,prior,limit){
  const path=this.path(parts,name),old=this.files.get(path);
  if(this.conflictOnce){this.conflictOnce=false;throw new GraphError(412,'synthetic-conflict');}
  if(prior?old?.etag!==prior.etag:!!old)throw new GraphError(412,'synthetic-conflict');
  const size=enc.encode(text).length;assert.ok(size<=limit);this.writes++;
  if(!this.discard)this.files.set(path,{id:path,etag:'fixture-'+(++this.serial),text,size});
 }
}
assert.deepEqual(validateEmployerDirectory([b,a]),[a,b]);
assert.deepEqual(upsertEmployer([a,b,c],{...b,current:true}),[{...a,current:false},{...b,current:true},c]);
assert.throws(()=>upsertEmployer([a],{...a,role:'side'}),/勤務区分/);
assert.deepEqual(upsertEmployer([a],{...a,name:'架空名称変更'}),[{...a,name:'架空名称変更'}]);
for(const invalid of [null,[a,a],[a,{...b,current:true}],[{...a,name:'  '}],[{...a,name:'x\u202Ey'}],[{...a,name:'x'.repeat(101)}],[{...a,id:'main'}],[{...a,extra:true}],new Array(1)])assert.throws(()=>validateEmployerDirectory(invalid),/勤務先/);
assert.deepEqual(mergeEmployerDirectories([a],[{...a,name:'変更前'}, {...b,current:true},c].map((x,i)=>i===0?{...x,current:false}:x)),[a,b,c]);
const graph=new FakeGraph(),vault=new PayrollVault(graph);
await vault.unlock('synthetic-directory-passphrase',true);
const {key,salt}=vault.sessionKey();
assert.deepEqual(await vault.readEmployerDirectory(),[]);
const oldIndex=await decryptJson('index',graph.files.get('payroll/index.enc').text,key);assert.ok(!Object.hasOwn(oldIndex,'employers'));
assert.deepEqual(await vault.writeEmployerDirectory([], [a,b]),[a,b]);
let clear=await decryptJson('index',graph.files.get('payroll/index.enc').text,key);
assert.deepEqual(clear.employers,[a,b]);assert.deepEqual(clear.years,oldIndex.years);assert.deepEqual(clear.incomeYears,oldIndex.incomeYears);assert.ok(!graph.files.get('payroll/index.enc').text.includes(a.name));
const other=new PayrollVault(graph);await other.unlockWithKey(key,salt);
const stale=await other.readEmployerDirectory();
const renamed={...a,name:'架空勤務先A改称',current:false},current={...b,current:true};
await vault.writeEmployerDirectory([a,b],[renamed,current]);
let n=graph.writes;await assert.rejects(other.writeEmployerDirectory(stale,[a,b,c]),/更新/);assert.equal(graph.writes,n);
await assert.rejects(vault.writeEmployerDirectory([renamed,current],[renamed]),/削除/);assert.equal(graph.writes,n);
graph.conflictOnce=true;await vault.writeEmployerDirectory([renamed,current],[renamed,current,c]);
graph.discard=true;await assert.rejects(vault.writeEmployerDirectory([renamed,current,c],[a,b,c]),/保存結果/);graph.discard=false;
assert.deepEqual(await other.readEmployerDirectory(),[renamed,current,c]);
const missing={id:'emp_'+'d'.repeat(32),name:'架空勤務先D',role:'side',current:true};
await other.restoreEmployerDirectory([a,b,missing]);assert.deepEqual(await other.readEmployerDirectory(),[renamed,current,c,{...missing,current:false}]);
assert.equal(toPublicIncomeRecord({id:1,employerId:A,form:{job:'main',kind:'salary',targetMonth:'2026-10',paymentDate:'2026-10-27',gross:'100',net:'100'}}).employerId,A);
const income=toPublicIncomeRecord({id:1,employerId:A,name:a.name,form:{job:'main',kind:'salary',targetMonth:'2026-10',paymentDate:'2026-10-27',gross:'100',net:'100'}});assert.ok(!JSON.stringify(income).includes(a.name));
// New backups carry directory metadata; legacy backups never claim to replace it.
const legacy=await readBackup(await createBackup([]));assert.ok(!Object.hasOwn(legacy,'employers'));
const archive=await createBackup([],[a,b,c]);const parsed=await readBackup(archive);assert.deepEqual(parsed.employers,[a,b,c]);
const encrypted=await encryptBackup(archive,'synthetic-backup-passphrase');
assert.equal(Buffer.from(await encrypted.arrayBuffer()).includes(Buffer.from(a.name)),false);
assert.deepEqual((await readBackup(await decryptBackup(encrypted,'synthetic-backup-passphrase'))).employers,[a,b,c]);
const manifest=JSON.parse(new TextDecoder().decode(readZip(await archive.arrayBuffer()).get('manifest.json')));assert.equal(manifest.schemaVersion,2);
const withManifest=value=>writeZip([{name:'manifest.json',data:enc.encode(JSON.stringify(value))}]);
await assert.rejects(readBackup(withManifest({...manifest,employers:[a,a]})),/勤務先/);
await assert.rejects(readBackup(withManifest({...manifest,employers:undefined})),/勤務先/);
await assert.rejects(readBackup(withManifest({...manifest,schemaVersion:1})),/勤務先/);
console.log('PASS: encrypted employer directory, stable identity, stale/failed writes, safe restore, legacy and v2 backup metadata, Finance ID-only export');

// New settings travel only inside encrypted employer metadata; live entries win during additive restore.
const beforeCustom=await other.readEmployerDirectory();
const configured={...current,forecast:{salaryMethod:'average',bonusMonths:[2,12]}};
const afterCustom=upsertEmployer(beforeCustom,configured);
await other.writeEmployerDirectory(beforeCustom,afterCustom);
const reloaded=new PayrollVault(graph);await reloaded.unlockWithKey(key,salt);
assert.deepEqual(await reloaded.readEmployerDirectory(),afterCustom);
const savedIndex=await decryptJson('index',graph.files.get('payroll/index.enc').text,key);
assert.deepEqual(savedIndex.employers,afterCustom);assert.deepEqual(savedIndex.years,oldIndex.years);assert.deepEqual(savedIndex.incomeYears,oldIndex.incomeYears);
assert.ok(!graph.files.get('payroll/index.enc').text.includes('salaryMethod'));
assert.throws(()=>validateEmployerDirectory([{...configured,forecast:{salaryMethod:'average',bonusMonths:[12,12]}}]),/見込み設定/);
await reloaded.restoreEmployerDirectory([a,b]);assert.deepEqual(await reloaded.readEmployerDirectory(),afterCustom);
const customArchive=await createBackup([],afterCustom);
const customEncrypted=await encryptBackup(customArchive,'synthetic-backup-passphrase');
assert.deepEqual((await readBackup(await decryptBackup(customEncrypted,'synthetic-backup-passphrase'))).employers,afterCustom);
assert.deepEqual((await readBackup(await createBackup([]))).employers,undefined);
const customIncome=toPublicIncomeRecord({id:1,employerId:B,forecast:configured.forecast,form:{job:'main',kind:'salary',targetMonth:'2026-10',paymentDate:'2026-10-27',gross:'100',net:'100'}});
assert.deepEqual(Object.keys(customIncome).sort(),Object.keys(income).sort());assert.ok(!JSON.stringify(customIncome).includes('salaryMethod'));
console.log('PASS: forecast preferences encrypted persistence, reload, old directory restore, encrypted backup and Finance export isolation');
