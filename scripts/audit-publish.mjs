/**
 * GitHub Pages公開前のフェイルクローズ検査。
 * 対象はGit管理対象ファイル（CIではコミットに含まれる内容）。
 * 個人情報や秘密情報の完全な検出器ではないため、人間による確認も必要。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findSensitiveContent } from './audit-rules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
const required = [
  'public/favicon.ico',
  'public/apple-touch-icon.png',
  'public/view/index.html',
  'public/view/pdf-sw.js',
  'public/payroll-cloud-session.js',
  'public/auth/redirect.html',
  'public/frame-guard.js',
  'scripts/msal-entry.mjs',
  'scripts/msal-redirect-bridge.mjs',
  'scripts/audit-msal.mjs',
  'src/view.ts',
  'src/export/sidePdfs.ts',
  'scripts/audit-publish.mjs',
  'scripts/test-audit-fixes.mjs',
];
const allowed = (file) => [
  '.gitignore', '.gitleaksignore', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json',
  '.github/workflows/deploy.yml',
].includes(file)
  || /^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.tsx?$/.test(file)
  || /^public\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:html|css)$/.test(file)
  || file === 'public/favicon.ico'
  || file === 'public/apple-touch-icon.png'
  || file === 'public/view/pdf-sw.js'
  || file === 'public/payroll-cloud-session.js'
  || file === 'public/frame-guard.js'
  || /^scripts\/[a-zA-Z0-9_-]+\.(?:mjs|js|cjs|sh)$/.test(file);
const problems = [];
const staged = process.argv.includes('--staged');
// パッチ適用時限定。未追跡の指定アセットも内容・ハッシュを検査する。
// 通常実行および--stagedではGit登録を必須とする。CIの審査は緩めない。
const installCheck = process.argv.includes('--install-check');
if (staged && installCheck) problems.push('--staged と --install-check は併用できません');
const installAssets=['public/frame-guard.js','public/auth/redirect.html','public/payroll-cloud-session.js','public/favicon.ico','public/apple-touch-icon.png'];
const untrackedVendor = [];
for (const file of required) {
  if (tracked.includes(file)) continue;
  if (!installCheck || !installAssets.includes(file)) {
    problems.push(`必要なファイルがGit未追跡です: ${file}`);
    continue;
  }
  if (!existsSync(path.join(root, file))) {
    problems.push(`必要な導入用ソースがありません: ${file}`);
    continue;
  }
  try {
    // ignore指定されたvendorは次のGitコミットに含められないため失敗させる。
    execFileSync('git', ['check-ignore', '-q', '--', file], { cwd: root, stdio: 'pipe' });
    problems.push(`必要な導入用ソースが.gitignoreで除外されています: ${file}`);
  } catch (error) {
    if (error.status !== 1) problems.push(`Git除外状態を検査できません: ${file}`);
  }
  untrackedVendor.push(file);
}
for (const file of [...tracked, ...untrackedVendor]) {
  if (!allowed(file)) {
    problems.push(`Git公開対象に想定外のファイルがあります: ${file}`);
    continue;
  }
  // Review approved icon binaries by their exact SHA-256. No generic PNG/ICO allowlist.
  if (file === 'public/favicon.ico' || file === 'public/apple-touch-icon.png') {
    const expected = file === 'public/favicon.ico'
      ? 'b06ca0c9bedb2193a918a61d39ddc6ce1e21f7c570742b67041ba57c360555fa'
      : 'd53c3d124cc364447214027bf6dcc8090cedf74a083f0ea8390d2bf368535fa6';
    try {
      const bytes = staged
        ? execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
        : readFileSync(path.join(root, file));
      if (createHash('sha256').update(bytes).digest('hex') !== expected)
        problems.push(`ファビコンが監査済みの内容と一致しません: ${file}`);
    } catch { problems.push(`ファビコンを読み取れません: ${file}`); }
    continue;
  }
  // 通常は作業ディレクトリを検査。--stagedならコミット予定のGit indexを検査。
  let contents;
  try {
    contents = staged
      ? execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString('utf8')
      : readFileSync(path.join(root, file), 'utf8');
  } catch {
    problems.push(`追跡対象を読み取れません: ${file}`);
    continue;
  }
  for (const label of findSensitiveContent(contents)) {
    problems.push(`公開前の手動確認が必要（${label}）: ${file}`);
  }
}
if (problems.length) {
  console.error('[公開前監査] 検査不合格:\n' + problems.map(s => `  - ${s}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`[公開前監査] OK: Git管理${tracked.length}ファイル${installCheck ? `・適用前vendor ${untrackedVendor.length}件` : ''}。必要なPDF閲覧・認証ブリッジソースが揃い、禁止ファイル・主要な秘密情報パターンは検出されませんでした。`);
}

// Additional deep audit, opt-in so legacy Git author findings are not silently suppressed.
if (process.argv.includes('--privacy')) {
  const {spawnSync}=await import('node:child_process');
  const scan=spawnSync(process.execPath,['scripts/audit-private-data.mjs',...(staged?['--staged']:['--working']),'--strict-gitleaks'],{cwd:root,stdio:'inherit'});
  if(scan.status!==0)process.exitCode=1;
}
