/** The JSON is the only editable release history. Run from the regular build. */
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const read=name=>readFileSync(new URL(name,root),'utf8');
export const labels={features:'新機能',ux:'UI・UXの改善',fixes:'不具合修正',security:'セキュリティ・信頼性の向上',internal:'性能・内部処理の改善'};
const text=value=>typeof value==='string'&&value.trim().length>0&&!/[\r\n<>]/.test(value);
const link=value=>typeof value==='string'&&/^https:\/\/github\.com\/oreno-payroll\/oreno-payroll\.github\.io\/(?:pull\/[1-9]\d*|commit\/[a-f0-9]{40})$/.test(value);
export function generateChangelog(notes,version){
 if(!Array.isArray(notes)||!notes.length||notes[0]?.version!==version)throw new Error('リリース履歴の先頭とpackage.jsonの版番号が一致しません。');
 const lines=['# Payroll アップデート履歴','','<!-- public/release-notes.json から自動生成。手編集しない。 -->','','同じバージョンで複数の公開があった期間は、公開内容ごとに記載しています。日付は日本時間です。',''];
 const md=value=>value.replace(/[\\`*_\[\]#|]/g,'\\$&');
 for(const [i,n] of notes.entries()){
  if(!n||!/^\d+\.\d+\.\d+$/.test(n.version)||!text(n.title)||!text(n.summary)||!n.sections||typeof n.sections!=='object'||Array.isArray(n.sections))throw new Error('リリース履歴の形式が不正です。');
  if(n.date!==undefined){if(!/^\d{4}-\d{2}-\d{2}$/.test(n.date)||!['published','merged'].includes(n.dateKind)||Number.isNaN(Date.parse(n.date))||new Date(n.date).toISOString().slice(0,10)!==n.date)throw new Error('リリース履歴の日付が不正です。');}
  else if(i!==0||n.dateKind!==undefined)throw new Error('過去のリリース日がありません。');
  if(n.link!==undefined&&!link(n.link))throw new Error('リリース履歴のリンクが不正です。');
  if(n.stats!==undefined&&(!n.stats||!['files','additions','deletions'].every(k=>Number.isSafeInteger(n.stats[k])&&n.stats[k]>=0)))throw new Error('リリース統計が不正です。');
  if(!Object.keys(n.sections).length||Object.entries(n.sections).some(([k,v])=>!Object.hasOwn(labels,k)||!Array.isArray(v)||!v.length||!v.every(text)))throw new Error('リリース履歴の分類が不正です。');
  lines.push(`## v${n.version}：${md(n.title)}`,'',...(n.date?[`${n.date}（${n.dateKind==='merged'?'マージ日':'公開日'}・JST）`,'']:[]),md(n.summary),'');
  for(const [key,label] of Object.entries(labels))if(n.sections[key])lines.push(`### ${label}`,'',...n.sections[key].map(item=>'- '+md(item)),'');
  if(n.stats)lines.push(`変更差分：${n.stats.files}ファイル、+${n.stats.additions}行、-${n.stats.deletions}行`,'');
  if(n.link)lines.push(`[GitHubの変更記録](${n.link})`,'');
 }
 return lines.join('\n');
}
export function writeChangelog(){
 const result=generateChangelog(JSON.parse(read('public/release-notes.json')),JSON.parse(read('package.json')).version);
 const output=new URL('CHANGELOG.md',root);
 let existing;try{existing=read('CHANGELOG.md');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(existing!==result){
  if(process.env.CI)throw new Error('CHANGELOG.mdが履歴JSONと一致しません。ローカルでビルドして更新してください。');
  writeFileSync(output,result,'utf8');
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url))writeChangelog();
