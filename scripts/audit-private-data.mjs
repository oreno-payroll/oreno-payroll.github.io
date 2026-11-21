/** Supplemental privacy audit. Never print detected secrets, names or email addresses. */
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const flags=new Set(process.argv.slice(2));
const staged=flags.has('--staged'),working=flags.has('--working');
if(staged&&working)throw new Error('ステージ済みと作業ファイルは同時指定できません。');
const git=a=>execFileSync('git',a,{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});
const splitZ=s=>s.split('\0').filter(Boolean);
const privateFile=process.env.PAYROLL_PRIVATE_TERMS_FILE||path.join(os.homedir(),'.config/payroll/private-terms.txt');
const privateTerms=existsSync(privateFile)?readFileSync(privateFile,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s.length>=3&&!s.startsWith('#')):[];
const problems=[],notices=[];
const patterns=[
 ['口座番号らしい記載',/(?:口座(?:番号)?|振込先(?:口座)?|bank\s*account)\s*[：:=]\s*["']?\s*\d[\d\s-]{5,}\d/iu],
 ['従業員番号らしい記載',/(?:社員番号|従業員番号|employee\s*id)\s*[：:=]\s*["']?\s*[A-Z0-9-]{5,}/iu],
 ['金融機関番号らしい記載',/(?:銀行コード|支店コード|金融機関コード)\s*[：:=]\s*["']?\s*\d{3,4}/u],
];
let files=staged?splitZ(git(['diff','--cached','--name-only','--diff-filter=ACMR','-z'])):working?[...new Set([...splitZ(git(['diff','--name-only','--diff-filter=ACMR','-z'])),...splitZ(git(['ls-files','--others','--exclude-standard','-z']))])]:splitZ(git(['ls-files','-z']));
let scanned=0;
for(const f of files){
 if(!/\.(?:ts|tsx|mjs|js|json|md|html|css|yml|yaml|xml|txt|sh|py)$/i.test(f)||f.startsWith('public/vendor/'))continue;
 let body;try{body=staged?git(['show',`:${f}`]):readFileSync(path.join(root,f),'utf8');}catch{problems.push(`ファイルの取得不可：${f}`);continue;}
 scanned++;
 for(const [label,re] of patterns)if(re.test(body))problems.push(`${label}：${f}（値は非表示）`);
 for(const term of privateTerms)if(body.toLocaleLowerCase('ja').includes(term.toLocaleLowerCase('ja')))problems.push(`個別登録した非公開語句に一致：${f}（値は非表示）`);
}
const isPublicAuthor=(name,email)=>{
 const handle=/^[a-z0-9][a-z0-9_.-]{1,39}$/i;
 // Construct the address separator at runtime so the public-email scanner does not
 // mistake its own allowlist regex for a user's private email address.
 const noreply=new RegExp(String.raw`^(?:\d+\+)?[a-z0-9_.-]+`+String.fromCharCode(64)+String.raw`users\.noreply\.github\.com$`,'i');
 return (noreply.test(email)&&handle.test(name))||(name==='GitHub'&&email===['noreply','github.com'].join('@'))||(name==='github-actions[bot]'&&noreply.test(email));
};
if(!flags.has('--no-history')){
 const flagged=new Set();
 for(const row of git(['log','--all','--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00']).split('\n')){
  const [hash,an,ae,cn,ce]=row.split('\0');if(!/^[a-f0-9]{40}$/.test(hash??''))continue;
  if(!isPublicAuthor(an,ae)||!isPublicAuthor(cn,ce))flagged.add(hash.slice(0,12));
 }
 for(const sha of flagged)problems.push(`Git履歴の作者情報を要確認：${sha}（氏名・メール非表示）`);
 if(!flags.has('--skip-current-author')){
  const match=/^(.*?) <(.*?)> \d+ [+-]\d{4}$/.exec(git(['var','GIT_AUTHOR_IDENT']).trim());
  if(match&&!isPublicAuthor(match[1],match[2]))problems.push('次回コミットの作者情報が公開用ハンドル名＋GitHub noreply形式ではありません（値は非表示）');
 }
}
if(!flags.has('--no-gitleaks')){
 const probe=spawnSync('gitleaks',['version'],{stdio:'ignore'});
 if(probe.error?.code==='ENOENT'){
  const msg='Gitleaks未導入。brew install gitleaks 後に再実行してください。';
  (flags.has('--strict-gitleaks')?problems:notices).push(msg);
 }else if(probe.status!==0)problems.push('Gitleaksの起動に失敗しました。');
 else{
  const temp=mkdtempSync(path.join(os.tmpdir(),'payroll-audit-'));
  try{const r=spawnSync('gitleaks',['git',root,'--log-opts=--all','--redact','--no-banner','--report-format','json','--report-path',path.join(temp,'report.json')],{cwd:root,stdio:'ignore'});
   if(r.status!==0)problems.push('Gitleaksで検出またはスキャンエラー。検出値は非表示です。');
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
}
console.log(`[追加プライバシー監査] ${scanned}ソースファイルを検査しました。`);
for(const note of notices)console.warn('未実施: '+note);
for(const p of problems.slice(0,40))console.error('要確認: '+p);
if(problems.length>40)console.error(`ほか${problems.length-40}件（非表示）`);
if(problems.length){console.error(`NG: ${problems.length}件。Git履歴は変更していません。`);process.exitCode=1;}
else console.log('OK: 実施した項目はPASS（未導入の外部検査は別扱い）');
