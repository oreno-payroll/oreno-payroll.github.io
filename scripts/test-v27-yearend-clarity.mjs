/** Synthetic UX regression: incomplete yearly totals, same-name restore, single exit prompt. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const model=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(read('src/yearEnd/model.ts'),{mode:'strip'})).toString('base64'));
const id=model.randomPersonId(),at='2026-11-21T00:00:00Z';
const salary={id:model.randomDocumentId(),personId:id,kind:'salary',paymentDate:'2026-01-25',targetMonth:'2026-01',taxable:240000,
 gross:260000,transportation:10000,nonTaxable:10000,healthInsurance:1000,pension:1000,employmentInsurance:100,incomeTax:2000,residentTax:0,
 fileName:'synthetic.pdf',pdfSize:100,fileHash:'a'.repeat(64),confirmedAt:at,updatedAt:at,source:'pdf-reviewed',revision:1};
const estimates=Array.from({length:9},(_,i)=>({month:`2026-${String(i+2).padStart(2,'0')}`,amount:250000,method:'manual',references:[],updatedAt:at}));
const annual={...model.emptyYear(id,2026),documents:[salary],estimates};
const totals=model.calculateYear(annual);
assert.equal(totals.total,2490000,'yearly calculation stays the existing actual+forecast total');
assert.deepEqual(totals.unknownMonths,['2026-11','2026-12']);
assert.deepEqual(model.calculateYear({...annual,noPaymentMonths:['2026-11']}).unknownMonths,['2026-12']);
assert.equal(model.calculateYear({...annual,estimates:[...estimates,{month:'2026-11',amount:1,method:'manual',references:[],updatedAt:at},{month:'2026-12',amount:1,method:'manual',references:[],updatedAt:at}]}).unknownMonths.length,0);
const html=read('public/year-end-assist/index.html'),ui=read('src/year-end-assist.ts'),css=read('public/styles/year-end-assist.css');
for(const id of ['yea-total-missing','yea-total-missing-note'])assert.match(html,new RegExp(`id="${id}"[^>]*hidden`));
assert.match(ui,/totals\.unknownMonths\.length===0/);
assert.match(ui,/未取得の月あり/);
assert.match(ui,/未取得月の金額は年間課税支給額に含まれていません/);
assert.match(ui,/\$\('yea-total-missing'\)\.hidden=true/,'reset stale warning while loading a different year');
assert.match(css,/\.yea-total-missing/);
console.log('PASS: missing months are shown alongside annual total without changing the calculation, and reset on year loading');

const exit=ui.slice(ui.indexOf('async function checkDetailExit(guard:()=>boolean):Promise<boolean>{'),ui.indexOf('const displayPerson='));
assert.ok(exit.startsWith('async function checkDetailExit(guard:()=>boolean):Promise<boolean>{'));
async function checkExit({memo=false,edits=false,forecast=false,bonus=false,accept=true}={}){
 const messages=[];
 const ctx={memoDirty:memo,forecastDirty:forecast,bonusDirty:bonus,pendingEdits:()=>edits,approveYearEnd:async(request,guard)=>{messages.push(request.subject+' '+request.details.join(' '));return accept&&guard();}};
 const fn=runInNewContext(stripTypeScriptTypes(exit,{mode:'strip'})+'\ncheckDetailExit',ctx);
 return {result:await fn(()=>true),messages};
}
let result=await checkExit({memo:true,edits:true,forecast:true,bonus:true});
assert.equal(result.result,true);assert.equal(result.messages.length,1);
for(const target of ['明細','給与・賞与の見込み','年別メモ'])assert.ok(result.messages[0].includes(target));
result=await checkExit({memo:true,edits:true,forecast:true,accept:false});
assert.equal(result.result,false);assert.equal(result.messages.length,1,'a rejected exit asks only once');
assert.equal((await checkExit()).messages.length,0);
assert.equal((await checkExit({edits:true})).messages.length,1);
console.log('PASS: one exit confirmation lists every unsaved area; cancel preserves the current screen');

const backup=read('src/backup.ts'),repository=read('src/yearEnd/repository.ts'),vaultCss=read('public/styles/vault.css');
assert.match(repository,/sameNameCollision=status==='restore'/);
assert.match(repository,/otherId!==id/);
assert.match(repository,/\.normalize\('NFKC'\)\.trim\(\)/);
assert.match(repository,/同名の別データが追加されます/);
assert.match(backup,/同名注意/);
assert.match(backup,/state\.dataset\.nameCollision='true'/);
assert.match(backup,/同名の別データが\$\{plan\.sameNameCollisions\}名追加されます/);
assert.match(vaultCss,/data-name-collision="true"/);
console.log('PASS: name-collision warning appears in employee preview and final confirmation; UUID identity remains unchanged');
