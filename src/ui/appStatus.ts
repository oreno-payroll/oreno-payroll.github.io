/** All Payroll pages use the same bottom-right, non-blocking operation status card. */
export type AppStatusKind = 'loading'|'success'|'info'|'warning'|'partial'|'error';
// Auth and page code may refer to the same status node. Share its timer/controller.
const controllers=new WeakMap<HTMLElement,ReturnType<typeof makeStatus>>();
export function createAppStatus(existing?: HTMLElement | null) {
 const element = existing ?? document.createElement('div');
 const current=controllers.get(element);if(current)return current;
 if(!existing)document.body.append(element);
 const controller=makeStatus(element);controllers.set(element,controller);return controller;
}
function makeStatus(element:HTMLElement){
 element.classList.add('app-status');
 element.setAttribute('role','status');element.setAttribute('aria-live','polite');element.setAttribute('aria-atomic','true');
 const messageNode=document.createElement('span');messageNode.className='app-status__message';
 const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='app-status__dismiss';dismiss.textContent='×';dismiss.setAttribute('aria-label','通知を閉じる');
 element.replaceChildren(messageNode,dismiss);
 // Keep bottom-right placement unless a visible save surface would be covered.
 // No layout observers are installed in non-browser test environments.
 const doc=element.ownerDocument,win=doc?.defaultView;
 const surfaces=doc?Array.from(doc.querySelectorAll<HTMLElement>('.save-bar,.vault-bottom,.yea-upload-savebar')):[];
 const position=()=>{
  if(!win||!surfaces.length||element.hidden)return;
  element.style.removeProperty('--status-bottom');element.style.removeProperty('--status-max-height');
  const toast=element.getBoundingClientRect(),height=win.innerHeight;
  const blockers=surfaces.map(node=>node.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0&&r.bottom>0&&r.top<height&&r.left<toast.right&&r.right>toast.left&&r.top<toast.bottom&&r.bottom>toast.top);
  if(!blockers.length)return;
  const top=Math.min(...blockers.map(r=>r.top)),bottom=Math.max(...blockers.map(r=>r.bottom));
  const above=Math.max(0,top-26),below=Math.max(0,height-bottom-26);
  const useAbove=above>=below;
  const room=useAbove?above:below;
  if(room<44)return; // A surface filling the viewport leaves no usable separate region.
  if(useAbove)element.style.setProperty('--status-bottom',`${Math.ceil(height-top+12)}px`);
  element.style.setProperty('--status-max-height',`${Math.min(240,Math.floor(room))}px`);
 };
 if(win&&surfaces.length){
  win.addEventListener('scroll',position,{capture:true,passive:true});win.addEventListener('resize',position);
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(position);for(const surface of surfaces)observer.observe(surface);}
 }
 let timer: ReturnType<typeof setTimeout>|undefined;
 let version=0;
 let loadingDismissed=false;
 const clear=()=>{loadingDismissed=false;version++;if(timer!==undefined)clearTimeout(timer);timer=undefined;element.hidden=true;messageNode.textContent='';dismiss.hidden=true;element.removeAttribute('data-state');};
 dismiss.addEventListener('click',()=>{
  if(element.dataset.state==='loading'){loadingDismissed=true;element.hidden=true;messageNode.textContent='';dismiss.hidden=true;}
  else clear();
 });clear();
 function show(kind:AppStatusKind,message:string,persistent=false) {
  if(kind==='loading'&&loadingDismissed)return;
  clear();const current=version;
  const sticky=kind==='error'||kind==='partial'||(kind==='warning'&&persistent);
  element.dataset.state=kind;messageNode.textContent=message;element.hidden=false;dismiss.hidden=false;position();
  if(kind!=='loading'&&!sticky)timer=setTimeout(()=>{if(current===version)clear();},kind==='warning'?9000:3500);
 }
 return {element,clear,show,info:(message:string)=>show('info',message),warning:(message:string,persistent=false)=>show('warning',message,persistent),partial:(message:string)=>show('partial',message),loading:(message:string)=>show('loading',message),success:(message:string)=>show('success',message),error:(message:string)=>show('error',message)};
}
