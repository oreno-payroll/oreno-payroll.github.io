/**
 * Audit the exact reviewed CI workflow. Any YAML alteration fails closed.
 * The baseline digest is updated ONLY after reviewing the entire workflow,
 * including its PR merge security job and deployment dependency graph.
 * This is intentionally stricter than an incomplete YAML subset parser.
 */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export const REVIEWED_WORKFLOW_SHA256='c3d753eea3e5a4fc6f06f111a3a6c2639d51852eb0b07f47a43f8bd384cec6ff';
export const REQUIRED_STATUS_CHECK='security';
const sha256=source=>createHash('sha256').update(source,'utf8').digest('hex');

export function auditWorkflow(source){
  const errors=[];
  if(sha256(source)!==REVIEWED_WORKFLOW_SHA256)
    errors.push('CI YAML is not byte-for-byte identical to the reviewed security workflow');
  // Independent intent checks make the protected security contract explicit.
  for(const [description,test] of [
    ['PR trigger to main',/^  pull_request:\n    branches: \[main\]$/m],
    ['push trigger to main',/^  push:\n    branches: \[main\]$/m],
    ['required security job',/^  security:\n    name: security\n    runs-on: ubuntu-latest$/m],
    ['no PR event filter',/^  pull_request:\n    branches: \[main\]$/m],
    ['PR merge tree verifier',/run: node scripts\/audit-pr-target\.mjs/],
    ['complete secret history scanner',/run: gitleaks git --log-opts=--all --redact --no-banner \./],
    ['npm vulnerability scanner',/run: npm audit --audit-level=high/],
    ['complete regression tests',/run: npm test/],
    ['Chromium installation',/run: npx playwright install --with-deps chromium/],
    ['headless E2E gate',/run: npm run test:e2e/],
    ['distribution integrity audit',/run: node scripts\/audit-dist\.mjs$/m],
    ['isolated main-only audit environment',/^  private_audit:\n    name: private-audit\n    needs: security\n    if: github\.ref == 'refs\/heads\/main' && .*\n    runs-on: ubuntu-latest\n[^\n]*\n    environment: payroll-private-audit$/m],
    ['encrypted-only intermediate',/python3 scripts\/audit-private-artifact\.py seal dist/],
    ['private exact-artifact validation',/python3 scripts\/audit-private-artifact\.py audit-open/],
    ['private dictionary source check',/run: node scripts\/audit-private-data\.mjs --no-gitleaks --skip-current-author --require-private-terms/],
    ['deploy depends on both audits',/^  deploy:\n    needs: \[security, private_audit\]\n    if: \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'$/m],
  ]){
    if(!test.test(source))errors.push('CI protection missing: '+description);
  }
  if((source.match(/^  security:$/gm)||[]).length!==1)errors.push('exactly one required security job expected');
  if((source.match(/^  deploy:$/gm)||[]).length!==1)errors.push('exactly one deployment job expected');
  if((source.match(/^        run: node scripts\/audit-dist\.mjs$/gm)||[]).length!==2)
    errors.push('both pre-test and final post-E2E distribution audits are mandatory');
  const split=source.indexOf('  private_audit:\n');
  const deploy=source.indexOf('  deploy:\n');
  const publicJob=source.slice(0,split),privateJob=source.slice(split,deploy);
  if(split<0||deploy<=split||/secrets\./.test(publicJob)||/secrets\./.test(source.slice(deploy)))errors.push('Secrets are forbidden outside the isolated audit job');
  if(/(?:npm (?:ci|run|test|exec)|npx |cache:|pull_request_target)/.test(privateJob))errors.push('private audit must not run candidate build or restore dependency cache');
  if((privateJob.match(/PAYROLL_PRIVATE_TERMS_B64: \$\{\{ secrets\.PAYROLL_PRIVATE_TERMS_B64 \}\}/g)||[]).length!==2)errors.push('private dictionary audits are mandatory');
  if(!privateJob.includes('path: ${{ runner.temp }}/payroll-audited-pages'))errors.push('only privately validated Pages output may upload');
  const e2e=source.indexOf('      - name: Headless Chromium end-to-end regression tests');
  const finalAudit=source.indexOf('      - name: Re-audit Pages distribution immediately before artifact upload');
  const upload=source.indexOf('      - name: Upload exactly the audited Pages build');
  const seal=source.indexOf('      - name: Seal exact build for isolated main audit');
  if(e2e<0||finalAudit<=e2e||seal<=finalAudit||split<=seal||upload<=split)errors.push('final Pages integrity audit must occur after E2E and before upload');
  // Pinned Actions and exact scripts are guaranteed by the complete SHA-256;
  // see scripts/test-security-pipeline.mjs for deliberate mutation tests.
  return errors;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const staged=process.argv.includes('--staged');
  const yaml=staged?execFileSync('git',['show',':.github/workflows/deploy.yml'],{cwd:root,encoding:'utf8'}):
    readFileSync(path.join(root,'.github/workflows/deploy.yml'),'utf8');
  const errors=auditWorkflow(yaml);
  for(const err of errors)console.error('NG: '+err);
  if(errors.length)process.exitCode=1;
  else console.log('[CI構造監査] PASS: PR security, main-only isolated private audit, encrypted handoff, reviewed YAML digest');
}
