/** One modal at a time. Consent exists only in the current page and is never persisted. */
export interface OperationDialogRequest {
 title:string;
 subject?:string;
 details:readonly string[];
 acceptLabel:string;
 tone?:'normal'|'warning'|'danger';
 /** Exact typed confirmation for particularly sensitive operations. */
 requiredText?:string;
}
type Guard=()=>boolean;
let activeCancel:(()=>void)|undefined;
export function dismissOperationDialog():void {activeCancel?.();}
function openDialog(request:OperationDialogRequest,guard:Guard,messageOnly:boolean):Promise<boolean>{
 if(activeCancel)return Promise.resolve(false);
 try{if(!guard())return Promise.resolve(false);}catch{return Promise.resolve(false);}
 return new Promise(resolve=>{
  const dialog=document.createElement('dialog');
  dialog.className='operation-dialog';dialog.setAttribute('aria-labelledby','operation-dialog-title');
  dialog.setAttribute('aria-describedby','operation-dialog-details');dialog.dataset.tone=request.tone??'normal';
  const heading=document.createElement('h2');heading.id='operation-dialog-title';heading.textContent=request.title;
  dialog.append(heading);
  if(request.subject){const subject=document.createElement('p');subject.className='operation-dialog__subject';subject.textContent=request.subject;dialog.append(subject);}
  const details=document.createElement('div');details.id='operation-dialog-details';details.className='operation-dialog__details';
  for(const text of request.details){const p=document.createElement('p');p.textContent=text;details.append(p);}
  dialog.append(details);
  const actions=document.createElement('div');actions.className='operation-dialog__actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='btn btn--secondary';cancel.textContent='キャンセル';
  const accept=document.createElement('button');accept.type='button';accept.className=`btn ${request.tone==='danger'?'btn--danger-outline':'btn--primary'}`;accept.textContent=request.acceptLabel;
  let typed:HTMLInputElement|undefined;
  if(!messageOnly&&request.requiredText!==undefined){
   const label=document.createElement('label');label.className='operation-dialog__typed';label.textContent=`実行するには「${request.requiredText}」と入力してください。`;
   typed=document.createElement('input');typed.type='text';typed.className='input';typed.autocomplete='off';typed.spellcheck=false;
   label.append(typed);dialog.append(label);accept.disabled=true;
   typed.addEventListener('input',()=>{accept.disabled=typed!.value!==request.requiredText;});
  }
  if(!messageOnly)actions.append(cancel);actions.append(accept);dialog.append(actions);
  const previous=document.activeElement;
  let settled=false;
  const finish=(approved:boolean)=>{
   if(settled)return;settled=true;
   window.removeEventListener('pagehide',onPageHide);
   if(dialog.open)dialog.close();dialog.remove();
   // Clear sensitive text/typed data even if an event still holds the detached node.
   if(typed)typed.value='';dialog.replaceChildren();
   activeCancel=undefined;
   if(previous instanceof HTMLElement&&previous.isConnected&&document.documentElement.style.visibility!=='hidden')previous.focus({preventScroll:true});
   resolve(approved);
  };
  const onPageHide=()=>finish(false);
  activeCancel=onPageHide;
  cancel.addEventListener('click',()=>finish(false));
  accept.addEventListener('click',()=>{
   if(accept.disabled||!dialog.open)return;
   if(typed&&typed.value!==request.requiredText)return;
   let current=false;try{current=guard();}catch{/* Fail closed. */}
   finish(current);
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
  dialog.addEventListener('close',()=>finish(false));
  window.addEventListener('pagehide',onPageHide);
  try{document.body.append(dialog);dialog.showModal();(messageOnly?accept:cancel).focus();}
  catch{finish(false);}
 });
}
/** No native confirm fallback: a missing modal or invalid session cannot authorize a write. */
export function confirmOperation(request:OperationDialogRequest,guard:Guard):Promise<boolean>{return openDialog(request,guard,false);}
export function showOperationMessage(request:Omit<OperationDialogRequest,'requiredText'>,guard:Guard):Promise<boolean>{return openDialog(request,guard,true);}
