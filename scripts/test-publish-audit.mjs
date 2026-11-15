/** 架空の値から生成したPII検出器の回帰テスト。実際のアドレス/電話番号はソースに埋め込まない。 */
import assert from 'node:assert/strict';
import { findSensitiveContent } from './audit-rules.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const email = ['test', 'example.invalid'].join(String.fromCharCode(64));
const mobile = ['090', '1234', '5678'].join('-');
const fixed = ['06', '1234', '5678'].join('-');
const phone = ['080', '1111', '2222'].join('');
const secret = ['client_secret', '"' + 'q'.repeat(26) + '"'].join(' = ');
const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
const includes = (source, label) => assert.ok(findSensitiveContent(source).includes(label), label);
includes(email, 'メールアドレス');
for (const value of [mobile, fixed, phone]) includes(value, '日本の電話番号らしい数列');
includes(secret, 'ハードコードされた認証情報');
includes(key, '秘密鍵');
// PDF.js を読み込まない編集画面と原本ビューアは、動的コード評価を許可しない。
for (const relative of ['public/edit/index.html', 'public/view/index.html']) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /unsafe-eval/);
}
for (const harmless of ['2026-11-15', 'v1.1.0', 'PAYROLL=2026', '1234567890']) {
  assert.deepEqual(findSensitiveContent(harmless), [], `架空データ誤検出: ${harmless}`);
}

// Git管理対象だけの審査を、公開前の最小リポジトリで実際に動かす。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-audit-test-'));
try {
  fs.mkdirSync(path.join(temp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'public/view'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'src/export'), { recursive: true });
  for (const relative of [
    'scripts/audit-publish.mjs', 'scripts/audit-rules.mjs', 'scripts/test-audit-fixes.mjs',
    'public/view/index.html', 'public/view/pdf-sw.js', 'src/view.ts', 'src/export/sidePdfs.ts',
  ]) {
    fs.mkdirSync(path.dirname(path.join(temp, relative)), { recursive: true });
    fs.copyFileSync(path.join(root, relative), path.join(temp, relative));
  }
  // Gitの追跡対象に入っていても、コミット時のindexに危険な内容があれば拒否。
  const git = (...args) => execFileSync('git', args, { cwd: temp, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  const runAudit = (...args) => spawnSync(process.execPath, ['scripts/audit-publish.mjs', ...args], { cwd: temp, encoding: 'utf8' });
  assert.equal(runAudit('--staged').status, 0, '正常な構成を誤検出しない');
  const target = path.join(temp, 'src/view.ts');
  fs.appendFileSync(target, `\n// ${mobile}\n`);
  assert.notEqual(runAudit().status, 0, '変更済みの携帯番号を検出する');
  assert.equal(runAudit('--staged').status, 0, 'まだステージしていない変更を--stagedが誤検出しない');
  git('add', 'src/view.ts');
  assert.notEqual(runAudit('--staged').status, 0, 'ステージ済み携帯番号を検出する');
  fs.writeFileSync(target, fs.readFileSync(path.join(root, 'src/view.ts')));
  assert.notEqual(runAudit('--staged').status, 0, '作業ツリーだけ修正してもステージ済み内容を検出する');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('OK: 架空メール・携帯/固定/IP電話・秘密情報の検出、Git indexの差分チェック');
