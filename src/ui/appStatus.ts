import {notificationAllowed,notificationGeneration,recordNotification,subscribeNotificationReset,type NoticeCode,type ResultKind} from './notificationHistory.ts';
/** All Payroll pages use the same bottom-right, non-blocking operation status card. */
export type AppStatusKind = 'loading'|'success'|'info'|'warning'|'partial'|'error';
// Auth and page code may refer to the same status node. Share its timer/controller.
const controllers=new WeakMap<HTMLElement,ReturnType<typeof makeStatus>>();
export function createAppStatus(existing?: HTMLElement | null, code:NoticeCode='general') {
 const element = existing ?? document.createElement('div');
 const current=controllers.get(element);if(current)return current;
 if(!existing)document.body.append(element);
 const controller=makeStatus(element,code);controllers.set(element,controller);return controller;
}
function makeStatus(element:HTMLElement,defaultCode:NoticeCode){
 element.classList.add('app-status');
 element.setAttribute('role','status');element.setAttribute('aria-live','polite');element.setAttribute('aria-atomic','true');
 const messageNode=document.createElement('span');messageNode.className='app-status__message';
 const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='app-status__dismiss';dismiss.textContent='×';dismiss.setAttribute('aria-label','通知を閉じる');
 element.replaceChildren(messageNode,dismiss);
 // Keep bottom-right placement unless a visible save surface would be covered.
 // No layout observers are installed in non-browser test environments.
 const doc=element.ownerDocument,win=doc?.defaultView;
 const surfaces=doc?Array.from(doc.querySelectorAll<HTMLElement>('.save-bar,.vault-bottom,.yea-upload-savebar')):[];
 const home=element.parentElement;
 const floating=()=>{
  if(!element.hasAttribute?.('data-inline'))return;
  element.removeAttribute('data-inline');messageNode.removeAttribute('tabindex');home?.append(element);
 };
 const inline=(surface:HTMLElement)=>{
  const host=surface.querySelector<HTMLElement>('[data-status-inline]');
  if(!host)return false;
  element.style.removeProperty('--status-bottom');element.style.removeProperty('--status-max-height');
  element.setAttribute('data-inline','');messageNode.setAttribute('tabindex','0');
  if(element.parentElement!==host)host.append(element);
  return true;
 };
 const position=(preserve=false)=>{
  if(!win||!surfaces.length||element.hidden)return;
  const viewport=win.visualViewport;
  const visibleTop=viewport?.offsetTop??0;
  const height=Math.min(win.innerHeight,visibleTop+(viewport?.height??win.innerHeight));
  const visible=(surface:HTMLElement)=>{const r=surface.getBoundingClientRect();return r.height>0&&r.width>0&&r.bottom>visibleTop&&r.top<height;};
  // A visible editor uses its existing save status region. Once placed inline,
  // keep it there for this operation to avoid resize/scroll feedback loops.
  if(element.hasAttribute('data-inline')){if(element.parentElement?.getClientRects().length)return;floating();}
  const always=surfaces.find(node=>visible(node)&&node.querySelector('[data-status-inline="always"]'));
  if(always&&inline(always))return;
  const overlaps=(toast:DOMRect)=>surfaces.map(node=>node.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0&&r.bottom>visibleTop&&r.top<height&&r.left<toast.right&&r.right>toast.left&&r.top<toast.bottom&&r.bottom>toast.top);
  if(preserve){
   const live=element.getBoundingClientRect();
   if(live.top>=visibleTop&&live.bottom<=height&&!overlaps(live).length)return;
  }
  element.style.removeProperty('--status-bottom');element.style.removeProperty('--status-max-height');
  // The visual viewport may be shorter than the layout viewport (keyboard).
  // innerHeight is integer CSS pixels; visualViewport can be fractional.
  if(win.innerHeight-height>1){
   element.style.setProperty('--status-bottom',`${Math.ceil(win.innerHeight-height+14)}px`);
   element.style.setProperty('--status-max-height',`${Math.max(0,Math.min(240,Math.floor(height-visibleTop-28)))}px`);
  }
  const toast=element.getBoundingClientRect();
  const blockers=overlaps(toast);
  if(!blockers.length)return;
  const top=Math.min(...blockers.map(r=>r.top)),bottom=Math.max(...blockers.map(r=>r.bottom));
  const above=Math.max(0,top-visibleTop-26),below=Math.max(0,height-bottom-26);
  const useAbove=above>=below;
  const room=useAbove?above:below;
  if(room<44){
   const host=surfaces.find(node=>visible(node)&&node.querySelector('[data-status-inline]'));
   if(host)inline(host);
   return;
  }
  if(useAbove)element.style.setProperty('--status-bottom',`${Math.ceil(win.innerHeight-top+12)}px`);
  element.style.setProperty('--status-max-height',`${Math.min(240,Math.floor(room))}px`);
 };
 if(win&&surfaces.length){
  win.addEventListener('scroll',()=>position(),{capture:true,passive:true});win.addEventListener('resize',()=>position());win.visualViewport?.addEventListener('resize',()=>position());win.visualViewport?.addEventListener('scroll',()=>position());
  if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>position(shown?.kind==='loading'));for(const surface of surfaces)observer.observe(surface);}
 }
 let timer: ReturnType<typeof setTimeout>|undefined;
 let version=0,loadingDismissed=false,loadingActive=false;
 type Scope={generation:number;code:NoticeCode;target?:object|string;result?:ResultKind;dismissed:boolean};
 type Toast={kind:AppStatusKind;message:string;sticky:boolean;scope?:Scope};
 let shown:Toast|undefined;
 let latestScope:Scope|undefined;
 const hide=()=>{version++;if(timer!==undefined)clearTimeout(timer);timer=undefined;shown=undefined;element.hidden=true;floating();messageNode.textContent='';dismiss.hidden=true;element.removeAttribute('data-state');};
 function paint(item:Toast){
  // Progress is one visible notification, not a sequence of replacements.
  // Keep the anchor while it remains safe; genuine collisions can reposition it.
  if(shown?.kind==='loading'&&item.kind==='loading'&&shown.scope===item.scope&&!element.hidden){
   shown=item;messageNode.textContent=item.message;position(true);return;
  }
  hide();shown=item;const current=version;
  element.dataset.state=item.kind;messageNode.textContent=item.message;element.hidden=false;dismiss.hidden=false;position();
  if(item.kind!=='loading'&&!item.sticky)timer=setTimeout(()=>{if(current===version)hide();},item.kind==='warning'?9000:3500);
 }
 function reset(){latestScope=undefined;loadingDismissed=false;loadingActive=false;hide();}
 subscribeNotificationReset(reset);
 const clear=(scope?:Scope)=>{if(scope){scope.dismissed=true;if(shown?.scope!==scope)return;}loadingDismissed=false;loadingActive=false;hide();};
 dismiss.addEventListener('click',()=>{
  if(shown?.kind==='loading'){if(shown.scope)shown.scope.dismissed=true;else loadingDismissed=true;}
  hide();
 });hide();
 // Explicit operation identity is in memory only; it is never a history field.
 function begin(code:NoticeCode=defaultCode,target?:object|string){
  loadingDismissed=false;loadingActive=true;
  const scope:Scope={generation:notificationGeneration(),code,target,dismissed:false};latestScope=scope;return scope;
 }
 function show(kind:AppStatusKind,message:string,persistent=false,options:{scope?:Scope;code?:NoticeCode;record?:boolean}={}) {
  if(!notificationAllowed())return;
  const scope=options.scope;
  if(scope&&scope.generation!==notificationGeneration())return;
  const outdated=!!scope&&!!latestScope&&scope!==latestScope;
  if(kind==='loading'){
   if(outdated)return;
   if(scope){if(scope.dismissed||scope.result)return;}
   else{if(!loadingActive){loadingActive=true;loadingDismissed=false;}if(loadingDismissed)return;}
  }else{
   if(kind!=='info'&&!outdated){loadingActive=false;loadingDismissed=false;}
   if(kind!=='info'){
    if(scope?.result===kind)return; // the same typed result from the same operation
    if(scope)scope.result=kind as ResultKind;
    if(options.record!==false)recordNotification(options.code??scope?.code??defaultCode,kind as ResultKind);
   }
  }
  const sticky=kind==='error'||kind==='partial'||(kind==='warning'&&persistent);
  const item={kind,message,sticky,scope};
  // Older scoped operations still record their outcomes, but cannot cover a newer one.
  if(outdated)return;
  paint(item);
 }
 return {element,clear,begin,show,locked(){reset();paint({kind:'error',message:'保管庫がロックされました。このPDFは閉じてください。',sticky:true});},info:(message:string)=>show('info',message),warning:(message:string,persistent=false)=>show('warning',message,persistent),partial:(message:string)=>show('partial',message),loading:(message:string)=>show('loading',message),success:(message:string)=>show('success',message),error:(message:string)=>show('error',message)};
}
