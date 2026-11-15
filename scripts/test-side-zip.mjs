/** PDF原本のZIPエクスポート回帰テスト。元PDF以外が混入しないことを検査。 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const built = await build({
  entryPoints: ['src/export/sidePdfs.ts', 'src/storage/zipArchive.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', write: false,
  outdir: 'unused', entryNames: '[name]',
});
async function load(name) {
  const out = built.outputFiles.find(file => file.path.endsWith(`/${name}.js`));
  if (!out) throw new Error(`${name}がバンドルされていません`);
  return import(`data:text/javascript;base64,${Buffer.from(out.contents).toString('base64')}`);
}
const { createSidePdfZip } = await load('sidePdfs');
const { writeZip } = await load('zipArchive');
const record = (id, job, fileName, date) => ({
  id, form: { job, paymentDate: date }, fileName,
  pdf: new Blob([`%PDF-1.4\nsource-${id}`], { type: 'application/pdf' }),
});
function zipEntries(blobBytes) {
  const view = new DataView(blobBytes.buffer, blobBytes.byteOffset, blobBytes.byteLength);
  const decoder = new TextDecoder();
  const names = [];
  let cursor = 0;
  while (cursor + 4 <= blobBytes.byteLength && view.getUint32(cursor, true) === 0x04034b50) {
    const size = view.getUint32(cursor + 18, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const name = decoder.decode(blobBytes.slice(cursor + 30, cursor + 30 + nameLength));
    names.push(name);
    cursor += 30 + nameLength + size;
  }
  return names;
}
const side = [
  record(3, 'side', '同名.pdf', '2026-05-20'),
  record(1, 'side', '同名.pdf', '2026-04-20'),
  record(2, 'side', '../日本語\\給与.pdf', '2026-04-21'),
];
const blob = await createSidePdfZip(side);
assert.deepEqual(zipEntries(new Uint8Array(await blob.arrayBuffer())), [
  'pdf/000001_同名.pdf', 'pdf/000002_.._日本語_給与.pdf', 'pdf/000003_同名.pdf',
]);
await assert.rejects(createSidePdfZip([]), /対象の副業PDF/);
await assert.rejects(createSidePdfZip([record(4, 'main', 'main.pdf', '2026-05-20')]), /副業以外/);
await assert.rejects(createSidePdfZip([{ ...record(5, 'side', 'bad.pdf', '2026-05-20'), pdf: new Blob(['INVALID']) }]), /PDF原本の形式/);
const backup = writeZip([{ name: 'manifest.json', data: new TextEncoder().encode('{}') }]);
assert.deepEqual(zipEntries(new Uint8Array(await backup.arrayBuffer())), ['manifest.json']);
console.log('OK: 副業のみのZIP、日本語/同名ファイル、危険な名前、PDF検証、従来バックアップ形式');
