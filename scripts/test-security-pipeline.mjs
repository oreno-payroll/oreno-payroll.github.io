/** Negative tests: guard rails MUST fail after simulated bypasses. */
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,cpSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {auditWorkflow} from './audit-ci-workflow.mjs';
import {auditDist} from './audit-dist.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const workflow=readFileSync(path.join(root,'.github/workflows/deploy.yml'),'utf8');
assert.deepEqual(auditWorkflow(workflow),[],'current workflow gates are intact');
for(const [name,bad] of [
 ['disabled scanner',workflow.replace('run: gitleaks git --log-opts=--all --redact --no-banner .',"if: false\n        run: gitleaks git --log-opts=--all --redact --no-banner .")],
 ['echo-only scanner',workflow.replace('run: gitleaks git --log-opts=--all --redact --no-banner .',"run: echo 'gitleaks git --log-opts=--all --redact --no-banner .' ")],
 ['tag instead of SHA',workflow.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v4')],
 ['upload before scan',workflow.replace('      - name: Regression tests','      - name: Regression tests\n      - name: Upload Pages artifact')],
 ['cron deploy',workflow.replace("if: github.event_name != 'schedule'",'if: always()')],
 ['missing CI dictionary',workflow.replace(/          PAYROLL_PRIVATE_TERMS_B64: \$\{\{ secrets\.PAYROLL_PRIVATE_TERMS_B64 \}\}/,'          PAYROLL_PRIVATE_TERMS_B64: ""')],
]){
 assert.ok(auditWorkflow(bad).length,`${name} must fail`);
}
const temp=mkdtempSync(path.join(os.tmpdir(),'payroll-dist-audit-'));
const prevB64=process.env.PAYROLL_PRIVATE_TERMS_B64;
try{
 mkdirSync(path.join(temp,'public'),{recursive:true});
 mkdirSync(path.join(temp,'src'),{recursive:true});
 for(const dir of ['cmaps','standard_fonts','wasm','iccs','build'])mkdirSync(path.join(temp,'node_modules/pdfjs-dist',dir),{recursive:true});
 writeFileSync(path.join(temp,'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),'/* benign worker */');
 writeFileSync(path.join(temp,'src/main.ts'),'export {};');
 writeFileSync(path.join(temp,'public/index.html'),'<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">');
 const target=path.join(temp,'dist');mkdirSync(target);
 cpSync(path.join(temp,'public/index.html'),path.join(target,'index.html'));
 for(const name of ['main.js','build-info.js'])writeFileSync(path.join(target,name),'/* verified generated app output */');
 mkdirSync(path.join(target,'vendor/msal'),{recursive:true});
 mkdirSync(path.join(target,'auth'),{recursive:true});
 writeFileSync(path.join(target,'vendor/msal/msal-browser.bundle.js'),'/* verified bundle example */');
 writeFileSync(path.join(target,'auth/redirect-bridge.js'),'/* verified bridge example */');
 writeFileSync(path.join(target,'pdf.worker.min.mjs'),'/* benign worker */');
 process.env.PAYROLL_PRIVATE_TERMS_B64=Buffer.from('do-not-publish-test-name').toString('base64');
 assert.equal((await auditDist({root:temp,requirePrivateTerms:true,verifyBundles:false})).problems.length,0);
 writeFileSync(path.join(target,'unaudited.pdf'),'private example');
 assert.ok((await auditDist({root:temp,verifyBundles:false})).problems.some(s=>s.includes('未知の配信')));
 rmSync(path.join(target,'unaudited.pdf'));
 writeFileSync(path.join(target,'main.js'),'/* do-not-publish-test-name */');
 assert.ok((await auditDist({root:temp,verifyBundles:false})).problems.some(s=>s.includes('個別禁止語句')));
 writeFileSync(path.join(target,'main.js'),'/* verified generated app output */');
 writeFileSync(path.join(target,'index.html'),'<html>no security policy</html>');
 assert.ok((await auditDist({root:temp,verifyBundles:false})).problems.some(s=>s.includes('CSP')));
}finally{
 if(prevB64===undefined)delete process.env.PAYROLL_PRIVATE_TERMS_B64;
 else process.env.PAYROLL_PRIVATE_TERMS_B64=prevB64;
 rmSync(temp,{recursive:true,force:true});
}
console.log('PASS: CI bypass mutation and Pages artifact tampering are rejected');
