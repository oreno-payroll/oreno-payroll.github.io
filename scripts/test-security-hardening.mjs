/** Security regression without user data, passwords, IDs, names, salaries or real PDFs. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const session=file('src/cloud/session.ts');
const auth=file('src/cloud/auth.ts');
const docs=file('README.md');
assert.match(session,/export function clearTabUnlock/);
assert.match(session,/removeItem\('payroll-ephemeral-tab-unlock-v1'\)/);
assert.match(session,/removeItem\('payroll-ephemeral-tab-unlock-v2'\)/);
assert.doesNotMatch(session,/export function rememberTabUnlock|export async function restoredTabUnlock|sessionStorage\.setItem/);
assert.doesNotMatch(auth,/このタブで保持（最長2時間）|rememberTabUnlock|restoredTabUnlock/);
assert.match(auth,/このブラウザを記憶する/);
assert.doesNotMatch(docs,/このタブで保持（最長2時間）.*保持します/);
for(const p of ['public/index.html','public/upload/index.html','public/backup/index.html','public/edit/index.html','public/view/index.html','public/year-end-assist/index.html']) {
 const html=file(p);
 const csp=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
 assert.ok(csp,p+' needs a CSP');
 const scripts=csp.split(';').map(x=>x.trim()).find(x=>x.startsWith('script-src '));
 assert.ok(scripts,p+' needs script-src');
 assert.equal(scripts.split(/\s+/).includes("'unsafe-eval'"),false,p+' allows eval');
 if(['public/index.html','public/upload/index.html','public/backup/index.html'].includes(p))
   assert.ok(scripts.includes("'wasm-unsafe-eval'"),p+' needs WASM permission');
}
const pkg=JSON.parse(file('package.json'));
assert.match(pkg.dependencies['pdfjs-dist'],/^\^?6\./,'PDF.js major version must be validated before tightening CSP');
for(const p of ['src/upload.ts','src/pdf/diagnostic.ts','src/storage/pdfIntegrity.ts']){
 assert.doesNotMatch(file(p),/isEvalSupported\s*:/,p+' must not use removed PDF.js v6 option');
}
const scanner=file('scripts/audit-history.sh');
assert.match(scanner,/gitleaks git --redact --log-opts="--all"/);
assert.doesNotMatch(scanner,/--report-path/);
// ファイルのMIMEは端末/ブラウザ側が提供する値であり、信頼できない。
// 誤った text/html として別タブで実行されないよう、PDFプレビューの型を固定する。
const upload=file('src/upload.ts');
assert.match(upload,/URL\.createObjectURL\(new Blob\(\[entry\.file\],\s*\{\s*type:\s*["']application\/pdf["']\s*\}\)\)/,
  'PDF preview must use an explicitly typed PDF Blob');
assert.doesNotMatch(upload,/URL\.createObjectURL\(entry\.file\)/,
  'Untrusted File.type must not decide preview content type');
const mislabeledPdf=new File([new Uint8Array([37,80,68,70])],'sample.pdf',{type:'text/html'});
assert.equal(new Blob([mislabeledPdf],{type:'application/pdf'}).type,'application/pdf');
console.log('PASS: removed recoverable tab keys, strict CSP, and PDF preview MIME-type hardening');
