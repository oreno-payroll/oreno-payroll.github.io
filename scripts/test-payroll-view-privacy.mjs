/** Round B: actual route helpers and single-PDF storage paths, using synthetic data only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=s=>stripTypeScriptTypes(s.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const loc=new URL('https://example.test/edit/index.html?id=7&fy=2025&hintYear=2024');
const window={location:loc,history:{state:null,replaceState(_state,_unused,url){loc.href=url;}}};
const routes=runInNewContext(strip(read('src/ui/navigationParams.ts'))+'\n({readNavigationParams,replaceNavigationParams,migrateLegacyNavigation})',{URL,URLSearchParams,window});
const editKeys=['id','mode','year','fy','hintYear'];
let params=routes.readNavigationParams(loc,editKeys);
assert.equal(params.get('id'),'7');assert.equal(params.get('fy'),'2025');assert.equal(params.get('hintYear'),'2024');
routes.migrateLegacyNavigation(params,editKeys);
assert.equal(loc.search,'');assert.equal(loc.hash,'#id=7&fy=2025&hintYear=2024');
assert.equal(routes.readNavigationParams(loc,editKeys).get('id'),'7');
loc.href='https://example.test/index.html?mode=fiscal&fy=2024#mode=calendar&year=2026';
params=routes.readNavigationParams(loc,['mode','year','fy']);
assert.equal(params.get('mode'),'calendar');assert.equal(params.get('year'),'2026');
routes.replaceNavigationParams(new URLSearchParams({mode:'calendar',year:'2026'}),['mode','year','fy']);
assert.equal(loc.href,'https://example.test/index.html#mode=calendar&year=2026');
const viewKeys=['id','yearend','handoff'];
for(const input of ['?id=7#handoff=fixture','#id=7&handoff=fixture']){
 loc.href='https://example.test/view/index.html'+input;
 params=routes.readNavigationParams(loc,viewKeys);assert.equal(params.get('id'),'7');assert.equal(params.get('handoff'),'fixture');
 params.delete('handoff');routes.replaceNavigationParams(params,viewKeys);assert.equal(loc.href,'https://example.test/view/index.html#id=7');
}
loc.href='https://example.test/view/index.html?yearend=old&handoff=untrusted#id=7';
params=routes.readNavigationParams(loc,viewKeys);assert.equal(params.get('id'),'7');assert.equal(params.has('yearend'),false);assert.equal(params.has('handoff'),false);
loc.href='https://example.test/view/index.html#id=7&id=8';assert.equal(routes.readNavigationParams(loc,viewKeys).getAll('id').length,2);
const main=read('src/main.ts'),edit=read('src/edit.ts'),view=read('src/view.ts');
assert.doesNotMatch(main+edit+read('src/pdf/yearEndHandoff.ts'),/index\.html\?(?:id|yearend|mode|year)=/);
assert.match(main,/pdf: await getOriginalForVerifiedEdit\(record\.id, recordSignature\(record\)\)/);
assert.match(edit,/pdf:await getOriginalForVerifiedEdit/);
assert.doesNotMatch(view,/(?:document|reader)\.title\s*=\s*(?:record|payload)\.fileName/);
assert.ok(view.indexOf("params.delete('handoff')")<view.indexOf('await receiveYearEndPdf'));
console.log('PASS: fragment routes, legacy migration, untrusted query ticket rejection, fixed title and verified UI path');
const pdf=new Blob(['%PDF-1.7 synthetic-only'],{type:'application/pdf'});
const rec={id:7,savedAt:'2026-01-01',revision:1,fileName:'synthetic-only.pdf',form:{targetMonth:'2026-01'},pages:1,pdfSize:pdf.size,pdfType:pdf.type,fileHash:'a'.repeat(64),warningsAcknowledged:true,originalId:'fixture-one',originalMonth:'2026-01'};
let before,after,reads,downloads,failAt;
const vault={
 async refresh(opts){assert.equal(opts.forceFresh,true);assert.equal(opts.reuseVerifiedYears,true);assert.equal(opts.bulkYearMetadata,true);reads++;if(failAt===reads)throw Error('fixture network failure');return structuredClone(reads===1?before:after);},
 records(){throw Error('single viewer must not use a stale in-memory snapshot');},
 async original(record){downloads++;assert.equal(record.id,7);return pdf;},
};
const api=runInNewContext(strip(read('src/storage/payrollStore.ts'))+'\n({getOriginalForVerifiedEdit,getRecord,recordSignature})',{cloudVault:async()=>vault,Blob,structuredClone});
const signature=api.recordSignature(rec);
const setup=(a,b,fail=0)=>{before=a;after=b;reads=downloads=0;failAt=fail;};
for(const get of [()=>api.getOriginalForVerifiedEdit(7,signature),()=>api.getRecord(7)]){
 setup([rec],[rec]);const got=await get();assert.equal(got instanceof Blob?got:got.pdf,pdf);assert.equal(reads,2);assert.equal(downloads,1);
 for(const changed of [[],[{...rec,revision:2}],[{...rec,originalId:'fixture-two'}],[{...rec,originalMonth:'2026-02'}]]){
  setup([rec],changed);await assert.rejects(get,/PDF取得中に明細が更新/);assert.equal(reads,2);assert.equal(downloads,1);
 }
 setup([rec],[rec],2);await assert.rejects(get,/network failure/);assert.equal(downloads,1);
 setup([rec],[rec],1);await assert.rejects(get,/network failure/);assert.equal(downloads,0);
}
setup([],[]);await assert.rejects(api.getOriginalForVerifiedEdit(7,signature),/更新/);assert.equal(downloads,0);
setup([],[]);assert.equal(await api.getRecord(7),undefined);assert.equal(downloads,0);
setup([{...rec,revision:2}],[rec]);await assert.rejects(api.getOriginalForVerifiedEdit(7,signature),/更新/);assert.equal(downloads,0);
console.log('PASS: stale/deleted records, changed original reference, and network failures never release PDF');
