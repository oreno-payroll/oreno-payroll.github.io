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

// IndexedDB復元テストはCloud移行に伴い独立した3-way mergeテストへ置き換え。
const { mergeAnnual } = await sourceModule('src/cloud/vault.ts');
const base = {format:'payroll-annual-v1',records:[],deleted:[]};
const r = (id, gross) => ({id,fileName:`${id}.pdf`,originalId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',originalMonth:'2026-11',pdfSize:20,pdfType:'application/pdf',savedAt:'2026-11-16T00:00:00Z',pages:1,warningsAcknowledged:true,form:{job:'main',kind:'salary',targetMonth:'2026-11',paymentDate:'2026-11-27',gross:String(gross),net:String(gross)}});
const first = { ...base, records:[r(1,100)] };
const second = { ...base, records:[r(2,200)] };
const merged = mergeAnnual(base, first, second);
assert.deepEqual(merged.records.map(x=>x.id).sort(),[1,2],'独立IDの追加は両方残す');
const changedA = {...first,records:[{...r(1,100),form:{...r(1,100).form,gross:'150'}}]};
const changedB = {...first,records:[{...r(1,100),form:{...r(1,100).form,net:'160'}}]};
assert.equal(mergeAnnual(first,changedA,changedB).records[0].form.net,'160');
assert.equal(mergeAnnual(first,changedA,changedB).records[0].form.gross,'150');
const clash = {...first,records:[{...r(1,100),form:{...r(1,100).form,gross:'999'}}]};
assert.throws(()=>mergeAnnual(first,changedA,clash),/別端末/,'同じ入力項目を上書きしない');
console.log('OK: ZIP検証、独立IDの3方向統合、異なる項目の統合、同一項目競合の拒否');
