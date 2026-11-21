/** Cross-tab vault lock coordination. Only a random lock epoch is stored persistently;
 * neither passphrases nor keys nor salary data ever enter this channel. */
const GLOBAL_LOCK_EPOCH = 'payroll-global-vault-lock-epoch-v1';
const TAB_UNLOCK_EPOCH = 'payroll-tab-unlock-lock-epoch-v1';
const CHANNEL_NAME = 'payroll-global-vault-lock-v1';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Channel = Pick<BroadcastChannel, 'postMessage' | 'addEventListener'>;
type WindowEvents = Pick<Window, 'addEventListener'>;
type DocumentEvents = Pick<Document, 'addEventListener'> & {visibilityState?: DocumentVisibilityState};
export interface TabLockEnvironment {
 local: Store | null;
 tab: Store | null;
 channel: Channel | null;
 windowEvents: WindowEvents | null;
 documentEvents: DocumentEvents | null;
 newId: () => string;
}
function safeStorage(name:'localStorage'|'sessionStorage'):Store|null {
 try {return typeof window==='undefined'?null:window[name];}catch{return null;}
}
function defaultEnvironment():TabLockEnvironment {
 let channel:BroadcastChannel|null=null;
 try {if(typeof BroadcastChannel!=='undefined'&&typeof window!=='undefined')channel=new BroadcastChannel(CHANNEL_NAME);}catch{}
 return {
  local:safeStorage('localStorage'),tab:safeStorage('sessionStorage'),channel,
  windowEvents:typeof window==='undefined'?null:window,
  documentEvents:typeof document==='undefined'?null:document,
  newId:()=>crypto.randomUUID(),
 };
}
function get(store:Store|null,key:string):string {
 try{return store?.getItem(key)??'';}catch{return '';}
}
function put(store:Store|null,key:string,value:string):void {
 try {store?.setItem(key,value);}catch{}
}
function drop(store:Store|null,key:string):void {
 try {store?.removeItem(key);}catch{}
}
/** A new tab cannot silently inherit a SharedWorker key after a previous global lock. */
export function createTabLockCoordinator(onRemoteLock:()=>void, env:TabLockEnvironment=defaultEnvironment()) {
 let observed=get(env.local,GLOBAL_LOCK_EPOCH);
 let locked=false;
 const handle=(epoch:string):void=>{
  if(!epoch||epoch===observed||locked)return;
  // Ignore late BroadcastChannel messages superseded by a newer localStorage epoch.
  const current=get(env.local,GLOBAL_LOCK_EPOCH);
  if(current&&current!==epoch)return;
  observed=epoch;locked=true;
  drop(env.tab,TAB_UNLOCK_EPOCH);
  onRemoteLock();
 };
 const check=():boolean=>{
  const epoch=get(env.local,GLOBAL_LOCK_EPOCH);
  if(epoch&&epoch!==observed)handle(epoch);
  return !locked;
 };
 env.channel?.addEventListener('message',((event:MessageEvent)=>{
  const data=event.data;
  if(data?.type==='lock'&&typeof data.epoch==='string'&&/^[a-f0-9-]{36}$/i.test(data.epoch))handle(data.epoch);
 }) as EventListener);
 env.windowEvents?.addEventListener('storage',((event:StorageEvent)=>{
  if(event.key===GLOBAL_LOCK_EPOCH)check();
 }) as EventListener);
 env.windowEvents?.addEventListener('pageshow',()=>{check();});
 env.windowEvents?.addEventListener('focus',()=>{check();});
 env.documentEvents?.addEventListener('visibilitychange',()=>{
  if(env.documentEvents?.visibilityState==='visible')check();
 });
 return {
  check,
  /** Capture before an awaited unlock; check again before accepting its result. */
  epoch():string {check();return observed;},
  canResume():boolean {
   if(!check())return false;
   const epoch=get(env.local,GLOBAL_LOCK_EPOCH);
   return !epoch||get(env.tab,TAB_UNLOCK_EPOCH)===epoch;
  },
  acceptUnlock(startEpoch:string):boolean {
   if(!check()||startEpoch!==observed)return false;
   if(observed)put(env.tab,TAB_UNLOCK_EPOCH,observed);
   else drop(env.tab,TAB_UNLOCK_EPOCH);
   return true;
  },
  /** Called by explicit lock/account switch; keepCurrent is for account/key changes only. */
  broadcast(keepCurrent=false):void {
   const epoch=env.newId();
   observed=epoch;locked=!keepCurrent;
   if(keepCurrent)put(env.tab,TAB_UNLOCK_EPOCH,epoch);
   else drop(env.tab,TAB_UNLOCK_EPOCH);
   put(env.local,GLOBAL_LOCK_EPOCH,epoch);
   try{env.channel?.postMessage({type:'lock',epoch});}catch{}
  },
 };
}
