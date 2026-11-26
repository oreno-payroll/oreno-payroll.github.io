/** Focused UI text/flow regression, no private data or network. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const edit=read('public/edit/index.html');
const editor=read('src/edit.ts');
const setup=read('public/backup/index.html');
const backup=read('src/backup.ts');
const upload=read('src/upload.ts');
const html=read('public/upload/index.html');
const css=read('public/styles/upload.css');
const readme=read('README.md');
assert.match(edit,/title="削除待ちにする（確定まではPDF原本はOneDriveに保持）"/);
assert.doesNotMatch(edit,/保存済みの明細とPDF原本を削除/);
assert.match(editor,/暗号化PDF原本は保全します/);
assert.match(setup,/Finance連携用の収入データ/);
assert.match(setup,/初回連携はFinanceで行います/);
assert.match(readme,/### Financeへの収入連携（実装済み）/);
assert.doesNotMatch(setup,/Finance側での読み込みは未対応/);
assert.match(upload,/case "error": return \{ label: "読み取り失敗", variant: "error" \}/);
assert.match(upload,/case "no-text": return isReviewed/);
assert.match(upload,/label: "要確認", variant: "warning"/);
assert.match(html,/id="upload-guide"/);
assert.match(html,/class="workspace is-empty"/);
assert.match(html,/class="save-bar is-empty"/);
assert.match(upload,/workspace\.classList\.toggle\('is-empty',isEmpty\)/);
assert.match(upload,/saveBar\.classList\.toggle\('is-empty',isEmpty&&!saving&&!uploadSaveRecoveryRequired\)/);
assert.match(css,/\.workspace\.is-empty \.file-panel, \.workspace\.is-empty \.review-panel \{ display: none; \}/);
assert.doesNotMatch(html,/PDFをまとめて読み取り、項目を確認・修正できます/);
assert.doesNotMatch(html,/PDFを追加すると、ここからまとめて保存できます/);
assert.match(setup,/id="remember-browser-register"[^>]*hidden disabled/);
assert.match(setup,/id="remember-browser-forget"[^>]*hidden disabled/);
assert.match(backup,/browserKeyRegister\.hidden=browserKeyStateValue!==\'missing\'/);
assert.match(backup,/browserKeyForget\.hidden=browserKeyStateValue!==\'saved\'/);
assert.match(backup,/browserKeyStateValue=state/);
assert.match(readme,/専用IndexedDB/);
const listRender=upload.slice(upload.indexOf('function renderFileList()'),upload.indexOf('fileList.replaceChildren()',upload.indexOf('function renderFileList()')));
assert.match(listRender,/progressWrap.hidden = !active/);
assert.doesNotMatch(listRender,/appStatus|wasParsing/,'inline PDF progress must not overwrite operation notices');
assert.doesNotMatch(editor,/appStatus.success\('明細を読み込みました'\)/);
assert.doesNotMatch(backup,/appStatus.success\('設定を読み込みました'\)/);
console.log('PASS: delete tooltip, Finance real contract, upload flow, failure state, remembered-browser actions');

// 画面表示の共通契約（旧V8〜V12を統合）。
const yearUI=read('src/year-end-assist.ts');
const yearCSS=read('public/styles/year-end-assist.css');
const yearHTML=read('public/year-end-assist/index.html');
const main=read('src/main.ts');
const homeHTML=read('public/index.html');
const dash=read('public/styles/dashboard.css');
const settingsHTML=setup;
const vaultCSS=read('public/styles/vault.css');
const statusUI=read('src/ui/appStatus.ts');
const sharedCSS=read('public/styles/style.css');

// 画面横断の表示・設定・通知
// Same row presentation as normal upload. Only chronological sorting, no headings.
assert.match(yearUI,/orderedItems\.sort\(\(a,b\)=>/);
assert.match(yearUI,/month:r\.targetMonth/);
assert.match(yearUI,/month:item\.draft\?\.targetMonth/);
assert.doesNotMatch(yearCSS,/\.yea-file-month-heading/);
assert.match(main,/periodMode==='calendar' \? record\.form\.paymentDate\.slice\(0,7\) : record\.form\.targetMonth/);
// Exactly one advanced settings panel contains the five independent operations.
assert.match(settingsHTML,/<h2 id="settings-details-title">メンテナンス<\/h2>/);
assert.equal((settingsHTML.match(/class="settings-details-column/g)??[]).length,5);
for (const id of ['payroll-income-publish','orphan-year-check','orphan-year-recover','legacy-cleanup-delete','legacy-cleanup-check','migrate-legacy-cloud']) {
 assert.equal((settingsHTML.match(new RegExp(`id="${id}"`,'g'))??[]).length,1,id);
}
assert.match(vaultCSS,/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(vaultCSS,/@media\s*\(max-width:\s*850px\)/);
// Mobile forecasts must not squeeze three months into a row; confirmed month label remains legible.
assert.match(yearCSS,/@media\(max-width:680px\)/);
assert.match(yearCSS,/\.yea-month-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.ok(yearCSS.includes('.yea-month[data-state="actual"] strong.yea-month__head'));
assert.ok(yearCSS.includes('color:var(--color-text);opacity:1'));
// Save areas have no artificial dividing rules.
assert.doesNotMatch(css,/\.review-actions \{[^}]*border-top/);
assert.doesNotMatch(yearCSS,/\.yea-upload-savebar\{[^}]*border-top/);
assert.doesNotMatch(vaultCSS,/\.settings-page \.backup-card__footer \{[^}]*border-top/);
// Every major screen must import and use the same right-bottom app status.
for (const file of ['src/main.ts','src/upload.ts','src/edit.ts','src/backup.ts','src/view.ts','src/year-end-assist.ts']) {
 const source=read(file);
 assert.match(source,/import \{ createAppStatus(?:, type AppStatusKind)? \} from /,file);
 assert.match(source,/createAppStatus\(/,file);
}
assert.match(sharedCSS,/\.app-status\{position:fixed;right:/);
assert.match(sharedCSS,/\.app-status\[data-state="loading"\]::before/);
assert.match(sharedCSS,/\.app-status\[data-state="error"\]/);
assert.match(statusUI,/if\(item.kind!=='loading'&&!item.sticky\)timer=setTimeout/);
assert.match(read('public/view/index.html'),/class="app-status" id="pdf-status"/);
assert.match(read('public/upload/index.html'),/class="app-status" id="toast"/);
assert.match(read('public/year-end-assist/index.html'),/class="app-status yea-status" id="yea-status"/);

// ホームの金額表示・設定の階層・通知サイズ
// Keep slips in month order, without redundant headers or duplicate calendar metadata; monetary totals stay visible.
assert.match(main,/monthKey\(b\)\.localeCompare\(monthKey\(a\)\)/);
assert.doesNotMatch(main,/statement-month-heading|statement-item__meta/);
assert.doesNotMatch(dash,/\.statement-month-heading|\.statement-item__meta/);
assert.doesNotMatch(homeHTML,/登録されたPDFを年月別に確認できます/);
assert.match(main,/detail\.append\(link, employer, amounts\)/);
assert.match(main,/\['総支給額', record\.form\.gross\]/);
assert.match(main,/\['手取り', record\.form\.net\]/);
assert.match(dash,/\.statement-item__amounts \{/);
// Work days belongs to the supplementary deductions, above net pay.
const days=homeHTML.indexOf('id="side-days"');
assert.ok(days>homeHTML.indexOf('id="side-social-insurance"'));
assert.ok(days<homeHTML.indexOf('id="side-net"'));
assert.doesNotMatch(homeHTML,/job-card__supplement/);
// Settings use the same app-shell inner width as the dashboard, not an extra 1050px cap.
assert.match(vaultCSS,/\.settings-page \{ max-width: none; width: 100%;/);
assert.doesNotMatch(vaultCSS,/\.settings-page \{ max-width: 1050px/);
// Three matching column hierarchies: title, supporting text, then the action (never crammed into the title).
assert.doesNotMatch(settingsHTML,/settings-detail-head/);
assert.match(settingsHTML,/<h3 id="settings-finance-income-title">[^<]+<\/h3>\s*<p class="settings-note">[\s\S]*?<div class="settings-action-row">\s*<button[^>]+id="payroll-income-publish"/);
assert.match(settingsHTML,/<h3 id="settings-orphan-title">[^<]+<\/h3>\s*<p class="settings-note">[\s\S]*?<div class="settings-action-row">\s*<button[^>]+id="orphan-year-check"/);
assert.match(settingsHTML,/id="orphan-year-recover"[^>]*hidden disabled/);
assert.match(vaultCSS,/\.settings-page \.settings-details-column \.settings-action-row,/);
assert.doesNotMatch(vaultCSS,/\.settings-details-column \.settings-action-row[^\n]*margin-top:auto/);
// Notification width & height are capped; errors can be scrolled, other notices stay non-blocking.
assert.match(sharedCSS,/\.app-status\{[^}]*max-width:min\(380px,calc\(100vw/);
assert.match(sharedCSS,/max-height:min\(240px,calc\(100dvh/);
assert.match(sharedCSS,/\.app-status\[data-state="error"\]\{color:var\(--color-danger\);pointer-events:auto\}/);

// 年末調整の一覧・左右カラム
// Same visual classes and markup hierarchy as the ordinary importer.
for (const token of ['file-list__item','file-list__select','file-list__icon','file-list__text','file-name','file-caption','file-status','file-list__current','file-list__remove']) {
 assert.ok(yearUI.includes(token),`year-end is missing standard row class: ${token}`);
 assert.ok(upload.includes(token),`ordinary importer is missing row class: ${token}`);
}
assert.match(yearUI,/return a\.month\.localeCompare\(b\.month\)\|\|a\.date\.localeCompare\(b\.date\)/);
assert.match(yearUI,/for\(const item of orderedItems\)drafts\.append\(item\.node\)/);
assert.doesNotMatch(yearUI,/yea-file-month-heading|年月未設定|currentGroup/);
assert.match(yearCSS,/\.yea-upload-left \.file-list\{flex:1;min-height:0;max-height:none;overflow-y:auto/);
assert.match(yearHTML,/id="yea-drafts"/);

// ホームの金額表示と設定ID
const list=main.match(/function renderList\(job: Job,[\s\S]*?\nfunction render\(\): void/);
assert.ok(list);
assert.match(list[0],/\['総支給額', record\.form\.gross\]/);
assert.match(list[0],/\['手取り', record\.form\.net\]/);
assert.match(list[0],/amountOrMissing\(value\)/);
assert.match(list[0],/detail\.append\(link, employer, amounts\)/);
assert.doesNotMatch(list[0],/statement-month-heading|statement-item__meta/);
assert.doesNotMatch(list[0],/caption\.textContent.*targetMonth/);
assert.match(dash,/\.statement-item__amounts\s*\{[^}]*flex-wrap:\s*wrap/);
assert.match(dash,/\.statement-item__amounts > span\s*\{[^}]*white-space:\s*nowrap/);
for(const id of ['settings-finance-income-title','settings-orphan-title']){
 const node=settingsHTML.indexOf(`<h3 id="${id}">`);
 const next=settingsHTML.indexOf('<p class="settings-note">',node);
 const action=settingsHTML.indexOf('<div class="settings-action-row">',node);
 assert.ok(node>=0 && node<next && next<action,`${id}: heading, description, then action`);
}
assert.match(vaultCSS,/min-height:\s*40px/);

// 年末調整の左右カラム・レスポンシブ
// Both grid columns stretch to the same bottom edge without syncing equal card heights.
assert.match(yearCSS, /@media\(min-width:951px\)\{[\s\S]*?\.yea-upload-workspace\{align-items:stretch\}/);
assert.match(yearCSS, /\.yea-upload-left \.file-panel\{flex:1 1 0;min-height:0;display:flex;flex-direction:column\}/);
assert.doesNotMatch(yearCSS, /--yea-review-panel-height|height:var\(--yea-review-panel-height/);
assert.doesNotMatch(yearUI, /matchFilePanelToDetail|ResizeObserver/);
assert.match(yearCSS, /@media\(max-width:950px\)\{\.yea-upload-workspace\{grid-template-columns:minmax\(0,1fr\)\}\}/);
console.log('PASS: unified UI presentation contracts (home, settings, year-end, notifications)');

// 年末調整の簡潔な入力UI・共通アコーディオン（旧V7）。
assert.doesNotMatch(yearHTML, /placeholder\s*=\s*["']例[：:]/);
assert.match(yearHTML, /placeholder="スタッフA"/);
assert.match(yearHTML, /placeholder="メモを入力"/);
assert.doesNotMatch(yearHTML, /灰色の月は|未確定月は、|推定方法を切り替えると|id="yea-method-help"|id="yea-estimate-summary"/);
assert.doesNotMatch(yearHTML, /賞与は必要な場合のみ入力してください/);
assert.doesNotMatch(yearCSS, /\.yea-month\[data-state="actual"\] \.yea-month__head::after/);
assert.doesNotMatch(yearUI, /amount\.title='確定済み給与/);
assert.doesNotMatch(yearCSS, /cursor:not-allowed/);
assert.match(sharedCSS, /details\[open\] > \.accordion-summary::after \{ transform:rotate\(45deg\)/);
assert.match(sharedCSS, /\.accordion-summary::after \{[^}]*transform:rotate\(-45deg\)/);
console.log('PASS: placeholders, lean month cards, neutral disabled cursors and chevrons for ALL accordions');
