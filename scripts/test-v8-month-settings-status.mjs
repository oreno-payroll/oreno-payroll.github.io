/** V8 presentation contract. Synthetic/static assertions: no private or cloud data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../'+file, import.meta.url), 'utf8');
const ye=read('src/year-end-assist.ts');
const yeCss=read('public/styles/year-end-assist.css');
const home=read('src/main.ts');
const homeCss=read('public/styles/dashboard.css');
const settings=read('public/backup/index.html');
const settingsCss=read('public/styles/vault.css');
const toast=read('src/ui/appStatus.ts');
const style=read('public/styles/style.css');
const uploadCss=read('public/styles/upload.css');
// Same row presentation as normal upload. Only chronological sorting, no headings.
assert.match(ye,/orderedItems\.sort\(\(a,b\)=>/);
assert.match(ye,/return a\.month\.localeCompare\(b\.month\)/);
assert.match(ye,/month:r\.targetMonth/);
assert.match(ye,/month:item\.draft\?\.targetMonth/);
assert.doesNotMatch(ye,/yea-file-month-heading/);
assert.doesNotMatch(yeCss,/\.yea-file-month-heading/);
assert.match(home,/periodMode==='calendar' \? record\.form\.paymentDate\.slice\(0,7\) : record\.form\.targetMonth/);
assert.doesNotMatch(home,/statement-month-heading/);
assert.doesNotMatch(homeCss,/\.statement-month-heading/);
// Exactly one advanced settings panel contains the four independent operations.
assert.match(settings,/<h2 id="settings-details-title">詳細設定<\/h2>/);
assert.equal((settings.match(/class="settings-details-column/g)??[]).length,4);
for (const id of ['payroll-income-publish','orphan-year-check','orphan-year-recover','legacy-cleanup-delete','legacy-cleanup-check','migrate-legacy-cloud']) {
 assert.equal((settings.match(new RegExp(`id="${id}"`,'g'))??[]).length,1,id);
}
assert.match(settingsCss,/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(settingsCss,/@media\s*\(max-width:\s*850px\)/);
// Mobile forecasts must not squeeze three months into a row; confirmed month label remains legible.
assert.match(yeCss,/@media\(max-width:680px\)/);
assert.match(yeCss,/\.yea-month-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.ok(yeCss.includes('.yea-month[data-state="actual"] strong.yea-month__head'));
assert.ok(yeCss.includes('color:var(--color-text);opacity:1'));
// Save areas have no artificial dividing rules.
assert.doesNotMatch(uploadCss,/\.review-actions \{[^}]*border-top/);
assert.doesNotMatch(yeCss,/\.yea-upload-savebar\{[^}]*border-top/);
assert.doesNotMatch(settingsCss,/\.settings-page \.backup-card__footer \{[^}]*border-top/);
// Every major screen must import and use the same right-bottom app status.
for (const file of ['src/main.ts','src/upload.ts','src/edit.ts','src/backup.ts','src/view.ts','src/year-end-assist.ts']) {
 const source=read(file);
 assert.match(source,/import \{ createAppStatus \} from /,file);
 assert.match(source,/createAppStatus\(/,file);
}
assert.match(style,/\.app-status\{position:fixed;right:/);
assert.match(style,/\.app-status\[data-state="loading"\]::before/);
assert.match(style,/\.app-status\[data-state="error"\]/);
assert.match(toast,/if\(kind!=='loading'\)timer=setTimeout/);
assert.match(read('public/view/index.html'),/class="app-status" id="pdf-status"/);
assert.match(read('public/upload/index.html'),/class="app-status" id="toast"/);
assert.match(read('public/year-end-assist/index.html'),/class="app-status yea-status" id="yea-status"/);
console.log('PASS: chronological year-end rows without extra headings, four settings cells, mobile 2-column forecast, label contrast, borderless save areas, unified operation card on six screens');
