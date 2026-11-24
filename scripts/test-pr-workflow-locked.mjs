/** Mutations that could otherwise dodge GitHub's required security check. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditWorkflow,REQUIRED_STATUS_CHECK} from './audit-ci-workflow.mjs';
const original=readFileSync(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
assert.deepEqual(auditWorkflow(original),[]);
assert.equal(REQUIRED_STATUS_CHECK,'security');
const checks=[
  ['no pull_request event','  pull_request:\n    branches: [main]\n',''],
  ['PR paths-ignore filter','    branches: [main]\n  workflow_dispatch:',
    '    branches: [main]\n    paths-ignore: ["**/*.md"]\n  workflow_dispatch:'],
  ['rename required job','    name: security','    name: security-skipped'],
  ['skip required job','    name: security','    name: security\n    if: false'],
  ['fake test command','        run: npm test','        run: echo npm test'],
  ['skip tests via shell','        run: npm test','        run: npm test\n        shell: echo {0}'],
  ['skip tests via job defaults','    runs-on: ubuntu-latest','    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: echo {0}'],
  ['change Gitleaks to echo','        run: gitleaks git --log-opts=--all --redact --no-banner .',
    '        run: echo gitleaks git --log-opts=--all --redact --no-banner .'],
  ['use unpinned Action','actions/checkout@11d5960a326750d5838078e36cf38b85af677262','actions/checkout@v4'],
  ['disable PR merge verification','run: node scripts/audit-pr-target.mjs','run: echo verified'],
  ['skip artifact audit','run: node scripts/audit-dist.mjs','run: echo audited'],
  ['deploy without CI dependency','    needs: [security, private_audit]','    needs: arbitrary'],
  ['deploy on PR','&& github.ref == \'refs/heads/main\'','|| github.event_name == \'pull_request\''],
  ['tamper Gitleaks checksum', 'sha256sum --check --status','echo sha256sum --check --status'],
  ['disable PR by overriding concurrency','  cancel-in-progress: false','  cancel-in-progress: true'],
];
for(const [name,needle,replacement] of checks){
  assert.ok(original.includes(needle),`mutation fixture is stale: ${name}`);
  const bad=original.replace(needle,replacement);
  assert.notEqual(bad,original,`mutation must change source: ${name}`);
  assert.ok(auditWorkflow(bad).length>0,`security workflow must reject: ${name}`);
}
console.log(`PASS: ${checks.length} PR merge / required CI / deployment bypass mutations rejected`);
