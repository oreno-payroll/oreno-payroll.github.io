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
assert.match(html,/<section class="settings-group settings-legacy"/);
assert.match(html,/<section class="card settings-panel backup-cloud-settings"/);
assert.match(html,/<section class="card settings-panel backup-key-change"/);
assert.doesNotMatch(html,/<details\b|<summary\b/,'settings should not need accordions');
assert.match(html,/<h2 id="settings-backup-title">バックアップ<\/h2>/);
assert.match(html,/<h2 id="settings-auth-title">認証<\/h2>/);
assert.match(html,/<h2 id="settings-legacy-title">旧データの整理・移行<\/h2>/);
assert.match(html,/<h2 id="settings-finance-income-title">Financeへの給与連携<\/h2>/);
assert.match(html,/<h2 id="settings-orphan-title">年度データの復旧<\/h2>/);
assert.equal((html.match(/class="settings-group(?: [^"]+)?"/g)??[]).length,5,'five settings groups including Finance income and orphan recovery');
assert.ok(html.indexOf('id="settings-backup-title"')<html.indexOf('id="settings-auth-title"'),'backup precedes auth');
assert.ok(html.indexOf('id="settings-auth-title"')<html.indexOf('id="settings-legacy-title"'),'migration follows auth');
assert.ok(html.indexOf('id="settings-finance-income-title"')<html.indexOf('id="settings-orphan-title"'),'orphan recovery follows Finance');
assert.ok(html.indexOf('id="settings-orphan-title"')<html.indexOf('id="settings-legacy-title"'),'legacy cleanup remains last');
assert.ok(html.indexOf('id="settings-security-title"')<html.indexOf('id="backup-cloud-title"'),'key change is left column');
assert.match(css,/\.settings-page \.settings-auth-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(css,/\.settings-page \.backup-key-change__fields\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.match(css,/@media\s*\(max-width:\s*830px\)[\s\S]*?\.settings-page \.settings-auth-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.doesNotMatch(css,/backup-key-change__fields\s*\{[^}]*repeat\(3,/,'passphrase fields must not be 3 columns');

assert.match(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),/>設定<\/span>/);
assert.match(html,/id="restore-ack" disabled/);
assert.match(html,/id="restore-button"[^>]*disabled/);
assert.match(html,/id="verify-button"[^>]*hidden disabled/);
assert.match(html,/id="restore-password-row"[^>]*hidden/);
assert.match(html,/id="backup-status"[^>]*aria-live="polite"/);
assert.match(script,/window\.confirm\(`/,'destructive replace confirm must remain');
assert.doesNotMatch(html,/style="/,'inline CSS should be removed');
assert.doesNotMatch(html,/保存先でファイルがあること/);
assert.doesNotMatch(script,/元のデータは保持されています/,'partial cloud restoration must not claim rollback');

assert.match(html, /class="card settings-panel settings-finance-income"/, 'Finance integration card must use shared settings styles');
assert.match(html, /id="payroll-income-publish"/, 'Finance regeneration must remain available');
assert.match(css, /\.settings-page \.settings-finance-income\s*\{[^}]*padding:\s*28px 30px/, 'Finance card desktop padding');
assert.doesNotMatch(html, /payroll\/income\//, 'avoid fixed path wording after password rotation');
// Finance連携と年度復旧の余白・行間を同一に保つ回帰テスト。
assert.match(html, /class="card settings-panel settings-orphan-recovery"/);
const financeSpacing = css.match(/\.settings-page \.settings-finance-income\s*\{([^}]+)\}/)?.[1];
const orphanSpacing = css.match(/\.settings-page \.settings-orphan-recovery\s*\{([^}]+)\}/)?.[1];
assert.ok(financeSpacing && orphanSpacing, 'two setting card layout rules must exist');
for(const prop of ['display','justify-items','align-content','gap','padding']){
 const read = rule => {
  const regex=new RegExp(String.raw`(?:^|;)\s*${prop}\s*:\s*([^;]+)`);
  const m=rule.match(regex);
  assert.ok(m,'missing '+prop);
  return m[1].trim();
 };
 assert.equal(read(orphanSpacing),read(financeSpacing),'Finance/年度復旧のレイアウト不一致: '+prop);
}
for(const selector of ['finance-income','orphan-recovery']){
 const noteSelector=new RegExp(String.raw`\.settings-page \.settings-${selector} \.settings-note\s*\{[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.8;`);
 const rowSelector=new RegExp(String.raw`\.settings-page \.settings-${selector} \.settings-action-row\s*\{\s*width:\s*100%;`);
 const mobileSelector=new RegExp(String.raw`\.settings-page \.settings-${selector}\s*\{\s*padding:\s*21px 18px;\s*gap:\s*16px;`);
 assert.match(css,noteSelector);
 assert.match(css,rowSelector);
 assert.match(css,mobileSelector);
}
console.log('PASS: five sections including orphan recovery / Finance / two-column auth / responsive / preserved IDs');
