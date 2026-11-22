/** Negative tests: guard rails MUST fail after simulated bypasses. */
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,cpSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {scanGitHistoryTerms} from './audit-git-history-terms.mjs';
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
 ['upload before scan',workflow.replace('      - name: Regression tests','      - name: Upload Pages artifact\n      - name: Regression tests')],
 ['PR can deploy',workflow.replace("if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'",'if: always()')],
 ['missing CI dictionary',workflow.replace(/          PAYROLL_PRIVATE_TERMS_B64: \$\{\{ secrets\.PAYROLL_PRIVATE_TERMS_B64 \}\}/,'          PAYROLL_PRIVATE_TERMS_B64: ""')],
 ['shell echoes instead of executing',workflow.replace('        run: npm audit --audit-level=high','        run: npm audit --audit-level=high\n        shell: echo {0}')],
 ['working directory redirection',workflow.replace('        run: npm audit --audit-level=high','        run: npm audit --audit-level=high\n        working-directory: /tmp')],
 ['job run defaults',workflow.replace('    runs-on: ubuntu-latest','    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: echo {0}')],
 ['action with injection',workflow.replace('          cache: npm','          cache: npm\n          unexpected: true')],
 ['gitleaks integrity check replaced by comment',workflow.replace('          echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  $archive" | sha256sum --check --status',
       '          # echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  $archive" | sha256sum --check --status')],
 ['no pull-request trigger',workflow.replace('  pull_request:\n    branches: [main]\n','')],
 ['security job skipped',workflow.replace('    name: security','    name: security\n    if: false')],
 ['security checks renamed',workflow.replace('    name: security','    name: fake-security')],
 ['deploy detached from required security',workflow.replace('    needs: security','    needs: ignored')],
 ['PR checkout to unmerged head',workflow.replace('        run: node scripts/audit-pr-target.mjs','        run: echo unmerged')],
 ['PR paths-ignore filters',workflow.replace('  pull_request:\n    branches: [main]','  pull_request:\n    branches: [main]\n    paths-ignore: ["**/*.md"]')],
 ['gitleaks archive bypass',workflow.replace('          tar -xzf "$archive" -C "$RUNNER_TEMP/gitleaks-bin" gitleaks',
       '          echo "$archive" # no extraction')],

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

 // Restore valid HTML after the explicit missing-CSP mutation.
 cpSync(path.join(temp,'public/index.html'),path.join(target,'index.html'));
 // Real deterministic bundle verification, intentionally excluded from the
 // lightweight fixture checks above, must reject byte-level tampering.
 writeFileSync(path.join(temp,'src/main.ts'),'console.log("security fixture app entry");');
 mkdirSync(path.join(temp,'scripts'));
 for(const filename of ['msal-entry.mjs','msal-redirect-bridge.mjs'])
   writeFileSync(path.join(temp,'scripts',filename),'export function mockEntry(){return "fixture test";}');
 writeFileSync(path.join(temp,'package.json'),JSON.stringify({version:'1.1.1',type:'module'}));
 execFileSync('git',['init','-q'],{cwd:temp});
 execFileSync('git',['add','public/index.html'],{cwd:temp});
 const out=await build({entryPoints:[path.join(temp,'src/main.ts')],outdir:target,entryNames:'[name]',
   bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
 writeFileSync(path.join(target,'main.js'),out.outputFiles[0].contents);
 for(const [entry,destination] of [
  ['msal-entry.mjs','vendor/msal/msal-browser.bundle.js'],
  ['msal-redirect-bridge.mjs','auth/redirect-bridge.js'],
 ]){
   const built=await build({entryPoints:[path.join(temp,'scripts',entry)],bundle:true,
     format:'esm',platform:'browser',target:'es2022',minify:true,write:false,logLevel:'silent'});
   writeFileSync(path.join(target,destination),built.outputFiles[0].contents);
 }
 const label='v1.1.1 · 2026/11/22 17:40:11 · local';
 writeFileSync(path.join(target,'build-info.js'),
   `document.querySelectorAll('[data-build-version]').forEach(el => { el.textContent = ${JSON.stringify(label)}; el.title = 'このブラウザが読み込んでいるPayrollのビルド情報'; });\n`);
 const verify=async()=>await auditDist({root:temp,verifyBundles:true,requirePrivateTerms:true});
 assert.deepEqual((await verify()).problems,[],'complete legitimate build must pass');
 for(const filename of ['main.js','vendor/msal/msal-browser.bundle.js','auth/redirect-bridge.js','build-info.js']){
  const file=path.join(target,filename),original=readFileSync(file);
  try{
   writeFileSync(file,Buffer.concat([original,Buffer.from('\n;console.log("tamper")')]));
   assert.ok((await verify()).problems.length>0,`${filename} tampering must fail with verifyBundles:true`);
  }finally{writeFileSync(file,original);}
 }
 assert.deepEqual((await verify()).problems,[],'complete build restored after mutations');
}finally{
 if(prevB64===undefined)delete process.env.PAYROLL_PRIVATE_TERMS_B64;
 else process.env.PAYROLL_PRIVATE_TERMS_B64=prevB64;
 rmSync(temp,{recursive:true,force:true});
}
console.log('PASS: CI bypass mutation and Pages artifact tampering are rejected');

// A formerly tracked, subsequently deleted secret must still be detected from
// Git history, even when the current worktree and index contain no secret.
const historyRoot=mkdtempSync(path.join(os.tmpdir(),'payroll-history-terms-'));
try{
 const git=(...args)=>execFileSync('git',args,{cwd:historyRoot,stdio:'pipe'});
 git('init','-q');
 const hidden='historical-test-only-marker';
 writeFileSync(path.join(historyRoot,'retired.txt'),hidden);
 git('add','retired.txt');
 const commit=()=>git('-c','user.name=Fixture','-c','user.email='+['fixture','example.invalid'].join(String.fromCharCode(64)),
   'commit','-qm','synthetic fixture');
 commit();
 rmSync(path.join(historyRoot,'retired.txt'));git('add','-u');commit();
 const hit=scanGitHistoryTerms(historyRoot,[hidden]);
 assert.ok(hit.findings.length>0,'deleted historical secret is blocked');
 assert.ok(hit.findings.every(message=>!message.includes(hidden)),'private value never appears in log');
 assert.equal(scanGitHistoryTerms(historyRoot,['definitely-not-present']).findings.length,0);
}finally{rmSync(historyRoot,{recursive:true,force:true});}
console.log('PASS: full bundle hashes, build-info injection, historical private-term blobs');
