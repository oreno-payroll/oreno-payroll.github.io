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
interface Item { id?: string; name?: string; folder?: Record<string,unknown>; eTag?: string; size?: number; '@microsoft.graph.downloadUrl'?: string }
export class GraphError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(status===403?'OneDriveへのアクセス権限がありません。Microsoftの接続権限を確認してください（HTTP 403）。':status===401?'Microsoft認証が無効です。再接続後にOneDriveの状態を確認してください（HTTP 401）。':`OneDrive通信エラー HTTP ${status}${code ? ` (${code})` : ''}`);
  }
}
export const isCollision = (e: unknown): boolean => e instanceof GraphError && (e.status === 409 || e.status === 412);
export interface CloudFolderItem {id:string;name:string;etag:string;folder:boolean;size:number}
// A generation-independent sibling of payroll/, shared by personal and year-end writes.
// The body is random ownership evidence only: no account, salary, key or timestamp.
export const PAYROLL_WRITE_LOCK_NAME='payroll-write-lock-v1.bin';
type WriteOwner={id:string;etag:string;text:string};
const LOCK_RETAINED='書き込みロックが残っている可能性があります。再保存せず、設定の書き込みロック復旧手順を確認してください。';
export class PayrollGraph {
  private writeLockBusy=false;
  private writeOwner:WriteOwner|null=null;
  private writeAttempted=false;
  private writeUncertain=false;
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
  async withWriteLock<T>(operation:()=>Promise<T>):Promise<T> {
    this.assertCurrent();
    if(this.writeLockBusy)throw new Error('この画面で別の保存処理を実行中です。完了後に読み直してください。');
    this.writeLockBusy=true;this.writeAttempted=false;this.writeUncertain=false;
    try {
      const parent=await this.root();
      const text=(crypto.randomUUID()+crypto.randomUUID()).replace(/-/g,'');
      const path=`/me/drive/items/${encodeURIComponent(parent)}:/${PAYROLL_WRITE_LOCK_NAME}:/content?@microsoft.graph.conflictBehavior=fail`;
      let created:Item;
      try {
        const response=await this.request(path,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:new TextEncoder().encode(text)},false,undefined,true);
        if(response.status!==201)throw new Error('ロック新規作成の応答が不正です。');
        created=await response.json() as Item;
      }catch(error){
        if(isCollision(error))throw new Error('他の端末・タブで保存中か、前回の書き込みロックが残っています。時間切れによる自動解除は行いません。設定の書き込みロック復旧手順を確認してください。');
        throw new Error('書き込みロックの取得を確認できません。'+LOCK_RETAINED,{cause:error});
      }
      if(!created.id||!created.eTag||created.name!==PAYROLL_WRITE_LOCK_NAME||created.size!==text.length)
        throw new Error('書き込みロックの作成結果が一致しません。'+LOCK_RETAINED);
      const proof=await this.read([],PAYROLL_WRITE_LOCK_NAME,64).catch(error=>{throw new Error(LOCK_RETAINED,{cause:error});});
      if(!proof||proof.id!==created.id||proof.etag!==created.eTag||proof.text!==text||proof.size!==text.length)
        throw new Error('書き込みロックの所有権を確認できません。'+LOCK_RETAINED);
      this.writeOwner={id:proof.id,etag:proof.etag,text};
      const release=async()=>{
        const owner=this.writeOwner!;
        const live=await this.read([],PAYROLL_WRITE_LOCK_NAME,64);
        if(!live||live.id!==owner.id||live.etag!==owner.etag||live.text!==owner.text||live.size!==owner.text.length)
          throw new Error('書き込みロックの所有権が変化しました。解除しません。');
        const response=await this.request(`/me/drive/items/${encodeURIComponent(owner.id)}`,{
          method:'DELETE',headers:{'If-Match':owner.etag},
        },false,undefined,true);
        if(response.status!==204)throw new Error('書き込みロックの解除結果を確認できません。');
      };
      let result:T;
      try{result=await operation();}
      catch(error){
        // Even a late readback failure can mean a multi-file operation partially
        // committed. Retain the lock instead of guessing that all writes settled.
        if(this.writeAttempted||this.writeUncertain){
          if(error instanceof Error){error.message+=' '+LOCK_RETAINED;throw error;}
          throw new Error(LOCK_RETAINED,{cause:error});
        }
        try{await release();}catch(releaseError){throw new Error(LOCK_RETAINED,{cause:releaseError});}
        throw error;
      }
      if(this.writeUncertain)throw new Error('保存中の通信結果が不明です。'+LOCK_RETAINED);
      try{await release();}catch(error){throw new Error('保存処理は完了しましたが、書き込みロックの解除を確認できません。再保存せず最新データを確認してください。'+LOCK_RETAINED,{cause:error});}
      return result;
    }finally{this.writeOwner=null;this.writeLockBusy=false;this.writeAttempted=false;this.writeUncertain=false;}
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
  private async request(path: string, init: RequestInit = {}, accept304=false,beforeSend?:()=>Promise<void>,lockControl=false): Promise<Response> {
    this.assertCurrent();
    const method=(init.method??'GET').toUpperCase();
    const readonly=method==='GET'||method==='HEAD';
    if(!readonly&&!lockControl){this.requireWriteOwner();this.clearEncryptedReadCache();this.onMutation();}
    let bearer=typeof this.token==='function'?await this.token():this.token;
    this.assertCurrent();
    const graphUrl=`${BASE}${path}`;
    const send=async()=>{
      const started=performance.now();
      this.assertCurrent();
      if(beforeSend){await beforeSend();this.assertCurrent();}
      if(!readonly&&!lockControl){await this.verifyWriteOwner();if(this.writeOwner)this.writeAttempted=true;}
      try{const response=await this.http(graphUrl,{...init,headers:{Authorization:`Bearer ${bearer}`,...init.headers},redirect:'error'});this.assertCurrent();return response;}
      finally{observeGraphTransfer('graph-api',performance.now()-started);}
    };
    let retries=0,renewed=false;
    for (;;) {
      let r:Response;
      try {r=await send();}
      catch(error){
        if(!readonly&&!lockControl&&this.writeOwner)this.writeUncertain=true;
        this.assertCurrent(); // A retired session is not a transient network failure.
        // GET/HEAD だけ、通信中断にも限定回数のバックオフを適用。
        if(readonly&&retries<READ_RETRIES){observeGraphRetry();await pause(350*2**retries++);continue;}
        throw error;
      }
      if(r.status===401&&this.unauthorized&&!renewed){
        this.unauthorized.invalidate();
        if(readonly){
          // 期限切れ認証は別系統の一回限りの再取得。書き込みは再送しない。
          observeGraphRetry();renewed=true;bearer=await this.unauthorized.refresh();this.assertCurrent();
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
        if(!readonly&&!lockControl&&this.writeOwner&&r.status!==409&&r.status!==412)this.writeUncertain=true;
        let code = '';
        try { const v = await r.json() as {error?:{code?:string}}; code = (v.error?.code ?? '').slice(0,80); } catch {}
        this.assertCurrent();
        throw new GraphError(r.status,code);
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
        throw new Error(`${stage}：GraphのGET開始前（認証など）または通信処理で失敗しました。暗号ファイルは変更していません。`,{cause:error});
      }
      const contentType=(response.headers.get('content-type')??'unknown').split(';')[0].trim().toLowerCase();
      const contentLength=response.headers.get('content-length');
      if(contentLength && Number(contentLength)>1_048_576)
        throw new Error(`${stage}：Graphのメタデータ応答が大きすぎます。クラウドは変更していません。`);
      let body:string;
      try {body=await response.text();}
      catch(error){throw new Error(`${stage}：Graphの応答本文を取得できません。クラウドは変更していません。`,{cause:error});}
      this.assertCurrent();
      if(new TextEncoder().encode(body).byteLength>1_048_576)
        throw new Error(`${stage}：Graphのメタデータ応答が大きすぎます。クラウドは変更していません。`);
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
        throw new Error(`${stage}：Graph APIのメタデータJSONが不正です（HTTP ${response.status}、MIME ${contentType}、本文 ${body.length}文字、${lengthStatus}、3回試行）。暗号ファイルは変更していません。`,{cause:error});
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
  async listFolder(parts:string[]):Promise<CloudFolderItem[]|null> {
    this.assertCurrent();
    const parent=await this.folder(parts,false);
    if(!parent)return null;
    const endpoint=`/me/drive/items/${encodeURIComponent(parent)}/children`;
    let path=`${endpoint}?$select=id,name,folder,file,eTag,size&$top=200`;
    const result:CloudFolderItem[]=[];
    for(let page=0;page<25;page++) {
      const data=await this.readMetadata<{value?:Item[];'@odata.nextLink'?:string}>(path,'整理対象フォルダーの照会');
      if(!Array.isArray(data.value))throw new Error('OneDriveのフォルダー一覧が不正です。削除を中断しました。');
      for(const item of data.value) {
        if(!item.id||typeof item.name!=='string'||!item.eTag||(!item.folder && !('file' in item)))
          throw new Error('OneDriveの項目情報が不正です。削除を中断しました。');
        result.push({id:item.id,name:item.name,etag:item.eTag,folder:Boolean(item.folder),size:item.size??0});
        if(result.length>5000)throw new Error('整理対象が多すぎます。自動削除を中断しました。');
      }
      const next=data['@odata.nextLink'];if(!next){this.assertCurrent();return result;}
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
  async write(parts: string[], name: string, text: string, prior: Pick<RemoteFile,'id'|'etag'>|null, limit: number, progress?:(sent:number,total:number)=>void): Promise<void> {
    this.assertCurrent();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error('クラウドファイル名が不正です。');
    const bytes = new TextEncoder().encode(text);
    if (!bytes.length || bytes.length > limit) throw new Error('暗号化ファイルのサイズが不正です。');
    progress?.(0,bytes.length);
    const parent = await this.folder(parts,true);
    if (!parent) throw new Error('保存先フォルダーがありません。');
    // 新規の小さな暗号ファイルは Graph の一括PUTで確定する。
    // createUploadSessionの途中中断で0バイトのプレースホルダーが残る事態を避ける。
    // 更新ではETag付きアップロードセッションを維持して競合を検知する。
    if (!prior && bytes.byteLength <= 4 * 1024 * 1024) {
      try {
      const path = `/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`;
      const response = await this.request(path,{
        method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes,
      });
      const created = await response.json() as Item;
      this.assertCurrent();
      if (!created.id || created.size !== bytes.byteLength)
        throw new Error('OneDriveへの新規保存後のサイズが一致しません。保存成功とみなせません。');
      progress?.(bytes.length,bytes.length);
      return;
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
    try {
    const path = prior
      ? `/me/drive/items/${encodeURIComponent(prior.id)}/createUploadSession`
      : `/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:/createUploadSession`;
    const sessionResponse=await this.request(path,{
      method:'POST',headers:{'Content-Type':'application/json',...(prior?{'If-Match':prior.etag}:{})},
      body:JSON.stringify({item:{'@microsoft.graph.conflictBehavior':prior?'replace':'fail'}}),
    });
    const session=await sessionResponse.json() as {uploadUrl?:string};
    this.assertCurrent();
    if (!session.uploadUrl || new URL(session.uploadUrl).protocol !== 'https:') throw new Error('OneDriveアップロードURLが不正です。');
    const size=3276800;
    for(let start=0;start<bytes.length;start+=size) {
      this.assertCurrent();
      const end=Math.min(start+size,bytes.length);
      await this.verifyWriteOwner();
      const response=await this.http(session.uploadUrl,{
        method:'PUT',credentials:'omit',headers:{'Content-Range':`bytes ${start}-${end-1}/${bytes.length}`},body:bytes.slice(start,end),
      });
      this.assertCurrent();
      if (!response.ok) {
        if(response.status===409||response.status===412)throw new GraphError(response.status,'conflict');
        throw new Error(`OneDriveのアップロードに失敗しました (HTTP ${response.status})。`);
      }
      if (end<bytes.length && response.status!==202) throw new Error('分割アップロードが途中終了しました。');
      if (end===bytes.length) {
        if(response.status!==200&&response.status!==201)throw new Error('OneDriveが保存完了を返しませんでした。');
        const item=await response.json() as Item;
        this.assertCurrent();
        if(!item.id || item.size !== bytes.length)throw new Error('OneDriveの保存IDまたはサイズが一致しません。');
      }
      progress?.(end,bytes.length);
    }
    } catch(error) {
      if(this.writeOwner&&!isCollision(error))this.writeUncertain=true;
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
