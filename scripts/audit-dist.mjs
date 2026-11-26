/** Fail-closed manifest audit of the *actual* GitHub Pages artifact. */
import {lstatSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {findSensitiveContent} from './audit-rules.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const utf8=bytes=>bytes.toString('utf8');
const textExt=/\.(?:html|css|js|mjs|json|svg|txt|map)$/i;
function walk(dir,prefix=''){
  if(!existsSync(dir))throw new Error(`必要な配信ディレクトリがありません: ${prefix||'dist'}`);
  const files=[];
  for(const ent of readdirSync(dir,{withFileTypes:true})){
    const rel=path.posix.join(prefix,ent.name);
    const abs=path.join(dir,ent.name);
    const st=lstatSync(abs);
    if(st.isSymbolicLink())throw new Error(`シンボリックリンクは禁止: ${rel}`);
    if(st.isDirectory())files.push(...walk(abs,rel));
    else if(st.isFile())files.push(rel);
    else throw new Error(`通常ファイル以外は禁止: ${rel}`);
  }
  return files;
}
function terms(){
  const encoded=process.env.PAYROLL_PRIVATE_TERMS_B64;
  let content='';
  if(encoded!==undefined){
    if(!encoded||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length%4)throw new Error('非公開語句のCI Secretが未設定・形式不正です');
    const raw=Buffer.from(encoded,'base64');
    if(raw.toString('base64')!==encoded)throw new Error('非公開語句のCI Secretが不正です');
    content=raw.toString('utf8');
  }else{
    const local=process.env.PAYROLL_PRIVATE_TERMS_FILE||path.join(os.homedir(),'.config/payroll/private-terms.txt');
    if(existsSync(local))content=readFileSync(local,'utf8');
  }
  return content.split(/\r?\n/).map(x=>x.trim()).filter(x=>x.length>=3&&!x.startsWith('#'));
}
export async function auditDist({root=project,requirePrivateTerms=false,verifyBundles=true}={}){
  const publicDir=path.join(root,'public');
  const dist=path.join(root,'dist');
  const npmPdf=path.join(root,'node_modules/pdfjs-dist');
  const expected=new Map();
  const requiredPublic=walk(publicDir);
  // A hidden/untracked PDF inside public/ must NEVER become trusted merely
  // because build.mjs copied it into dist/. Only reviewed, Git-tracked assets.
  const tracked=verifyBundles?new Set(execFileSync('git',['ls-files','-z','--','public'],{cwd:root})
    .toString('utf8').split('\0').filter(Boolean)):new Set(requiredPublic.map(rel=>'public/'+rel));
  const approvedPublic=rel=>/^(?:[^/]+\/)*[^/]+\.(?:html|css)$/.test(rel)||
    ['release-notes.json','favicon.ico','apple-touch-icon.png','view/pdf-sw.js','payroll-cloud-session.js','frame-guard.js'].includes(rel);
  for(const rel of requiredPublic){
    if(!tracked.has('public/'+rel)||!approvedPublic(rel)){
      throw new Error(`未追跡または不許可の公開元ファイル: public/${rel}`);
    }
    expected.set(rel,{origin:path.join(publicDir,rel),kind:'copy'});
  }
  const worker='pdf.worker.min.mjs';
  expected.set(worker,{origin:path.join(npmPdf,'build',worker),kind:'copy'});
  for(const dir of ['cmaps','standard_fonts','wasm','iccs']){
    for(const rel of walk(path.join(npmPdf,dir),dir))expected.set(rel,{origin:path.join(npmPdf,rel),kind:'copy'});
  }
  for(const filename of readdirSync(path.join(root,'src')).filter(x=>/\.ts$/.test(x)&&!x.endsWith('.d.ts'))){
    expected.set(filename.replace(/\.ts$/,'.js'),{kind:'generated'});
  }
  for(const f of ['build-info.js','vendor/msal/msal-browser.bundle.js','auth/redirect-bridge.js']){
    if(expected.has(f))throw new Error(`生成物パスの重複: ${f}`);
    expected.set(f,{kind:'generated'});
  }
  const actual=walk(dist);
  const observed=new Set(actual);
  const problems=[];
  for(const rel of actual)if(!expected.has(rel))problems.push(`未知の配信ファイル: ${rel}`);
  for(const [rel,rule] of expected){
    if(!observed.has(rel)){problems.push(`配信ファイルが欠落: ${rel}`);continue;}
    const bytes=readFileSync(path.join(dist,rel));
    if(bytes.length===0)problems.push(`空の配信ファイル: ${rel}`);
    if(bytes.length>30*1024*1024)problems.push(`異常に大きな配信ファイル: ${rel}`);
    if(rule.kind==='copy'){
      if(sha(bytes)!==sha(readFileSync(rule.origin)))problems.push(`ソースと異なる配信ファイル: ${rel}`);
    }else if(bytes.length<20)problems.push(`生成されたコードが短すぎます: ${rel}`);
    // Third-party MSAL contains numeric protocol constants resembling phone numbers.
    // Its bytes are verified by deterministic npm-based recompilation below.
    if(rule.kind==='generated'&&textExt.test(rel)&&rel!=='vendor/msal/msal-browser.bundle.js'){
      const code=utf8(bytes);
      for(const label of findSensitiveContent(code))problems.push(`生成コードに機密情報らしい内容(${label}): ${rel}`);
    }
    if(/\.html$/.test(rel)){
      const html=utf8(bytes);
      if(!/http-equiv=["']Content-Security-Policy["']/i.test(html))problems.push(`CSPがありません: ${rel}`);
      if(/<script\b[^>]*\bsrc=["']https?:\/\//i.test(html))problems.push(`外部JavaScript参照: ${rel}`);
    }
  }
  // Compile again from the exact npm dependencies and source entries. A correctly
  // named (or large) JavaScript file is NOT sufficient; its bytes must match.
  if(verifyBundles){
    const {build}=await import('esbuild');
    const entryPoints=readdirSync(path.join(root,'src'))
      .filter(x=>x.endsWith('.ts')&&!x.endsWith('.d.ts'))
      .map(x=>path.join(root,'src',x));
    const outputs=await build({entryPoints,outdir:dist,entryNames:'[name]',bundle:true,
      format:'esm',platform:'browser',target:'es2022',logLevel:'silent',write:false});
    for(const output of outputs.outputFiles){
      const rel=path.relative(dist,output.path).split(path.sep).join('/');
      if(!observed.has(rel)||sha(readFileSync(path.join(dist,rel)))!==sha(output.contents))
        problems.push(`ソースの再ビルドと異なるアプリJS: ${rel}`);
    }
    for(const [entry,rel] of [
      ['scripts/msal-entry.mjs','vendor/msal/msal-browser.bundle.js'],
      ['scripts/msal-redirect-bridge.mjs','auth/redirect-bridge.js'],
    ]){
      const output=await build({entryPoints:[path.join(root,entry)],bundle:true,
        format:'esm',platform:'browser',target:'es2022',minify:true,logLevel:'silent',write:false});
      if(output.outputFiles.length!==1||!observed.has(rel)||
        sha(readFileSync(path.join(dist,rel)))!==sha(output.outputFiles[0].contents))
        problems.push(`npm固定依存からの再ビルドと異なるMSALコード: ${rel}`);
    }
    const buildLabel=utf8(readFileSync(path.join(dist,'build-info.js')));
    const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
    // Require the exact two statements emitted by build.mjs, not a substring.
    const prefix=`document.querySelectorAll('[data-build-version]').forEach(el => { el.textContent = ${JSON.stringify(`v${version}`)}; });\n`+
      "document.querySelectorAll('[data-build-details]').forEach(el => { el.textContent = ";
    const suffix="; el.title = 'このブラウザが読み込んでいるPayrollのビルド情報'; });\n";
    let approved=false;
    if(buildLabel.startsWith(prefix)&&buildLabel.endsWith(suffix)&&buildLabel.length<=1024){
      const literal=buildLabel.slice(prefix.length,-suffix.length);
      try{
        const label=JSON.parse(literal);
        if(typeof label==='string' && literal===JSON.stringify(label) &&
          /^\d{4}[/.-]\d{1,2}[/.-]\d{1,2} \d{1,2}:\d{2}:\d{2} · (?:local|[0-9a-f]{7,40})$/.test(label)){
          let head='local';
          try{head=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
          approved=label.endsWith(` · ${head}`) &&
            buildLabel===prefix+JSON.stringify(label)+suffix;
        }
      }catch{}
    }
    if(!approved)problems.push('ビルド識別子に想定外のコードが含まれています');
  }
  const dictionary=terms();
  if(requirePrivateTerms&&!dictionary.length)problems.push('個別禁止語句が未設定のためdist監査を完了できません');
  if(dictionary.length){
    for(const rel of actual){
      if(!textExt.test(rel))continue;
      const code=utf8(readFileSync(path.join(dist,rel))).toLocaleLowerCase('ja');
      if(dictionary.some(term=>code.includes(term.toLocaleLowerCase('ja'))))problems.push(`個別禁止語句を含む配信ファイル: ${rel}`);
    }
  }
  return {count:actual.length,problems};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=await auditDist({requirePrivateTerms:process.argv.includes('--require-private-terms')});
    for(const p of result.problems)console.error('NG: '+p);
    if(result.problems.length)process.exitCode=1;
    else console.log(`[dist監査] PASS: 配信${result.count}ファイル、許可リスト・完全コピー照合・生成コード・CSP・個人情報`);
  }catch(e){console.error('[dist監査] NG: '+e.message);process.exitCode=1;}
}
