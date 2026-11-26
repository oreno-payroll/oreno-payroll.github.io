/** Settings categories are presentation-only; switching does not create history entries. */
type View='employers'|'auth'|'backup'|'maintenance'|'notifications';
const views:readonly View[]=['employers','auth','backup','maintenance','notifications'];
const stateKey='payrollSettingsView';
function readView(state:unknown):View|undefined{
 const value=(state as Record<string,unknown>|null)?.[stateKey];
 return typeof value==='string'&&views.includes(value as View)?value as View:undefined;
}
export function mountSettingsNavigation(root:HTMLElement,canNavigate:()=>boolean,onOpen?:(view:View)=>void):{setBusy:(busy:boolean)=>void} {
 const required=<T extends HTMLElement>(selector:string):T=>{
  const node=root.querySelector<T>(selector);
  if(!node)throw new Error('設定画面の構成が不正です。');
  return node;
 };
 const menu=required<HTMLElement>('#settings-menu');
 const buttons=Array.from(menu.querySelectorAll<HTMLButtonElement>('button[data-settings-open]'));
 const panels={employers:required<HTMLElement>('#settings-employers-panel'),auth:required<HTMLElement>('#settings-auth-panel'),backup:required<HTMLElement>('#settings-backup-panel'),maintenance:required<HTMLElement>('#settings-details-panel'),notifications:required<HTMLElement>('#settings-notifications-panel')};
 let busy=false;
 let current:View='auth';
 function renderButtons():void{
  for(const button of buttons)button.disabled=busy;
 }
 function remask():void{
  for(const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-toggle-password]'))){
   const id=button.dataset.togglePassword;
   const input=id?root.ownerDocument.getElementById(id):null;
   if(input instanceof HTMLInputElement&&input.type==='text'&&root.contains(input)){
    input.type='password';button.textContent='表示';button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','パスワードを表示');
   }
  }
 }
 function render(key:View):void{
  remask();current=key;
  const panel=panels[current];
  for(const item of Object.values(panels))item.hidden=item!==panel;
  for(const button of buttons)button.setAttribute('aria-current',String(button.dataset.settingsOpen===current));
 }
 function open(button:HTMLButtonElement):void{
  if(busy||!canNavigate())return;
  const key=readView({[stateKey]:button.dataset.settingsOpen});
  if(!key||key===current)return;
  render(key);onOpen?.(key);
 }
 window.addEventListener('pagehide',remask);
 const initial=window.location?.hash==='#employers'?'employers':'auth';
 render(initial);
 if(initial==='employers')onOpen?.(initial);
 for(const button of buttons)button.addEventListener('click',()=>open(button));
 renderButtons();
 return {setBusy(value){busy=value;renderButtons();}};
}
