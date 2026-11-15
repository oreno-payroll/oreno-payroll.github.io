/** PDF閲覧画面の実処理をモックDOMとWorkerで動かす。文字列存在テストではない。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { safePdfFileName } from '../src/storage/fileNaming.ts';

const source = fs.readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source.replace(/^import .*?;\s*$/gm, ''), { mode: 'strip' });
const pdf = new Blob(['%PDF-1.4\nviewer-test\n'], { type: 'application/pdf' });
const names = ['給与明細.pdf', 'report...pdf', '...pdf', 'a .pdf', 'A.PDF', 'a\u0000:b?c.pdf'];

async function verify(name, supported) {
  const record = { id: 7, fileName: name, pdf };
  const reader = { hidden: true, src: '', title: '' };
  const status = { hidden: false, textContent: '', setAttribute() {} };
  const base = 'http://localhost:5173/view/index.html?id=7';
  let registrations = 0;
  let created = 0;
  const realUrl = URL;
  class URLMock extends realUrl {
    static createObjectURL(blob) { assert.equal(blob, pdf); created++; return 'blob:viewer-test'; }
    static revokeObjectURL() {}
  }
  const sw = supported ? {
    controller: { scriptURL: 'http://localhost:5173/view/pdf-sw.js' },
    async register(url, options) { registrations++; assert.equal(url, 'http://localhost:5173/view/pdf-sw.js'); assert.equal(options.scope, './'); },
  } : undefined;
  const ctx = {
    window: { isSecureContext: true, addEventListener() {}, setTimeout, clearTimeout },
    document: { title: '', getElementById(id) { return id === 'pdf-status' ? status : id === 'pdf-reader' ? reader : null; } },
    location: { href: base, search: '?id=7' },
    navigator: supported ? { serviceWorker: sw } : {},
    URL: URLMock, URLSearchParams, console, setTimeout, clearTimeout, Blob,
    getRecord: async (id) => { assert.equal(id, 7); return record; },
    safePdfFileName,
  };
  vm.runInNewContext(runnable, ctx, { filename: 'view.ts (browser mock)' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.hidden, true, '読み込み完了時は状態表示を隠す');
  assert.equal(reader.hidden, false, 'PDF iframeを表示する');
  assert.equal(ctx.document.title, name, '外側のタブタイトルは原本名');
  if (supported) {
    assert.equal(reader.src, `./pdf/7/${encodeURIComponent(safePdfFileName(name))}`);
    assert.equal(registrations, 1);
    assert.equal(created, 0);
  } else {
    assert.equal(reader.src, 'blob:viewer-test');
    assert.equal(created, 1);
  }
}
for (const name of names) await verify(name, true);
await verify('report...pdf', false);
console.log('OK: PDF閲覧6種類の名前付きURL生成、原本名の保持、Worker非対応時のフォールバック');
