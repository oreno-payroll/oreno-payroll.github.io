/**
 * Verify that a pull_request run is checking GitHub's synthetic merge commit,
 * not just the contributor branch. Pin the checked commit as a local ref so
 * `git log --all` and Gitleaks include the synthetic PR merge in history scans.
 * Never pushes the ref or modifies the working tree.
 */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const shaPattern=/^[a-f0-9]{40}$/;
export function verifyCheckoutAndPin({cwd=root,env=process.env}={}){
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  const {GITHUB_EVENT_NAME:event,GITHUB_SHA:expected,GITHUB_REF:ref,GITHUB_EVENT_PATH:eventFile}=env;
  if(!['pull_request','push','workflow_dispatch','schedule'].includes(event))
    throw Error('unsupported GitHub event for the audited Payroll workflow');
  const actual=git('rev-parse','HEAD');
  if(!shaPattern.test(expected??'')||actual!==expected)
    throw Error('checked-out SHA differs from the triggering GitHub event');
  if(event==='pull_request'){
    if(!/^refs\/pull\/\d+\/merge$/.test(ref??''))
      throw Error('PR workflow must check out the GitHub synthetic merge ref');
    if(!eventFile)throw Error('GitHub event metadata is absent');
    const data=JSON.parse(readFileSync(eventFile,'utf8'));
    const base=data.pull_request?.base?.sha;
    const head=data.pull_request?.head?.sha;
    const parents=git('rev-list','--parents','-n','1','HEAD').split(' ');
    if(!shaPattern.test(base??'')||!shaPattern.test(head??'')||
        parents.length!==3||parents[0]!==expected||parents[1]!==base||parents[2]!==head)
      throw Error('PR must test the exact base + head synthetic merge commit');
  }else if(ref!=='refs/heads/main'){
    throw Error('push/manual/scheduled security runs must check the main branch');
  }
  git('update-ref','refs/payroll-ci/audited',actual);
  if(git('rev-parse','refs/payroll-ci/audited')!==actual)
    throw Error('PR merge commit could not be pinned for complete Git history scans');
  return {event,sha:actual};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const verified=verifyCheckoutAndPin();
    console.log(`[PR merge監査] PASS: ${verified.event} の検査対象をGit履歴スキャンに追加しました`);
  }catch(error){
    console.error('[PR merge監査] NG: '+error.message);
    process.exitCode=1;
  }
}
