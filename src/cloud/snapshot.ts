/** Tab-scoped *encrypted* read-only view cache. OneDrive remains the sole durable source.
 * No plaintext salary metadata, PDFs, or passphrases are written to browser storage.
 * A restored snapshot is display-only: every mutation still revalidates OneDrive. */
import {encryptJson,decryptJson} from './crypto';
const CACHE='payroll-navigation-snapshot-v1';
const EPOCH='payroll-navigation-write-epoch-v1';
const AUTH_EPOCH='payroll-navigation-identity-epoch-v1';
export const SNAPSHOT_TTL_MS=120_000;
const MAX_CIPHER_LENGTH=2_500_000;
interface Cached {format:'payroll-navigation-snapshot-v1';scope:string;salt:string;created:number;expires:number;data:unknown}
function storage():Storage|null {try{return typeof sessionStorage==='undefined'?null:sessionStorage;}catch{return null;}}
export function clearNavigationSnapshot():void {try{storage()?.removeItem(CACHE);}catch{}}
/** Mutations invalidate on *attempt*, including a partially completed multi-file restore. */
export function invalidateNavigationSnapshot():void {
 clearNavigationSnapshot();
 try{storage()?.setItem(EPOCH,crypto.randomUUID());}catch{}
}
export function mutationEpoch():string {try{return storage()?.getItem(EPOCH)??'';}catch{return '';}}
export function authEpoch():string {try{return storage()?.getItem(AUTH_EPOCH)??'';}catch{return '';}}
/** A changed Microsoft identity invalidates any bfcache page holding the previous account. */
export function invalidateAuthSession():void {
 invalidateNavigationSnapshot();
 try{storage()?.setItem(AUTH_EPOCH,crypto.randomUUID());}catch{}
}
export async function rememberNavigationSnapshot(scope:string,salt:string,key:CryptoKey,data:unknown):Promise<void> {
 const store=storage();if(!store||!scope||!salt)return;
 const epoch=mutationEpoch();
 try{
  const created=Date.now();
  const content:Cached={format:'payroll-navigation-snapshot-v1',scope,salt,created,expires:created+SNAPSHOT_TTL_MS,data};
  const encrypted=await encryptJson('snapshot',content,key);
  if(encrypted.length>MAX_CIPHER_LENGTH){clearNavigationSnapshot();return;}
  // A mutation may start while Web Crypto is encrypting. Never reinsert that stale view.
  if(epoch!==mutationEpoch())return;
  store.setItem(CACHE,encrypted);
 }catch{clearNavigationSnapshot();}
}
export async function restoredNavigationSnapshot(scope:string,salt:string,key:CryptoKey):Promise<{data:unknown;expires:number}|null> {
 const store=storage();if(!store)return null;
 try{
  const encrypted=store.getItem(CACHE);
  if(!encrypted)return null;
  if(encrypted.length>MAX_CIPHER_LENGTH){clearNavigationSnapshot();return null;}
  const cached=await decryptJson<Cached>('snapshot',encrypted,key);
  const now=Date.now();
  if(cached?.format!=='payroll-navigation-snapshot-v1'||cached.scope!==scope||cached.salt!==salt||
     !Number.isFinite(cached.created)||!Number.isFinite(cached.expires)||
     cached.created>now||cached.expires<=now||cached.expires-cached.created!==SNAPSHOT_TTL_MS){
   clearNavigationSnapshot();return null;
  }
  return {data:cached.data,expires:cached.expires};
 }catch{clearNavigationSnapshot();return null;}
}
