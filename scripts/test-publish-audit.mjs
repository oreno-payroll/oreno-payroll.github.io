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
// 全ページでJavaScriptの動的評価を禁止。PDF.js向けのWebAssemblyのみ別途許可。
for (const relative of ['public/index.html', 'public/upload/index.html', 'public/backup/index.html', 'public/edit/index.html', 'public/view/index.html']) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /(?<![\w-])'unsafe-eval'/, 'JavaScript unsafe-eval must be disabled');
}
for (const harmless of ['2026-11-15', 'v1.1.0', 'PAYROLL=2026', '1234567890']) {
  assert.deepEqual(findSensitiveContent(harmless), [], `架空データ誤検出: ${harmless}`);
}

// Favicon is intentionally present on every page, with no external image hosting.
for (const [relative, prefix] of [
  ['public/index.html', './'],
  ['public/upload/index.html', '../'],
  ['public/backup/index.html', '../'],
  ['public/edit/index.html', '../'],
  ['public/view/index.html', '../'],
]) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.ok(html.includes(`rel="icon" type="image/x-icon" href="${prefix}favicon.ico"`), relative);
  assert.ok(html.includes(`rel="apple-touch-icon" sizes="180x180" href="${prefix}apple-touch-icon.png"`), relative);
}
const favicon = fs.readFileSync(path.join(root, 'public/favicon.ico'));
assert.equal(favicon.readUInt16LE(0), 0, 'ICO header reserved field');
assert.equal(favicon.readUInt16LE(2), 1, 'ICO image type');
assert.ok(favicon.readUInt16LE(4) >= 3, 'multi-resolution favicon');
const touch = fs.readFileSync(path.join(root, 'public/apple-touch-icon.png'));
assert.equal(touch.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG header');
assert.equal(touch.readUInt32BE(16), 180, 'touch width');
assert.equal(touch.readUInt32BE(20), 180, 'touch height');

// The icon must have genuine transparent pixels, not an opaque square.
const {inflateSync} = await import('node:zlib');
const pngFirstAlpha = png => {
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png[25],6,'RGBA PNG required');
  const blocks=[];let at=8;
  while(at<png.length){
    const length=png.readUInt32BE(at),kind=png.toString('ascii',at+4,at+8);
    if(kind==='IDAT')blocks.push(png.subarray(at+8,at+8+length));
    at+=length+12;if(kind==='IEND')break;
  }
  assert.ok(blocks.length>0,'PNG contains IDAT');
  return inflateSync(Buffer.concat(blocks))[4];
};
assert.equal(pngFirstAlpha(touch),0,'Apple icon has a transparent corner');
const firstEntry=6;
const icoLength=favicon.readUInt32LE(firstEntry+8),icoOffset=favicon.readUInt32LE(firstEntry+12);
assert.equal(pngFirstAlpha(favicon.subarray(icoOffset,icoOffset+icoLength)),0,'ICO has a transparent corner');

// Git管理対象だけの審査を、公開前の最小リポジトリで実際に動かす。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-audit-test-'));
try {
  fs.mkdirSync(path.join(temp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'public/view'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'src/export'), { recursive: true });
  for (const relative of [
    'scripts/audit-publish.mjs', 'scripts/audit-rules.mjs', 'scripts/test-audit-fixes.mjs',
    'public/view/index.html', 'public/view/pdf-sw.js', 'src/view.ts', 'src/export/sidePdfs.ts',
    'public/vendor/msal/msal-browser.bundle.js', 'public/vendor/msal/LICENSE.txt',
    'public/payroll-cloud-session.js',
    'public/favicon.ico', 'public/apple-touch-icon.png',
  ]) {
    fs.mkdirSync(path.dirname(path.join(temp, relative)), { recursive: true });
    fs.copyFileSync(path.join(root, relative), path.join(temp, relative));
  }
  // Gitの追跡対象に入っていても、コミット時のindexに危険な内容があれば拒否。
  const git = (...args) => execFileSync('git', args, { cwd: temp, stdio: 'pipe' });
  git('init', '-q');
  // 新規vendorがGit未追跡でも、適用前検査は内容とハッシュを検証する。
  git('add', '--', 'scripts', 'public/view', 'src');
  const runAudit = (...args) => spawnSync(process.execPath, ['scripts/audit-publish.mjs', ...args], { cwd: temp, encoding: 'utf8' });
  assert.notEqual(runAudit().status, 0, '通常監査は未追跡vendorを拒否する');
  assert.notEqual(runAudit('--staged').status, 0, 'Git index監査は未追跡vendorを拒否する');
  assert.equal(runAudit('--install-check').status, 0, '適用時のみ未追跡vendorをハッシュ検証して許可する');
  const msal = path.join(temp, 'public/vendor/msal/msal-browser.bundle.js');
  fs.appendFileSync(msal, '\n// tamper\n');
  assert.notEqual(runAudit('--install-check').status, 0, '未追跡vendorの改ざんは拒否する');
  fs.copyFileSync(path.join(root, 'public/vendor/msal/msal-browser.bundle.js'), msal);
  const license = path.join(temp, 'public/vendor/msal/LICENSE.txt');
  fs.unlinkSync(license);
  assert.notEqual(runAudit('--install-check').status, 0, '必要なライセンスファイルの欠落は拒否する');
  fs.copyFileSync(path.join(root, 'public/vendor/msal/LICENSE.txt'), license);
  git('add', '--', 'public/vendor/msal/msal-browser.bundle.js', 'public/vendor/msal/LICENSE.txt', 'public/payroll-cloud-session.js', 'public/favicon.ico', 'public/apple-touch-icon.png');
  assert.equal(runAudit('--staged').status, 0, 'Git追跡後の監査が通る');
  const icon = path.join(temp, 'public/favicon.ico');
  fs.appendFileSync(icon, Buffer.from([0]));
  assert.notEqual(runAudit().status, 0, 'modified favicon is rejected');
  fs.copyFileSync(path.join(root, 'public/favicon.ico'), icon);
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
