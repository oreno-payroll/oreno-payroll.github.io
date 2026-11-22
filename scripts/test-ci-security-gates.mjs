/** Fail if deploy can bypass privacy or secret scans. No external dependencies. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditWorkflow} from './audit-ci-workflow.mjs';
const workflow=readFileSync(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
const privacy=readFileSync(new URL('./audit-private-data.mjs',import.meta.url),'utf8');
assert.deepEqual(auditWorkflow(workflow),[],'CI command/step structure must be verifiably safe');
assert.match(workflow,/^  pull_request:\n    branches: \[main\]$/m,'PRs must run security before merging');
assert.match(workflow,/^  security:\n    name: security\n    runs-on: ubuntu-latest$/m,'required check context is security');
assert.match(workflow,/^  deploy:\n    needs: security$/m,'Pages must depend on successful security job');
assert.match(workflow,/node scripts\/audit-pr-target\.mjs/,'PR merge is checked, not just the branch tip');
assert.doesNotMatch(workflow,/pull_request_target:/,'untrusted PRs must never use privileged pull_request_target');

assert.match(workflow,/fetch-depth:\s*0/,'full history is required');
assert.match(workflow,/persist-credentials:\s*false/,'checkout should not leave a credential in .git/config');
// Freeze every external GitHub Action at its official 40-character commit SHA.
// An Action addition or version update must be reviewed and added to this allowlist.
const actionRefs=[...workflow.matchAll(/^[ \t]*uses:[ \t]*([^\s#]+)/gm)].map(match=>match[1]);
const approvedActions=[
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b",
  "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa",
  "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
];
assert.deepEqual(actionRefs.sort(),approvedActions.sort(),'every external GitHub Action must be an explicitly reviewed full-length commit SHA');
for(const ref of actionRefs)assert.match(ref,/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/,'an Action must use a full 40-character commit SHA');
assert.match(workflow,/gitleaks_8\.30\.1_linux_x64\.tar\.gz/,'Gitleaks is pinned');
assert.match(workflow,/551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/,'archive digest must be checked');
assert.match(workflow,/node scripts\/audit-publish\.mjs/);
assert.match(workflow,/node scripts\/audit-private-data\.mjs --strict-gitleaks --skip-current-author/);
assert.match(workflow,/gitleaks git --log-opts=--all --redact --no-banner \./);
assert.match(workflow,/npm audit --audit-level=high/);
const verify=workflow.indexOf('Full Git history Gitleaks audit');
const upload=workflow.indexOf('Upload exactly the audited Pages build');
assert.ok(verify>0&&upload>verify,'Gitleaks must gate the upload/deployment');
assert.doesNotMatch(workflow,/continue-on-error:\s*true/,'security checks must fail closed');
assert.doesNotMatch(workflow,/\|\|\s*true/,'security checks must not be silenced');
assert.match(privacy,/\['git',root,'--log-opts=--all'/,'CLI must use position argument, not removed --source');
assert.doesNotMatch(privacy,/\['git','--source'/);
assert.match(privacy,/if\(!flags\.has\('--skip-current-author'\)\)/,'only current CI author check may be skipped');
assert.match(privacy,/for\(const row of git\(\['log','--all'/,'Git author history remains inspected');
console.log('PASS: CI executes full privacy, Gitleaks and vulnerability scans before publishing');
