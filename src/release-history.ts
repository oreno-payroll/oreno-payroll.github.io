/** Read-only settings feature, deliberately independent of auth and cloud storage. */
const labels={features:'新機能',ux:'UI・UXの改善',fixes:'不具合修正',security:'セキュリティ・信頼性の向上',internal:'性能・内部処理の改善'} as const;
type Release={version:string;title:string;summary:string;date?:string;dateKind?:'published'|'merged';sections:Partial<Record<keyof typeof labels,string[]>>;stats?:{files:number;additions:number;deletions:number};link?:string};
const validText=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
function isRelease(value:unknown):value is Release {
 if(!value||typeof value!=='object')return false;
 const n=value as Release;
 return typeof n.version==='string'&&/^\d+\.\d+\.\d+$/.test(n.version)&&validText(n.title)&&validText(n.summary)&&
  !!n.sections&&typeof n.sections==='object'&&!Array.isArray(n.sections)&&Object.keys(n.sections).length>0&&
  Object.entries(n.sections).every(([key,items])=>Object.hasOwn(labels,key)&&Array.isArray(items)&&items.length>0&&items.every(validText));
}
function element<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string):HTMLElementTagNameMap[K]{
 const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;
}
const trigger=document.querySelector<HTMLButtonElement>('#settings-version');
const dialog=document.querySelector<HTMLDialogElement>('#release-history-dialog');
const content=document.querySelector<HTMLElement>('#release-history-content');
const close=document.querySelector<HTMLButtonElement>('#release-history-close');
if(trigger&&dialog&&content&&close){
 let request:AbortController|undefined;
 const show=async()=>{
  if(dialog.open)return;
  content.replaceChildren(element('p','履歴を読み込み中…'));
  try{dialog.showModal();}catch{return;}
  close.focus();
  request?.abort();const controller=new AbortController();request=controller;
  try{
   const response=await fetch(new URL('../release-notes.json',document.baseURI),{signal:controller.signal,credentials:'same-origin',redirect:'error',cache:'no-cache'});
   if(!response.ok)throw new Error('history unavailable');
   const notes:unknown=await response.json();
   if(!Array.isArray(notes)||!notes.length||!notes.every(isRelease))throw new Error('invalid history');
   if(controller.signal.aborted||!dialog.open)return;
   const version=trigger.querySelector('[data-build-version]')?.textContent?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
   const fragment=document.createDocumentFragment();
   for(const [index,note] of notes.entries()){
    const item=element('article',undefined,'release-history__entry');
    const meta=element('div',undefined,'release-history__meta');
    meta.append(element('strong',`v${note.version}`));
    if(index===0&&note.version===version)meta.append(element('span','最新版','count-badge'));
    if(typeof note.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(note.date)&&['published','merged'].includes(note.dateKind??'')){
     const date=element('time',`${note.date.replaceAll('-','/')}（${note.dateKind==='merged'?'マージ':'公開'}・JST）`);date.dateTime=note.date;meta.append(date);
    }
    item.append(meta,element('h3',note.title),element('p',note.summary));
    for(const [key,label] of Object.entries(labels)){
     const rows=note.sections[key as keyof typeof labels];if(!rows?.length)continue;
     const section=element('section');section.append(element('h4',label));const list=element('ul');
     for(const row of rows)list.append(element('li',row));section.append(list);item.append(section);
    }
    if(note.stats&&['files','additions','deletions'].every(k=>Number.isSafeInteger(note.stats![k as keyof typeof note.stats])&&note.stats![k as keyof typeof note.stats]>=0)){
     const {files,additions,deletions}=note.stats;item.append(element('p',`${files.toLocaleString('ja-JP')}ファイル · +${additions.toLocaleString('ja-JP')}行 · −${deletions.toLocaleString('ja-JP')}行`,'release-history__detail'));
    }
    if(typeof note.link==='string'&&/^https:\/\/github\.com\/oreno-payroll\/oreno-payroll\.github\.io\/(?:pull\/[1-9]\d*|commit\/[a-f0-9]{40})$/.test(note.link)){
     const a=element('a','GitHubの変更記録','release-history__link');a.href=note.link;a.target='_blank';a.rel='noopener noreferrer';item.append(a);
    }
    fragment.append(item);
   }
   content.replaceChildren(fragment);content.scrollTop=0;
  }catch{if(!controller.signal.aborted&&dialog.open)content.replaceChildren(element('p','履歴を読み込めませんでした。閉じてもう一度お試しください。'));}
 };
 trigger.addEventListener('click',()=>{void show();});
 close.addEventListener('click',()=>dialog.close());
 dialog.addEventListener('close',()=>{if(dialog.open)return;request?.abort();trigger.focus({preventScroll:true});});
}

export {};
