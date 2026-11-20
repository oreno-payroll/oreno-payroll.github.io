import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const ui=read('src/year-end-assist.ts');
const css=read('public/styles/year-end-assist.css');
const html=read('public/year-end-assist/index.html');
const normal=read('src/upload.ts');
// Same visual classes and markup hierarchy as the ordinary importer.
for (const token of ['file-list__item','file-list__select','file-list__icon','file-list__text','file-name','file-caption','file-status','file-list__current','file-list__remove']) {
 assert.ok(ui.includes(token),`year-end is missing standard row class: ${token}`);
 assert.ok(normal.includes(token),`ordinary importer is missing row class: ${token}`);
}
assert.match(ui,/orderedItems\.sort\(\(a,b\)=>/);
assert.match(ui,/return a\.month\.localeCompare\(b\.month\)\|\|a\.date\.localeCompare\(b\.date\)/);
assert.match(ui,/for\(const item of orderedItems\)drafts\.append\(item\.node\)/);
assert.doesNotMatch(ui,/yea-file-month-heading|年月未設定|currentGroup/);
assert.doesNotMatch(css,/yea-file-month-heading/);
assert.match(css,/@media\(min-width:951px\)\{/);
assert.match(css,/\.yea-upload-workspace\{align-items:stretch\}/);
assert.match(css,/\.yea-upload-left \.file-list\{flex:1;min-height:0;max-height:none;overflow-y:auto/);
assert.match(css,/\.yea-upload-left \.file-panel\{flex:1 1 0;min-height:0;/);
assert.doesNotMatch(ui,/matchFilePanelToDetail/);
assert.match(html,/id="yea-drafts"/);
console.log('PASS: year-end list matches normal row classes, sorted 1 to 12, without headings; desktop list and detail card bottoms align');
