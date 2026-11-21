/** バックアップ画面のHTML/CSSと操作IDを静的に検証する。Nodeだけで動く。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/backup/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/styles/vault.css',import.meta.url),'utf8');
const script=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
const ids=['export-summary','export-password','export-confirm','export-button','restore-file',
 'restore-password-row','restore-password','verify-button','restore-preview','restore-ack',
 'restore-button','backup-status','migrate-legacy-cloud','migrate-legacy-cloud-status',
 'orphan-year-check','orphan-year-recover','orphan-year-status'];
for(const id of ids){
 assert.equal((html.match(new RegExp('id="'+id+'"','g'))??[]).length,1,'duplicate/missing control id: '+id);
 assert.ok(script.includes(id),'handler no longer references '+id);
}
for(const id of ['export-password','export-confirm','restore-file','restore-password']){
 assert.match(html,new RegExp('for="'+id+'"'),'label must associate with '+id);
}
assert.match(html,/class="vault-stack backup-grid"/);
assert.match(html,/<title>設定 \| Payroll<\/title>/);
assert.match(html,/<h1>設定<\/h1>/);
assert.match(css,/\.settings-page \.backup-grid\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(css,/@media\s*\(max-width:\s*830px\)[\s\S]*?\.settings-page \.backup-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
const yearEndSaveCard=html.match(/<section class="card vault-section" aria-labelledby="ye-backup-export-heading">([\s\S]*?)<\/section>/)?.[1];
assert.ok(yearEndSaveCard,'year-end backup save card must exist');
const note='従業員情報・各年の明細・PDF原本・見込み額・年度メモを専用ファイルにまとめます。本人用のバックアップとは別です。';
assert.equal(html.split(note).length-1,1,'year-end backup explanation should appear only once');
assert.ok(yearEndSaveCard.includes(note),'description must be inside employee backup save card');
assert.match(yearEndSaveCard,/<div class="vault-section__head">[\s\S]*?従業員データを保存[\s\S]*?<p class="vault-info">/,'explanation should follow heading');
assert.doesNotMatch(html,/OneDriveの全従業員を照合し、AES-GCM暗号化してダウンロードします。/,'redundant implementation explanation removed');
assert.match(yearEndSaveCard,/<\/div>\s*<button type="button" class="btn btn--primary ye-backup-export" id="ye-backup-export">/,'export button follows password inputs directly');
assert.doesNotMatch(yearEndSaveCard,/backup-card__footer/,'export button should not be forced to bottom');
assert.match(css,/\.settings-page \.ye-backup-export\s*\{\s*width:\s*100%;\s*white-space:\s*normal;/,'inline export button should occupy the card width');
assert.match(html,/<section class="card settings-panel backup-cloud-settings"/);
assert.match(html,/<section class="card settings-panel backup-key-change"/);
const withoutRestorePreview=html.replace(/<details id="ye-restore-people"[\s\S]*?<\/details>/,'');
assert.doesNotMatch(withoutRestorePreview,/<details\b|<summary\b/,'settings sections must not be accordions; only restore-preview list may collapse');
assert.match(html,/id="ye-restore-people"/,'large restore preview can collapse');
for(const [id,title] of [['settings-backup-title','バックアップ'],['settings-yearend-backup-title','年末調整のバックアップ'],['settings-auth-title','認証'],['settings-details-title','詳細設定']]){
 assert.ok(html.includes(`<h2 id="${id}">${title}</h2>`));
}
for(const [id,title] of [['settings-finance-income-title','Financeへの給与連携'],['settings-orphan-title','年度データの復旧'],['settings-legacy-title','旧データの整理・移行']]){
 assert.ok(html.includes(`<h3 id="${id}">${title}</h3>`));
}
assert.equal((html.match(/class="settings-group(?: [^"]+)?"/g)??[]).length,4,'personal backup, year-end backup, auth and details groups');
assert.match(html,/<div class="card settings-details-grid">/);
assert.equal((html.match(/class="settings-details-column/g)??[]).length,3);
assert.match(css,/\.settings-page \.settings-details-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
assert.match(css,/@media\s*\(max-width:\s*850px\)\s*\{[^}]*\.settings-page \.settings-details-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.ok(html.indexOf('id="settings-backup-title"')<html.indexOf('id="settings-auth-title"'));
assert.ok(html.indexOf('id="settings-auth-title"')<html.indexOf('id="settings-details-title"'));
assert.ok(html.indexOf('id="settings-finance-income-title"')<html.indexOf('id="settings-orphan-title"'));
assert.ok(html.indexOf('id="settings-orphan-title"')<html.indexOf('id="settings-legacy-title"'));
assert.match(css,/\.settings-page \.settings-auth-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0, 1fr\)\)/);
assert.match(css,/\.settings-page \.backup-key-change__fields\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.doesNotMatch(css,/backup-key-change__fields\s*\{[^}]*repeat\(3,/);
assert.match(html,/id="restore-ack" disabled/);
assert.match(html,/id="restore-button"[^>]*disabled/);
assert.match(html,/id="verify-button"[^>]*hidden disabled/);
assert.match(html,/id="restore-password-row"[^>]*hidden/);
assert.match(html,/id="backup-status"[^>]*aria-live="polite"/);
assert.match(script,/window\.confirm\(`/,'destructive restore confirmation must remain');
assert.doesNotMatch(html,/style="/,'no inline CSS');
assert.match(html,/id="payroll-income-publish"/);
assert.match(html,/id="orphan-year-check"/);
assert.match(html,/id="legacy-cleanup-delete"/);
assert.doesNotMatch(html,/payroll\/income\//);
console.log('PASS: personal/year-end backup, auth and details sections; responsive layout; preserved safety controls');
