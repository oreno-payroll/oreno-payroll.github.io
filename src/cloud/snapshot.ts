/** Tab-scoped *encrypted* read-only view cache. OneDrive remains the sole durable source.
 * No plaintext salary metadata, PDFs, or passphrases are written to browser storage.
 * A restored snapshot is display-only: every mutation still revalidates OneDrive. */
import {encryptJson,decryptJson} from './crypto';
import {clearNavigationNotice} from '../ui/navigationNotice';
import {dismissOperationDialog} from '../ui/operationDialog';
import {dismissRecordDiagnostic} from '../ui/recordDiagnostic';
const CACHE='payroll-navigation-snapshot-v1';
const PEOPLE_CACHE='payroll-yearend-navigation-snapshot-v1';
export const NAVIGATION_MUTATION_KEY='payroll-navigation-write-epoch-v1';
const EPOCH=NAVIGATION_MUTATION_KEY;
const AUTH_EPOCH='payroll-navigation-identity-epoch-v1';
export const SNAPSHOT_TTL_MS=600_000;
const MAX_CIPHER_LENGTH=2_500_000;
interface Cached {format:'payroll-navigation-snapshot-v1';scope:string;salt:string;created:number;expires:number;data:unknown;epoch?:string}
function storage():Storage|null {try{return typeof sessionStorage==='undefined'?null:sessionStorage;}catch{return null;}}
export function clearNavigationSnapshot():void {try{const store=storage();store?.removeItem(CACHE);store?.removeItem(PEOPLE_CACHE);}catch{}}
/** Mutations invalidate on *attempt*, including a partially completed multi-file restore. */
export function invalidateNavigationSnapshot():void {
 clearNavigationSnapshot();
 const epoch=crypto.randomUUID();
 try{storage()?.setItem(EPOCH,epoch);}catch{}
 try{if(typeof localStorage!=='undefined')localStorage.setItem(EPOCH,epoch);}catch{}
}
export function sharedNavigationEpoch():string {
 try{return typeof localStorage==='undefined'?'':localStorage.getItem(EPOCH)??'';}catch{return '';}
}
export function mutationEpoch():string {
 let shared=sharedNavigationEpoch(),tab='';
 try{tab=storage()?.getItem(EPOCH)??'';}catch{}
 return JSON.stringify([shared,tab]);
}
// The storage event carries only a random invalidation token. The epoch is also
// checked synchronously on restore, so missed events/BFCache cannot revive a stale cache.
if(typeof window!=='undefined')window.addEventListener('storage',event=>{
 if(event.key===EPOCH||event.key===null)clearNavigationSnapshot();
});
export function authEpoch():string {try{return storage()?.getItem(AUTH_EPOCH)??'';}catch{return '';}}
/** A changed Microsoft identity invalidates any bfcache page holding the previous account. */
export function invalidateAuthSession():void {
 dismissOperationDialog();
 dismissRecordDiagnostic();
 clearNavigationNotice();
 invalidateNavigationSnapshot();
 try{storage()?.setItem(AUTH_EPOCH,crypto.randomUUID());}catch{}
}
export async function rememberNavigationSnapshot(scope:string,salt:string,key:CryptoKey,data:unknown,channel:'dashboard'|'people'='dashboard',expectedEpoch=mutationEpoch()):Promise<void> {
 const store=storage();if(!store||!scope||!salt)return;
 const epoch=expectedEpoch,identity=authEpoch(),slot=channel==='people'?PEOPLE_CACHE:CACHE;
 if(epoch!==mutationEpoch())return;
 try{
  const created=Date.now();
  const content:Cached={format:'payroll-navigation-snapshot-v1',scope,salt,created,expires:created+SNAPSHOT_TTL_MS,data,epoch};
  const encrypted=await encryptJson('snapshot',content,key);
  if(encrypted.length>MAX_CIPHER_LENGTH){if(epoch===mutationEpoch()&&identity===authEpoch())store.removeItem(slot);return;}
  // A mutation may start while Web Crypto is encrypting. Never reinsert that stale view.
  if(epoch!==mutationEpoch()||identity!==authEpoch())return;
  store.setItem(slot,encrypted);
 }catch{if(epoch===mutationEpoch()&&identity===authEpoch())try{store.removeItem(slot);}catch{}}
}
export async function restoredNavigationSnapshot(scope:string,salt:string,key:CryptoKey,channel:'dashboard'|'people'='dashboard'):Promise<{data:unknown;expires:number}|null> {
 const store=storage();if(!store)return null;
 const slot=channel==='people'?PEOPLE_CACHE:CACHE,epoch=mutationEpoch(),identity=authEpoch();
 let encrypted:string|null=null;
 const discard=()=>{try{if(store.getItem(slot)===encrypted)store.removeItem(slot);}catch{}};
 try{
  encrypted=store.getItem(slot);
  if(!encrypted)return null;
  if(encrypted.length>MAX_CIPHER_LENGTH){discard();return null;}
  const cached=await decryptJson<Cached>('snapshot',encrypted,key);
  if(epoch!==mutationEpoch()||identity!==authEpoch()||store.getItem(slot)!==encrypted)return null;
  const now=Date.now();
  if(cached?.format!=='payroll-navigation-snapshot-v1'||cached.scope!==scope||cached.salt!==salt||cached.epoch!==epoch||
     !Number.isFinite(cached.created)||!Number.isFinite(cached.expires)||
     cached.created>now||cached.expires<=now||cached.expires-cached.created!==SNAPSHOT_TTL_MS){
   discard();return null;
  }
  return {data:cached.data,expires:cached.expires};
 }catch{discard();return null;}
}
