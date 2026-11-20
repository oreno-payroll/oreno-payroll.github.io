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
assert.match(html,/<section class="card settings-panel backup-cloud-settings"/);
assert.match(html,/<section class="card settings-panel backup-key-change"/);
assert.doesNotMatch(html,/<details\b|<summary\b/,'settings should not need accordions');
for(const [id,title] of [['settings-backup-title','バックアップ'],['settings-auth-title','認証'],['settings-details-title','詳細設定']]){
 assert.ok(html.includes(`<h2 id="${id}">${title}</h2>`));
}
for(const [id,title] of [['settings-finance-income-title','Financeへの給与連携'],['settings-orphan-title','年度データの復旧'],['settings-legacy-title','旧データの整理・移行']]){
 assert.ok(html.includes(`<h3 id="${id}">${title}</h3>`));
}
assert.equal((html.match(/class="settings-group(?: [^"]+)?"/g)??[]).length,3,'backup, auth and details groups');
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
console.log('PASS: backup/auth/details sections; three grouped tasks; responsive layout; preserved safety controls');
