/**
 * Search all reachable historical Git *blobs* for the locally supplied private
 * dictionary, including files which were subsequently removed. No raw matches
 * or path names are printed. Commit author metadata is deliberately separate.
 */
import {execFileSync} from 'node:child_process';
const textFile=/(?:^|\/)(?:[^/]+\.(?:ts|tsx|mjs|cjs|js|json|md|html|css|yml|yaml|xml|txt|sh|py)|\.gitignore|\.gitleaksignore)$/i;
const fatalDecoder=new TextDecoder('utf-8',{fatal:true});
export function scanGitHistoryTerms(root,dictionary){
  if(!dictionary.length)return {scanned:0,findings:[]};
  const command=(args,options={})=>execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024,...options});
  const entries=command(['rev-list','--objects','--all'],{encoding:'utf8'}).split('\n')
    .map(row=>/^([a-f\d]{40})\s+(.+)$/.exec(row))
    .filter(match=>match && textFile.test(match[2]));
  const unique=new Map(entries.map(match=>[match[1],match[2]]));
  const ids=[...unique.keys()];
  if(!ids.length)return {scanned:0,findings:[]};
  const types=command(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {input:ids.join('\n')+'\n',encoding:'utf8'}).trim().split('\n');
  const lowered=dictionary.map(x=>x.toLocaleLowerCase('ja'));
  const findings=[];
  let scanned=0;
  for(const row of types){
    const match=/^([a-f\d]{40}) blob (\d+)$/.exec(row);
    if(!match)continue;
    const [,id,size]=match;
    // Source text over this limit is unsafe to inspect under the bounded audit.
    // Fail closed instead of silently declaring a historical blob safe.
    if(Number(size)>8*1024*1024){findings.push(`Git履歴に検査上限を超えるテキストblob：${id.slice(0,12)}（内容非表示）`);continue;}
    const bytes=command(['cat-file','blob',id]);
    let body;
    try{body=fatalDecoder.decode(bytes);}catch{findings.push(`Git履歴のテキストblobを解釈できません：${id.slice(0,12)}（内容非表示）`);continue;}
    scanned++;
    const normalized=body.toLocaleLowerCase('ja');
    const pathname=unique.get(id).toLocaleLowerCase('ja');
    if(lowered.some(term=>normalized.includes(term)||pathname.includes(term)))
      findings.push(`Git履歴の過去ファイルに個別禁止語句が存在：blob ${id.slice(0,12)}（値・ファイル名非表示）`);
  }
  return {scanned,findings};
}
