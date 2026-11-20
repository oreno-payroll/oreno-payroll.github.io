import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const main=read('src/main.ts');
const css=read('public/styles/dashboard.css');
const settings=read('public/backup/index.html');
const vault=read('public/styles/vault.css');
const list=main.match(/function renderList\(job: Job,[\s\S]*?\nfunction render\(\): void/);
assert.ok(list);
assert.match(list[0],/\['総支給', record\.form\.gross\]/);
assert.match(list[0],/\['手取り', record\.form\.net\]/);
assert.match(list[0],/amountOrMissing\(value\)/);
assert.match(list[0],/detail\.append\(link, amounts\)/);
assert.doesNotMatch(list[0],/statement-month-heading|statement-item__meta/);
assert.doesNotMatch(list[0],/caption\.textContent.*targetMonth/);
assert.match(css,/\.statement-item__amounts\s*\{[^}]*flex-wrap:\s*wrap/);
assert.match(css,/\.statement-item__amounts > span\s*\{[^}]*white-space:\s*nowrap/);
for(const id of ['settings-finance-income-title','settings-orphan-title']){
 const node=settings.indexOf(`<h3 id="${id}">`);
 const next=settings.indexOf('<p class="settings-note">',node);
 const action=settings.indexOf('<div class="settings-action-row">',node);
 assert.ok(node>=0 && node<next && next<action,`${id}: heading, description, then action`);
}
assert.doesNotMatch(settings,/class="settings-detail-head"/);
assert.equal((settings.match(/class="settings-details-column/g)||[]).length,3);
for(const id of ['payroll-income-publish','orphan-year-check','orphan-year-recover','legacy-cleanup-check','migrate-legacy-cloud','legacy-cleanup-delete']) {
 assert.equal((settings.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,id);
}
assert.match(vault,/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(vault,/min-height:\s*40px/);
assert.match(vault,/@media \(max-width: 850px\)/);
console.log('PASS: financial totals restored without repetitive metadata; 3 settings columns share hierarchy and actions');
