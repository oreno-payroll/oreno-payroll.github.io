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
export const REVIEWED_WORKFLOW_SHA256='f99795dad9d8b04e2e2c038b196bc5cc899228d63941e64f7ad09fca942acd43';
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
    ['distribution integrity audit',/run: node scripts\/audit-dist\.mjs --require-private-terms/],
    ['deploy depends on security',/^  deploy:\n    needs: security\n    if: \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'$/m],
    ['secrets only read in security',/^  security:[\s\S]*?PAYROLL_PRIVATE_TERMS_B64: \$\{\{ secrets\.PAYROLL_PRIVATE_TERMS_B64 \}\}/m],
  ]){
    if(!test.test(source))errors.push('CI protection missing: '+description);
  }
  if((source.match(/^  security:$/gm)||[]).length!==1)errors.push('exactly one required security job expected');
  if((source.match(/^  deploy:$/gm)||[]).length!==1)errors.push('exactly one deployment job expected');
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
  else console.log('[CI構造監査] PASS: PR security job, merge ref audit, approved YAML digest, deploy dependency');
}
