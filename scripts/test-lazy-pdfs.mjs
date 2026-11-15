/** PDF非一括読み込みの純粋関数テスト。IndexedDB実操作はブラウザで最終確認する。
 *  TypeScript 7のパッケージ直下には従来のtranspileModuleが公開されていないため、
 *  アプリのビルドでも使っているesbuildで検証対象を一時的に束ねる。
 */
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const built = await build({
  entryPoints: [path.join(root, 'src/storage/payrollStore.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  write: false,
  outfile: 'payrollStore-test.mjs',
  logLevel: 'silent',
});
const output = built.outputFiles.find(file => file.path.endsWith('/payrollStore-test.mjs'));
if (!output) throw new Error('PDF索引テスト用コードを構築できませんでした。');
const url = `data:text/javascript;base64,${Buffer.from(output.contents).toString('base64')}`;
const { recordSignature, toSummary } = await import(url);
const pdf = new Blob(['%PDF-1.5\nTest document\n%%EOF'], { type: 'application/pdf' });
const sample = {
  id: 7, fileName: '2026年の明細.pdf', originalFileName: 'original.pdf', savedAt: '2026-11-14T01:00:00.000Z',
  fileHash: 'd'.repeat(64), pdf, pages: 1, revision: 4, warningsAcknowledged: true,
  reviewedIssues: ['サンプル'], reviewedAt: '2026-11-14T01:00:00.000Z',
  form: { job: 'side', kind: 'salary', targetMonth: '2026-10', paymentDate: '2026-11-10', gross: '120000', net: '120000' },
};
const meta = toSummary(sample);
assert.equal(Object.hasOwn(meta, 'pdf'), false, '索引にはPDF本体を含めない');
assert.equal(meta.pdfSize, pdf.size);
assert.equal(meta.pdfType, 'application/pdf');
assert.equal(meta.id, sample.id);
assert.deepEqual(meta.form, sample.form);
assert.equal(recordSignature(sample), recordSignature(meta), '削除用の競合検出署名は一致する');
const legacy = { ...sample };
delete legacy.revision;
delete legacy.fileHash;
delete legacy.reviewedIssues;
delete legacy.reviewedAt;
assert.equal(recordSignature(legacy), recordSignature(toSummary(legacy)), '旧版の明細にも対応する');
const edited = { ...sample, revision: 5 };
assert.notEqual(recordSignature(edited), recordSignature(meta), '別タブ更新は検出する');
console.log('OK: PDF本体を含まない索引、PDFサイズ、旧データ互換、署名一致、更新検出');
