/** Regression gates for the two primary workflows: collapsed management and monthly forecast. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src = f => readFileSync(new URL('../'+f, import.meta.url), 'utf8');
const html=src('public/year-end-assist/index.html');
const css=src('public/styles/year-end-assist.css');
const script=src('src/year-end-assist.ts');
const standard=src('public/upload/index.html');
const standardCSS=src('public/styles/upload.css');
const start=html.indexOf('<details class="card yea-upload-panel" id="yea-upload-accordion"');
const closing=html.indexOf('</details>',start);
assert.ok(start>0&&closing>start);
const body=html.slice(start,closing);
assert.match(body,/<summary class="yea-upload-summary">/);
for(const id of ['yea-pdf-dropzone','yea-drafts','yea-review-form','yea-save-all'])
  assert.ok(body.includes(`id="${id}"`), `${id} must collapse along with the whole editor`);
assert.equal((html.match(/<details\b/g)||[]).length, 2, 'one PDF accordion and one income forecast accordion');
assert.match(script,/uploadAccordion\.open=data\.documents\.length===0/);
assert.match(script,/if\(result\.data\.documents\.length\)uploadAccordion\.open=excluded\.length>0/,'show excluded-file details after successful mixed batch');
assert.match(script,/count\.textContent=pendingCount\?`未保存/,'unsaved state visible when closed');
for(const symbol of ['file','close']) {
 assert.ok(standard.includes(`id="icon-${symbol}"`), 'standard file symbol present');
 assert.ok(html.includes(`id="icon-${symbol}"`), `shared svg symbol ${symbol}`);
 assert.match(script,new RegExp(`uploadIcon\\('${symbol}'\\)`));
}
for(const name of ['file-list__item','file-list__select','file-list__icon','file-list__text','file-name','file-caption','file-status','file-list__current','file-list__remove'])
 assert.ok(script.includes(`'${name}'`) || script.includes(` ${name}`) || script.includes(`\`${name}`), `${name} standard component used`);
assert.doesNotMatch(script,/file-list__icon','PDF'/,'no bespoke PDF text icon');
assert.match(css,/\.yea-upload-left \.mobile-file-picker-wrap\{display:none\}/);
assert.match(css,/@media\(max-width:640px\)/);
assert.match(standardCSS,/\.upload-left \.zone-content \{ min-height: 133px/);
assert.doesNotMatch(css,/\.yea-upload-left \.zone-content\{[^}]*min-height/);
assert.match(script,/const salary=data\.documents\.find\(d=>d\.kind==='salary'/);
assert.match(script,/yen\(salary\.taxable\)/);
assert.match(script,/card\.dataset\.state='actual'/);
assert.doesNotMatch(script,/head\.append\(check\)/);
assert.match(css,/\.yea-month__amount/);
assert.match(html,/class="yea-bonus-fields"/);
assert.match(css,/\.yea-bonus-fields\{[^}]*grid-template-columns:minmax\(0,155px\) minmax\(0,210px\)/);
assert.doesNotMatch(html,/賞与見込みをプレビュー|賞与見込みを確定する/);
assert.match(html,/input type="radio" name="yea-method"/);
assert.match(html,/class="yea-forecast-actions"/);
assert.doesNotMatch(html,/yea-bonus-preview|yea-preview-result|id="yea-preview"/);
assert.doesNotMatch(html,/id="yea-bonus-commit"/);
assert.match(html,/id="yea-commit"[^>]*>見込みをまとめて保存<\/button>/);
assert.doesNotMatch(html,/本人から許可を得た明細のみ/);
assert.match(script,/let savingDocuments=false/);
assert.match(script,/saveAll\.textContent=savingDocuments\?'保存中…'/);
assert.match(script,/formatBytes\(item\.file\.size\)/);
assert.match(script,/formatBytes\(r\.pdfSize\)/);
assert.doesNotMatch(script,/file-list__icon','PDF'|file-caption',item\.draft\?/);
console.log('PASS: whole-workspace accordion, shared SVG/list controls, confirmed monthly amount, direct bonus save');
