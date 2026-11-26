/** One modal at a time. Consent exists only in the current page and is never persisted. */
export interface OperationDialogRequest {
 title:string;
 subject?:string;
 details:readonly string[];
 /** Local, fragment-based links for read-only informational dialogs. */
 links?:readonly {label:string;href:string;description?:string}[];
 /** Explanations below the link list in informational dialogs. */
 afterLinks?:readonly string[];
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
  if(messageOnly&&request.links?.length){
   dialog.className+=' operation-dialog--links';
   const list=document.createElement('ul');list.className='operation-dialog__links';
   for(const entry of request.links){
    // Only the existing same-origin statement edit route; no external URLs or raw HTML.
    if(!/^\.\/edit\/index\.html#id=\d+&mode=(?:fiscal|calendar)&year=\d{4}(?:&hintYear=\d{4})?$/.test(entry.href))continue;
    const item=document.createElement('li'),link=document.createElement('a');
    link.className='operation-dialog__link';link.href=entry.href;
    if(entry.description!==undefined){
     const content=document.createElement('span');content.className='operation-dialog__link-content';
     const label=document.createElement('span');label.className='operation-dialog__link-label';label.textContent=entry.label;
     const description=document.createElement('span');description.className='operation-dialog__link-description';description.textContent=entry.description;
     content.append(label,description);link.append(content);
    }else link.textContent=entry.label;
    const check=(event:Event)=>{let current=false;try{current=dialog.open&&guard();}catch{/* Fail closed. */}if(!current){event.preventDefault();finish(false);}};
    link.addEventListener('click',check);link.addEventListener('auxclick',check);
    item.append(link);list.append(item);
   }
   details.append(list);
  }
  if(messageOnly)for(const text of request.afterLinks??[]){const p=document.createElement('p');p.className='operation-dialog__link-note';p.textContent=text;details.append(p);}
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
