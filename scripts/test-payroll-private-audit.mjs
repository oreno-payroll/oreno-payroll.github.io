/** Synthetic history and sealed artifact tests; never use live keys or payroll data. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanGitHistoryTerms} from './audit-git-history-terms.mjs';
import {auditWorkflow} from './audit-ci-workflow.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const tmp=mkdtempSync(path.join(os.tmpdir(),'payroll-private-audit-test-'));
const marker='synthetic-forbidden-audit-marker';
try{
 const repo=path.join(tmp,'repo');mkdirSync(repo);
 const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 git('init','-q');
 const commit=message=>{git('add','-A');git('-c','user.name=Fixture','-c','user.email='+['fixture','example.invalid'].join(String.fromCharCode(64)),'commit','-qm',message);};
 writeFileSync(path.join(repo,'ordinary.txt'),'ordinary');commit('ordinary commit');
 assert.deepEqual(scanGitHistoryTerms(repo,[marker]).findings,[]);
 renameSync(path.join(repo,'ordinary.txt'),path.join(repo,marker+'.txt'));commit('renamed same content');
 renameSync(path.join(repo,marker+'.txt'),path.join(repo,'ordinary.txt'));commit(marker);
 writeFileSync(path.join(repo,'removed.pdf'),'%PDF-1.7\nsynthetic');
 writeFileSync(path.join(repo,'disguised.txt'),'%PDF-1.7\nsynthetic');
 symlinkSync('ordinary.txt',path.join(repo,'link.txt'));commit('invalid formats');
 for(const name of ['removed.pdf','disguised.txt','link.txt'])rmSync(path.join(repo,name));commit('removed');
 const hits=scanGitHistoryTerms(repo,[marker]);
 for(const label of ['過去パス','コミットメッセージ','不許可の形式','非テキスト形式'])assert.ok(hits.findings.some(s=>s.includes(label)),label);
 assert.ok(hits.findings.every(s=>!s.includes(marker)&&!s.includes('removed.pdf')));
 assert.ok(scanGitHistoryTerms(repo,[]).findings.some(s=>s.includes('不許可の形式')),'format gate runs on secretless PR');
 // A detached HEAD commit is checked even if no branch points at it.
 git('checkout','--detach');writeFileSync(path.join(repo,'detached.txt'),marker);commit('detached');
 assert.ok(scanGitHistoryTerms(repo,[marker]).findings.some(s=>s.includes('過去ファイル')));
 console.log('PASS: complete history trees, aliases, commit messages, deleted binaries, special modes and detached commits');

 const workflow=readFileSync(path.join(root,'.github/workflows/deploy.yml'),'utf8');
 assert.deepEqual(auditWorkflow(workflow),[]);
 for(const [before,after] of [
  ['    environment: payroll-private-audit','    environment: wrong-environment'],
  ['        run: npm ci','        env:\n          TEST: ${{ secrets.PAYROLL_PRIVATE_TERMS_B64 }}\n        run: npm ci'],
  ['          path: ${{ runner.temp }}/payroll-build.cms','          path: dist'],
  ['          path: ${{ runner.temp }}/payroll-audited-pages','          path: dist'],
  ['      - name: Authenticate decrypt and privately audit the exact build as data','      - name: bypass private audit'],
  ['    needs: [security, private_audit]','    needs: security'],
  ["    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event_name == 'schedule')","    if: always()"],
 ]){
  assert.ok(workflow.includes(before));assert.ok(auditWorkflow(workflow.replace(before,after)).length);
 }
 console.log('PASS: secret isolation and encrypted-only artifact workflow bypasses rejected');

 const openssl=process.env.PAYROLL_AUDIT_OPENSSL||['/opt/homebrew/opt/openssl@3/bin/openssl','/usr/local/opt/openssl@3/bin/openssl'].find(existsSync)||'openssl';
 const pem=path.join(tmp,'fixture-cert.pem'),key=path.join(tmp,'fixture-key.pem');
 execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-sha256','-days','1','-nodes','-subj','/CN=Payroll Synthetic Test/','-keyout',key,'-out',pem],{stdio:'ignore'});
 const env={...process.env,PAYROLL_AUDIT_OPENSSL:openssl,PAYROLL_AUDIT_CERT_B64:readFileSync(pem).toString('base64'),PAYROLL_AUDIT_ARTIFACT_KEY_B64:readFileSync(key).toString('base64'),PAYROLL_PRIVATE_TERMS_B64:Buffer.from(marker).toString('base64')};
 const run=(args,overrides={})=>spawnSync('python3',[path.join(root,'scripts/audit-private-artifact.py'),...args],{encoding:'utf8',env:{...env,...overrides}});
 const digest=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
 const good=path.join(tmp,'good');mkdirSync(good);writeFileSync(path.join(good,'index.html'),'ordinary synthetic page');
 const sealed=path.join(tmp,'sealed.cms');assert.equal(run(['seal',good,sealed],{PAYROLL_PRIVATE_TERMS_B64:'',PAYROLL_AUDIT_ARTIFACT_KEY_B64:''}).status,0);
 assert.ok(!readFileSync(sealed).includes(Buffer.from('ordinary synthetic page')));
 const verified=path.join(tmp,'verified');assert.equal(run(['audit-open',sealed,verified,digest(sealed)]).status,0);
 assert.deepEqual(readFileSync(path.join(verified,'index.html')),readFileSync(path.join(good,'index.html')));
 const expectReject=(f,hash,overrides={})=>{
  const target=path.join(tmp,'rejected');const result=run(['audit-open',f,target,hash],overrides);
  assert.equal(result.status,1);assert.ok(!existsSync(target));assert.ok(!(`${result.stdout}${result.stderr}`).includes(marker));
 };
 expectReject(sealed,'0'.repeat(64));expectReject(sealed,digest(sealed),{PAYROLL_PRIVATE_TERMS_B64:''});
 expectReject(sealed,digest(sealed),{PAYROLL_AUDIT_ARTIFACT_KEY_B64:''});
 const corrupt=path.join(tmp,'corrupt.cms'),bytes=readFileSync(sealed);bytes[bytes.length-30]^=1;writeFileSync(corrupt,bytes);expectReject(corrupt,digest(corrupt));
 writeFileSync(path.join(good,'index.html'),marker);
 const bad=path.join(tmp,'bad.cms');assert.equal(run(['seal',good,bad]).status,0);expectReject(bad,digest(bad));
 writeFileSync(path.join(good,'index.html'),'ordinary');writeFileSync(path.join(good,marker+'.txt'),'ordinary');
 const badName=path.join(tmp,'bad-name.cms');assert.equal(run(['seal',good,badName]).status,0);expectReject(badName,digest(badName));
 rmSync(path.join(good,marker+'.txt'));symlinkSync('index.html',path.join(good,'bad-link'));
 assert.equal(run(['seal',good,path.join(tmp,'link.cms')]).status,1);
 // An independently encrypted malicious archive is not treated as safe merely
 // because it has a valid cryptographic envelope. No archive member is executed.
 for(const kind of ['traversal','link','duplicate']){
  const tar=path.join(tmp,kind+'.tar'),cipher=path.join(tmp,kind+'.cms');
  execFileSync('python3',['-c',`import io,sys,tarfile\nwith tarfile.open(sys.argv[1],'w') as t:\n for n in (['../escape'] if sys.argv[2]=='traversal' else ['index.html','index.html'] if sys.argv[2]=='duplicate' else ['index.html']):\n  i=tarfile.TarInfo(n);i.size=1\n  if sys.argv[2]=='link':\n   i.type=tarfile.SYMTYPE;i.linkname='../escape';i.size=0;t.addfile(i)\n  else:t.addfile(i,io.BytesIO(b'x'))`,tar,kind]);
  execFileSync(openssl,['cms','-encrypt','-binary','-aes-256-gcm','-in',tar,'-outform','DER','-out',cipher,'-recip',pem,'-keyopt','rsa_padding_mode:oaep','-keyopt','rsa_oaep_md:sha256'],{stdio:'ignore'});
  expectReject(cipher,digest(cipher));
 }
 assert.ok(!existsSync(path.join(tmp,'escape')));
 console.log('PASS: encrypted round-trip, missing keys/terms, ciphertext tamper, private content/path, traversal, symlink and duplicate members');
}finally{rmSync(tmp,{recursive:true,force:true});}
