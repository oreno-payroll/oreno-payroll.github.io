/** In-memory cross-page key sharing only. No plaintext or exportable key material is
 * written to sessionStorage. Legacy 2h/8h tab-unlock entries are deleted on entry.
 * The separately opted-in non-extractable browser key lives in rememberedBrowser.ts. */
type SessionResult = {key:CryptoKey;salt:string};
type Reply = {id:number;result:unknown};
let port:MessagePort|undefined;
let serial=0;
const waiting=new Map<number,{resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
function getPort():MessagePort|null {
 if(port)return port;
 if(typeof SharedWorker==='undefined')return null;
 try {
  const worker=new SharedWorker(new URL('./payroll-cloud-session.js',import.meta.url),{name:'payroll-cloud-memory-v1'});
  worker.port.onmessage=(event:MessageEvent<Reply>)=>{
   const request=waiting.get(event.data?.id);
   if(!request)return;
   clearTimeout(request.timer);waiting.delete(event.data.id);request.resolve(event.data.result);
  };
  worker.port.start();port=worker.port;return port;
 }catch{return null;}
}
async function send(action:'get'|'set'|'clear'|'clear-all'|'generation',scope:string,key?:CryptoKey,salt?:string,generation?:string):Promise<unknown> {
 const connection=getPort();if(!connection)return null;
 const id=++serial;
 return new Promise(resolve=>{
  const timer=setTimeout(()=>{waiting.delete(id);resolve(null);},1800);
  waiting.set(id,{resolve,timer});
  try{connection.postMessage({id,action,scope,key,salt,generation});}
  catch{clearTimeout(timer);waiting.delete(id);resolve(null);}
 });
}
/** Obtain a worker-instance generation before starting asynchronous authentication. */
export async function captureKeyGeneration():Promise<string|undefined> {
 const result=await send('generation','global');
 return typeof result==='string'&&/^[a-f0-9-]{36}$/i.test(result)?result:undefined;
}
export async function rememberKey(scope:string,key:CryptoKey,salt:string,generation?:string):Promise<boolean> {
 if(!generation)return false;
 return await send('set',scope,key,salt,generation)===true;
}
export async function restoredKey(scope:string,generation?:string):Promise<SessionResult|null> {
 if(!generation)return null;
 const result=await send('get',scope,undefined,undefined,generation) as SessionResult|null;
 if(!result||!result.key||result.key.type!=='secret'||result.key.extractable!==false||
    result.key.algorithm.name!=='AES-GCM'||typeof result.salt!=='string')return null;
 return result;
}
export async function clearKey(scope:string):Promise<void> {const generation=await captureKeyGeneration();if(generation)await send('clear',scope,undefined,undefined,generation);}
/** A lock cannot claim that memory keys were removed unless the worker
 * explicitly acknowledges `clear-all`. No worker support means no shared cache.
 * A missing/broken port or timeout is an unconfirmed erase, not success. */
export async function clearAllKeys():Promise<void> {
 if(typeof SharedWorker==='undefined')return;
 if(!getPort())throw new Error('SharedWorkerに接続できず、一時鍵の消去を確認できませんでした。');
 if(await send('clear-all','global')!==true)
  throw new Error('SharedWorkerが鍵消去を確認できませんでした。通信または応答時間を確認してください。');
}
/** One-way migration: delete both old sessionStorage key-material versions.
 * This is intentionally cleanup-only: no code can write or restore these keys. */
export function clearTabUnlock():void {
 try {
  if(typeof sessionStorage==='undefined')return;
  sessionStorage.removeItem('payroll-ephemeral-tab-unlock-v1');
  sessionStorage.removeItem('payroll-ephemeral-tab-unlock-v2');
 }catch{/* private browsing/storage unavailable */}
}
