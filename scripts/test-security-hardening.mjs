/** Security regression without user data, passwords, IDs, names, salaries or real PDFs. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const session=file('src/cloud/session.ts');
const auth=file('src/cloud/auth.ts');
const docs=file('README.md');
assert.match(session,/TAB_TTL_MS=2\*60\*60\*1000/);
assert.match(session,/payroll-ephemeral-tab-unlock-v2/);
assert.match(session,/removeItem\(LEGACY_TAB_KEY\)/);
assert.match(auth,/最長2時間/);
assert.doesNotMatch(auth,/最長8時間/);
assert.match(docs,/最長2時間保持/);
assert.doesNotMatch(docs,/最長8時間保持/);
for(const p of ['public/index.html','public/upload/index.html','public/backup/index.html','public/edit/index.html','public/view/index.html']) {
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
console.log('PASS: 2h key storage, old-cache invalidation, strict CSP, PDF.js 6 API, redacted local history scan');
