/** Read-only, transient diagnostic. No raw text is created until explicitly authorized. */
let activeClose:(()=>void)|undefined;
export function dismissRecordDiagnostic():void{activeClose?.();}
/** Both diagnostic views share the existing auth-invalidation cleanup boundary. */
export function registerDiagnosticClose(close:()=>void):()=>void {
 activeClose?.();activeClose=close;
 return ()=>{if(activeClose===close)activeClose=undefined;};
}
export function openRecordDiagnostic(readRaw:()=>string,authorized:()=>boolean):void{
 const allowed=()=>{try{return authorized();}catch{return false;}};
 if(activeClose||!allowed()||document.querySelector('dialog[open]'))return;
 const dialog=document.createElement('dialog');dialog.className='operation-dialog record-diagnostic';
 dialog.setAttribute('aria-labelledby','record-diagnostic-title');dialog.setAttribute('aria-describedby','record-diagnostic-note');
 const header=document.createElement('div');header.className='operation-dialog__header';
 const heading=document.createElement('h2');heading.id='record-diagnostic-title';heading.textContent='保存済み明細の詳細診断';
 const close=document.createElement('button');close.type='button';close.className='btn btn--ghost btn--small btn--square operation-dialog__close';close.textContent='×';close.setAttribute('aria-label','閉じる');
 header.append(heading,close);
 const note=document.createElement('p');note.id='record-diagnostic-note';note.className='record-diagnostic__note';note.textContent='保存済みの明細データ（JSON）を確認できます。給与額や内部IDなどの個人情報を含みます。編集中の内容・PDF本体は含みません。';
 const output=document.createElement('pre');output.className='operation-dialog__data';output.hidden=true;output.tabIndex=0;output.setAttribute('aria-label','保存済み明細データ');
 const status=document.createElement('p');status.className='operation-dialog__status';status.setAttribute('role','status');
 const actions=document.createElement('div');actions.className='operation-dialog__actions';
 const action=document.createElement('button');action.type='button';action.className='btn btn--primary';action.textContent='診断データを表示';actions.append(status,action);
 const body=document.createElement('div');body.className='operation-dialog__body';body.append(note,output);dialog.append(header,body,actions);
 const previous=document.activeElement;
 let closed=false,pending=false;
 const current=()=>!closed&&dialog.open&&allowed();
 function finish():void{
  if(closed)return;closed=true;window.removeEventListener('pagehide',finish);output.textContent='';output.hidden=true;status.textContent='';
  if(dialog.open)dialog.close();dialog.remove();dialog.replaceChildren();activeClose=undefined;
  if(previous instanceof HTMLElement&&previous.isConnected&&document.documentElement.style.visibility!=='hidden')previous.focus({preventScroll:true});
 }
 async function perform():Promise<void>{
  if(pending||closed)return;
  if(!current()){finish();return;}
  if(output.hidden){
   try{
    const raw=readRaw();if(!current()){finish();return;}
    output.textContent=raw;output.hidden=false;
    note.textContent='個人情報を含みます。コピーした内容はアプリを閉じてもクリップボードに残る場合があります。共有先を確認してください。';
    action.textContent='診断データをコピー';status.textContent='';
   }catch{if(current())status.textContent='診断データを表示できませんでした。';else finish();}
   return;
  }
  pending=true;action.disabled=true;
  try{await navigator.clipboard.writeText(output.textContent??'');if(current())status.textContent='クリップボードにコピーしました。';else finish();}
  catch{if(current())status.textContent='コピーできませんでした。もう一度お試しください。';else finish();}
  finally{pending=false;if(!closed)action.disabled=false;}
 }
 action.addEventListener('click',()=>void perform());close.addEventListener('click',finish);
 dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});dialog.addEventListener('close',finish);
 window.addEventListener('pagehide',finish);activeClose=finish;
 try{document.body.append(dialog);dialog.showModal();close.focus();}catch{finish();}
}
