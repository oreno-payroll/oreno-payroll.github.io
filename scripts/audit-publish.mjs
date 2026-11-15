/**
 * GitHub Pages公開前のフェイルクローズ検査。
 * 対象はGit管理対象ファイル（CIではコミットに含まれる内容）。
 * 個人情報や秘密情報の完全な検出器ではないため、人間による確認も必要。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findSensitiveContent } from './audit-rules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
const required = [
  'public/view/index.html',
  'public/view/pdf-sw.js',
  'src/view.ts',
  'src/export/sidePdfs.ts',
  'scripts/audit-publish.mjs',
  'scripts/test-audit-fixes.mjs',
];
const allowed = (file) => [
  '.gitignore', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json',
  '.github/workflows/deploy.yml',
].includes(file)
  || /^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.tsx?$/.test(file)
  || /^public\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:html|css)$/.test(file)
  || file === 'public/view/pdf-sw.js'
  || /^scripts\/[a-zA-Z0-9_-]+\.(?:mjs|js|cjs|sh)$/.test(file);
const problems = [];
const staged = process.argv.includes('--staged');
for (const file of required) {
  if (!tracked.includes(file)) problems.push(`必要なファイルがGit未追跡です: ${file}`);
}
for (const file of tracked) {
  if (!allowed(file)) {
    problems.push(`Git公開対象に想定外のファイルがあります: ${file}`);
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
  console.log(`[公開前監査] OK: Git管理${tracked.length}ファイル。必要なPDF閲覧ファイルが揃い、禁止ファイル・主要な秘密情報パターンは検出されませんでした。`);
}
