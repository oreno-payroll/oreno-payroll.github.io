/** 実ブラウザ制限環境でも、Service WorkerのPDF応答を独立に検査する。 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safePdfFileName } from '../src/storage/fileNaming.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'public/view/pdf-sw.js'), 'utf8');
const events = new Map();
const pdf = new Blob([new TextEncoder().encode('%PDF-1.4\n%unit-test\n')], { type: 'application/pdf' });
const fileName = '2025年8月 給与明細.pdf';
const record = { id: 7, fileName, pdf };
const indexedDB = {
  open(name) {
    assert.equal(name, 'payroll-local-v1');
    const open = { result: {
      objectStoreNames: { contains(name) { return name === 'payroll-records'; } },
      transaction(name, mode) {
        assert.equal(name, 'payroll-records');
        assert.equal(mode, 'readonly');
        const tx = { objectStore() { return { get(id) {
          const request = { result: id === 7 ? record : undefined };
          queueMicrotask(() => { request.onsuccess?.(); tx.oncomplete?.(); });
          return request;
        } }; } };
        return tx;
      },
      close() {},
    } };
    queueMicrotask(() => open.onsuccess?.());
    return open;
  },
};
const scope = 'http://localhost:5173/view/';
const self = {
  registration: { scope },
  location: { origin: 'http://localhost:5173' },
  addEventListener(name, handler) { events.set(name, handler); },
  skipWaiting() {},
  clients: { claim() {} },
};
vm.runInNewContext(source, { self, indexedDB, Response, Headers, URL, Blob, Number, encodeURIComponent, decodeURIComponent, console });
const fetchEvent = events.get('fetch');
assert.equal(typeof fetchEvent, 'function');
async function request(path, headers = {}, method = 'GET') {
  let response;
  fetchEvent({ request: new Request(`${scope}${path}`, { method, headers }), respondWith(promise) { response = promise; } });
  return await response;
}
const encoded = encodeURIComponent(fileName);
const whole = await request(`pdf/7/${encoded}`);
assert.equal(whole.status, 200);
assert.equal(whole.headers.get('Content-Type'), 'application/pdf');
assert.match(whole.headers.get('Content-Disposition'), /filename\*=UTF-8''2025/);
assert.equal(await whole.text(), '%PDF-1.4\n%unit-test\n');
const range = await request(`pdf/7/${encoded}`, { Range: 'bytes=0-3' });
assert.equal(range.status, 206);
assert.equal(range.headers.get('Content-Range'), `bytes 0-3/${pdf.size}`);
assert.equal(await range.text(), '%PDF');
// ビューア側の共通命名関数とWorkerの命名規則が特殊名でも一致するか。
for (const original of [
  'report...pdf', '...pdf', 'a .pdf', 'A.PDF', ' .pdf ',
  '../日本語\\給与.pdf', 'a\u0000:b?c.pdf', 'x'.repeat(230) + '.pdf',
]) {
  record.fileName = original;
  const expected = safePdfFileName(original);
  const actual = await request(`pdf/7/${encodeURIComponent(expected)}`);
  assert.equal(actual.status, 200, `命名不一致: ${JSON.stringify(original)} → ${expected}`);
  assert.equal(await actual.text(), '%PDF-1.4\n%unit-test\n');
  assert.equal(actual.headers.get('Content-Disposition')?.includes(encodeURIComponent(expected)), true);
}
record.fileName = fileName;
const head = await request(`pdf/7/${encoded}`, {}, 'HEAD');
assert.equal(head.status, 200);
assert.equal((await head.arrayBuffer()).byteLength, 0);
const invalid = await request(`pdf/7/${encodeURIComponent('wrong.pdf')}`);
assert.equal(invalid.status, 409);
const missing = await request(`pdf/8/${encoded}`);
assert.equal(missing.status, 404);
console.log('OK: 通常取得・部分取得・HEAD・改名検知・原本なし・特殊名8種の整合性を確認。');
