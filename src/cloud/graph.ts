/** Finance v1.1のAppFolder/ETag/事前認証URL方式をPayroll専用APIへ適用。 */
import {MicrosoftSignInRequiredError,MicrosoftTemporaryError} from './msalPolicy.ts';
import {observeGraphTransfer,observeGraphRetry} from './perf.ts';
const BASE = 'https://graph.microsoft.com/v1.0';
// Graph のスロットリングと一時障害だけを、読み取り専用で再試行する。
// Retry-After が待機上限を超える場合は早めに再送せず、呼び出し元へエラーを返す。
const TEMPORARY_READ_STATUSES = new Set([408,429,500,502,503,504]);
const READ_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30_000;
function retryWaitMs(response:Response, retry:number):number|null {
  const retryAfter=response.headers.get('Retry-After')?.trim();
  if(retryAfter) {
    let ms:number;
    if(/^\d+(?:\.\d+)?$/.test(retryAfter))ms=Number(retryAfter)*1000;
    else {
      const at=Date.parse(retryAfter);
      if(!Number.isFinite(at))return Math.min(350*2**retry,MAX_RETRY_WAIT_MS);
      ms=Math.max(0,at-Date.now());
    }
    return Number.isFinite(ms)&&ms<=MAX_RETRY_WAIT_MS?Math.max(0,Math.ceil(ms)):null;
  }
  return 350*2**retry;
}
const pause=(ms:number):Promise<void>=>new Promise(resolve=>setTimeout(resolve,ms));
// The cache contains only encrypted JSON text in RAM. It never stores PDF originals,
// a plaintext payroll record, an OAuth token, or a decryption key.
const MAX_CACHED_ENCRYPTED_BYTES=1_048_576;
const MAX_TOTAL_CACHED_ENCRYPTED_BYTES=4_194_304;
const MAX_CACHED_ENCRYPTED_FILES=8;
interface CachedEncryptedRead {file:RemoteFile;bytes:number}


