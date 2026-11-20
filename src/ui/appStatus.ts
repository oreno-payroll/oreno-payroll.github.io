/** All Payroll pages use the same bottom-right, non-blocking operation status card. */
export type AppStatusKind = 'loading'|'success'|'error';
export function createAppStatus(existing?: HTMLElement | null) {
 const element = existing ?? document.createElement('div');
 element.classList.add('app-status');
 element.setAttribute('role','status');element.setAttribute('aria-live','polite');element.setAttribute('aria-atomic','true');
 element.hidden=true;
 if(!existing)document.body.append(element);
 let timer: ReturnType<typeof setTimeout>|undefined;
 let version=0;
 const clear=()=>{version++;if(timer!==undefined)clearTimeout(timer);timer=undefined;element.hidden=true;element.textContent='';element.removeAttribute('data-state');};
 function show(kind:AppStatusKind,message:string) {
  clear();const current=version;
  element.dataset.state=kind;element.textContent=message;element.hidden=false;
  if(kind!=='loading')timer=setTimeout(()=>{if(current===version)clear();},kind==='error'?9000:3500);
 }
 return {element,clear,loading:(message:string)=>show('loading',message),success:(message:string)=>show('success',message),error:(message:string)=>show('error',message)};
}
