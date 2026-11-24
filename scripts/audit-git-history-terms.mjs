/** Read every reachable commit tree, every distinct pathname and text blob, and
 * commit subjects/bodies. Never print untrusted paths or matched dictionary terms. */
import {execFileSync} from 'node:child_process';
const textFile=/\.(?:ts|tsx|mjs|cjs|js|json|md|html|css|yml|yaml|xml|txt|sh|py)$/i;
const textSpecial=new Set(['.gitignore','.gitleaksignore','.githooks/pre-commit','.githooks/pre-push']);
// Reviewed binary assets only; a historical filename alone is not authorization.
const approvedIcons=new Map([
 ['public/favicon.ico','84117581fc615f7e9b2906a9e7da76faa9653cd4'],
 ['public/apple-touch-icon.png','6c6b6ba16012e26aed9cee88e2c5bb131824d2dc'],
]);
const decoder=new TextDecoder('utf-8',{fatal:true});
export function scanGitHistoryTerms(root,dictionary){
 const command=(args,options={})=>execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024,...options});
 const lowered=dictionary.map(x=>x.toLocaleLowerCase('ja'));
 const matches=s=>lowered.some(term=>s.toLocaleLowerCase('ja').includes(term));
 const findings=[],trees=new Set(),textBlobs=new Set(),paths=new Set(),badEntries=new Set();
 const commits=command(['rev-list','--all','HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 let scanned=0;
 for(const commit of commits){
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('invalid commit ID');
  const obj=decoder.decode(command(['cat-file','commit',commit]));
  const split=obj.indexOf('\n\n');
  const tree=/^tree ([a-f0-9]{40})$/m.exec(obj.slice(0,split))?.[1];
  if(split<0||!tree)throw Error('invalid commit object');
  if(matches(obj.slice(split+2)))findings.push(`Git履歴のコミットメッセージに個別禁止語句：${commit.slice(0,12)}（値非表示）`);
  if(trees.has(tree))continue;
  trees.add(tree);
  for(const entry of decoder.decode(command(['ls-tree','-r','-z',tree])).split('\0').filter(Boolean)){
   const parsed=/^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
   if(!parsed)throw Error('invalid tree entry');
   const [,mode,type,id,name]=parsed;
   if(!paths.has(name)){
    paths.add(name);
    if(matches(name))findings.push(`Git履歴の過去パスに個別禁止語句：${commit.slice(0,12)}（パス非表示）`);
   }
   const executableAllowed=/^\.githooks\/(?:pre-commit|pre-push)$/.test(name)||/^scripts\/[^/]+\.sh$/.test(name);
   const validMode=type==='blob'&&(mode==='100644'||(mode==='100755'&&executableAllowed));
   const icon=approvedIcons.get(name);
   if(!validMode || (icon ? mode!=='100644'||id!==icon : !textFile.test(name)&&!textSpecial.has(name))){
    const key=`${mode}:${id}:${name}`;
    if(!badEntries.has(key)){badEntries.add(key);findings.push(`Git履歴に不許可の形式・特殊ファイル：${id.slice(0,12)}（パス非表示）`);}
    continue;
   }
   if(!icon)textBlobs.add(id);
  }
 }
 // Batch-check object lengths before reading; fail closed on an unknown object.
 const ids=[...textBlobs];
 if(ids.length){
  const types=command(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],{input:ids.join('\n')+'\n',encoding:'utf8'}).trim().split('\n');
  if(types.length!==ids.length)throw Error('incomplete object inventory');
  for(let i=0;i<types.length;i++){
   const match=/^([a-f\d]{40}) blob (\d+)$/.exec(types[i]);
   if(!match||match[1]!==ids[i])throw Error('invalid blob inventory');
   const [,id,size]=match;
   if(Number(size)>8*1024*1024){findings.push(`Git履歴に検査上限を超えるテキストblob：${id.slice(0,12)}（内容非表示）`);continue;}
   let body;
   try{body=decoder.decode(command(['cat-file','blob',id]));}catch{findings.push(`Git履歴のテキストblobを解釈できません：${id.slice(0,12)}（内容非表示）`);continue;}
   if(body.includes('\0')||body.startsWith('%PDF-')||body.startsWith('PK\u0003\u0004')){
    findings.push(`Git履歴のテキストblobに非テキスト形式：${id.slice(0,12)}（内容非表示）`);continue;
   }
   scanned++;
   if(matches(body))findings.push(`Git履歴の過去ファイルに個別禁止語句が存在：blob ${id.slice(0,12)}（値・ファイル名非表示）`);
  }
 }
 return {scanned,commits:commits.length,paths:paths.size,findings};
}
