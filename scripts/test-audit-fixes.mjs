/** セキュリティ監査パッチの回帰テスト。実際のIndexedDBや給与PDFは使用しない。 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function sourceModule(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'node',
    target: 'es2022', write: false, logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const { writeZip, readZip } = await sourceModule('src/storage/zipArchive.ts');
const original = await writeZip([
  { name: 'manifest.json', data: new TextEncoder().encode('{}') },
  { name: 'pdf/000001.pdf', data: new TextEncoder().encode('%PDF-1.4\nTEST') },
]).arrayBuffer();
assert.equal(readZip(original).size, 2, '正規の従来ZIPを読み込める');
for (const offset of [6, 8, 14, 18, 22]) {
  const changed = original.slice(0);
  const bytes = new Uint8Array(changed);
  bytes[offset] ^= 1;
  assert.throws(() => readZip(changed), `ローカルヘッダー${offset}番目の改ざんを拒否`);
}
{
  const changed = original.slice(0);
  const bytes = new Uint8Array(changed);
  const central = bytes.findIndex((value, i) => value === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02);
  assert.ok(central > 0);
  new DataView(changed).setUint32(central + 42, 3, true);
  assert.throws(() => readZip(changed), /ファイル位置/, 'ローカル領域の重複・改ざんを拒否');
}

const { payrollSnapshot, replaceAllRecords, toSummary } = await sourceModule('src/storage/payrollStore.ts');
const record = (id, month) => ({
  id, fileName: `${month}.pdf`, pdf: new Blob(['%PDF-1.4\nTEST']),
  savedAt: '2026-11-14T00:00:00.000Z', revision: 1,
  pages: 1, warningsAcknowledged: false,
  form: { job: 'main', kind: 'salary', targetMonth: month, paymentDate: `${month}-25`, gross: '100', net: '100' },
});
const saved = [toSummary(record(1, '2026-09'))];
const baseline = payrollSnapshot(saved);
let writes = 0;
let changes = saved;
const mockDb = {
  open(name, version) {
    assert.equal(name, 'payroll-local-v1');
    assert.equal(version, 2);
    const request = {
      result: {
        close() {},
        transaction(names, mode) {
          assert.equal(mode, 'readwrite');
          assert.deepEqual(names, ['payroll-records', 'payroll-record-index']);
          const tx = {
            objectStore(name) {
              return {
                getAll() {
                  assert.equal(name, 'payroll-record-index');
                  const req = { result: changes };
                  queueMicrotask(() => {
                    req.onsuccess?.();
                    queueMicrotask(() => { if (!tx.aborted) tx.oncomplete?.(); });
                  });
                  return req;
                },
                clear() { writes++; },
                put() { writes++; },
              };
            },
            abort() { tx.aborted = true; tx.onabort?.(); },
          };
          return tx;
        },
      },
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  },
};
const originalWindow = globalThis.window;
const originalIndexedDb = globalThis.indexedDB;
try {
  globalThis.window = { indexedDB: mockDb };
  globalThis.indexedDB = mockDb;
  changes = [toSummary(record(1, '2026-09')), toSummary(record(2, '2026-10'))];
  await assert.rejects(replaceAllRecords([record(3, '2026-11')], baseline), /変更されています/);
  assert.equal(writes, 0, '別タブで変化があれば削除処理を実行しない');
  changes = saved;
  await replaceAllRecords([record(3, '2026-11')], baseline);
  assert.equal(writes, 4, '状態が一致すれば原子的な復元処理へ進む');
} finally {
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  if (originalIndexedDb === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = originalIndexedDb;
}
console.log('OK: ZIP構造検証、従来ZIP互換性、別タブ更新時の復元中止、通常復元');
