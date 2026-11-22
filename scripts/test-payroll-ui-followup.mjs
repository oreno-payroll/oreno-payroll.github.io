/** Follow-up regression: native accordion, honest year-end drafts, matching mobile auth actions. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {asPersonId,asDocumentId,emptyYear,forecastPreview,calculateYear} from '../src/yearEnd/model.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const home=read('public/index.html');
const dash=read('public/styles/dashboard.css');
const vault=read('public/styles/vault.css');
const yearHtml=read('public/year-end-assist/index.html');
const yearSrc=read('src/year-end-assist.ts');
assert.match(home,/<details class="card registration-card" id="monthly-registration"[^>]*hidden>/);
assert.match(home,/<summary class="registration-card__heading">/);
assert.match(home,/<span class="registration-card__chevron" aria-hidden="true"><\/span>/);
assert.match(dash,/\.registration-card\[open\] \.registration-card__chevron/);
assert.match(vault,/@media\(max-width:480px\)[\s\S]*?\.settings-page \.settings-connection-account>\.settings-action-row>\.btn\{width:100%/);
assert.match(yearHtml,/id="yea-draft-forecast"[^>]+hidden/);
assert.match(yearHtml,/id="yea-draft-annual"[^>]+hidden/);
assert.match(yearSrc,/function updateUnsavedForecastPreview\(\):void/);
assert.match(yearSrc,/updateUnsavedForecastPreview\(\);/);
assert.match(yearSrc,/未保存の試算：/);
assert.match(yearSrc,/現在の年間合計には未反映/);
assert.match(yearSrc,/const amount=parseYen\(raw\);/);
assert.match(yearSrc,/if\(proposedForecast===saved\.forecast\)return;/);
// Confirm actual model arithmetic without personal or remote data.
const id=asPersonId('11111111-1111-4111-8111-111111111111');
const year=emptyYear(id,2026);
const actual={id:asDocumentId('22222222-2222-4222-8222-222222222222'),personId:id,kind:'salary',
 paymentDate:'2026-10-25',targetMonth:'2026-10',taxable:230000,gross:null,transportation:null,
 nonTaxable:null,healthInsurance:null,pension:null,employmentInsurance:null,incomeTax:null,residentTax:null,
 fileName:'synthetic.pdf',pdfSize:100,fileHash:'a'.repeat(64),confirmedAt:'2026-10-25',updatedAt:'2026-10-25',
 source:'manual-confirmed',revision:1};
const withActual={...year,documents:[actual]};
const draft=forecastPreview(withActual,'latest',['2026-11','2026-12']);
assert.deepEqual(draft.estimated.map(x=>x.amount),[230000,230000]);
assert.equal(draft.annualTotal,690000);
assert.equal(calculateYear(withActual).total,230000,'an unsaved projection must not overwrite persisted annual total');
console.log('PASS: registration accordion, mobile login buttons, unsaved year-end forecast preview and saved totals');
