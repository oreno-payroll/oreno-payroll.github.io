/** Fail if deploy can bypass privacy or secret scans. No external dependencies. */
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {auditWorkflow} from './audit-ci-workflow.mjs';
const workflow=readFileSync(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
const privacy=readFileSync(new URL('./audit-private-data.mjs',import.meta.url),'utf8');
assert.deepEqual(auditWorkflow(workflow),[],'CI command/step structure must be verifiably safe');
assert.match(workflow,/^  pull_request:\n    branches: \[main\]$/m,'PRs must run security before merging');
assert.match(workflow,/^  security:\n    name: security\n    runs-on: ubuntu-latest$/m,'required check context is security');
assert.match(workflow,/^  deploy:\n    needs: \[security, private_audit\]$/m,'Pages must depend on successful security job');
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
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b",
  "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa",
  "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
];
assert.deepEqual(actionRefs.sort(),approvedActions.sort(),'every external GitHub Action must be an explicitly reviewed full-length commit SHA');
for(const ref of actionRefs)assert.match(ref,/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/,'an Action must use a full 40-character commit SHA');
assert.match(workflow,/gitleaks_8\.30\.1_linux_x64\.tar\.gz/,'Gitleaks is pinned');
assert.match(workflow,/551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/,'archive digest must be checked');
assert.match(workflow,/node scripts\/audit-publish\.mjs/);
assert.match(workflow,/node scripts\/audit-private-data\.mjs --no-gitleaks --skip-current-author/);
assert.equal((workflow.match(/^        run: gitleaks git --log-opts=--all --redact --no-banner \.$/gm)||[]).length,1,'CI runs exactly one full history scan');
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

// Exercise the actual push hook and actual privacy/history audit in a synthetic
// repository. Gitleaks and the unrelated source/workflow checks are mocked.
const fixture=mkdtempSync(path.join(os.tmpdir(),'payroll-push-audit-'));
try{
 const repo=path.join(fixture,'repo'),bin=path.join(fixture,'bin'),calls=path.join(fixture,'calls');
 mkdirSync(path.join(repo,'scripts'),{recursive:true});mkdirSync(bin);
 for(const f of ['audit-private-data.mjs','audit-git-history-terms.mjs','verify-push-ref-policy.sh'])
   copyFileSync(new URL('./'+f,import.meta.url),path.join(repo,'scripts',f));
 for(const f of ['audit-publish.mjs','audit-ci-workflow.mjs'])
   writeFileSync(path.join(repo,'scripts',f),`import {appendFileSync} from 'node:fs';appendFileSync(process.env.FIXTURE_CALLS, '${f}\\n');process.exit(Number(process.env.${f==='audit-publish.mjs'?'FIXTURE_SOURCE_EXIT':'FIXTURE_WORKFLOW_EXIT'}||0));`);
 writeFileSync(path.join(repo,'scripts','audit-dist.mjs'),'process.exit(91);');
 const hook=path.join(repo,'pre-push');copyFileSync(new URL('../.githooks/pre-push',import.meta.url),hook);
 writeFileSync(path.join(bin,'gitleaks'),`#!/bin/bash
case "$1" in
 version) exit 0;;
 git) printf 'scan\\n' >> "$FIXTURE_CALLS"; exit "${'${FIXTURE_SCAN_EXIT:-0}'}";;
 *) exit 1;;
esac
`,{mode:0o755});
 writeFileSync(path.join(bin,'npm'),'#!/bin/bash\nexit 92\n',{mode:0o755});
 const env={...process.env};
 for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
 Object.assign(env,{HOME:fixture,XDG_CONFIG_HOME:fixture,PATH:bin+path.delimiter+process.env.PATH,FIXTURE_CALLS:calls,GIT_CONFIG_NOSYSTEM:'1'});
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:repo,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');git('config','user.name','Fixture');git('config','user.email',['123+fixture','users.noreply.github.com'].join(String.fromCharCode(64)));
 const commit=message=>{git('add','ordinary.txt');git('commit','-qm',message);};
 writeFileSync(path.join(repo,'ordinary.txt'),'ordinary content');commit('initial synthetic data');
 const marker='synthetic-only-push-history-marker';
 const dictionary=Buffer.from(marker).toString('base64');
 const push=(overrides={},deletion=false,remote='refs/heads/feature/payroll-fixture')=>{
   writeFileSync(calls,'');
   const head=git('rev-parse','HEAD');
   const ref='refs/heads/feature/payroll-fixture';
   const result=spawnSync('bash',[hook],{cwd:repo,env:{...env,PAYROLL_PRIVATE_TERMS_B64:dictionary,...overrides},encoding:'utf8',input:deletion?`(delete) ${'0'.repeat(40)} ${ref} ${head}\n`:`${ref} ${head} ${remote} ${head}\n`});
   assert.ok(!result.error);assert.ok(!(result.stdout+result.stderr).includes(marker),'private marker is never emitted');
   const events=readFileSync(calls,'utf8').trim().split('\n').filter(Boolean);
   return {status:result.status,scans:events.filter(x=>x==='scan').length,source:events.filter(x=>x!=='scan')};
 };
 assert.deepEqual(push(),{status:0,scans:1,source:['audit-publish.mjs','audit-ci-workflow.mjs']},'source and history audit without rebuilding or npm on successful push');
 assert.deepEqual(push({},false,'refs/heads/main'),{status:1,scans:0,source:[]},'main direct push blocked before scanning');
 assert.deepEqual(push({FIXTURE_SOURCE_EXIT:'1'}),{status:1,scans:0,source:['audit-publish.mjs']},'source audit failure blocks push');
 assert.deepEqual(push({FIXTURE_WORKFLOW_EXIT:'1'}),{status:1,scans:1,source:['audit-publish.mjs','audit-ci-workflow.mjs']},'workflow audit failure blocks push');
 assert.deepEqual(push({FIXTURE_SCAN_EXIT:'1'}),{status:1,scans:1,source:['audit-publish.mjs']},'Gitleaks failure blocks push');
 assert.deepEqual(push({PAYROLL_PRIVATE_TERMS_B64:''}),{status:1,scans:1,source:['audit-publish.mjs']},'missing private dictionary blocks push');
 writeFileSync(path.join(repo,'ordinary.txt'),marker);commit('synthetic historical content');
 writeFileSync(path.join(repo,'ordinary.txt'),'ordinary content');commit('remove synthetic content');
 assert.deepEqual(push(),{status:1,scans:1,source:['audit-publish.mjs']},'removed private data in earlier commit still blocks push');
 assert.deepEqual(push({},true),{status:0,scans:0,source:[]},'safe ref deletion sends no source');
 console.log('PASS: source/history gate, no npm or dist checks at push, direct main and failed audits rejected, safe deletion unchanged');
}finally{rmSync(fixture,{recursive:true,force:true});}
