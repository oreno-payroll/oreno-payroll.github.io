/** 2026-11-19 year-end UI parity and safe PDF delete regression gates. Fake records only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const ui = read('src/year-end-assist.ts');
const html = read('public/year-end-assist/index.html');
const css = read('public/styles/year-end-assist.css');
const repo = read('src/yearEnd/repository.ts');
const model = read('src/yearEnd/model.ts');
const normal = read('public/upload/index.html');

// Activity is transient; errors remain visible until a later action.
assert.match(html, /id="yea-status"[^>]*hidden/);
assert.match(ui, /function showBusy\(message:string,scope\?/);
assert.match(ui, /if\(!failed&&authorized\(\)\)\{if\(_showSuccess\)appStatus.show\('success'/);
assert.doesNotMatch(ui, /が完了しました。/);
assert.match(read('public/styles/style.css'), /\.app-status\[data-state=\"loading\"\]::before/);
assert.match(html, /class="app-status yea-status"/);

// The original button uses the same upload-page button class, icon and label.
const originalButton=/<button[^>]*class="btn btn--soft btn--small"[^>]*id="yea-open-draft-pdf"[^>]*><svg[^>]*><use href="#icon-external"><\/use><\/svg>原本を見る<\/button>/;
assert.match(html, originalButton);
assert.match(normal, /id="open-pdf"[^>]*><svg[^>]*><use href="#icon-external"><\/use><\/svg>原本を見る<\/button>/);
assert.doesNotMatch(html, /yea-replace|yea-copy|yea-copy-raw/);
assert.doesNotMatch(ui, /await repo\.deleteDocument\(id,year,r\.id\)/);
assert.match(ui, /pendingDeletions\.set\(r\.id,r\.revision\)/);
assert.match(ui, /pendingDeletions\.delete\(record\.id\)/);
assert.match(ui, /repo\.saveDocumentsBatch\(id,year,/);
assert.match(ui, /remove\.append\(uploadIcon\('close'\)\)/);
assert.match(ui, /fileQueue=fileQueue\.filter\(x=>x!==item\)/);

// Forecasts reuse the standard upload page's three-option radio cards.
assert.equal((html.match(/type="radio" name="yea-method"/g)??[]).length,3);
assert.doesNotMatch(html, /<select[^>]*id="yea-method"/);
assert.match(html, /<input class="input" id="yea-new-name"/);
assert.match(ui, /el\('input','input'\)/);
assert.match(html, /<span class="unit-field"><input class="input" data-field="taxable"/);
assert.match(html, /class="segmented-choice segmented-choice--three yea-method-options"/);
assert.match(read('public/styles/style.css'), /\.segmented-choice input:checked \+ span/);
for(const id of ['yea-select-all-months','yea-clear-months','yea-bonus-commit'])assert.doesNotMatch(html,new RegExp(`id="${id}"`));
assert.equal((html.match(/<input[^>]*type="checkbox"[^>]*>/g)??[]).length,1);
assert.match(html,/<input type="checkbox" id="yea-review-confirm" disabled>/);
assert.doesNotMatch(html.slice(html.indexOf('id="yea-forecast-accordion"')),/<input[^>]*type="checkbox"/);
assert.doesNotMatch(ui, /noPayCheck|repo\.setNoPay\(/);
assert.match(ui, /const oldNoPay=data\.noPaymentMonths\.includes\(month\)/);
assert.match(ui, /input\.value=oldNoPay\?'0':existing\?String\(existing\.amount\):''/);
assert.match(repo, /async replaceForecast\(/);
assert.match(ui, /await repo\.replaceIncomeForecasts\(/);
assert.doesNotMatch(html, /id="yea-preview"|id="yea-bonus-preview"|id="yea-preview-result"/);
assert.match(ui, /function markForecastDirty\(\)/);
assert.match(ui, /commit\.addEventListener\('click',saveForecast\)/);
assert.match(ui, /showYearPlaceholders\(\)/);
assert.match(html, /class="yea-directory" aria-labelledby/);
assert.equal((html.match(/class="yea-forecast-actions"/g)??[]).length,1);
assert.equal((html.match(/class="yea-forecast-work"/g)??[]).length,1);

// ETag protected delete: annual data comes first; original trash follows.
const del=repo.slice(repo.indexOf('async deleteDocument('),repo.indexOf('async correctDocument('));
assert.match(del,/documents:context\.data\.documents\.filter\(r=>r\.id!==documentId\)/);
assert.match(del,/estimates:context\.data\.estimates\.filter\(e=>!e\.references\.includes\(record\.id\)\)/);
assert.match(del,/await this\.saveYear\(a,id,year,context\.file,next,context\.yearFile,context\)/);
assert.doesNotMatch(del,/await a\.graph\.trashFile/);
assert.match(del,/const cleanupPending=true/);
assert.match(model,/kind:'estimate-replaced'\|'document-corrected'\|'document-deleted'/);
const {randomPersonId,emptyYear,validateYear}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(model,{mode:'strip'})).toString('base64'));
const id=randomPersonId(),year=emptyYear(id,2026);
assert.equal(validateYear({...year,history:[{at:'2026-11-19',kind:'document-deleted',month:'2026-11',oldValue:100,newValue:0}]},id,2026).history.length,1);
console.log('PASS: transient spinner, PDF delete, shared radio cards, draft-only edits, zero-yen legacy migration, direct save, loading view');
