import {confirmOperation} from './operationDialog.ts';
/** Read-only, transient diagnostic. No raw text is created until explicitly authorized. */
let activeClose:(()=>void)|undefined;
export function dismissRecordDiagnostic():void{activeClose?.();}
export function openRecordDiagnostic(readRaw:()=>string,authorized:()=>boolean):void{
 if(activeClose||!authorized())return;
 const dialog=document.createElement('dialog');dialog.className='operation-dialog record-diagnostic';
 dialog.setAttribute('aria-labelledby','record-diagnostic-title');
 const heading=document.createElement('h2');heading.id='record-diagnostic-title';heading.textContent='保存済み明細の詳細診断';
 const note=document.createElement('p');note.textContent='診断用の情報です。内部ID・金額・勤務先IDなどの個人情報は初期状態では表示しません。編集途中の入力値やPDF本体は含みません。';
 const output=document.createElement('pre');output.className='record-diagnostic__raw';output.hidden=true;
 const status=document.createElement('p');status.setAttribute('role','status');status.textContent='原文は非表示です。';
 const actions=document.createElement('div');actions.className='operation-dialog__actions';
 const makeButton=(label:string)=>{const b=document.createElement('button');b.type='button';b.className='btn btn--secondary';b.textContent=label;return b;};
 const reveal=makeButton('原文を表示'),copy=makeButton('原文をコピー'),mask=makeButton('原文を隠す'),close=makeButton('閉じる');mask.disabled=true;
 actions.append(reveal,copy,mask,close);dialog.append(heading,note,status,output,actions);
 const previous=document.activeElement;
 let closed=false,pending=false;
 const current=()=>!closed&&dialog.open&&authorized();
 function conceal():void{output.textContent='';output.hidden=true;mask.disabled=true;reveal.disabled=false;status.textContent='原文は非表示です。';}
 function finish():void{
  if(closed)return;closed=true;window.removeEventListener('pagehide',finish);conceal();
  if(dialog.open)dialog.close();dialog.remove();dialog.replaceChildren();activeClose=undefined;
  if(previous instanceof HTMLElement&&previous.isConnected&&document.documentElement.style.visibility!=='hidden')previous.focus({preventScroll:true});
 }
 async function consent(action:'表示'|'コピー'):Promise<void>{
  if(pending||!current())return;pending=true;
  try{
   if(!await confirmOperation({title:`診断原文を${action}`,details:['内部ID・給与額など個人情報を含む保存済みデータです。共有先に個人情報を送信しないよう注意してください。',action==='コピー'?'クリップボードの内容はアプリを閉じても残る場合があります。':'原文はこの画面だけに表示し、閉じると消去します。'],tone:'warning',acceptLabel:`原文を${action}`},current)||!current())return;
   const raw=readRaw();if(!current())return;
   if(action==='表示'){output.textContent=raw;output.hidden=false;mask.disabled=false;reveal.disabled=true;status.textContent='原文を表示中です。';}
   else{
    try{await navigator.clipboard.writeText(raw);if(current())status.textContent='原文をコピーしました。共有先を確認してください。';}
    catch{if(current())status.textContent='コピーできませんでした。原文の自動表示・選択は行いません。';}
   }
  }finally{pending=false;}
 }
 reveal.addEventListener('click',()=>void consent('表示'));
 copy.addEventListener('click',()=>void consent('コピー'));
 mask.addEventListener('click',conceal);close.addEventListener('click',finish);
 dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});dialog.addEventListener('close',finish);
 window.addEventListener('pagehide',finish);activeClose=finish;
 try{document.body.append(dialog);dialog.showModal();close.focus();}catch{finish();}
}
