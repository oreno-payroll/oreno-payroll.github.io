/** Side-only PDF parser and two-column review / bulk upload guards. Synthetic samples only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/year-end-assist/index.html');
const standard=read('public/upload/index.html');
const standardCss=read('public/styles/upload.css');
const css=read('public/styles/year-end-assist.css');
const ui=read('src/year-end-assist.ts');
const pdfSource=read('src/yearEnd/pdf.ts');
const repo=read('src/yearEnd/repository.ts');
assert.match(html,/href="\.\.\/styles\/upload\.css"/,'normal-mode CSS imported');
for(const id of ['yea-upload-accordion','yea-pdf-dropzone','yea-file-count','yea-drafts','yea-review-content','yea-review-form','yea-save-all','yea-clear-all'])
 assert.ok(html.includes(`id="${id}"`),`UI requires ${id}`);
assert.match(html,/class="yea-upload-workspace"/);
assert.match(html,/<details class="card yea-upload-panel" id="yea-upload-accordion" open>/);
assert.doesNotMatch(html,/id="yea-upload-accordion"[\s\S]*<details class="yea-import-toggle"/);
assert.ok(html.indexOf('id="yea-drafts"')<html.indexOf('id="yea-review-content"'),'left list precedes right review');
assert.match(css,/\.yea-upload-workspace\{display:grid;grid-template-columns/);
assert.match(ui,/uploadAccordion\.open=data\.documents\.length===0/,'expand empty year only');
assert.match(ui,/repo\.saveDocumentsBatch\(id,year,/,'bulk click uses isolated repository');
assert.match(repo,/await this\.saveYear\(a,id,year,context\.file,working,context\.yearFile\)/,'one annual commit per batch');
assert.doesNotMatch(html,/id="yea-review-ack"|id="yea-validate"|この従業員のPDF原本と入力内容を照合しました/,'no per-file checkbox or mandatory check button');
assert.doesNotMatch(ui,/reviewAck|\.reviewed|reviewed:/,'no manual review state');
assert.match(ui,/const blocked=ready\.some\(item=>validateQueueItem\(item\)!==null\)/,'automatic validation gates save');
assert.match(ui,/item\.year!==year\|\|validateQueueItem\(item\)/,'cloud write checks preflight without checkbox');
assert.match(ui,/updateDrafts\(true\)/,'retain form input during automatic validation');
assert.match(ui,/function updateDrafts\(preserveReview=false\)/,'avoid discarding typed invalid values');
assert.match(html,/class="mobile-file-picker-wrap"/,'use standard mobile picker wrapper');
assert.match(standard,/class="mobile-file-picker-wrap"/,'ordinary upload uses same mobile picker wrapper');
assert.match(html,/class="btn btn--primary mobile-file-picker"/,'same mobile button classes');
assert.match(html,/id="yea-pdf-dropzone"[\s\S]*?ここにPDFをドロップ/,'normal drop target wording');
assert.match(html,/枠内をクリックして選択 \/ 複数PDFのドロップにも対応/,'normal drop target guidance');
assert.match(html,/PDFのみ・1件25MBまで・最大30件/,'standard privacy label');
assert.doesNotMatch(html,/副業の給与・賞与明細のみ/,'do not repeat known document template limitation in drop area');
assert.doesNotMatch(css,/\.yea-upload-left \.zone-content\{[^}]*min-height/,'no private desktop drop target size override');
assert.doesNotMatch(css,/\.yea-upload-left \.zone-content\{min-height:162px/,'no private mobile target size override');
assert.match(html,/class="mobile-file-picker-wrap"/,'normal mobile picker used');
assert.match(standardCss,/#drop-zone\{display:none\}/,'ordinary drop zone hidden on mobile');
assert.match(css,/\.yea-upload-workspace\{display:grid;grid-template-columns:minmax\(0,\.86fr\) minmax\(0,1\.14fr\)/,'column sizes match ordinary upload');
assert.match(standardCss,/\.workspace \{ display: grid; grid-template-columns: minmax\(0,\.86fr\) minmax\(0,1\.14fr\)/,'original two-column dimensions available');

assert.match(ui,/data=result\.data;/,'saved annual data is reused without refetch');
assert.doesNotMatch(ui,/from ['"]\.\/storage\/payrollStore/,'no personal payroll storage');
assert.match(pdfSource,/parsePayroll\(cells\)/,'use standard parser');
assert.match(pdfSource,/parsed\.profile!=='side'\|\|parsed\.layout\?\.status!=='matched'/,'reject main and unknown layouts');
assert.doesNotMatch(html,/name="job"|value="main"|value="side"/,'no job selector in third-party view');
// Exercise actual PDF adapter under an in-memory PDF.js stand-in, without any real PDF bytes.
let profile='side',layout='matched';
const source=stripTypeScriptTypes(pdfSource.replace(/^import .*?;\s*$/gm,'').replace(/new URL\('[^']+',import\.meta\.url\)\.href/g,"'http://localhost:5000/asset'"),{mode:'strip'})
 .replace(/export async function parseAssistedPdf/,'async function parseAssistedPdf')+'\n globalThis.testParse=parseAssistedPdf;';
const api={};
const sideResult=()=>({profile,layout:{status:layout,matched:4,required:4},fields:{job:profile,kind:'salary',taxable:'255000',gross:'260000',transportation:'5000',nonTaxable:'5000',paymentDate:'2026-11-25',targetMonth:'2026-11'},warnings:[],missingFields:[]});
const ctx={globalThis:api,URL,TextDecoder,Uint8Array,Set,Number,RegExp,
 GlobalWorkerOptions:{workerSrc:''},
 getDocument(){return {promise:Promise.resolve({numPages:1,async getPage(){return {async getTextContent(){return {items:[{str:'課税支給合計',transform:[1,0,0,1,50,510],width:80,height:10}]};}};}}),async destroy(){}};},
 parsePayroll:()=>sideResult()};
vm.runInNewContext(source,ctx,{filename:'yearEnd/pdf.ts'});
const fakeFile={size:32,async arrayBuffer(){return new TextEncoder().encode('%PDF-1.7 synthetic content').buffer;}};
const accepted=await api.testParse(fakeFile);
assert.equal(accepted.taxable,255000);assert.equal(accepted.kind,'salary');
profile='main';await assert.rejects(api.testParse(fakeFile),/副業.*書式/);
profile=null;await assert.rejects(api.testParse(fakeFile),/副業.*書式/);
profile='side';layout='suspect';await assert.rejects(api.testParse(fakeFile),/副業.*書式/);
console.log('PASS: native upload components and sizes, no forced checkbox, automatic safety validation, batch saving, side-only parser');