export interface RemoteFile { id: string; etag: string; text: string; size?: number; }
export interface NewWriteReceipt {id:string;etag:string;size:number;name:string}
interface Item { parentReference?:{id?:string}; id?: string; name?: string; folder?: Record<string,unknown>; eTag?: string; size?: number; '@microsoft.graph.downloadUrl'?: string }
export class GraphError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(status===403?'OneDriveへのアクセス権限がありません。Microsoftの接続権限を確認してください（HTTP 403）。':status===401?'Microsoft認証が無効です。再接続後にOneDriveの状態を確認してください（HTTP 401）。':`OneDrive通信エラー HTTP ${status}${code ? ` (${code})` : ''}`);
  }
}
/** Distinguish an explicit mutation rejection from a failed read with the same status. */
export class GraphWriteRejectedError extends GraphError {}
// Explicit Graph rejections are not lost write replies. Do not resend mutations.
const rejectedWriteStatus=(status:number):boolean=>[401,403,409,412,429].includes(status);
export const isCollision = (e: unknown): boolean => e instanceof GraphError && (e.status === 409 || e.status === 412);
export interface CloudFolderItem {id:string;name:string;etag:string;folder:boolean;size:number}
// A generation-independent sibling of payroll/, shared by personal and year-end writes.
// The body is random ownership evidence only: no account, salary, key or timestamp.
export const PAYROLL_WRITE_LOCK_NAME='payroll-write-lock-v1.bin';
type WriteOwner={id:string;etag:string;text:string};
/** Per-operation, in-memory evidence. Lock-file writes are not payroll data writes. */
export interface PayrollWriteState {attempted:boolean;uncertain:boolean;completed:boolean;payrollSaved?:boolean;lock:'none'|'held'|'released'|'unknown'}
class GraphReadStageError extends Error {
  constructor(readonly stage:'auth'|'transport',cause:unknown){super(stage,{cause});}
}
const LOCK_RETAINED='書き込みロックが残っている可能性があります。再保存せず、設定の書き込みロック復旧手順を確認してください。';
export class PayrollGraph {
  private writeLockBusy=false;
  private writeOwner:WriteOwner|null=null;
  private writeAttempted=false;
  private uncertainWrites=0;
  private get writeUncertain():boolean{return this.uncertainWrites!==0;}
  private markUncertain(proof?:{uncertain:boolean}):void{
    if(proof?.uncertain)return;
    if(proof)proof.uncertain=true;
    this.uncertainWrites++;
  }
  // A rejection cannot invalidate an earlier verified checkpoint. Parallel
  // requests are counted individually; checkpoints are taken after all workers settle.
  private markRejected():void{this.writeSerial--;this.writeAttempted=this.writeSerial>0;}
  private writeSerial=0;
  private uploadCheckpoint=-1;
  /** Called only after an upload batch has authenticated every preceding business write. */
  async markUploadCheckpoint():Promise<void> {
    if(this.writeOwner&&!this.writeUncertain){
      this.uploadCheckpoint=this.writeSerial;
      await this.publishCheckpointReceipt();
    }
  }
  // Reuse the exact-owner receipt. A Web Lock protects it while the browser
  // operation is alive. No age, salary, key, account, or pending request is stored.
  private checkpointReceipt:string|null=null;
  private checkpointPublished=false;
  private checkpointRemoval:Promise<void>|null=null;
  private browserLocks():LockManager|undefined{
    try{return typeof navigator==='undefined'?undefined:navigator.locks;}catch{return undefined;}
  }
  // Unlike localStorage, an explicitly strict IndexedDB transaction can commit
  // revocation before a remote request is dispatched. A stale marker after a
  // browser crash must never authorize deleting a lock for an unknown write.
  // This isolated store contains only the existing opaque owner fingerprint.
  private async checkpointStorage(receipt:string,action:'read'|'put'|'delete'):Promise<boolean>{
    if(typeof indexedDB==='undefined')throw new Error('復旧用の保存領域を利用できません。');
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const req=indexedDB.open('payroll-lock-checkpoints-v1',1);let blocked=false;
      req.onupgradeneeded=()=>req.result.createObjectStore('receipts');
      req.onblocked=()=>{blocked=true;reject(new Error('復旧用の保存領域を開けません。'));};
      req.onerror=()=>reject(req.error);
      req.onsuccess=()=>{if(blocked)req.result.close();else resolve(req.result);};
    });
    try{return await new Promise<boolean>((resolve,reject)=>{
      const tx=action==='read'?db.transaction('receipts','readonly'):db.transaction('receipts','readwrite',{durability:'strict'});
      if(action!=='read'&&tx.durability!=='strict'){tx.abort();reject(new Error('復旧情報の永続化を確認できません。'));return;}
      const store=tx.objectStore('receipts');let exists=false;
      tx.oncomplete=()=>resolve(action==='read'?exists:true);
      tx.onabort=()=>reject(tx.error??new Error('復旧情報の更新が中断されました。'));
      if(action==='read'){const req=store.get(receipt);req.onsuccess=()=>{exists=req.result===1;};}
      else if(action==='put')store.put(1,receipt);
      else store.delete(receipt);
    });}finally{db.close();}
  }
  private async publishCheckpointReceipt():Promise<void>{
    if(!this.checkpointReceipt||this.checkpointPublished)return;
    try{await this.checkpointStorage(this.checkpointReceipt,'put');this.checkpointPublished=true;}catch{/* No persistent recovery without a committed strict transaction. */}
  }
  private async clearCheckpointBeforeWrite():Promise<void>{
    if(!this.checkpointReceipt||!this.checkpointPublished)return;
    const receipt=this.checkpointReceipt;
    // Parallel original transfers share the same durable revocation. Do not
    // dispatch ANY business request until it has committed.
    if(!this.checkpointRemoval)this.checkpointRemoval=this.checkpointStorage(receipt,'delete').then(()=>{this.checkpointPublished=false;});
    try{await this.checkpointRemoval;}
    catch{throw new Error('保存ロックの復旧情報を更新できません。ブラウザの保存設定を確認してください。');}
    finally{this.checkpointRemoval=null;}
  }
  private pendingContentChecks:Array<()=>Promise<boolean>>=[];
  private readonly retainedOwners=new WeakMap<PayrollWriteState,{text:string;owner?:WriteOwner;settled?:boolean;confirm?:()=>Promise<boolean>}>();
  private matchesOwner(live:RemoteFile,owner:WriteOwner):boolean {
    return live.id===owner.id&&live.etag===owner.etag&&live.text===owner.text&&live.size===owner.text.length;
  }
  // Persist only a fingerprint of an owner which is already safe to release.
  // Never store a pending write, account, file path, token or PDF information.
  private async releaseReceipt(owner:WriteOwner):Promise<string|null>{
    try{
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([owner.id,owner.etag,owner.text])));
      return 'payroll-settled-lock-v1:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    }catch{return null;}
  }
  private async recoverSettledOwner():Promise<boolean>{
    const live=await this.read([],PAYROLL_WRITE_LOCK_NAME,64);
    if(!live||!live.id||!live.etag||!(/^[a-f0-9]{64}$/.test(live.text))||live.size!==64)return false;
    const owner={id:live.id,etag:live.etag,text:live.text};
    const receipt=await this.releaseReceipt(owner);
    if(!receipt)return false;
    let settled=false;
    try{settled=localStorage.getItem(receipt)==='1';}catch{}
    if(settled){
      await this.releaseOwner(owner);
      if(this.browserLocks())try{await this.checkpointStorage(receipt,'delete');}catch{}
      return true;
    }
    const locks=this.browserLocks();
    if(!locks)return false;
    // Only the same browser storage partition can prove the exact checkpoint
    // and absence of its active owner. Other tabs/devices cannot steal a lock.
    return locks.request(receipt,{ifAvailable:true},async lock=>{
      if(!lock)return false;
      try{if(!await this.checkpointStorage(receipt,'read'))return false;}catch{return false;}
      await this.releaseOwner(owner); // fresh identity, ETag and conditional DELETE
      try{await this.checkpointStorage(receipt,'delete');}catch{}
      return true;
    });
  }
  /** A missing lock after a conditional DELETE is evidence of release, not of
   * payroll failure. A different owner is never deleted. */
  private async releaseOwner(owner:WriteOwner):Promise<void>{
    const receipt=await this.releaseReceipt(owner);
    try{if(receipt)localStorage.setItem(receipt,'1');}catch{/* Storage may be disabled; same-tab recovery remains available. */}
    const live=await this.read([],PAYROLL_WRITE_LOCK_NAME,64);
    if(!live||!this.matchesOwner(live,owner))throw new Error('書き込みロックの所有権が変化しました。解除しません。');
    try{
      const response=await this.request(`/me/drive/items/${encodeURIComponent(owner.id)}`,{
        method:'DELETE',headers:{'If-Match':owner.etag},
      },false,undefined,true);
      if(response.status!==204)throw new Error('書き込みロックの解除結果を確認できません。');
    }catch(error){
      const current=await this.read([],PAYROLL_WRITE_LOCK_NAME,64);
      if(current)throw error;
      // The known item is gone. No data write is retried here.
    }
    try{if(receipt)localStorage.removeItem(receipt);}catch{}
    if(receipt&&this.checkpointReceipt===receipt&&this.checkpointPublished){
      try{await this.checkpointStorage(receipt,'delete');}catch{}
      this.checkpointPublished=false;
    }
  }
  private markReleased(state?:PayrollWriteState):void{
    if(state){state.lock='released';this.retainedOwners.delete(state);}
  }
  private requireWriteOwner():void {
    if((this.enforceOperationLock||this.writeLockBusy)&&!this.writeOwner)
      throw new Error('書き込みロックを取得していないため、OneDriveへの変更を拒否しました。');
  }
  private async verifyWriteOwner():Promise<void> {
    this.requireWriteOwner();
    const owner=this.writeOwner;if(!owner)return;
    const current=await this.metadata([],PAYROLL_WRITE_LOCK_NAME);
    if(!current||current.id!==owner.id||current.etag!==owner.etag||current.size!==owner.text.length)
      throw new Error('書き込みロックの所有権が変化しました。保存を中断しました。');
    this.assertCurrent();
  }
  /** The lock is never expired or stolen. A lost reply must not authorize a write.
   * Hold across the complete multi-file operation and its readbacks, not per PUT. */
  async withWriteLock<T>(operation:()=>Promise<T>,state?:PayrollWriteState,releaseSettledFailure=false):Promise<T> {
    this.assertCurrent();
    if(this.writeLockBusy)throw new Error('この画面で別の保存処理を実行中です。完了後に読み直してください。');
    this.writeLockBusy=true;this.writeAttempted=false;this.uncertainWrites=0;this.writeSerial=0;this.uploadCheckpoint=-1;this.pendingContentChecks=[];
    try {
      const parent=await this.root();
      const text=(crypto.randomUUID()+crypto.randomUUID()).replace(/-/g,'');
      const path=`/me/drive/items/${encodeURIComponent(parent)}:/${PAYROLL_WRITE_LOCK_NAME}:/content?@microsoft.graph.conflictBehavior=fail`;
      let created:Item;
      const evidence:{text:string;owner?:WriteOwner;settled?:boolean;confirm?:()=>Promise<boolean>}={text};
      if(state){state.lock='unknown';this.retainedOwners.set(state,evidence);}
      let acquisitionSent=false,creationStatus:number|undefined;
      for(let recovery=0;;recovery++){
      try {
        const response=await this.request(path,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:new TextEncoder().encode(text)},false,async()=>{acquisitionSent=true;},true);
        creationStatus=response.status;
        if(response.status!==201)throw new Error('ロック新規作成の応答が不正です。');
        created=await response.json() as Item;
        if(!created.id||!created.eTag||created.name!==PAYROLL_WRITE_LOCK_NAME||created.size!==text.length)
          throw new Error('書き込みロックの作成結果が一致しません。');
        evidence.owner={id:created.id,etag:created.eTag,text};
        const proof=await this.read([],PAYROLL_WRITE_LOCK_NAME,64);
        if(!proof||!this.matchesOwner(proof,evidence.owner))throw new Error('書き込みロックの所有権を確認できません。');
      }catch(error){
        if(!acquisitionSent||(creationStatus===undefined&&error instanceof GraphError&&rejectedWriteStatus(error.status))){
          if(state){state.lock='none';this.retainedOwners.delete(state);}
          if(acquisitionSent&&isCollision(error)){
            if(recovery===0&&await this.recoverSettledOwner()){
              acquisitionSent=false;creationStatus=undefined;
              if(state){state.lock='unknown';this.retainedOwners.set(state,evidence);}
              continue;
            }
            throw new Error('他の端末・タブで保存中か、前回の書き込みロックが残っています。設定の書き込みロック復旧手順を確認してください。');
          }
          throw error;
        }
        // A 200 (replacement) or other unexpected successful status cannot
        // establish that this was a newly created lock. Never delete it here.
        if(creationStatus!==undefined&&creationStatus!==201){
          if(state)this.retainedOwners.delete(state);
          throw new Error('書き込みロックの新規作成を確認できません。'+LOCK_RETAINED,{cause:error});
        }
        // No business write was started. The random body can prove that a
        // lost creation reply belongs to this operation, but a 404 cannot.
        try{
          const live=await this.read([],PAYROLL_WRITE_LOCK_NAME,64);
          if(!live||live.text!==text||live.size!==text.length||(evidence.owner&&!this.matchesOwner(live,evidence.owner)))throw new Error('取得結果が不明です。');
          evidence.owner={id:live.id,etag:live.etag,text};
          await this.releaseOwner(evidence.owner);
          this.markReleased(state);
        }catch(recovery){throw new Error('書き込みロックの取得を確認できません。'+LOCK_RETAINED,{cause:recovery});}
        throw new Error('保存ロックの取得を完了できませんでした。ロックは解除しました。そのまま再試行できます。',{cause:error});
      }
      break;
      }
      this.writeOwner=evidence.owner!;
      if(state)state.lock='held';
      const runOwned=async():Promise<T>=>{
        const release=async()=>{await this.releaseOwner(this.writeOwner!);this.markReleased(state);};
        let result:T;
        try{result=await operation();}
        catch(error){
          // Only the verified payroll checkpoint or a derived-data-only operation
          // may release after a settled failure. Other multi-file mutations retain
          // the old policy, and an unknown write always retains protection.
          evidence.settled=!this.writeUncertain&&(state?.payrollSaved===true||releaseSettledFailure||(state!==undefined&&this.uploadCheckpoint===this.writeSerial));
          // Only a verified payroll checkpoint / derived-only operation can use
          // delayed positive content proofs. Never treat a partial annual commit as settled.
          if(state&&(state.payrollSaved||releaseSettledFailure)&&this.uncertainWrites>0&&this.pendingContentChecks.length===this.uncertainWrites){
            const checks=[...this.pendingContentChecks];
            evidence.confirm=async()=>{for(const check of checks)if(!await check())return false;return true;};
          }
          if(this.writeUncertain||(this.writeAttempted&&!evidence.settled)){
            if(error instanceof Error){error.message+=' '+LOCK_RETAINED;throw error;}
            throw new Error(LOCK_RETAINED,{cause:error});
          }
          try{await release();}catch(releaseError){if(state)state.lock='unknown';throw new Error('保存ロックの所有権または解除結果を確認できません。'+LOCK_RETAINED,{cause:releaseError});}
          throw error;
        }
        if(this.writeUncertain)throw new Error('保存中の通信結果が不明です。'+LOCK_RETAINED);
        if(state)state.completed=true;
        try{await release();}catch(error){if(state)state.lock='unknown';throw new Error('保存処理は完了しましたが、書き込みロックの解除を確認できません。再保存せず最新データを確認してください。'+LOCK_RETAINED,{cause:error});}
        return result;
      };
      const locks=this.browserLocks(),receipt=locks?await this.releaseReceipt(this.writeOwner):null;
      if(!locks||!receipt)return await runOwned();
      // The remote lock has already been verified. Hold the browser guard for
      // the entire operation, including release, before publishing a marker.
      let callbackStarted=false;
      try{return await locks.request(receipt,{ifAvailable:true},async lock=>{
        callbackStarted=true;
        if(!lock)throw new Error('同じブラウザで保存ロックの確認中です。再試行してください。');
        this.checkpointReceipt=receipt;await this.publishCheckpointReceipt();
        return await runOwned();
      });}catch(error){
        // Unsupported/disabled Web Locks must not break ordinary saves. Never
        // retry a callback that has started, and never bypass a busy guard.
        if(!callbackStarted)return await runOwned();
        throw error;
      }
    }finally{if(state){state.attempted=this.writeAttempted;state.uncertain=this.writeUncertain;}this.writeOwner=null;this.writeLockBusy=false;this.writeAttempted=false;this.uncertainWrites=0;this.pendingContentChecks=[];this.checkpointReceipt=null;this.checkpointPublished=false;this.checkpointRemoval=null;}
  }

  /** Only reconcile a lock belonging to this exact in-memory operation. Positive
   * content proofs can settle a lost final reply after a verified payroll checkpoint. */
  async reconcileUploadLock(state:PayrollWriteState):Promise<void>{
    if(state.lock==='none'||state.lock==='released')return;
    this.assertCurrent();
    if(this.writeLockBusy)throw new Error('別の保存処理が進行中です。');
    this.writeLockBusy=true;
    try{
      const evidence=this.retainedOwners.get(state);
      if(!evidence||(state.uncertain&&!evidence.confirm)||(state.attempted&&!state.completed&&!evidence.settled&&!evidence.confirm))
        throw new Error('安全に解除できない保存ロックがあります。設定の書き込みロック復旧手順を確認してください。');
      const live=await this.read([],PAYROLL_WRITE_LOCK_NAME,64);
      if(!live){
        // A creation that may still arrive is not resolved by a single 404.
        if(!evidence.owner)throw new Error('保存ロックの作成結果がまだ不明です。再保存せず確認してください。');
        if(state.uncertain)throw new Error('書き込み結果がまだ不明です。再保存せず確認してください。');
        this.markReleased(state);return;
      }
      if(live.text!==evidence.text||live.size!==evidence.text.length||(evidence.owner&&!this.matchesOwner(live,evidence.owner)))
        throw new Error('安全に解除できない保存ロックがあります。設定の書き込みロック復旧手順を確認してください。');
      if(state.uncertain){
        if(!evidence.confirm||!await evidence.confirm())throw new Error('書き込み結果がまだ不明です。再保存せず確認してください。');
        state.uncertain=false;evidence.settled=true;delete evidence.confirm;
      }
      evidence.owner={id:live.id,etag:live.etag,text:live.text};
      await this.releaseOwner(evidence.owner);
      this.markReleased(state);
    }finally{this.writeLockBusy=false;}
  }

  private rootId: string | undefined;
  private rootPending:Promise<string>|undefined;
  private folders = new Map<string,string>();
  private folderPending = new Map<string,Promise<string|null>>();
  private encryptedReadCache=new Map<string,CachedEncryptedRead>();
  private encryptedReadCacheBytes=0;
  private encryptedReadPending=new Map<string,{epoch:number;promise:Promise<RemoteFile|null>}>();
  private readCacheEpoch=0;
  private clearEncryptedReadCache():void {
    this.readCacheEpoch++;
    this.encryptedReadCache.clear();this.encryptedReadCacheBytes=0;
  }
  private discardEncryptedRead(key:string):void {
    const value=this.encryptedReadCache.get(key);
    if(value){this.encryptedReadCacheBytes-=value.bytes;this.encryptedReadCache.delete(key);}
  }
  private rememberEncryptedRead(key:string,file:RemoteFile,bytes:number):void {
    this.discardEncryptedRead(key);
    if(bytes>MAX_CACHED_ENCRYPTED_BYTES||bytes<1)return;
    while(this.encryptedReadCache.size>=MAX_CACHED_ENCRYPTED_FILES ||
       this.encryptedReadCacheBytes+bytes>MAX_TOTAL_CACHED_ENCRYPTED_BYTES){
      const oldest=this.encryptedReadCache.keys().next().value;
      if(oldest===undefined)break;
      this.discardEncryptedRead(oldest);
    }
    this.encryptedReadCache.set(key,{file:{...file},bytes});
    this.encryptedReadCacheBytes+=bytes;
  }

  constructor(private readonly token: string | (() => Promise<string>), private readonly http: typeof fetch = (url, init) => globalThis.fetch(url, init), private readonly onMutation:()=>void=()=>{}, private readonly unauthorized?:{invalidate:()=>void;refresh:()=>Promise<string>},private readonly assertCurrent:()=>void=()=>{},private readonly enforceOperationLock=true) {}
  private async request(path: string, init: RequestInit = {}, accept304=false,beforeSend?:()=>Promise<void>,lockControl=false,proof?:{uncertain:boolean}): Promise<Response> {
    this.assertCurrent();
    const method=(init.method??'GET').toUpperCase();
    const readonly=method==='GET'||method==='HEAD';
    if(!readonly&&!lockControl){this.requireWriteOwner();this.clearEncryptedReadCache();this.onMutation();}
    let bearer:string;
    try{bearer=typeof this.token==='function'?await this.token():this.token;}
    catch(error){if(readonly&&!(error instanceof MicrosoftSignInRequiredError)&&!(error instanceof MicrosoftTemporaryError))throw new GraphReadStageError('auth',error);throw error;}
    let dispatched=false;
    this.assertCurrent();
    const graphUrl=`${BASE}${path}`;
    const send=async()=>{
      const started=performance.now();
      dispatched=false;
      this.assertCurrent();
      if(beforeSend){await beforeSend();this.assertCurrent();}
      if(!readonly&&!lockControl){await this.clearCheckpointBeforeWrite();await this.verifyWriteOwner();if(this.writeOwner){this.writeAttempted=true;this.writeSerial++;}}
      try{dispatched=true;const response=await this.http(graphUrl,{...init,headers:{Authorization:`Bearer ${bearer}`,...init.headers},redirect:'error'});this.assertCurrent();return response;}
      finally{observeGraphTransfer('graph-api',performance.now()-started);}
    };
    let retries=0,renewed=false;
    for (;;) {
      let r:Response;
      try {r=await send();}
      catch(error){
        if(!readonly&&!lockControl&&this.writeOwner&&dispatched)this.markUncertain(proof);
        this.assertCurrent(); // A retired session is not a transient network failure.
        // GET/HEAD だけ、通信中断にも限定回数のバックオフを適用。
        if(readonly&&dispatched&&retries<READ_RETRIES){observeGraphRetry();await pause(350*2**retries++);continue;}
        if(readonly&&dispatched)throw new GraphReadStageError('transport',error);
        throw error;
      }
      if(r.status===401&&this.unauthorized&&!renewed){
        this.unauthorized.invalidate();
        if(readonly){
          // 期限切れ認証は別系統の一回限りの再取得。書き込みは再送しない。
          observeGraphRetry();renewed=true;
          try{bearer=await this.unauthorized.refresh();}catch(error){if(error instanceof MicrosoftSignInRequiredError||error instanceof MicrosoftTemporaryError)throw error;throw new GraphReadStageError('auth',error);}
          this.assertCurrent();
          continue;
        }
      }
      if(readonly&&TEMPORARY_READ_STATUSES.has(r.status)&&retries<READ_RETRIES){
        const delay=retryWaitMs(r,retries);
        if(delay!==null){
          try{await r.body?.cancel();}catch{/* レスポンス本体を診断に使わない */}
          observeGraphRetry();retries++;await pause(delay);continue;
        }
      }
      // HTTP 304 is allowed only by an explicitly conditional, read-only caller.
      if (!r.ok && !(readonly&&accept304&&r.status===304)) {
        if(!readonly&&!lockControl&&this.writeOwner){
          if(rejectedWriteStatus(r.status))this.markRejected();else this.markUncertain(proof);
        }
        let code = '';
        try { const v = await r.json() as {error?:{code?:string}}; code = (v.error?.code ?? '').slice(0,80); } catch {}
        this.assertCurrent();
        throw !readonly&&!lockControl&&rejectedWriteStatus(r.status)
          ? new GraphWriteRejectedError(r.status,code) : new GraphError(r.status,code);
      }
      this.assertCurrent();
      return r;
    }
  }
  /** 署名付き原本ダウンロードURLもBearerなしのGETだけ再試行する。 */
  private async download(url:string):Promise<Response> {
    for(let retry=0;;){
      this.assertCurrent();
      let response:Response;
      try {
        const started=performance.now();
        try{response=await this.http(url,{credentials:'omit',cache:'no-store'});this.assertCurrent();}
        finally{observeGraphTransfer('encrypted-download',performance.now()-started);}
      }
      catch(error){this.assertCurrent();if(retry>=READ_RETRIES)throw error;observeGraphRetry();await pause(350*2**retry++);continue;}
      if(TEMPORARY_READ_STATUSES.has(response.status)&&retry<READ_RETRIES){
        const delay=retryWaitMs(response,retry);
        if(delay!==null){
          try{await response.body?.cancel();}catch{}
          observeGraphRetry();retry++;await pause(delay);continue;
        }
      }
      this.assertCurrent();
      return response;
    }
  }

  /**
   * Graph の GET メタデータ応答だけを検証して再試行する。
   * OneDrive の暗号文は解析せず、書き込み・削除の再試行も行わない。
   * URL・トークン・生のレスポンスはエラーやログへ含めない。
   */
  private async readMetadata<T>(path:string,stage:string):Promise<T>;
  private async readMetadata<T>(path:string,stage:string,etag:string):Promise<T|null>;
  private async readMetadata<T>(path:string,stage:string,etag?:string):Promise<T|null> {
    for(let attempt=1;attempt<=3;attempt++) {
      let response:Response;
      try {
        response=await this.request(path,{
          method:'GET',cache:'no-store',headers:{'Accept':'application/json',
            ...(etag?{'If-None-Match':etag}:{})},
        },Boolean(etag));
        this.assertCurrent();
        if(response.status===304)return null;
      }catch(error){
        if(error instanceof GraphError||error instanceof MicrosoftSignInRequiredError||error instanceof MicrosoftTemporaryError)throw error;
        const reason=error instanceof GraphReadStageError?(error.stage==='auth'?'認証処理で失敗しました（次の照会リクエスト送信前）':'OneDriveへの照会通信に失敗しました（再試行上限）'):'照会処理を完了できませんでした';
        throw new Error(`${stage}：${reason}。`,{cause:error});
      }
      const contentType=(response.headers.get('content-type')??'unknown').split(';')[0].trim().toLowerCase();
      const contentLength=response.headers.get('content-length');
      if(contentLength && Number(contentLength)>1_048_576)
        throw new Error(`${stage}：Graphのメタデータ応答が大きすぎます。`);
      let body:string;
      try {body=await response.text();}
      catch(error){throw new Error(`${stage}：Graphの応答本文を取得できません。`,{cause:error});}
      this.assertCurrent();
      if(new TextEncoder().encode(body).byteLength>1_048_576)
        throw new Error(`${stage}：Graphのメタデータ応答が大きすぎます。`);
      try {
        const parsed:unknown=JSON.parse(body.replace(/^\uFEFF/,''));
        if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))
          throw new SyntaxError('Graph metadata is not a JSON object');
        return parsed as T;
      }catch(error){
        if(!(error instanceof SyntaxError))throw error;
        if(attempt<3){await new Promise<void>(resolve=>setTimeout(resolve,150*attempt));continue;}
        const actualBytes=new TextEncoder().encode(body).byteLength;
        const declaredBytes=contentLength!==null&&/^\d+$/.test(contentLength)?Number(contentLength):null;
        const encoding=response.headers.get('content-encoding');
        // Content-Length は転送時（圧縮前後）の数値の場合がある。圧縮中は不一致を破損と断定しない。
        const lengthStatus=declaredBytes===null?'Content-Length不明':`Content-Length ${declaredBytes}バイト、取得後 ${actualBytes}バイト${encoding?'（転送圧縮あり・直接比較不可）':declaredBytes!==actualBytes?'（サイズ不一致）':''}`;
        throw new Error(`${stage}：Graph APIのメタデータJSONが不正です（HTTP ${response.status}、MIME ${contentType}、本文 ${body.length}文字、${lengthStatus}、3回試行）。`,{cause:error});
      }
    }
    throw new Error(`${stage}：Graphのメタデータ取得に失敗しました。`);
  }
  private async root(): Promise<string> {
    this.assertCurrent();
    if (this.rootId) return this.rootId;
    if (!this.rootPending) this.rootPending = (async()=>{
      const item=await this.readMetadata<Item>('/me/drive/special/approot','AppFolderの照会');
      if (!item.id) throw new Error('AppFolderが見つかりません。');
      this.assertCurrent();
      return (this.rootId=item.id);
    })();
    const pending=this.rootPending;
    try{const result=await pending;this.assertCurrent();return result;}finally{if(this.rootPending===pending)this.rootPending=undefined;}
  }
  /**
   * `versions` は Graph でも DriveItem の履歴一覧リソース名。
   * /items/{parent}:/versions のパス指定では API ルートと衝突し得るため、
   * 親IDの children を列挙し、name が厳密一致するフォルダーを探す。
   * 暗号化ファイルは読み書きしない。ページングも同一Graph URLに限定する。
   */
  private async reservedFolder(parent: string, name: string): Promise<Item | null> {
    const endpoint = `/me/drive/items/${encodeURIComponent(parent)}/children`;
    let path = `${endpoint}?$select=id,name,folder&$top=200`;
    for(let page=0;page<50;page++) {
      const response = await this.readMetadata<{value?:Item[]; '@odata.nextLink'?:string}>(path,'保存世代フォルダー一覧の照会');
      if(!Array.isArray(response.value))
        throw new Error('保存世代フォルダーの一覧形式が不正です。クラウドは変更していません。');
      const matches = response.value.filter(item=>item.name===name);
      if(matches.length>1)
        throw new Error('同名の保存世代フォルダーが複数存在します。クラウドは変更していません。');
      if(matches.length===1) {
        const found=matches[0];
        if(!found.id || !found.folder || typeof found.folder!=='object')
          throw new Error('保存世代の名前と一致する項目はフォルダーではありません。クラウドは変更していません。');
        return found;
      }
      const next=response['@odata.nextLink'];
      if(!next)return null;
      let url: URL;
      try {url=new URL(next);}catch{throw new Error('GraphのページングURLが不正です。クラウドは変更していません。');}
      if(url.protocol!=='https:' || url.hostname!=='graph.microsoft.com' || url.port ||
         url.username || url.password || url.pathname!==`/v1.0${endpoint}`)
        throw new Error('GraphのページングURLが許可された範囲外です。クラウドは変更していません。');
      path=url.pathname.slice('/v1.0'.length)+url.search;
    }
    throw new Error('保存世代フォルダーの一覧が多すぎます。クラウドは変更していません。');
  }
  private async folder(parts: string[], create: boolean): Promise<string | null> {
    this.assertCurrent();
    if (!parts.length) return this.root();
    const cacheKey=parts.join('/');
    const cached=this.folders.get(cacheKey);
    if(cached)return cached;
    const pendingKey=`${create?'create':'read'}:${cacheKey}`;
    const current=this.folderPending.get(pendingKey);
    if(current){const result=await current;this.assertCurrent();return result;}
    const pending=(async():Promise<string|null>=>{
      const parent=await this.folder(parts.slice(0,-1),create);
      if(!parent)return null;
      const name=parts[parts.length-1];
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error('OneDriveのフォルダー名が不正です。');
      // IDだけを取得するために全メタデータを読む必要はない。Graphの巨大な応答を避ける。
      // $select は Graph v1.0 driveItem GET の正式なオプション。
      const lookup=`/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}?$select=id,name,folder`;
      // 通常のフォルダー名は従来の経路を維持する。reserved名だけID一覧検索。
      // Graph の /items/{id}/versions は履歴APIなので、パスとして使ってはいけない。
      const reserved=name==='versions';
      let item:Item|null=null;
      if(reserved) item=await this.reservedFolder(parent,name);
      else {
        try {item=await this.readMetadata<Item>(lookup,'フォルダー階層の照会');}
        catch(e) {if(!(e instanceof GraphError&&e.status===404))throw e;}
      }
      if(!item) {
        if(!create)return null;
        try {
          item=await (await this.request(`/me/drive/items/${encodeURIComponent(parent)}/children`,{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({name,folder:{},'@microsoft.graph.conflictBehavior':'fail'}),
          })).json() as Item;
        }catch(collision) {
          if(!isCollision(collision))throw collision;
          item=reserved
            ? await this.reservedFolder(parent,name)
            : await this.readMetadata<Item>(lookup,'フォルダー階層の照会');
        }
      }
      if(!item?.id)throw new Error('OneDriveのフォルダーIDが取得できません。');
      this.assertCurrent();
      this.folders.set(cacheKey,item.id);
      return item.id;
    })();
    this.folderPending.set(pendingKey,pending);
    try{const result=await pending;this.assertCurrent();return result;}finally{if(this.folderPending.get(pendingKey)===pending)this.folderPending.delete(pendingKey);}
  }
  /** 同時編集検査専用。本文をダウンロードせずETagとサイズだけ取得。 */
  async metadata(parts:string[],name:string):Promise<{id:string;etag:string;size?:number}|null> {
    this.assertCurrent();
    if(!/^[A-Za-z0-9_.-]{1,100}$/.test(name))throw new Error('ファイル名が不正です。');
    const parent=await this.folder(parts,false);
    if(!parent)return null;
    let item:Item;
    try{item=await this.readMetadata<Item>(`/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`,'暗号ファイル情報の照会');}
    catch(e){if(e instanceof GraphError&&e.status===404)return null;throw e;}
    if(!item.id||!item.eTag)throw new Error('クラウドファイルのIDまたはETagがありません。');
    this.assertCurrent();
    return {id:item.id,etag:item.eTag,size:item.size};
  }
  async read(parts: string[], name: string, limit: number, directChild=false): Promise<RemoteFile|null> {
    this.assertCurrent();
    if(!/^[A-Za-z0-9_.-]{1,100}$/.test(name))throw new Error('ファイル名が不正です。');
    const pendingKey=JSON.stringify([parts,name,limit,directChild]);
    const running=this.encryptedReadPending.get(pendingKey);
    if(running?.epoch===this.readCacheEpoch){
      const result=await running.promise;
      this.assertCurrent();
      if(this.readCacheEpoch!==running.epoch)throw new Error('読み込み中に保存操作が完了しました。再読み込みしてください。');
      return result?{...result}:null;
    }
    const operation=this.readEncryptedUnshared(parts,name,limit,directChild);
    const entry={epoch:this.readCacheEpoch,promise:operation};
    this.encryptedReadPending.set(pendingKey,entry);
    try{
      const result=await operation;
      this.assertCurrent();
      // Also guard the final promise handoff, including a concurrent 404 and a
      // completed read whose result was waiting for the caller's continuation.
      if(this.readCacheEpoch!==entry.epoch)throw new Error('読み込み中に保存操作が完了しました。再読み込みしてください。');
      return result?{...result}:null;
    }
    finally{if(this.encryptedReadPending.get(pendingKey)===entry)this.encryptedReadPending.delete(pendingKey);}
  }
  private async readEncryptedUnshared(parts:string[],name:string,limit:number,directChild=false):Promise<RemoteFile|null> {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error('ファイル名が不正です。');
    // Read-only fast path for employee profiles: resolve the persons folder once,
    // then address each profile by its validated relative path, without a per-person folder GET.
    const child=directChild?parts.at(-1):undefined;
    if(directChild&&(name!=='profile.enc'||parts.at(-2)!=='persons'||!child||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(child)))
      throw new Error('従業員プロフィールの参照先が不正です。');
    const parent = await this.folder(directChild?parts.slice(0,-1):parts,false);
    if (!parent) return null;
    const relative=child?`${encodeURIComponent(child)}/${encodeURIComponent(name)}`:encodeURIComponent(name);
    const cacheKey=JSON.stringify(child?[parent,child,name]:[parent,name]);
    const cached=this.encryptedReadCache.get(cacheKey);
    const startEpoch=this.readCacheEpoch;
    const metadataPath=`/me/drive/items/${encodeURIComponent(parent)}:/${relative}`;
    let item:Item|null;
    try {
      // A cached body is reusable only after a fresh, successful Graph 304 for
      // the exact drive item. Any 200 re-downloads and validates the ciphertext.
      item=cached && cached.bytes<=limit && cached.file.etag.length<=256 &&
        !/[\r\n]/.test(cached.file.etag)
        ? await this.readMetadata<Item>(metadataPath,'年度暗号ファイル情報の照会',cached.file.etag)
        : await this.readMetadata<Item>(metadataPath,'年度暗号ファイル情報の照会');
    } catch(e) {
      if(e instanceof GraphError&&e.status===404){this.discardEncryptedRead(cacheKey);return null;}
      throw e;
    }
    this.assertCurrent();
    if(item===null){
      if(!cached||this.readCacheEpoch!==startEpoch||this.encryptedReadCache.get(cacheKey)!==cached)
        throw new Error('読み込み中に保存先の状態が変更されました。再読み込みしてください。');
      this.encryptedReadCache.delete(cacheKey);this.encryptedReadCache.set(cacheKey,cached);
      return {...cached.file};
    }
    this.discardEncryptedRead(cacheKey);
    if (!item.id || !item.eTag) throw new Error('クラウドファイルのIDまたはETagがありません。');
    if (item.size !== undefined && item.size > limit) throw new Error('OneDriveファイルの容量が上限を超えています。');
    let url = item['@microsoft.graph.downloadUrl'];
    if (!url) { const refreshed = await this.readMetadata<Item>(`/me/drive/items/${encodeURIComponent(item.id)}`,'ダウンロード情報の照会'); if(refreshed.id!==item.id||refreshed.eTag!==item.eTag||refreshed.size!==item.size)throw new Error('ダウンロード情報の取得中に保存先の世代が変更されました。'); url = refreshed['@microsoft.graph.downloadUrl']; }
    if (!url || new URL(url).protocol !== 'https:') throw new Error('OneDriveのダウンロード先URLが不正です。');
    // 署名付きダウンロードURLにBearerトークンを付けてはいけない。
    const response = await this.download(url);
    if (!response.ok) {try{await response.body?.cancel();}catch{}throw new Error(`OneDriveの取得に失敗しました (HTTP ${response.status})。`);}
    // Graph のダウンロード先が成功応答でログインHTMLなどを返しても、暗号ファイルと誤認しない。
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      try{await response.body?.cancel();}catch{}
      throw new Error(`OneDriveのファイル配信先がHTMLを返しました (HTTP ${response.status}, MIME: ${mime})。暗号化データとして扱わず、クラウドは変更していません。`);
    }
    if (Number(response.headers.get('content-length') ?? 0) > limit) {try{await response.body?.cancel();}catch{}throw new Error('ダウンロードサイズが大きすぎます。');}
    const checked = async (text: string, byteLength: number): Promise<RemoteFile> => {
      this.assertCurrent();
      // HTMLのエラーページを成功レスポンスとして読み込む等の取り違えを検出する。
      if (item.size !== undefined && item.size !== byteLength)
        throw new Error(`OneDriveのファイルサイズが一致しません (メタデータ ${item.size}バイト、取得 ${byteLength}バイト)。クラウドは変更していません。`);
      if(this.readCacheEpoch!==startEpoch)
        throw new Error('読み込み中に保管庫の保存操作が始まりました。再読み込みしてください。');
      // Bind the downloaded bytes to the same item/version at the requested path.
      // A size match alone is not proof: two versions can have identical lengths.
      const latest=await this.readMetadata<Item>(metadataPath,'暗号ファイル取得後の世代確認');
      this.assertCurrent();
      if(latest.id!==item.id||latest.eTag!==item.eTag||latest.size!==item.size)
        throw new Error('暗号ファイルの取得中に保存先の世代が変更されました。再読み込みしてください。');
      if(this.readCacheEpoch!==startEpoch)
        throw new Error('読み込み中に保管庫の保存操作が始まりました。再読み込みしてください。');
      const file={id:item.id!,etag:item.eTag!,text,size:item.size};
      // Profile, annual and income ciphertext only. Never cache encrypted PDFs.
      if(name!==PAYROLL_WRITE_LOCK_NAME&&!parts.includes('originals'))this.rememberEncryptedRead(cacheKey,file,byteLength);
      return file;
    };
    const body = response.body;
    if (!body) { const text=await response.text();const size=new TextEncoder().encode(text).length;if(size>limit)throw new Error('ダウンロードサイズ超過。');return checked(text,size); }
    const reader=body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try { for (;;) { const {value,done}=await reader.read();this.assertCurrent();if(done)break;size+=value.byteLength;if(size>limit)throw new Error('ダウンロードサイズ超過。');chunks.push(value); } }
    catch(error){try{await reader.cancel();}catch{}throw error;}
    finally {reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
    return checked(new TextDecoder('utf-8',{fatal:true}).decode(bytes),size);
  }
  /** 旧暗号領域の整理用。指定したPayroll配下だけを一覧化し、名前・ID・ETagを返す。 */
  async listFolder(parts:string[],reuseChildFolderIds=false):Promise<CloudFolderItem[]|null> {
    this.assertCurrent();
    const parent=await this.folder(parts,false);
    if(!parent)return null;
    const endpoint=`/me/drive/items/${encodeURIComponent(parent)}/children`;
    let path=`${endpoint}?$select=id,name,folder,file,eTag,size&$top=200`;
    const result:CloudFolderItem[]=[];
    for(let page=0;page<25;page++) {
      const data=await this.readMetadata<{value?:Item[];'@odata.nextLink'?:string}>(path,'OneDriveフォルダー一覧の取得');
      if(!Array.isArray(data.value))throw new Error('OneDriveのフォルダー一覧が不正です。削除を中断しました。');
      for(const item of data.value) {
        if(!item.id||typeof item.name!=='string'||!item.eTag||(!item.folder && !('file' in item)))
          throw new Error('OneDriveの項目情報が不正です。削除を中断しました。');
        result.push({id:item.id,name:item.name,etag:item.eTag,folder:Boolean(item.folder),size:item.size??0});
        if(result.length>5000)throw new Error('整理対象が多すぎます。自動削除を中断しました。');
      }
      const next=data['@odata.nextLink'];if(!next){
        this.assertCurrent();
        if(reuseChildFolderIds){
          const folders=result.filter(item=>item.folder&&/^[A-Za-z0-9-]{1,64}$/.test(item.name));
          if(new Set(folders.map(item=>item.name)).size!==folders.length)throw new Error('同名フォルダーを検出しました。');
          for(const child of folders)this.folders.set([...parts,child.name].join('/'),child.id);
        }
        return result;
      }
      let u:URL;try{u=new URL(next);}catch{throw new Error('一覧の次ページURLが不正です。');}
      if(u.protocol!=='https:'||u.hostname!=='graph.microsoft.com'||u.port||u.username||u.password||u.pathname!==`/v1.0${endpoint}`)
        throw new Error('不正なページングURLを拒否しました。');
      path=u.pathname.slice('/v1.0'.length)+u.search;
    }
    throw new Error('OneDriveのフォルダー一覧が大きすぎます。');
  }
  /** After a verified year-end document replacement, trash only its orphaned encrypted original. */
  async trashFile(parts:string[],item:CloudFolderItem):Promise<void> {
    if(item.folder||parts.length<5||parts.at(-1)!=='originals'||parts.at(-3)!=='persons'||
       !/^[0-9a-f-]{36}\.enc$/i.test(item.name))
      throw new Error('年末調整の原本暗号ファイル以外は整理できません。');
    const latest=(await this.listFolder(parts))?.find(x=>x.name===item.name);
    if(!latest||latest.folder||latest.id!==item.id||latest.etag!==item.etag)
      throw new Error('整理対象が更新されました。古い原本の削除を中断しました。');
    await this.request(`/me/drive/items/${encodeURIComponent(item.id)}`,{
      method:'DELETE',headers:{'If-Match':item.etag},
    });
  }
  /** 本人の未参照PDF原本だけをごみ箱へ。現行の参照有無は Vault 側で再検証する。 */
  async trashPayrollOriginal(parts:string[],item:CloudFolderItem,beforeDelete:()=>Promise<void>):Promise<void> {
    const legacy=parts.length===4&&parts[0]==='payroll'&&parts[1]==='originals';
    const generated=parts.length===6&&parts[0]==='payroll'&&parts[1]==='versions'&&
      /^[0-9a-f-]{36}$/i.test(parts[2])&&parts[3]==='originals';
    const year=parts.at(-2)??'',month=parts.at(-1)??'';
    if((!legacy&&!generated)||!/^\d{4}$/.test(year)||!/^(0[1-9]|1[0-2])$/.test(month)||
       item.folder||!item.id||!item.etag||!/^[0-9a-f-]{36}\.enc$/i.test(item.name))
      throw new Error('給与PDF原本の保管領域以外は削除できません。');
    const found=(await this.listFolder(parts))?.find(x=>x.name===item.name);
    if(!found||found.folder||found.id!==item.id||found.etag!==item.etag||found.size!==item.size)
      throw new Error('PDF原本が別端末で更新されました。整理対象を再検査してください。');
    await this.request(`/me/drive/items/${encodeURIComponent(item.id)}`,{
      method:'DELETE',headers:{'If-Match':item.etag},
    },false,beforeDelete);
    if(await this.metadata(parts,item.name))throw new Error('ごみ箱への移動結果を確認できません。再検査してください。');
  }
  /** 対象の親パス・名前・ID・ETagが一致した場合のみ、ごみ箱へ移動する。 */
  async trashFolder(parts:string[],item:CloudFolderItem):Promise<void> {
    if(!item.folder)throw new Error('フォルダー以外は一括整理できません。');
    const latest=(await this.listFolder(parts))?.find(x=>x.name===item.name);
    if(!latest||latest.id!==item.id||latest.etag!==item.etag||!latest.folder)
      throw new Error('整理対象が別端末で更新されました。削除を中断します。');
    await this.request(`/me/drive/items/${encodeURIComponent(item.id)}`,{
      method:'DELETE',headers:{'If-Match':item.etag},
    });
    // フォルダーIDキャッシュは削除した旧データを指し続けないよう破棄。
    this.folders.clear();
  }
  /** 初回作成中断で残った「0バイト索引」を、明示同意後に非破壊で退避する。
   * 他のPayrollファイルがあれば新規作成を禁止し、既存データを保護する。 */
  async archiveEmptyIndex(): Promise<string> {
  return this.withWriteLock(async()=>{
    const parent = await this.folder(['payroll'],false);
    if (!parent) throw new Error('Payrollフォルダーが見つかりません。');
    const list = await (await this.request(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,size,eTag&$top=200`)).json() as {
      value?: Array<{id?:string;name?:string;size?:number;eTag?:string}>;
      '@odata.nextLink'?:string;
    };
    const indexFiles = Array.isArray(list.value) ? list.value.filter(v=>v.name==='index.enc') : [];
    const otherFiles = Array.isArray(list.value) ? list.value.filter(v=>v.name!=='index.enc') : [];
    const onlyEmptyArchives = otherFiles.every(v=>v.size===0 &&
      /^index-empty-[0-9TZ-]+-[0-9a-f-]{36}\.enc$/i.test(v.name??''));
    if (list['@odata.nextLink'] || !Array.isArray(list.value) || indexFiles.length !== 1 ||
        !onlyEmptyArchives || indexFiles[0]?.size !== 0 ||
        !indexFiles[0].id || !indexFiles[0].eTag)
      throw new Error('Payrollフォルダーに空の索引以外のデータがあります。自動復旧は行いません。');
    const candidate = indexFiles[0];
    const actual = await this.read(['payroll'],'index.enc',1_000_000);
    if (!actual || actual.size !== 0 || actual.text.length !== 0 ||
        actual.id !== candidate.id || actual.etag !== candidate.eTag)
      throw new Error('空ファイルの状態が変化しました。OneDriveデータは変更していません。');
    const archive = `index-empty-${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}-${crypto.randomUUID()}.enc`;
    const result = await (await this.request(`/me/drive/items/${encodeURIComponent(candidate.id)}`,{
      method:'PATCH',headers:{'Content-Type':'application/json','If-Match':candidate.eTag},
      body:JSON.stringify({name:archive}),
    })).json() as Item & {name?:string};
    if (result.id !== candidate.id || result.name !== archive)
      throw new Error('空ファイルの退避結果を確認できません。クラウドを再確認してください。');
    const remaining = await this.read(['payroll'],'index.enc',1_000_000);
    if (remaining) throw new Error('退避後も旧索引が見つかります。新規作成を中止しました。');
    return archive;
  });
 }
  private async confirmLostContent(parts:string[],name:string,text:string,prior:Pick<RemoteFile,'id'|'etag'>|null,limit:number,proof:{uncertain:boolean}):Promise<boolean>{
    if(!this.writeOwner||!proof.uncertain)return false;
    // The caller supplied freshly encrypted content. An exact positive match
    // proves this final write; mere absence, matching size, or an old ETag do not.
    const size=new TextEncoder().encode(text).length;
    const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
    let expected:string;
    try{expected=await digest(text);}catch{return false;}
    const check=async()=>{
      try{
        this.clearEncryptedReadCache();
        const current=await this.read(parts,name,limit);
        return Boolean(current&&current.id&&current.etag&&current.size===size&&
          (!prior||(current.id===prior.id&&current.etag!==prior.etag))&&await digest(current.text)===expected);
      }catch{return false;}
    };
    if(await check()){
      try{await this.verifyWriteOwner();proof.uncertain=false;this.uncertainWrites--;return true;}catch{/* Keep protection. */}
    }
    this.pendingContentChecks.push(check);
    return false;
  }
  async write(parts: string[], name: string, text: string, prior: Pick<RemoteFile,'id'|'etag'>|null, limit: number, progress?:(sent:number,total:number)=>void,freshCiphertext=true): Promise<NewWriteReceipt|undefined> {
    this.assertCurrent();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error('クラウドファイル名が不正です。');
    const bytes = new TextEncoder().encode(text);
    if (!bytes.length || bytes.length > limit) throw new Error('暗号化ファイルのサイズが不正です。');
    progress?.(0,bytes.length);
    const parent = await this.folder(parts,true);
    if (!parent) throw new Error('保存先フォルダーがありません。');
    // Only a complete creation response can replace an original readback.
    const receipt=(item:Item,status:number):NewWriteReceipt|undefined=>
      !prior&&status===201&&typeof item.id==='string'&&item.id&&typeof item.eTag==='string'&&item.eTag&&
      !item.folder&&item.name===name&&item.size===bytes.length&&item.parentReference?.id===parent
       ?{id:item.id,etag:item.eTag,size:item.size,name}:undefined;
    // 新規の小さな暗号ファイルは Graph の一括PUTで確定する。
    // createUploadSessionの途中中断で0バイトのプレースホルダーが残る事態を避ける。
    // 更新ではETag付きアップロードセッションを維持して競合を検知する。
    if (!prior && bytes.byteLength <= 4 * 1024 * 1024) {
      let responseReceived=false,verified=false;
      const proof={uncertain:false};
      try {
      const path = `/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`;
      const response = await this.request(path,{
        method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes,
      },false,undefined,false,proof);
      responseReceived=true;
      const created = await response.json() as Item;
      this.assertCurrent();
      if (!created.id || created.size !== bytes.byteLength)
        throw new Error('OneDriveへの新規保存後のサイズが一致しません。保存成功とみなせません。');
      verified=true;
      progress?.(bytes.length,bytes.length);
      return receipt(created,response.status);
      } catch(error) {
        if(this.writeOwner&&responseReceived&&!verified)this.markUncertain(proof);
        if(freshCiphertext&&await this.confirmLostContent(parts,name,text,prior,limit,proof)){progress?.(bytes.length,bytes.length);return;}
        throw error;
      } finally {
        // A new-file PUT can also overlap a pending GET; the final boundary
        // must invalidate even when the Graph reply is lost or malformed.
        this.clearEncryptedReadCache();
        this.onMutation();
      }
    }
    // An upload-session PUT goes directly to a signed URL, bypassing request().
    // request() invalidates at session creation; the *completion* boundary must
    // invalidate again so overlapping GETs cannot publish pre-upload ciphertext.
    // Failure is equally ambiguous: Graph may have committed the final chunk.
    let sessionAccepted=false,finalDispatched=false,chunkDispatched=false;
    let createdReceipt:NewWriteReceipt|undefined;
    const proof={uncertain:false};
    try {
    const path = prior
      ? `/me/drive/items/${encodeURIComponent(prior.id)}/createUploadSession`
      : `/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:/createUploadSession`;
    const sessionResponse=await this.request(path,{
      method:'POST',headers:{'Content-Type':'application/json',...(prior?{'If-Match':prior.etag}:{})},
      body:JSON.stringify({item:{'@microsoft.graph.conflictBehavior':prior?'replace':'fail'}}),
    });
    sessionAccepted=true;
    const session=await sessionResponse.json() as {uploadUrl?:string};
    this.assertCurrent();
    if (!session.uploadUrl || new URL(session.uploadUrl).protocol !== 'https:') throw new Error('OneDriveアップロードURLが不正です。');
    const size=3276800;
    for(let start=0;start<bytes.length;start+=size) {
      this.assertCurrent();
      const end=Math.min(start+size,bytes.length);
      await this.verifyWriteOwner();
      chunkDispatched=true;finalDispatched=end===bytes.length;
      const response=await this.http(session.uploadUrl,{
        method:'PUT',credentials:'omit',headers:{'Content-Range':`bytes ${start}-${end-1}/${bytes.length}`},body:bytes.slice(start,end),
      });
      this.assertCurrent();
      if (!response.ok) {
        if(rejectedWriteStatus(response.status)){chunkDispatched=false;finalDispatched=false;if(this.writeOwner)this.markRejected();throw new GraphWriteRejectedError(response.status,'upload-rejected');}
        throw new Error(`OneDriveのアップロードに失敗しました (HTTP ${response.status})。`);
      }
      if (end<bytes.length && response.status!==202) throw new Error('分割アップロードが途中終了しました。');
      if (end===bytes.length) {
        if(response.status!==200&&response.status!==201)throw new Error('OneDriveが保存完了を返しませんでした。');
        const item=await response.json() as Item;
        this.assertCurrent();
        if(!item.id || item.size !== bytes.length)throw new Error('OneDriveの保存IDまたはサイズが一致しません。');
        createdReceipt=receipt(item,response.status);
      }
      chunkDispatched=false;finalDispatched=false;
      progress?.(end,bytes.length);
    }
    return createdReceipt;
    } catch(error) {
      // An explicitly rejected session creation has not sent any content.
      // Accepted/abandoned sessions without a final reply remain protected.
      if(this.writeOwner&&sessionAccepted&&(!(error instanceof GraphError)||!rejectedWriteStatus(error.status)))this.markUncertain(proof);
      if(freshCiphertext&&finalDispatched&&chunkDispatched&&await this.confirmLostContent(parts,name,text,prior,limit,proof)){progress?.(bytes.length,bytes.length);return;}
      throw error;
    } finally {
      // Both success and failure invalidate all encrypted bodies and pending GETs.
      // Keep this after the final signed PUT (or its failure), never only after
      // the createUploadSession POST. onMutation also drops navigation snapshots.
      this.clearEncryptedReadCache();
      this.onMutation();
    }
  }
}
