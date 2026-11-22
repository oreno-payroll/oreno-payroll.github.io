/** PR security tests must evaluate the actual merged tree, not the PR head. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyCheckoutAndPin} from './audit-pr-target.mjs';
const dir=mkdtempSync(path.join(os.tmpdir(),'payroll-ci-merge-test-'));
try{
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  git('init','-q','--initial-branch=main');
  git('config','user.name','Fixture');
  git('config','user.email',['fixture','example.invalid'].join(String.fromCharCode(64)));
  writeFileSync(path.join(dir,'README.md'),'base');
  git('add','.');git('commit','-qm','base');
  git('switch','-q','-c','feature');
  writeFileSync(path.join(dir,'feature.txt'),'feature');
  git('add','.');git('commit','-qm','feature');
  const head=git('rev-parse','HEAD');
  git('switch','-q','main');
  writeFileSync(path.join(dir,'base.txt'),'more main');
  git('add','.');git('commit','-qm','main update');
  const base=git('rev-parse','HEAD');
  git('merge','--no-ff','-qm','synthetic PR merge','feature');
  const sha=git('rev-parse','HEAD');
  const file=path.join(dir,'event.json');
  writeFileSync(file,JSON.stringify({pull_request:{base:{sha:base},head:{sha:head}}}));
  const env={GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/1/merge',GITHUB_SHA:sha,GITHUB_EVENT_PATH:file};
  assert.equal(verifyCheckoutAndPin({cwd:dir,env}).sha,sha);
  assert.equal(git('rev-parse','refs/payroll-ci/audited'),sha,'PR merge must be part of --all history');
  assert.throws(()=>verifyCheckoutAndPin({cwd:dir,env:{...env,GITHUB_REF:'refs/heads/feature'}}),/synthetic merge ref/);
  assert.throws(()=>verifyCheckoutAndPin({cwd:dir,env:{...env,GITHUB_SHA:head}}),/SHA differs/);
  writeFileSync(file,JSON.stringify({pull_request:{base:{sha:head},head:{sha:base}}}));
  assert.throws(()=>verifyCheckoutAndPin({cwd:dir,env}),/exact base \+ head/);
  assert.equal(verifyCheckoutAndPin({cwd:dir,env:{...env,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main'}}).event,'push');
  console.log('PASS: GitHub synthetic PR merge verified, included in full Git history, fake checkouts rejected');
}finally{rmSync(dir,{recursive:true,force:true});}
