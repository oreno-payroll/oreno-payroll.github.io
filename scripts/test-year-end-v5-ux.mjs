/** Year-end 2026-11-19 UX: shared kind cards, local forecast fill, safe one-click save. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/year-end-assist/index.html'),css=read('public/styles/year-end-assist.css');
const ui=read('src/year-end-assist.ts'),pdf=read('src/yearEnd/pdf.ts'),repo=read('src/yearEnd/repository.ts');
assert.match(html,/<div class="segmented-choice" role="group" aria-label="明細種別">/);
assert.match(html,/<input type="radio" name="yea-review-kind" data-field="kind" value="salary"/);
assert.match(html,/<input type="radio" name="yea-review-kind" data-field="kind" value="bonus"/);
assert.doesNotMatch(html,/<select[^>]*data-field="kind"/);
assert.match(css,/\.yea-review-kind \.segmented-choice/);
assert.match(ui,/function syncForecastAmounts\(methodChanged=false\)/);
assert.match(ui,/syncForecastAmounts\(true\)/);
assert.doesNotMatch(ui,/check\.addEventListener\('change'/);
assert.match(ui,/for\(const input of fields\)/);
assert.match(ui,/input\.value=!methodChanged&&oldZero/);
assert.doesNotMatch(html,/id="yea-method-help"/);
assert.match(ui,/\$<HTMLButtonElement>\('yea-discard-edit'\)\.hidden=!changed/);
const save=ui.slice(ui.indexOf('async function saveAllDocuments()'),ui.indexOf('async function refreshPeopleKeepSelection()'));
assert.match(save,/await repo\.saveDocumentsBatch/);
assert.match(save,/data=result\.data/);
assert.doesNotMatch(save,/await loadYear\(|await refreshPeopleKeepSelection\(/);
assert.match(save,/if\(acknowledged&&!window\.confirm/, 'only confirmed monetary contradictions prompt');
assert.match(save,/forecastSnapshot/);
const remove=ui.slice(ui.indexOf("$<HTMLButtonElement>('yea-delete-person').addEventListener"),ui.indexOf("memoInput.addEventListener('input'"));
assert.match(remove,/if\(dialog\.open\)dialog\.close\(\)/);
assert.ok(remove.indexOf('dialog.close()')<remove.indexOf('await repo.deletePerson(id)'));
assert.match(css,/\.yea-manage-dialog\{width:min\(390px/);
assert.match(repo,/for\(let i=0;i<pending\.length;i\+=2\)/);
assert.match(repo,/await this\.saveYear\(a,id,year,context\.file,working,context\.yearFile\)/);
// Exercise exact adapter with synthetic side-bonus and guard for non-taxable rows.
let nonTaxable=undefined,transportation=undefined,gross='120000';
const stripped=stripTypeScriptTypes(pdf.replace(/^import .*?;\s*$/gm,'').replace(/new URL\('[^']+',import\.meta\.url\)\.href/g,"'http://localhost/fake'"),{mode:'strip'})
 .replace(/export async function parseAssistedPdf/,'async function parseAssistedPdf')+'\nglobalThis.parse=parseAssistedPdf;';
const api={};
const ctx={globalThis:api,URL,TextDecoder,Uint8Array,Set,Number,RegExp,
 GlobalWorkerOptions:{workerSrc:''},getDocument:()=>({promise:Promise.resolve({numPages:1,async getPage(){return {async getTextContent(){return {items:[{str:'支給合計',transform:[1,0,0,1,50,510],width:100,height:12}]};}};}}),async destroy(){}}),
 parsePayroll:()=>({profile:'side',layout:{status:'matched'},fields:{kind:'bonus',gross,nonTaxable,transportation,paymentDate:'2026-12-20',targetMonth:'2026-12'},warnings:[],missingFields:[]})};
vm.runInNewContext(stripped,ctx);
const sample={size:32,async arrayBuffer(){return new TextEncoder().encode('%PDF-1.7 synthetic content').buffer;}};
const bonus=await api.parse(sample);
assert.equal(bonus.taxable,120000,'bonus gross becomes taxable if no non-taxable payment');
assert.equal(bonus.warnings.length,0);
nonTaxable='1000';
const suspicious=await api.parse(sample);
assert.equal(suspicious.taxable,null,'a non-taxable bonus component must block automatic gross inference');
assert.match(suspicious.warnings.join(' '),/課税支給合計を原本で確認/);
transportation=undefined;nonTaxable=undefined;gross=undefined;
const missing=await api.parse(sample);
assert.equal(missing.taxable,null);
console.log('PASS: normal-mode kind radio cards, immediate forecast fill, edit undo, compact delete, one-click batch save, conditional bonus gross');
