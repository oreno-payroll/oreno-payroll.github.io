/** Year-end UI regression: one source of truth for saved and new PDFs. Synthetic only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/year-end-assist/index.html');
const css=read('public/styles/year-end-assist.css');
const ts=read('src/year-end-assist.ts');
const home=read('public/index.html');
const dash=read('public/styles/dashboard.css');
const between=(value,start,end)=>{const a=value.indexOf(start),b=value.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Expected section ${start}`);return value.slice(a,b);};
const directory=between(html,'<section id="yea-directory"','<div class="yea-main"');
const detail=between(html,'<div class="yea-main" id="yea-content" hidden>','<dialog id="yea-manage-dialog"');
const management=html.slice(html.indexOf('<dialog id="yea-manage-dialog"'));
assert.ok(directory.indexOf('yea-create-card')<directory.indexOf('id="yea-people-heading"'),'new employee is left; directory list is right');
for(const id of ['yea-person-create','yea-new-name','yea-person-list'])assert.ok(directory.includes(`id="${id}"`));
for(const id of ['yea-current-name','yea-calendar-year','yea-open-manage','yea-pdfs','yea-year-memo','yea-estimate-months','yea-save-all','yea-forecast-accordion','yea-commit'])assert.ok(detail.includes(`id="${id}"`),`required detail: ${id}`);
for(const id of ['yea-rename-name','yea-delete-person','yea-close-manage'])assert.ok(management.includes(`id="${id}"`));
assert.match(html,/<a[^>]*id="yea-back-home"[^>]*href="\.\.\/index\.html"[^>]*>[\s\S]*?<span>ホームへ戻る<\/span><\/a>/);
const headerActions=between(html,'<div class="header-actions">','</div></header>');
assert.match(headerActions, /data-theme-toggle/,'theme toggle is in the shared header actions');
assert.match(headerActions, /id="yea-back-directory" hidden>[\s\S]*?<span>従業員一覧へ<\/span><\/button>/);
assert.ok(headerActions.indexOf('data-theme-toggle')<headerActions.indexOf('id="yea-back-home"')&&
 headerActions.indexOf('id="yea-back-home"')<headerActions.indexOf('id="yea-back-directory"'),
 'theme switch and both navigation actions keep the existing header order');
for(const id of ['yea-back-home','yea-back-directory']){const i=html.indexOf(`id="${id}"`),part=html.slice(i,html.indexOf(id==='yea-back-home'?'</a>':'</button>',i));assert.match(part,/<svg class="icon"[^>]*viewBox="0 0 24 24"/);}
assert.match(ts,/backHome\.hidden=false/);assert.match(ts,/backHome\.hidden=true/);
assert.match(ts,/yearContent\.dataset\.empty=data\.documents\.length===0\?'true':'false'/);
assert.doesNotMatch(css,/\.yea-main\[data-empty="true"\] >/);
assert.match(ts,/function showYearPlaceholders\(\)/);
assert.ok(detail.indexOf('class="yea-context"')<detail.indexOf('class="card yea-upload-panel"'));
assert.ok(detail.indexOf('class="card yea-upload-panel"')<detail.indexOf('class="yea-stats"'));
assert.doesNotMatch(detail,/月別給与の状態|id="yea-docs"|保存済み給与・賞与明細|yea-copy-raw|yea-copy|yea-replace-pdf/);
assert.doesNotMatch(html,/yea-upload-target|id="yea-pdf-dialog"|iframe|本人への確認・転記|id="yea-review-ack"/);
assert.match(html,/<details class="card yea-upload-panel" id="yea-upload-accordion" open>/);
const start=detail.indexOf('id="yea-upload-accordion"');
const summary=detail.indexOf('class="yea-upload-summary"',start);
const list=detail.indexOf('id="yea-drafts"',start);
const review=detail.indexOf('id="yea-review-content"',start);
const save=detail.indexOf('id="yea-save-all"',start);
const close=detail.indexOf('</details>',start);
assert.ok(start>=0&&summary>start&&list>summary&&review>list&&save>review&&close>save,
 'the single accordion must contain upload, saved list, edit form and bulk save together');
assert.match(css,/\.yea-context\{[^}]*background:transparent;border:0/,'employee header has no background card');
assert.match(ts,/uploadAccordion\.open=data\.documents\.length===0/);
assert.match(ts,/repo\.createPerson\(name,''\)/);assert.match(ts,/repo\.renamePerson\(id,name,''\)/);
assert.match(ts,/const displayPerson=.*p\.alias/);
assert.doesNotMatch(ts,/\.\/storage\/payrollStore/);
const first=home.indexOf('href="./backup/index.html"');const second=home.indexOf('href="./year-end-assist/index.html"');const third=home.indexOf('href="./upload/index.html"');assert.ok(first>=0&&second>first&&third>second);
assert.doesNotMatch(home,/class="card yea-entry"/);assert.doesNotMatch(dash,/\.yea-entry/);
console.log('PASS: directory, empty-state importer, always-visible unified list, header navigation, single collapsible editor, no redundant monthly table or PDF iframe');
