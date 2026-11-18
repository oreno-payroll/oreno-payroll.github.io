/** 同一オリジン内のページ遷移用SharedWorker鍵はメモリ限定。
 * SharedWorkerが終了した場合は通常のパスフレーズ入力に戻る。
 * 明示的に選択した場合のみ、復号可能な鍵素材をsessionStorageへ最長2時間保存する。
 * パスフレーズや給与明細自体は永続化しない。 */
type SessionResult = {key:CryptoKey;salt:string};
type Reply = {id:number;result:unknown};
let port:MessagePort|undefined;
let serial=0;
const waiting=new Map<number,{resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
function getPort():MessagePort|null {
 if(port)return port;
 if(typeof SharedWorker==='undefined')return null;
 try {
  // esbuildはこのコードを各ページのルートJSにバンドルする。public/から配信。
  const worker=new SharedWorker(new URL('./payroll-cloud-session.js',import.meta.url),{name:'payroll-cloud-memory-v1'});
  worker.port.onmessage=(event:MessageEvent<Reply>)=>{
   const request=waiting.get(event.data?.id);
   if(!request)return;
   clearTimeout(request.timer);waiting.delete(event.data.id);request.resolve(event.data.result);
  };
  worker.port.start();
  port=worker.port;
  return port;
 }catch{return null;}
}
async function send(action:'get'|'set'|'clear',scope:string,key?:CryptoKey,salt?:string):Promise<unknown> {
 const connection=getPort();if(!connection)return null;
 const id=++serial;
 return new Promise(resolve=>{
  const timer=setTimeout(()=>{waiting.delete(id);resolve(null);},1800);
  waiting.set(id,{resolve,timer});
  try {connection.postMessage({id,action,scope,key,salt});}
  catch {clearTimeout(timer);waiting.delete(id);resolve(null);}
 });
}
export async function rememberKey(scope:string,key:CryptoKey,salt:string):Promise<boolean> {
 return await send('set',scope,key,salt)===true;
}
export async function restoredKey(scope:string):Promise<SessionResult|null> {
 const result=await send('get',scope) as SessionResult|null;
 if(!result||!result.key||result.key.type!=='secret'||result.key.extractable!==false||
    result.key.algorithm.name!=='AES-GCM'||typeof result.salt!=='string')return null;
 return result;
}
export async function clearKey(scope:string):Promise<void> {await send('clear',scope);}


/** Opt-in tab cache. This is recoverable AES key material, NOT an encrypted password.
 * Never used unless the user explicitly checks "remember for this tab".
 * This is a deliberate usability/security trade-off: any script in the same
 * origin can read sessionStorage during the time window (e.g. after XSS).
 * No salary record, PDF, or passphrase is stored here. */
const TAB_KEY='payroll-ephemeral-tab-unlock-v2';
const LEGACY_TAB_KEY='payroll-ephemeral-tab-unlock-v1';
export const TAB_TTL_MS=2*60*60*1000;
interface TabPayload {version:2;scope:string;salt:string;key:string;expiresAt:number}
function tabStore():Storage|null {
 try {return typeof sessionStorage==='undefined'?null:sessionStorage;}catch{return null;}
}
export function clearTabUnlock():void {
 try {const store=tabStore();store?.removeItem(TAB_KEY);store?.removeItem(LEGACY_TAB_KEY);}catch{ /* storage may be blocked */ }
}
export function rememberTabUnlock(scope:string, raw:Uint8Array, salt:string):boolean {
 if(raw.length!==32||!scope||!salt)return false;
 const store=tabStore();if(!store)return false;
 try {
  const secret=btoa(String.fromCharCode(...raw));
  store.removeItem(LEGACY_TAB_KEY); // 旧8時間方式の鍵を次回のログインで破棄する。
  const data:TabPayload={version:2,scope,salt,key:secret,expiresAt:Date.now()+TAB_TTL_MS};
  store.setItem(TAB_KEY,JSON.stringify(data));
  return true;
 }catch{return false;}
}
export async function restoredTabUnlock(scope:string):Promise<SessionResult|null> {
 const store=tabStore();if(!store)return null;
 let raw:Uint8Array|undefined;
 try{store.removeItem(LEGACY_TAB_KEY);}catch{ /* legacy cleanup is best effort */ }
 try {
  const saved=store.getItem(TAB_KEY);if(!saved)return null;
  const data=JSON.parse(saved) as Partial<TabPayload>;
  if(data.version!==2||data.scope!==scope||typeof data.salt!=='string'||
     typeof data.key!=='string'||!/^[a-zA-Z0-9+/]{43}=$/.test(data.key)||
     typeof data.expiresAt!=='number'||!Number.isFinite(data.expiresAt)||
     data.expiresAt<=Date.now()||data.expiresAt>Date.now()+TAB_TTL_MS) {
   clearTabUnlock();return null;
  }
  const decoded=atob(data.key);
  if(decoded.length!==32){clearTabUnlock();return null;}
  raw=new Uint8Array(32);
  for(let i=0;i<32;i++)raw[i]=decoded.charCodeAt(i);
  // Always use a real ArrayBuffer for Web Crypto. TypeScript 7's BufferSource
  // excludes Uint8Array<ArrayBufferLike>, and raw is declared with that type.
  // Copy the secret before import, and zero both temporary buffers afterward.
  const keyData: ArrayBuffer = new ArrayBuffer(32);
  new Uint8Array(keyData).set(raw);
  try {
   const key=await crypto.subtle.importKey('raw',keyData,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
   return {key,salt:data.salt};
  } finally {new Uint8Array(keyData).fill(0);}
 }catch{clearTabUnlock();return null;}
 finally{raw?.fill(0);}
}
