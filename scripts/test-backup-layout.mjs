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
const personalSaveCard=html.match(/<section class="card vault-section" aria-labelledby="backup-export-title">([\s\S]*?)<\/section>/)?.[1];
const yearEndSaveCard=html.match(/<section class="card vault-section" aria-labelledby="ye-backup-export-heading">([\s\S]*?)<\/section>/)?.[1];
assert.ok(personalSaveCard,'personal backup save card must exist');
assert.ok(yearEndSaveCard,'year-end backup save card must exist');
const note='従業員情報・各年の明細・PDF原本・見込み額・年度メモを専用ファイルにまとめます。本人用のバックアップとは別です。';
assert.equal(html.split(note).length-1,1,'year-end backup explanation should appear only once');
assert.ok(yearEndSaveCard.includes(note),'description must be inside employee backup save card');
assert.match(yearEndSaveCard,/<div class="vault-section__head">[\s\S]*?従業員データを保存[\s\S]*?<p class="vault-info">/,'explanation should follow heading');
assert.doesNotMatch(html,/OneDriveの全従業員を照合し、AES-GCM暗号化してダウンロードします。/,'redundant implementation explanation removed');
const personalDescription='本人の給与・賞与明細と原本PDFが対象です。年末調整の従業員データは下の専用バックアップで保存してください。復元にはこのパスワードが必要です。';
assert.equal(html.split(personalDescription).length-1,1,'personal backup explanation should appear only once');
for(const [card,heading,desc,password,button] of [
 [personalSaveCard,'backup-export-title',personalDescription,'export-password','export-button'],
 [yearEndSaveCard,'ye-backup-export-heading',note,'ye-backup-password','ye-backup-export']]){
 const parts=[`id="${heading}"`,desc,`id="${password}"`,`id="${button}"`];
 let last=-1;
 for(const part of parts){const next=card.indexOf(part);assert.ok(next>last,`${heading}: ordering must be title → description → password → button`);last=next;}
 assert.doesNotMatch(card,/backup-card__footer/,'save buttons should not be forced to bottom');
 assert.match(card,/class="btn btn--primary [^"]*backup-save-button/,'save button must share a class');
}
assert.ok(personalSaveCard.indexOf('id="export-summary"')>personalSaveCard.indexOf(personalDescription),'live count/size should remain below the explanation');
assert.ok(personalSaveCard.indexOf('id="export-summary"')<personalSaveCard.indexOf('id="export-password"'),'live count/size should remain above inputs');
assert.match(css,/\.settings-page \.backup-save-button\s*\{\s*width:\s*100%;\s*white-space:\s*normal;/,'both save buttons must share full-width styling');
assert.match(html,/<section class="card settings-panel backup-cloud-settings"/);
assert.match(html,/<section class="card settings-panel backup-key-change"/);
const withoutRestorePreview=html.replace(/<details id="ye-restore-people"[\s\S]*?<\/details>/,'');
assert.doesNotMatch(withoutRestorePreview,/<details\b|<summary\b/,'settings sections must not be accordions; only restore-preview list may collapse');
assert.match(html,/id="ye-restore-people"/,'large restore preview can collapse');
for(const [id,title] of [['settings-backup-title','バックアップ'],['settings-yearend-backup-title','年末調整のバックアップ'],['settings-auth-title','認証'],['settings-details-title','詳細設定']]){
 assert.ok(html.includes(`<h2 id="${id}">${title}</h2>`));
}
for(const [id,title] of [['settings-finance-income-title','Finance連携用の収入データ'],['settings-orphan-title','年度データの復旧'],['settings-legacy-title','旧データの整理・移行']]){
 assert.ok(html.includes(`<h3 id="${id}">${title}</h3>`));
}
assert.equal((html.match(/class="settings-group(?: [^"]+)?"/g)??[]).length,4,'personal backup, year-end backup, auth and details groups');
assert.match(html,/<div class="card settings-details-grid">/);
assert.equal((html.match(/class="settings-details-column/g)??[]).length,4);
assert.match(css,/\.settings-page \.settings-details-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
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
assert.match(html,/id="verify-button"[^>]*disabled/);
assert.doesNotMatch(html,/id="restore-password-row"[^>]*hidden/);
assert.match(html,/id="backup-status"[^>]*aria-live="polite"/);
assert.match(script,/window\.confirm\(`/,'destructive restore confirmation must remain');
assert.doesNotMatch(html,/style="/,'no inline CSS');
assert.match(html,/id="payroll-income-publish"/);
assert.match(html,/id="orphan-year-check"/);
assert.match(html,/id="legacy-cleanup-delete"/);
assert.doesNotMatch(html,/payroll\/income\//);
// Both restore forms must use the same explicit interaction sequence.
const personal=html.match(/<section class="card vault-section" aria-labelledby="backup-restore-title">([\s\S]*?)<\/section>/)?.[1];
const employee=html.match(/<section class="card vault-section" aria-labelledby="ye-backup-restore-heading">([\s\S]*?)<\/section>/)?.[1];
assert.ok(personal && employee,'both restore panels must be present');
const steps=[['file','restore-file','ye-restore-file'],['password','restore-password','ye-restore-password'],
 ['verify','verify-button','ye-restore-verify'],['preview','restore-preview','ye-restore-preview'],
 ['ack','restore-ack','ye-restore-ack'],['commit','restore-button','ye-restore-commit']];
for(const [step,pid,eid] of steps){
 assert.ok(personal.includes(`id="${pid}"`),`missing personal ${step}`);
 assert.ok(employee.includes(`id="${eid}"`),`missing employee ${step}`);
}
for(const [label,section,ids] of [['personal',personal,steps.map(x=>x[1])],['employee',employee,steps.map(x=>x[2])]]){
 let cursor=-1;
 for(const id of ids){
  const position=section.indexOf(`id="${id}"`);
  assert.ok(position>cursor,`${label}: ${id} not in common sequence`);
  cursor=position;
 }
 assert.doesNotMatch(section,/backup-restore-warning/,'old duplicate warning must be removed');
 assert.match(section,/>復元する<\/button>/,'final button label must match');
}
assert.match(personal,/現在の本人明細をすべて置き換えることを確認しました/);
assert.match(employee,/登録済み従業員は上書きせず、未登録・削除済みの従業員だけを追加することを確認しました/);
assert.match(script,/verifyButton\.disabled = busy \|\| !filePicker\.files\?\.length \|\| \(encryptedFile && !restorePassword\.value\)/);
assert.match(script,/await verifyRestore\(file, encryptedFile \? restorePassword\.value : undefined\)/);
assert.doesNotMatch(script,/if \(!encryptedFile\) await verifyRestore\(file\)/,'legacy ZIP must await explicit verification');
assert.doesNotMatch(css,/\.settings-page \.backup-card__footer\s*\{[^}]*margin-top:\s*auto/,'restore buttons may not be bottom-pinned');
assert.match(html,/<div class="card settings-details-grid">[\s\S]*?settings-detached-originals[\s\S]*?<\/div>\s*<\/section>\s*<\/main>/,'fourth cell belongs inside shared card');
assert.ok(html.indexOf('id="settings-cloud-legacy-title"')>html.indexOf('id="settings-legacy-title"'),'cloud cleanup belongs to legacy settings');
const account=html.match(/<section class="card settings-panel backup-cloud-settings"([\s\S]*?)<\/section>/)?.[1];
const passphrase=html.match(/<section class="card settings-panel backup-key-change"([\s\S]*?)<\/section>/)?.[1];
assert.ok(account?.includes('id="remember-browser-register"'));
assert.ok(!passphrase?.includes('id="remember-browser-register"'));
console.log('PASS: personal/employee restore flow, browser auth layout, 2x2 detail grid, safety confirmation');
