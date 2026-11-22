/** Payroll-only browser key vault. IndexedDB stores a structured-cloned, non-extractable
 * CryptoKey and minimal account/vault identity. NO passphrase, raw key, PDF or tokens.
 * This DB is intentionally unrelated to the retired payroll-local-v1 data store. */
export const BROWSER_KEY_DB = 'payroll-remembered-browser-key-v1';
const STORE = 'keys';
const VAULT = 'Payroll:graph-appfolder:payroll/index.enc:v1';
export interface RememberedBrowserKey {
 version:1;
 scope:string;
 vault:string;
 salt:string;
 generation:string|null;
 key:CryptoKey;
}
function validKey(key:unknown):key is CryptoKey {
 if(!key||typeof key!=='object')return false;
 const value=key as CryptoKey;
 return value.type==='secret'&&value.extractable===false&&value.algorithm?.name==='AES-GCM'&&
  (value.algorithm as AesKeyAlgorithm).length===256&&Array.isArray(value.usages)&&
  value.usages.includes('decrypt')&&value.usages.includes('encrypt');
}
function validSalt(value:unknown):value is string {
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(value))return false;
 try{return atob(value).length===16;}catch{return false;}
}
function open():Promise<IDBDatabase> {
 if(typeof indexedDB==='undefined')return Promise.reject(new Error('このブラウザでは鍵の永続保存を利用できません。'));
 return new Promise((resolve,reject)=>{
  let request:IDBOpenDBRequest;
  try{request=indexedDB.open(BROWSER_KEY_DB,1);}catch(error){reject(error);return;}
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'scope'});};
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
  request.onerror=()=>reject(request.error??new Error('鍵の保存領域を開けません。'));
  request.onblocked=()=>reject(new Error('別のタブで保存領域が使用されています。'));
 });
}
async function operate<T>(mode:IDBTransactionMode,action:(store:IDBObjectStore,finish:(value:T)=>void)=>void):Promise<T> {
 const db=await open();
 try{return await new Promise<T>((resolve,reject)=>{
  let result:T;let tx:IDBTransaction;
  try{tx=db.transaction(STORE,mode);action(tx.objectStore(STORE),value=>{result=value;});}
  catch(error){reject(error);return;}
  tx.oncomplete=()=>resolve(result);
  tx.onerror=()=>reject(tx.error??new Error('鍵の保存領域でエラーが発生しました。'));
  tx.onabort=()=>reject(tx.error??new Error('鍵の保存処理が中断されました。'));
 });}finally{db.close();}
}
export async function readRememberedBrowserKey(scope:string):Promise<RememberedBrowserKey|null> {
 const entry=await operate<unknown>('readonly',(store,finish)=>{
  const request=store.get(scope);
  request.onsuccess=()=>finish(request.result);
 });
 if(entry===undefined||entry===null)return null;
 const record=entry as Partial<RememberedBrowserKey>;
 if(record.version!==1||record.scope!==scope||record.vault!==VAULT||
  !validSalt(record.salt)||!(record.generation===null||(typeof record.generation==='string'&&/^[0-9a-f-]{36}$/i.test(record.generation)))||
  !validKey(record.key)) {
  // Invalid local metadata/key may be removed; a temporary IndexedDB failure is not invalidity.
  await forgetRememberedBrowserKey(scope);
  return null;
 }
 return record as RememberedBrowserKey;
}
export async function saveRememberedBrowserKey(scope:string,key:CryptoKey,salt:string,generation:string|null):Promise<void> {
 if(!scope||scope.length>250||!validKey(key)||!validSalt(salt)||
  !(generation===null||/^[0-9a-f-]{36}$/i.test(generation)))throw new Error('記憶する暗号鍵の形式が不正です。');
 const record:RememberedBrowserKey={version:1,scope,vault:VAULT,key,salt,generation};
 await operate<void>('readwrite',(store,finish)=>{store.put(record);finish(undefined);});
}
export async function forgetRememberedBrowserKey(scope:string):Promise<void> {
 await operate<void>('readwrite',(store,finish)=>{store.delete(scope);finish(undefined);});
}
/** Explicit shared-device sign-out revokes all Payroll-origin saved keys,
 * including other Microsoft accounts once cached in this browser. */
export async function forgetAllRememberedBrowserKeys():Promise<void> {
 await operate<void>('readwrite',(store,finish)=>{store.clear();finish(undefined);});
}
