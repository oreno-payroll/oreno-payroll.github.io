import {createSalt,deriveKey,encryptBytes,decryptBytes,encryptJson,decryptJson,envelopeSalt,parseEnvelope} from './crypto';
import {PayrollGraph,GraphWriteRejectedError,isCollision,type RemoteFile,type CloudFolderItem,type PayrollWriteState} from './graph';
import type {SavedPayrollRecord,SavedPayrollSummary} from '../storage/payrollStore';
import {fiscalYearOfTargetMonth} from '../forecast/payrollCalendar';
import {payrollPeriodsConflict} from '../storage/payrollValidation';
import {isValidPayrollSemantics} from '../storage/payrollSemantics';
import {isValidPayrollZeroResolution} from '../storage/payrollZeroResolution';
import {validEmployerId} from '../storage/employerIdentity';
import {validateEmployerDirectory,employerDirectorySignature,mergeEmployerDirectories,type EmployerEntry} from '../storage/employerDirectory';
import {rememberNavigationSnapshot,restoredNavigationSnapshot,clearNavigationSnapshot,SNAPSHOT_TTL_MS,mutationEpoch} from './snapshot';
import {toPublicIncomeRecord,type PublicIncomeRecord} from './income';
import {MAX_RECORDS,MAX_TOTAL_PDF_BYTES} from '../storage/storageLimits';
import {PayrollPartialSuccessError} from '../storage/operationError';
import {beginPerfOperation} from './perf';
import type {PayrollSaveProgress,PayrollSavePhase} from '../ui/operationFeedback';

export interface CloudRecord extends SavedPayrollSummary {
  originalId: string;
  originalMonth: string;
}
export interface AnnualDocument { format:'payroll-annual-v1'; records:CloudRecord[]; deleted:number[] }
interface Index {format:'payroll-index-v1'; years:string[]; incomeYears:string[]; employers?:EmployerEntry[]; originalTrashHistory?:OriginalTrashEvidence[]; generation?:string; rotation?:{id:string;startedAt:number}}
type IncomeRecord = PublicIncomeRecord;
interface IncomeDocument {format:'payroll-income-v1';year:string;records:IncomeRecord[]}
export interface OrphanAnnualYear {year:string;etag:string;records:number}
/** Exact old encrypted copy observed before a confirmed current-original trash.
 * The index is encrypted; no filename, payroll amount or PDF plaintext is stored. */
interface OriginalTrashEvidence {generation:string;month:string;uuid:string;id:string;etag:string;size:number}
const MAX_TRASH_EVIDENCE=5000;
function trashEvidenceKey(e:OriginalTrashEvidence):string{return JSON.stringify([e.generation,e.month,e.uuid,e.id,e.etag,e.size]);}
function validateTrashEvidence(value:unknown):OriginalTrashEvidence[]{
 if(!Array.isArray(value)||value.length>MAX_TRASH_EVIDENCE)throw new Error('原本整理履歴の形式または件数が不正です。');
 const seen=new Set<string>();
 for(const e of value){
  if(!e||typeof e!=='object'||typeof e.generation!=='string'||(e.generation!==''&&!/^[0-9a-f-]{36}$/i.test(e.generation))||
    typeof e.month!=='string'||!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(e.month)||typeof e.uuid!=='string'||!/^[0-9a-f-]{36}$/i.test(e.uuid)||
    typeof e.id!=='string'||!e.id||e.id.length>1024||typeof e.etag!=='string'||!e.etag||e.etag.length>1024||!Number.isSafeInteger(e.size)||e.size<1||
    Object.keys(e).sort().join(',')!=='etag,generation,id,month,size,uuid')throw new Error('原本整理履歴が不正です。');
  const key=trashEvidenceKey(e);if(seen.has(key))throw new Error('原本整理履歴が重複しています。');seen.add(key);
 }
 return value;
}
interface OriginalInventoryEntry {id:string;month:string;uuid:string;path:string[];name:string;etag:string;size:number}
export interface DetachedOriginal {
  id:string;month:string;uuid:string;etag:string;size:number;
}
export interface DetachedUploadMatch {targetMonth:string;fileHash:string;original:DetachedOriginal}
export interface DetachedOriginalReport {
  generation:string;indexEtag:string;
  years:Array<{year:string;etag:string}>;
  originals:DetachedOriginal[];
}
const emptyDoc=():AnnualDocument=>({format:'payroll-annual-v1',records:[],deleted:[]});
const emptyIndex=():Index=>({format:'payroll-index-v1',years:[],incomeYears:[]});
const copy=<T>(v:T):T=>structuredClone(v);
const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
/** Canonical JSON comparison for authenticated readback. Optional undefined fields
 * are omitted exactly as in the encrypted JSON serialization. Arrays retain order. */
function canonicalJson(value:unknown):string {
 return JSON.stringify(value,(_key,v:unknown)=>{
  if(v&&typeof v==='object'&&!Array.isArray(v))return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0));
  return v;
 });
}
function annualReadbackSignature(doc:AnnualDocument):string {
 return canonicalJson({format:doc.format,records:[...doc.records].sort((a,b)=>a.id-b.id),deleted:[...doc.deleted].sort((a,b)=>a-b)});
}
const MAX_INDEX=1_000_000,MAX_YEAR=30_000_000,MAX_ORIGINAL=100_000_000;
const shardYear=(r:{form:Record<string,string>}):string=>{
 const m=/^(19|20|21)\d{2}-\d{2}$/.exec(r.form.targetMonth??'');
 if(!m)throw new Error('対象年月が不正なため年度ファイルを選択できません。');
 const fiscal=fiscalYearOfTargetMonth(r.form.targetMonth);
 if(fiscal===null)throw new Error('給与の年度が不正です。');
 return String(fiscal);
};
const incomeYear=(r:{form:Record<string,string>}):string=>{
 const v=r.form.paymentDate??'';
 if(!/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(v))throw new Error('支給日が不正です。');
 return v.slice(0,4);
};
const idOkay=(id:number):boolean=>Number.isSafeInteger(id)&&id>0;
function validateDoc(value:AnnualDocument,expectedYear?:string):AnnualDocument {
 if(!value||value.format!=='payroll-annual-v1'||!Array.isArray(value.records)||!Array.isArray(value.deleted)||value.records.length>10000||value.deleted.length>20000)throw new Error('年別明細の形式が不正です。');
 const ids=new Set<number>();
 for(const rec of value.records) {
  if(!rec||!idOkay(rec.id)||ids.has(rec.id)||!rec.form||typeof rec.form!=='object'||typeof rec.originalId!=='string'||!/^[\da-f-]{36}$/i.test(rec.originalId)||!/^\d{4}-\d{2}$/.test(rec.originalMonth)||!Number.isSafeInteger(rec.pdfSize)||rec.pdfSize<1||typeof rec.fileName!=='string')throw new Error('年別明細のレコードが不正です。');
  if(Array.isArray(rec.form)||Object.values(rec.form).some(v=>typeof v!=='string'))throw new Error('保存済み明細の入力形式が不正です。');
  const actualYear=shardYear(rec);
  if(expectedYear!==undefined&&actualYear!==expectedYear)throw new Error('年別明細の対象年度と保存先が一致しません。');
  const payment=rec.form.paymentDate;
  const date=new Date(`${payment}T00:00:00.000Z`);
  if(!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(payment??'')||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==payment||
     !['main','side'].includes(rec.form.job)||!['salary','bonus'].includes(rec.form.kind)||
     !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(rec.originalMonth))throw new Error('保存済み明細の日付または区分が不正です。');
  // Legacy optional fields may be absent or blank; present amounts must be safe numbers.
  for(const name of ['gross','net','taxable','nonTaxable','transportation','reimbursedExpenses','incomeTax','residentTax','healthInsurance','careInsurance','childcareSupport','pension','employmentInsurance','otherDeductions','yearEndAdjustment','bonusBase','performanceBonus','workDays']){
   const raw=rec.form[name];if(raw===undefined||!raw.trim())continue;
   const n=Number(raw);
   if(!Number.isFinite(n)||(name==='workDays'?n<0||!Number.isSafeInteger(Math.ceil(n)):!Number.isSafeInteger(n))||
      (['gross','net','taxable','nonTaxable','transportation','reimbursedExpenses','bonusBase','performanceBonus'].includes(name)&&n<0))throw new Error('保存済み明細の金額または日数が不正です。');
  }
  if(!validEmployerId(rec.employerId))throw new Error('保存済み明細の勤務先IDが不正です。');
   if(rec.semantics!==undefined&&!isValidPayrollSemantics(rec.semantics))throw new Error('保存済み明細の解析意味情報が不正です。');
  if(rec.zeroResolution!==undefined&&!isValidPayrollZeroResolution(rec.zeroResolution,rec.form))
   throw new Error('保存済み明細の0円確認情報が不正です。');
  ids.add(rec.id);
 }
 for(const id of value.deleted)if(!idOkay(id))throw new Error('削除履歴が不正です。');
 return value;
}
function validateIndex(value:Index):Index {
 if(!value||value.format!=='payroll-index-v1'||!Array.isArray(value.years)||!Array.isArray(value.incomeYears)||value.years.length>300||value.incomeYears.length>300||![...value.years,...value.incomeYears].every(v=>typeof v==='string'&&/^(19|20|21)\d{2}$/.test(v)))throw new Error('Payroll索引の形式が不正です。');
 if(value.generation!==undefined&&!/^[0-9a-f-]{36}$/i.test(value.generation))throw new Error('保存世代が不正です。');
 if(value.rotation!==undefined&&(!/^[0-9a-f-]{36}$/i.test(value.rotation?.id??'')||!Number.isFinite(value.rotation?.startedAt)))throw new Error('保管庫の変更処理情報が不正です。');
 if(value.employers!==undefined)validateEmployerDirectory(value.employers);
 if(value.originalTrashHistory!==undefined)validateTrashEvidence(value.originalTrashHistory);
 return value;
}

/** 安定IDに基づく3方向マージ。独立した編集は統合し、同じ値の競合は警告して保存を止める。 */
export function mergeAnnual(base:AnnualDocument,local:AnnualDocument,remote:AnnualDocument):AnnualDocument {
 const bm=new Map(base.records.map(r=>[r.id,r]));
 const lm=new Map(local.records.map(r=>[r.id,r]));
 const rm=new Map(remote.records.map(r=>[r.id,r]));
 const bdel=new Set(base.deleted),ldel=new Set(local.deleted),rdel=new Set(remote.deleted);
 const result:CloudRecord[]=[],deleted=new Set<number>([...ldel,...rdel]);
 const missing=Symbol('missing');
 const choose=(id:number,path:string,b:unknown,l:unknown,r:unknown):unknown=>{
  if(same(l,b))return r;
  if(same(r,b)||same(l,r))return l;
  if(l===missing||r===missing)throw new Error(`明細ID ${id} に削除と編集の競合があります。最新データを確認してください。`);
  if(b!==missing&&l&&r&&b&&typeof l==='object'&&typeof r==='object'&&typeof b==='object'&&!Array.isArray(l)&&!Array.isArray(r)&&!Array.isArray(b)) {
   const out:Record<string,unknown>={};const bo=b as Record<string,unknown>,lo=l as Record<string,unknown>,ro=r as Record<string,unknown>;
   for(const key of new Set([...Object.keys(bo),...Object.keys(lo),...Object.keys(ro)])) {
    const own=(obj:Record<string,unknown>)=>Object.hasOwn(obj,key)?obj[key]:missing;
    const v=choose(id,`${path}.${key}`,own(bo),own(lo),own(ro));
    if(v!==missing)out[key]=v;
   }
   return out;
  }
  throw new Error(`明細ID ${id} の「${path}」が別端末でも編集されました。変更内容は上書きせず、再読込してください。`);
 };
 for(const id of new Set([...bm.keys(),...lm.keys(),...rm.keys(),...bdel,...ldel,...rdel])) {
  const b=bdel.has(id)?missing:bm.get(id)??missing;
  const l=ldel.has(id)?missing:lm.get(id)??missing;
  const r=rdel.has(id)?missing:rm.get(id)??missing;
  const selected=choose(id,'record',b,l,r);
  if(selected===missing){deleted.add(id);continue;}
  deleted.delete(id);
  result.push(selected as CloudRecord);
 }
 return validateDoc({format:'payroll-annual-v1',records:result,deleted:[...deleted]});
}

/** 本当に0バイトの索引だけを対話的に退避するための専用エラー。 */
export class EmptyPayrollIndexError extends Error {
 constructor(){super('OneDriveのPayroll索引は0バイトです。初回作成が中断された可能性があります。');}
}

export class InterruptedRotationError extends Error {
 constructor(){super('別のタブで保管庫のパスフレーズ変更が進行中か、中断されています。変更中のタブを確認してください。');}
}

export class RememberedKeyMismatchError extends Error {
 constructor(message='記憶した暗号鍵が現在の保管庫と一致しません。'){super(message);this.name='RememberedKeyMismatchError';}
}

export class PayrollVault {
 private key:CryptoKey|null=null;
 private salt='';
 private index=emptyIndex();
 private shards=new Map<string,AnnualDocument>();
 // Verified ciphertext identity. Only after a full decrypt+schema validation can the
 // corresponding annual document be reused behind a fresh Graph metadata check.
 private shardVersions=new Map<string,{id:string;etag:string;size?:number}>();
 private shardKey:CryptoKey|null=null;
 private shardSalt='';
 private shardGeneration:string|undefined;
 private pdfDrafts=new WeakMap<Blob,{id:string;month:string;encrypted:string}>();
 // The verified index from unlock is fresh enough for one immediate dashboard load.
 // Mutations and later refreshes always revalidate the remote index.
 private firstDashboardIndexUntil=0;
 private rotationId:string|null=null;
 private snapshotScope='';
 private reusedSnapshot=false;
 private snapshotDeadline=0;
 private snapshotEpoch='';
 navigationDeadline():number{return this.snapshotDeadline;}
 setNavigationScope(scope:string):void {this.snapshotScope=scope;}
 isShowingSnapshot():boolean{return this.reusedSnapshot;}
 /** Display-only cache; rejected if the index, year list or record schema differs. */
 async resumeFromSnapshot(key:CryptoKey,salt:string):Promise<boolean> {
  if(!this.snapshotScope)return false;
  const epoch=mutationEpoch();
  const cached=await restoredNavigationSnapshot(this.snapshotScope,salt,key);
  if(epoch!==mutationEpoch())return false;
  if(!cached?.data||typeof cached.data!=='object')return false;
  try {
   const value=cached.data as {index:Index;years:Array<[string,AnnualDocument]>};
   const index=validateIndex(value.index);
   if(index.rotation||!Array.isArray(value.years)||value.years.length!==index.years.length)return false;
   const docs=new Map<string,AnnualDocument>();
   for(const row of value.years){
    if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||docs.has(row[0])||!index.years.includes(row[0]))return false;
    docs.set(row[0],validateDoc(row[1],row[0]));
   }
   if(docs.size!==index.years.length)return false;
   this.key=key;this.salt=salt;this.index=index;this.shards=docs;
   // This metadata is inside the authenticated, encrypted, account-scoped
   // navigation snapshot. NEVER trust it without a NEW remote index and
   // ETag inventory check before using it for an edit or a PDF download.
   const claimed=(value as {versions?:unknown}).versions;
   const versions=new Map<string,{id:string;etag:string;size?:number}>();
   let validVersions=Array.isArray(claimed)&&claimed.length===index.years.length;
   if(validVersions)for(const entry of claimed as unknown[]){
    if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||
       !index.years.includes(entry[0])||versions.has(entry[0])||
       !entry[1]||typeof entry[1]!=='object'||Array.isArray(entry[1])){validVersions=false;break;}
    const meta=entry[1] as {id?:unknown;etag?:unknown;size?:unknown};
    if(typeof meta.id!=='string'||!meta.id||meta.id.length>512||
       typeof meta.etag!=='string'||!meta.etag||meta.etag.length>512||
       (meta.size!==undefined&&(!Number.isSafeInteger(meta.size)||
       (meta.size as number)<1||(meta.size as number)>MAX_YEAR))){validVersions=false;break;}
    versions.set(entry[0],{id:meta.id,etag:meta.etag,size:meta.size as number|undefined});
   }
   if(validVersions&&versions.size===index.years.length){
    this.shardVersions=versions;this.shardKey=key;this.shardSalt=salt;this.shardGeneration=index.generation;
   }else{
    // Legacy or malformed snapshots may still be displayed, but are never
    // allowed to skip a cryptographically authenticated annual-file read.
    this.shardVersions.clear();this.shardKey=null;this.shardSalt='';this.shardGeneration=undefined;
   }
   this.reusedSnapshot=true;this.snapshotEpoch=epoch;this.snapshotDeadline=cached.expires;this.firstDashboardIndexUntil=0;
   return true;
  }catch{clearNavigationSnapshot();return false;}
 }

 private storagePath(segment:string,...rest:string[]):string[]{return this.pathFor(this.index,segment,...rest);}
 private pathFor(index:Index,segment:string,...rest:string[]):string[]{return index.generation?['payroll','versions',index.generation,segment,...rest]:['payroll',segment,...rest];}
 private ensureRotationAllowed(index:Index):void{if(index.rotation?.id && index.rotation.id!==this.rotationId)throw new InterruptedRotationError();}
 constructor(readonly graph:PayrollGraph){}
 isUnlocked():boolean{return this.key!==null;}
 lock():void{this.key=null;this.salt='';this.index=emptyIndex();this.shards.clear();this.shardVersions.clear();this.shardKey=null;this.shardSalt='';this.shardGeneration=undefined;this.firstDashboardIndexUntil=0;this.rotationId=null;this.reusedSnapshot=false;this.snapshotDeadline=0;clearNavigationSnapshot();}
 private unlocked():CryptoKey{if(!this.key)throw new Error('OneDriveの給与保管庫を解除してください。');return this.key;}
 async unlock(passphrase:string, createIfMissing=false):Promise<boolean> {
  const derive=(salt:string):Promise<CryptoKey>=>deriveKey(passphrase,salt);
  let file:RemoteFile|null;
  try {file=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);}
  catch(error){throw new Error('暗号索引 index.enc の初回取得に失敗しました（Graph API/配信応答）。OneDriveは変更していません。',{cause:error});}
  if (!file) {
   if(!createIfMissing)return false;
   return this.graph.withWriteLock(async()=>{
   if(await this.graph.read(['payroll'],'index.enc',MAX_INDEX))throw new Error('別の端末で保管庫が作成されました。読み直してください。');
   const salt=createSalt(),key=await derive(salt);
   try{await this.graph.write(['payroll'],'index.enc',await encryptJson('index',emptyIndex(),key,salt),null,MAX_INDEX);}
   catch(e){if(!isCollision(e))throw e;throw new Error('別の端末で保管庫が作成されました。読み直してください。');}
   const verify=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
   if(!verify)throw new Error('暗号化索引を読み戻せません。');
   const decoded=validateIndex(await decryptJson<Index>('index',verify.text,key));
   this.shards.clear();this.shardVersions.clear();this.shardKey=null;
   this.key=key;this.salt=salt;this.index=decoded;this.firstDashboardIndexUntil=Date.now()+15_000;return true;
   });
  }
  if (file.size === 0 && file.text.length === 0) throw new EmptyPayrollIndexError();
  let salt: string;
  try { salt=envelopeSalt(file.text); }
  catch (e) {
    const reason=e instanceof Error?e.message:String(e);
    throw new Error(`OneDriveの payroll/index.enc が存在しますが暗号索引として読めません。${reason} 既存ファイルを削除・上書きしていません。`);
  }
  const key=await derive(salt);
  const index=validateIndex(await decryptJson<Index>('index',file.text,key));
  this.ensureRotationAllowed(index);
  this.shards.clear();this.shardVersions.clear();this.shardKey=null;
  this.key=key;this.salt=salt;this.index=index;this.firstDashboardIndexUntil=Date.now()+15_000;
  // 起動時は索引の検証だけにする。全年度の取得と収入ファイル再保存は画面表示/更新時のみ。
  return true;
 }
 /** ページ移動後、SharedWorkerのメモリにある非抽出CryptoKeyで再開する。
  * 認証済みOneDriveの現在の索引を必ず復号して、アカウント/鍵の取り違えを拒否する。 */
 async unlockWithKey(key:CryptoKey,salt:string):Promise<void> {
  let file:RemoteFile|null;
  try {file=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);}
  catch(error){throw new Error('暗号索引 index.enc の取得に失敗しました（Graph API/配信応答）。OneDriveは変更していません。',{cause:error});}
  if(!file)throw new Error('Payrollの暗号索引が見つかりません。OneDriveは変更していません。');
  // A salt change can also be caused by a damaged remote index. It is not proof
  // that the saved browser key is stale; never revoke it from this read path.
  if(envelopeSalt(file.text)!==salt)throw new RememberedKeyMismatchError(
   'OneDrive索引のソルトと記憶鍵が一致しません。保管庫の鍵変更・接続先・索引破損を確認してください。記憶鍵は削除していません。');
  let decoded:Index;
  try{decoded=await decryptJson<Index>('index',file.text,key);}
  catch(error){
   // AES-GCM authentication failure cannot distinguish a wrong key from
   // corrupt ciphertext. Keep the locally remembered key for recovery.
   throw new Error('OneDriveの暗号索引を検証できません。鍵の不一致か索引破損の可能性があります。記憶鍵は削除していません。',{cause:error});
  }
  const index=validateIndex(decoded);
  this.ensureRotationAllowed(index);
  this.shards.clear();this.shardVersions.clear();this.shardKey=null;
  this.key=key;this.salt=salt;this.index=index;this.firstDashboardIndexUntil=Date.now()+15_000;
 }
 /** パスフレーズの代わりに安全なメモリ連携へ渡す。鍵はextractable:false。 */
 sessionKey():{key:CryptoKey;salt:string} {
  return {key:this.unlocked(),salt:this.salt};
 }
 /** The generation is metadata of the freshly verified remote index. */
 rememberedKeyGeneration():string|null {this.unlocked();return this.index.generation??null;}
 async yearEndAccess():Promise<{path:string[];key:CryptoKey;salt:string;graph:PayrollGraph}> {
  const {index}=await this.readIndex();
  if(index.rotation)throw new Error('暗号鍵の変更中は年末調整の操作を中断してください。');
  return {path:this.pathFor(index,'year-end-assist'),key:this.unlocked(),salt:this.salt,graph:this.graph};
 }
 /** Read-only employee list cache; the caller must first validate the live root generation. */
 async readPeopleNavigation(path:string[]):Promise<unknown>{
  if(!this.snapshotScope)return null;
  return (await restoredNavigationSnapshot(`${this.snapshotScope}:${path.join('/')}`,this.salt,this.unlocked(),'people'))?.data??null;
 }
 async rememberPeopleNavigation(path:string[],data:unknown,epoch:string):Promise<void>{
  if(this.snapshotScope)await rememberNavigationSnapshot(`${this.snapshotScope}:${path.join('/')}`,this.salt,this.unlocked(),data,'people',epoch);
 }
 /** Strict inventory: unknown files abort rotation rather than silently losing data. */
 private async listYearEndFiles(index:Index):Promise<Array<{kind:'assist-index'|'assist-profile'|'assist-year'|'assist-original';path:string[];name:string;etag:string;size:number;relative:string[]}>> {
  const base=this.pathFor(index,'year-end-assist');
  const root=await this.graph.listFolder(base);if(!root)return [];
  const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const result:Array<{kind:'assist-index'|'assist-profile'|'assist-year'|'assist-original';path:string[];name:string;etag:string;size:number;relative:string[]}>=[];
  const visit=async(parts:string[],relative:string[]):Promise<void>=>{
   if(relative.length>3)throw new Error('年末調整フォルダーの階層が不正です。');
   const children=await this.graph.listFolder(parts);if(!children)throw new Error('年末調整フォルダーが読み取れません。');
   for(const child of children){
    if(child.folder){
     const next=[...relative,child.name];
     const okay=(relative.length===0&&child.name==='persons')||
      (relative.length===1&&relative[0]==='persons'&&id.test(child.name))||
      (relative.length===2&&relative[0]==='persons'&&id.test(relative[1])&&['years','originals'].includes(child.name));
     if(!okay)throw new Error('年末調整保存先に未知のフォルダーがあります。鍵変更を中止します。');
     await visit([...parts,child.name],next);
    }else{
     const key=relative.join('/');let kind:typeof result[number]['kind'];
     if(!key&&child.name==='index.enc')kind='assist-index';
     else if(/^persons\/[0-9a-f-]{36}$/i.test(key)&&child.name==='profile.enc')kind='assist-profile';
     else if(/^persons\/[0-9a-f-]{36}\/years$/i.test(key)&&id.test(child.name.slice(0,-4))&&child.name.endsWith('.enc'))kind='assist-year';
     else if(/^persons\/[0-9a-f-]{36}\/originals$/i.test(key)&&id.test(child.name.slice(0,-4))&&child.name.endsWith('.enc'))kind='assist-original';
     else throw new Error('年末調整保存先に未知の暗号ファイルがあります。鍵変更を中止します。');
     if(child.size<1||!child.etag)throw new Error('年末調整の暗号ファイルが不正です。');
     result.push({kind,path:parts,name:child.name,etag:child.etag,size:child.size,relative});
     if(result.length>5000)throw new Error('年末調整ファイルが上限を超えました。');
    }
   }
  };
  await visit(base,[]);
  if(result.length>0&&!result.some(x=>x.kind==='assist-index'))throw new Error('年末調整索引が未登録です。復旧が必要です。');
  return result.sort((a,b)=>[...a.relative,a.name].join('/').localeCompare([...b.relative,b.name].join('/')));
 }
 private async readIndex():Promise<{index:Index;file:RemoteFile}> {
  let file:RemoteFile|null;
  try {file=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);}
  catch(error){throw new Error('暗号索引 index.enc の再取得に失敗しました（Graph API/配信応答）。OneDriveは変更していません。',{cause:error});}
  if(!file||envelopeSalt(file.text)!==this.salt)throw new Error('OneDrive保管庫の索引が別のものに変わりました。');
  const index=validateIndex(await decryptJson<Index>('index',file.text,this.unlocked()));
  this.ensureRotationAllowed(index);
  if(index.generation!==this.index.generation)throw new Error('保管庫の保存世代が変更されました。再読み込みしてください。');
  return {index,file};
 }
 /** Display-only directory from the same verified dashboard snapshot. Never use for mutations. */
 dashboardEmployerDirectory():EmployerEntry[] {this.unlocked();return validateEmployerDirectory(this.index.employers??[]);}
 /** Never use a cached directory for editing or selecting a default. */
 async readEmployerDirectory():Promise<EmployerEntry[]> {
  const {index}=await this.readIndex();
  return validateEmployerDirectory(index.employers??[]);
 }
 /** Full expected directory + root ETag protect against concurrent changes.
  * Existing identities cannot be removed; a past employer remains addressable. */
 async writeEmployerDirectory(expected:readonly EmployerEntry[],next:readonly EmployerEntry[]):Promise<EmployerEntry[]> {
  return this.graph.withWriteLock(async()=>{
  const signature=employerDirectorySignature(expected),changed=validateEmployerDirectory(next);
  if(expected.some(entry=>!changed.some(v=>v.id===entry.id)))throw new Error('登録済みの勤務先は削除できません。過去の勤務先に変更してください。');
  if(expected.some(entry=>changed.find(v=>v.id===entry.id)?.role!==entry.role))throw new Error('登録済み勤務先の勤務区分は変更できません。');
  const target=employerDirectorySignature(changed);
  for(let retry=0;retry<5;retry++){
   const {index,file}=await this.readIndex();
   if(index.rotation)throw new InterruptedRotationError();
   if(employerDirectorySignature(index.employers??[])!==signature)throw new Error('勤務先一覧が更新されました。最新データを確認してください。');
   if(target===signature)return changed;
   const updated:Index={...index,employers:changed};
   try{await this.graph.write(['payroll'],'index.enc',await encryptJson('index',updated,this.unlocked(),this.salt),file,MAX_INDEX);}
   catch(error){if(isCollision(error))continue;throw error;}
   const verified=await this.readIndex();
   if(employerDirectorySignature(verified.index.employers??[])!==target)throw new Error('勤務先一覧の保存結果が一致しません。最新データを確認してください。');
   // Do not reuse an old startup index or navigation snapshot after mutation.
   this.index=verified.index;this.firstDashboardIndexUntil=0;clearNavigationSnapshot();
   return validateEmployerDirectory(verified.index.employers??[]);
  }
  throw new Error('勤務先一覧の同時更新が続いています。再試行してください。');
  });
 }
 /** Backup restores missing IDs only. Existing names and defaults stay intact. */
 async restoreEmployerDirectory(backup:readonly EmployerEntry[]):Promise<void> {
  const live=await this.readEmployerDirectory();
  await this.writeEmployerDirectory(live,mergeEmployerDirectories(live,backup));
 }
 private async registerYear(year:string,type:'years'|'incomeYears'):Promise<void> {
  await this.registerYears([year],type);
 }
 private async registerYears(years:readonly string[],type:'years'|'incomeYears'):Promise<void> {
  for(let retry=0;retry<5;retry++){
   const {index,file}=await this.readIndex();
   if(years.every(year=>index[type].includes(year))){this.index=index;return;}
   const changed={...index,[type]:[...new Set([...index[type],...years])].sort()};
   try{await this.graph.write(['payroll'],'index.enc',await encryptJson('index',changed,this.unlocked(),this.salt),file,MAX_INDEX);}
   catch(e){if(isCollision(e))continue;throw e;}
   if(type==='incomeYears'){
    const verified=await this.readIndex();
    if(!years.every(year=>verified.index.incomeYears.includes(year)))throw new Error('収入連携の索引保存結果が一致しません。');
    this.index=verified.index;
   }else this.index=changed;
   return;
  }
  throw new Error('OneDrive索引の同時変更が続いています。再試行してください。');
 }
 /** Register a verified empty year before writing real statements. An index failure can then
  * leave only an empty orphan, never invisible payroll records. */
 private async prepareYearForWrite(year:string):Promise<boolean> {
  const {index}=await this.readIndex();
  // A pre-existing year was just checked against the live index, rotation lock
  // and encryption generation. A newly registered year MUST re-read the index
  // before committing because this path may write both the year and the index.
  if(index.years.includes(year))return true;
  const existing=await this.readYear(year,index);
  if(!existing.file) {
   try {
    await this.graph.write(this.pathFor(index,'statements'),`${year}.enc`,await encryptJson('year',emptyDoc(),this.unlocked(),this.salt),null,MAX_YEAR);
   }catch(error){if(!isCollision(error))throw error;}
  }
  const confirmed=await this.readYear(year,index);
  if(!confirmed.file)throw new Error(`${year}年度の初期ファイルを確認できません。明細はまだ保存していません。`);
  if(confirmed.doc.records.length||confirmed.doc.deleted.length)
   throw new Error(`${year}年度に索引未登録の明細が存在します。上書きせず、設定画面の「孤立年度を検査・復旧」を実行してください。`);
  await this.registerYear(year,'years');
  return false;
 }
 /** Read-only bounded inventory. A scope is used only for ordinary uploads;
  * cleanup and key rotation always scan the complete original tree. */
 private async listOriginalFiles(index:Index,scope?:readonly string[]):Promise<OriginalInventoryEntry[]> {
  const root=this.pathFor(index,'originals');
  const result:OriginalInventoryEntry[]=[];
  // Full recovery/cleanup scans every month; routine saves inspect only target months.
  // Three reads at a time; wait for all in-flight reads on failure before returning.
  const readGroups=async<T,R>(items:readonly T[],read:(item:T)=>Promise<R>):Promise<R[]>=>{
   const values:R[]=[];
   for(let i=0;i<items.length;i+=3){
    const group=await Promise.allSettled(items.slice(i,i+3).map(read));
    for(const value of group){if(value.status==='rejected')throw value.reason;values.push(value.value);}
   }
   return values;
  };
  const allMonths=async()=>{
   const years=await this.graph.listFolder(root,true)??[];
   for(const year of years)if(!year.folder||!/^(19|20|21)\d{2}$/.test(year.name))throw new Error('PDF原本領域に未知の項目があります。暗号鍵の変更・整理を中断しました。');
   const monthGroups=await readGroups(years,async year=>{
    const months=await this.graph.listFolder([...root,year.name],true)??[];
    return months.map(month=>{
     if(!month.folder||!/^(0[1-9]|1[0-2])$/.test(month.name))throw new Error('PDF原本の月フォルダーが想定外です。');
     return {year:year.name,month:month.name};
    });
   });
   return monthGroups.flat();
  };
  const monthPaths=scope===undefined?await allMonths():[...new Set(scope)].sort().map(value=>{
   if(!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value))throw new Error('原本の対象年月が不正です。');
   const [year,month]=value.split('-');return {year,month};
  });
  for(let i=0;i<monthPaths.length;i+=3){
   const groups=await readGroups(monthPaths.slice(i,i+3),async ({year,month})=>{
    const path=[...root,year,month];
    const files=await this.graph.listFolder(path)??[];
    return files.map(file=>{
     if(file.folder||!/^[0-9a-f-]{36}\.enc$/i.test(file.name))throw new Error('PDF原本のファイル名または構造が想定外です。');
     if(!file.etag||!file.id||file.size<1)throw new Error('PDF原本のファイル情報が不正です。');
     return {id:file.id,month:`${year}-${month}`,uuid:file.name.slice(0,-4),path,name:file.name,etag:file.etag,size:file.size};
    });
   });
   for(const group of groups)for(const file of group){
    result.push(file);
    if(result.length>10000)throw new Error('PDF原本の件数が多すぎるため、自動で鍵変更・整理できません。');
   }
  }
  return result.sort((a,b)=>(a.month+'/'+a.uuid).localeCompare(b.month+'/'+b.uuid));
 }
  /**
   * 参照されていない本人PDF原本の読み取り専用監査。削除済みとアップロード中断の原本は
   * 構造上区別できないため、どちらも「未参照」と表記する。
   * 保管庫の年別明細が索引にない場合、安全な判定ができないため中断する。
   */
  async inspectDetachedOriginals(reuseVerifiedYears=false,scope?:readonly string[]):Promise<DetachedOriginalReport> {
    this.unlocked();
    const {index,file:indexFile}=await this.readIndex();
    const entries=await this.graph.listFolder(this.pathFor(index,'statements'))??[];
    const expectedYears=new Set(index.years);
    const listed=new Map<string,CloudFolderItem>();
    for(const entry of entries){
      if(entry.folder||!/^(19|20|21)\d{2}\.enc$/.test(entry.name)||!expectedYears.has(entry.name.slice(0,-4)))
        throw new Error('索引に登録されていない年度または不明なファイルがあります。年度データの復旧を先に行ってください。');
      if(reuseVerifiedYears){
        if(listed.has(entry.name)||!entry.id||!entry.etag||!Number.isSafeInteger(entry.size)||entry.size<1||entry.size>MAX_YEAR)throw new Error('年度メタデータが不正です。');
        listed.set(entry.name,entry);
      }
    }
    const yearEtags:Array<{year:string;etag:string}>=[];
    const used=new Set<string>(),recordIds=new Set<number>();
    for(const year of index.years){
      const entry=listed.get(`${year}.enc`),prior=this.shardVersions.get(year),cached=this.shards.get(year);
      // Reuse authenticated annual bytes only against this fresh strict listing.
      const reuse=reuseVerifiedYears&&this.shardKey===this.key&&this.shardSalt===this.salt&&this.shardGeneration===index.generation&&entry&&prior&&cached&&entry.id===prior.id&&entry.etag===prior.etag&&entry.size===prior.size;
      const {doc,file}=reuse?{doc:cached,file:entry}:await this.readYear(year,index);
      if(!file)throw new Error(`${year}年度の明細がありません。原本整理を中断しました。`);
      if(reuseVerifiedYears&&(!entry||entry.id!==file.id||entry.etag!==file.etag||entry.size!==file.size))throw new Error('年度明細が原本一覧の検査中に変更されました。');
      yearEtags.push({year,etag:file.etag});
      for(const record of doc.records){
        if(shardYear(record)!==year)throw new Error('年別明細の所属年度が不正です。原本整理を中断しました。');
        if(recordIds.has(record.id))throw new Error('複数年度に同じ明細IDが存在します。年度移動の整合性を確認してください。');
        recordIds.add(record.id);
        used.add(`${record.originalMonth}/${record.originalId.toLowerCase()}`);
      }
    }
    const inventory=await this.listOriginalFiles(index,scope);
    const available=new Set(inventory.map(x=>`${x.month}/${x.uuid.toLowerCase()}`));
    // Routine uploads authenticate relevant duplicate candidates separately.
    // Missing unrelated originals must not block new payroll data.
    for(const ref of used)if(scope===undefined&&!available.has(ref))
      throw new Error('有効な給与明細が参照する原本が見つかりません。整理を中断しました。');
    const latest=await this.readIndex();
    if(latest.file.etag!==indexFile.etag)
      throw new Error('監査中に索引が変更されました。再確認してください。');
    return {
      generation:index.generation??'',indexEtag:indexFile.etag,years:yearEtags,
      originals:inventory.filter(x=>!used.has(`${x.month}/${x.uuid.toLowerCase()}`))
       .map(({id,month,uuid,etag,size})=>({id,month,uuid,etag,size})),
    };
  }
  /** Inspect detached originals across all months, since the user may correct the
   * target month after an interrupted save. Unrelated intact PDFs do not block. */
  async inspectDetachedUploadMatches(report:DetachedOriginalReport,attempt:readonly {targetMonth:string;fileHash:string}[]):Promise<DetachedUploadMatch[]> {
    const matches:DetachedUploadMatch[]=[];
    const {index,file:indexFile}=await this.readIndex();
    if(indexFile.etag!==report.indexEtag||(index.generation??'')!==report.generation)throw new Error('原本検査中に索引が変更されました。');
    for(const item of report.originals){
      const [year,month]=item.month.split('-');
      const file=await this.graph.read(this.pathFor(index,'originals',year,month),`${item.uuid}.enc`,MAX_ORIGINAL);
      if(!file||file.id!==item.id||file.etag!==item.etag||file.size!==item.size)throw new Error('未参照PDF原本が検査中に変更されました。');
      const bytes=await decryptBytes('original',file.text,this.unlocked());
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(attempt.some(p=>p.fileHash===hash))matches.push({targetMonth:item.month,fileHash:hash,original:item});
    }
    return matches;
  }
  private async verifiedDetachedOriginal(report:DetachedOriginalReport,item:DetachedOriginal):Promise<{data:Blob;path:string[];target:CloudFolderItem}> {
    const fresh=await this.inspectDetachedOriginals();
    if(!same(fresh,report))throw new Error('原本一覧か年別明細が更新されました。再検査してください。');
    return this.readDetachedOriginal(fresh,item);
  }
  private async readDetachedOriginal(fresh:DetachedOriginalReport,item:DetachedOriginal):Promise<{data:Blob;path:string[];target:CloudFolderItem}> {
    if(!fresh.originals.some(x=>same(x,item)))throw new Error('選択したPDF原本が未参照であると確認できません。');
    const [year,month]=item.month.split('-');
    const path=this.storagePath('originals',year,month),name=`${item.uuid}.enc`;
    const file=await this.graph.read(path,name,MAX_ORIGINAL);
    if(!file||file.id!==item.id||file.etag!==item.etag||file.size!==item.size)
      throw new Error('原本が更新されました。再検査してください。');
    const bytes=await decryptBytes('original',file.text,this.unlocked());
    if(bytes.length<5||new TextDecoder().decode(bytes.slice(0,1024)).indexOf('%PDF-')<0)
      throw new Error('PDFとして確認できない原本です。削除せず、元データを調査してください。');
    return {data:new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),path,
      target:{id:item.id,name,etag:item.etag,size:item.size,folder:false}};
  }
  /** PDF本体だけを回収する。削除前の解析値・手動編集値は復元しない。 */
  async retrieveDetachedOriginal(report:DetachedOriginalReport,item:DetachedOriginal):Promise<Blob> {
    return (await this.verifiedDetachedOriginal(report,item)).data;
  }
  /** Enumerate exact old copies of the approved logical original. Older keys are
   * not available: this attests identity/ETag, not equality of decrypted bytes.
   * Cleanup of those copies still needs a separate explicit user confirmation. */
  private async oldCopiesForTrash(index:Index,item:DetachedOriginal):Promise<OriginalTrashEvidence[]> {
   if(!index.generation)return [];
   const generations=[''];
   const versions=await this.graph.listFolder(['payroll','versions'])??[];
   if(!versions.some(entry=>entry.folder&&entry.name===index.generation))throw new Error('現行の保存世代を確認できません。原本整理を中断します。');
   for(const entry of versions){
    if(!entry.folder||!/^[0-9a-f-]{36}$/i.test(entry.name))throw new Error('旧保存世代に未知の項目があります。原本整理を中断します。');
    if(entry.name!==index.generation)generations.push(entry.name);
   }
   const copies:OriginalTrashEvidence[]=[];
   for(const generation of generations){
    const old:Index={...emptyIndex(),...(generation?{generation}:{})};
    for(const entry of await this.listOriginalFiles(old)){
     if(entry.month===item.month&&entry.uuid.toLowerCase()===item.uuid.toLowerCase())copies.push({generation,month:entry.month,uuid:entry.uuid,id:entry.id,etag:entry.etag,size:entry.size});
    }
   }
   return validateTrashEvidence(copies);
  }
  /** 個別確認後のごみ箱移動。データが変わった場合は必ず再監査する。 */
  async trashDetachedOriginal(report:DetachedOriginalReport,item:DetachedOriginal,requiredIncomeYears:ReadonlySet<string>=new Set(),checkState?:()=>Promise<unknown>):Promise<void> {
  return this.graph.withWriteLock(async()=>{
    const checked=await this.verifiedDetachedOriginal(report,item);
    const baseline=await this.readIndex();
    if(baseline.file.etag!==report.indexEtag)throw new Error('原本整理の確認後に索引が変更されました。');
    const oldCopies=await this.oldCopiesForTrash(baseline.index,item);
    const history=validateTrashEvidence([...new Map([...(baseline.index.originalTrashHistory??[]),...oldCopies].map(e=>[trashEvidenceKey(e),e])).values()]);
    const changed:Index={...baseline.index,originalTrashHistory:history};
    // Prepare the encrypted receipt before any destructive operation. Publish
    // it ONLY after the conditional DELETE and its absence readback succeed.
    const receipt=oldCopies.length?await encryptJson('index',changed,this.unlocked(),this.salt):null;
    if(receipt&&new TextEncoder().encode(receipt).byteLength>MAX_INDEX)throw new Error('原本整理履歴の容量上限です。原本は移動していません。');
    // Revalidate after the Graph target lookup and token acquisition, not before them.
    // No cross-file transaction exists: refuse any observed drift and never retry DELETE.
    await this.graph.trashPayrollOriginal(checked.path,checked.target,async()=>{
      await checkState?.();
      await this.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
      const years=new Set([...this.index.incomeYears,...this.records().map(incomeYear),...requiredIncomeYears]);
      if((await this.inspectIncomeConsistency(years)).length)
        throw new Error('Finance連携に未同期の収入情報があります。設定で連携データを再生成してから再検査してください。');
      const latest=await this.readIndex();
      if(latest.file.etag!==report.indexEtag||(latest.index.generation??'')!==report.generation)
        throw new Error('保管庫が更新されました。原本の整理を中断します。');
      const entries=await this.graph.listFolder(this.pathFor(latest.index,'statements'))??[];
      if(entries.length!==report.years.length||entries.some(e=>e.folder||!report.years.some(y=>`${y.year}.enc`===e.name&&y.etag===e.etag)))
        throw new Error('年度ファイルが変更されました。原本の整理を中断します。');
      for(const year of report.years){
        const meta=await this.graph.metadata(this.pathFor(latest.index,'statements'),`${year.year}.enc`);
        if(!meta||meta.etag!==year.etag)
          throw new Error('別端末で給与明細が変更されました。原本の整理を中断します。');
      }
      if(!same(await this.oldCopiesForTrash(latest.index,item),oldCopies))throw new Error('旧世代の原本が変更されました。原本の整理を中断します。');
      if((await this.readIndex()).file.etag!==report.indexEtag)throw new Error('索引が変更されました。原本の整理を中断します。');
    });
    clearNavigationSnapshot();
    if(receipt){
     // A failed/ambiguous receipt never authorizes old-copy cleanup. Do not
     // retry DELETE or manufacture evidence from an already missing original.
     const latest=await this.readIndex();
     if(latest.file.etag!==report.indexEtag||await this.graph.metadata(checked.path,checked.target.name))throw new Error('原本は移動済みですが、整理履歴を確定できません。旧世代は保持してください。');
     await this.graph.write(['payroll'],'index.enc',receipt,latest.file,MAX_INDEX);
     const verified=await this.readIndex();
     if(!same(verified.index.originalTrashHistory,history))throw new Error('原本整理履歴の読み戻しに失敗しました。旧世代は保持してください。');
     this.index=verified.index;this.firstDashboardIndexUntil=0;
    }
  });
 }
 /** Explicit, read-only discovery; never mutates or exposes data from unknown folders. */
 async inspectOrphanYears():Promise<OrphanAnnualYear[]> {
  this.unlocked();
  const {index}=await this.readIndex();
  const entries=await this.graph.listFolder(this.pathFor(index,'statements'))??[];
  const candidates:OrphanAnnualYear[]=[];
  for(const entry of entries) {
   if(entry.folder||!/^(19|20|21)\d{2}\.enc$/.test(entry.name))throw new Error('年度ファイルに想定外の項目があります。孤立年度の調査を完了できません。');
   const year=entry.name.slice(0,-4);
   if(index.years.includes(year))continue;
   const {doc,file}=await this.readYear(year,index);
   if(!file||file.etag!==entry.etag)throw new Error(`${year}年度の孤立ファイルが検査中に変わりました。`);
   for(const rec of doc.records){
    if(shardYear(rec)!==year)throw new Error(`${year}年度のファイルに対象年度の異なる明細が含まれています。`);
    await this.original(rec); // Authenticate/decrypt actual PDF, including size and SHA when recorded.
   }
   candidates.push({year,etag:file.etag,records:doc.records.length});
  }
  return candidates.sort((a,b)=>a.year.localeCompare(b.year));
 }
 /** Confirmed recovery is index-only; never re-encrypts or overwrites orphan statements. */
 async recoverOrphanYears(expected:readonly OrphanAnnualYear[]):Promise<number> {
  return this.graph.withWriteLock(async()=>{
  if(!expected.length)return 0;
  const actual=await this.inspectOrphanYears();
  if(!same(actual,expected))throw new Error('孤立年度の検査後にクラウドデータが変わりました。検査し直してください。');
  const live=await this.refresh({forceFresh:true});
  const ids=new Map(live.map(r=>[r.id,r]));
  let count=live.length, bytes=live.reduce((sum,r)=>sum+r.pdfSize,0);
  for(const entry of expected){
   const {doc,file}=await this.readYear(entry.year);
   if(!file||file.etag!==entry.etag||doc.records.length!==entry.records)throw new Error('復旧対象の年度ファイルが変わりました。');
   for(const rec of doc.records){
    if(ids.has(rec.id)||[...ids.values()].some(r=>payrollPeriodsConflict(r,rec)||(r.fileHash&&r.fileHash===rec.fileHash)))throw new Error(`${entry.year}年度の孤立明細は既存明細と競合します。自動復旧を中止しました。`);
    ids.set(rec.id,rec);count++;bytes+=rec.pdfSize;
   }
  }
  if(count>MAX_RECORDS||bytes>MAX_TOTAL_PDF_BYTES)throw new Error('孤立年度を戻すと件数またはPDF容量上限を超えます。自動復旧を中止しました。');
  let restored=0;const incomeYears=new Set<string>();
  for(const entry of expected){
   // A new writer cannot silently overwrite this file: prepareYearForWrite rejects nonempty orphans.
   const {doc,file}=await this.readYear(entry.year);
   if(!file||file.etag!==entry.etag)throw new Error('復旧対象ファイルが更新されました。残りの復旧を中止します。');
   for(const rec of doc.records)incomeYears.add(incomeYear(rec));
   await this.registerYear(entry.year,'years');restored++;
  }
  await this.refresh({forceFresh:true});
  try{if(incomeYears.size)await this.syncIncomeUnderLock(incomeYears);}
  catch(error){throw new Error(`${restored}年度の索引復旧は完了しましたが、収入ファイルの同期に失敗しました。設定画面の「連携データを再生成」から再実行してください。原因: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
  return restored;
  });
 }
 private async readYear(year:string,sourceIndex:Index=this.index):Promise<{doc:AnnualDocument;file:RemoteFile|null}> {
  const storage=sourceIndex.generation?'変更後の保存世代':'従来の保存領域';
  let file:RemoteFile|null;
  try {file=await this.graph.read(this.pathFor(sourceIndex,'statements'),`${year}.enc`,MAX_YEAR);}
  catch(error) {
    throw new Error(`${year}年度の明細取得に失敗しました（${storage}、Graph API/配信応答）。`,{cause:error});
  }
  if(!file)return {doc:emptyDoc(),file:null};
  try {
    const env=parseEnvelope(file.text,'year');
    if(env.salt!==this.salt)throw new Error('暗号ファイルの鍵情報が索引と一致しません。');
    const doc=validateDoc(await decryptJson<AnnualDocument>('year',file.text,this.unlocked()),year);
    return {doc,file};
  }catch(error) {
    const reason=error instanceof Error?error.message:'不明な復号エラー';
    throw new Error(`${year}年度の暗号明細を読み取れません（${storage}）。${reason}`,{cause:error});
  }
 }
 /**
  * Read-only dashboard startup can reuse the just-verified index once (max 15 seconds).
  * Normal refresh and every write path always read the remote index/ETags afresh.
  * The preferred years are fetched first. A bounded worker pool avoids waiting for a
  * whole batch of four to finish before starting the next year. No partial data is committed.
  */
 async refresh(options?:{
  dashboardStartup?:boolean;
  forceFresh?:boolean;
  /** Reuse a previously decrypted year ONLY after fresh remote ETag validation. */
  reuseVerifiedYears?:boolean;
  /** One fresh paginated Graph inventory validates all indexed annual ETags. */
  bulkYearMetadata?:boolean;
  priorityYears?:readonly string[];
  onProgress?:(loaded:number,total:number,year:string)=>void;
  /** Only requested by fresh edit/preflight readers; delivered from this exact index. */
  onEmployerDirectory?:(directory:EmployerEntry[])=>void;
 }):Promise<CloudRecord[]> {
  if(options?.dashboardStartup && !options.onEmployerDirectory && !options.forceFresh && this.reusedSnapshot && this.snapshotEpoch===mutationEpoch() && Date.now()<this.snapshotDeadline){return this.records();}
  const readEpoch=this.snapshotScope?mutationEpoch():'';
  this.reusedSnapshot=false;
  const useVerifiedIndex=options?.dashboardStartup===true && !options.onEmployerDirectory && Date.now()<this.firstDashboardIndexUntil;
  this.firstDashboardIndexUntil=0;
  const index=useVerifiedIndex?copy(this.index):(await this.readIndex()).index;
  const priorities=new Map((options?.priorityYears??[]).map((year,i)=>[year,i]));
  const years=[...index.years].sort((a,b)=>{
   const ap=priorities.get(a),bp=priorities.get(b);
   if(ap!==undefined||bp!==undefined)return (ap??Infinity)-(bp??Infinity);
   return Number(b)-Number(a);
  });
  const docs=new Map<string,AnnualDocument>();
  const versions=new Map<string,{id:string;etag:string;size?:number}>();
  const mayReuse=options?.reuseVerifiedYears===true && this.shardKey===this.key &&
    this.shardSalt===this.salt && this.shardGeneration===index.generation &&
    typeof this.graph.metadata==='function';
  // Capture the prior verified snapshot before workers await remote metadata.
  const priorDocs=mayReuse?new Map(this.shards):new Map<string,AnnualDocument>();
  const priorVersions=mayReuse?new Map(this.shardVersions):new Map<string,{id:string;etag:string;size?:number}>();
  // Read-only edit/PDF checks and income publication retain EVERY indexed
  // year at EACH consistency boundary. A fresh paginated Graph folder inventory
  // replaces N individual metadata GETs; changed years are decrypted again.
  // A missing, duplicate, malformed, or oversized indexed item fails closed.
  // Read-only and batch-save snapshots require fresh live metadata at each boundary.
  // Batch writes independently re-read the live index/year and use conditional ETags.
  const bulk=options?.bulkYearMetadata===true&&mayReuse&&years.length>=3&&typeof this.graph.listFolder==='function';
  let inventory:Map<string,{id:string;etag:string;size:number}>|undefined;
  if(bulk){
   const entries=await this.graph.listFolder(this.pathFor(index,'statements'));
   if(!entries)throw new Error('年度フォルダーが存在しません。最新状態の確認を中断しました。');
   const indexed=new Set(years.map(year=>`${year}.enc`));
   inventory=new Map();
   for(const item of entries){
    if(!indexed.has(item.name))continue;
    if(item.folder||!item.id||!item.etag||!Number.isSafeInteger(item.size)||item.size<1||item.size>MAX_YEAR||inventory.has(item.name))
     throw new Error('年度メタデータが不正または重複しています。最新状態の確認を中断しました。');
    inventory.set(item.name,{id:item.id,etag:item.etag,size:item.size});
   }
   if(inventory.size!==years.length)throw new Error('年度ファイルの一覧が変更されました。最新状態の確認を中断しました。');
  }
  let next=0,loaded=0,failed=false;
  const worker=async():Promise<void>=>{
   for(;;){
    const at=next++;
    if(at>=years.length)return;
    const year=years[at];
    const prior=priorVersions.get(year);
    if(prior && priorDocs.has(year)) {
      // The current ETag is checked in this boundary either by a fresh folder
      // listing or by the original individual metadata GET (not by cache age).
      const current=inventory?inventory.get(`${year}.enc`):await this.graph.metadata(this.pathFor(index,'statements'),`${year}.enc`);
      if(!current)throw new Error(`${year}年の明細ファイルがありません。`);
      if(current.size!==undefined&&(current.size<1||current.size>MAX_YEAR))throw new Error('OneDriveファイルの容量が上限を超えています。');
      if(current.id===prior.id&&current.etag===prior.etag&&current.size===prior.size){
        docs.set(year,copy(priorDocs.get(year)!));versions.set(year,current);
        loaded++;
        if(!failed)options?.onProgress?.(loaded,years.length,year);
        continue;
      }
    }
    // ETag/identity changed, or no verified prior document: fetch, decrypt, validate.
    const {doc,file}=await this.readYear(year,index);
    if(!file)throw new Error(`${year}年の明細ファイルがありません。`);
    // A file changed DURING a paginated listing/read. Never install a mixed
    // snapshot or silently publish its partially observed contents to Finance.
    const listed=inventory?.get(`${year}.enc`);
    if(listed&&(file.id!==listed.id||file.etag!==listed.etag||file.size!==listed.size))
     throw new Error(`${year}年度の暗号明細が一覧照合中に更新されました。同期を中断しました。`);
    docs.set(year,doc);versions.set(year,{id:file.id,etag:file.etag,size:file.size});
    loaded++;
    if(!failed)options?.onProgress?.(loaded,years.length,year);
   }
  };
  try {
   await Promise.all(Array.from({length:Math.min(4,years.length)},()=>worker()));
  } catch(error){failed=true;throw error;}
  if(options?.dashboardStartup&&this.snapshotScope&&readEpoch!==mutationEpoch())throw new Error('明細の読み込み中にデータが更新されました。最新データを確認してください。');
  // Atomic handover: a failed load cannot replace the last complete in-memory snapshot.
  this.index=index;this.shards=docs;this.shardVersions=versions;
  this.shardKey=this.unlocked();this.shardSalt=this.salt;this.shardGeneration=index.generation;
  this.snapshotDeadline=Date.now()+SNAPSHOT_TTL_MS;
  const editSnapshot=options?.onEmployerDirectory?{records:this.records(),key:this.unlocked(),salt:this.salt}:undefined;
  if(this.snapshotScope&&!index.rotation)await rememberNavigationSnapshot(this.snapshotScope,this.salt,this.unlocked(),{index,years:[...docs],versions:[...versions]},'dashboard',readEpoch);
  if(options?.dashboardStartup&&this.snapshotScope&&readEpoch!==mutationEpoch())throw new Error('明細の読み込み中にデータが更新されました。最新データを確認してください。');
  if(editSnapshot){
   if(this.unlocked()!==editSnapshot.key||this.salt!==editSnapshot.salt||(this.snapshotScope&&readEpoch!==mutationEpoch()))
    throw new Error('明細の読み込み中に保管庫が変更されました。最新データを確認してください。');
   options?.onEmployerDirectory?.(validateEmployerDirectory(index.employers??[]));
   return editSnapshot.records;
  }
  return this.records();
 }
 records():CloudRecord[] {
  const byId=new Map<number,CloudRecord>();
  // 年度移動が途中で止まった場合、同じIDはリビジョンが大きい方を採用。
  for(const doc of this.shards.values())for(const record of doc.records){
   const prior=byId.get(record.id);
   if(!prior||(record.revision??0)>(prior.revision??0))byId.set(record.id,copy(record));
  }
  for(const doc of this.shards.values())for(const id of doc.deleted){
   const record=byId.get(id);
   if(record&&doc.records.some(x=>x.id===id))continue;
   // move時の墓標は別年度の明細を削除しない。
  }
  return [...byId.values()];
 }
 private async commit(year:string,changed:AnnualDocument,checkRemote?:(remote:AnnualDocument)=>void,checkIndex?:(index:Index)=>void):Promise<void> {
  const existingYearChecked=await this.prepareYearForWrite(year);
  const base=copy(this.shards.get(year)??emptyDoc());
  for(let retry=0;retry<5;retry++) {
   // The existing-year preparation read is this attempt's fresh index guard.
   // On creation or every ETag conflict retry, repeat the remote lock/generation check.
   if(!existingYearChecked||retry>0)await this.readIndex();
   const {doc:remote,file}=await this.readYear(year);
   checkRemote?.(remote);
   const merged=validateDoc(mergeAnnual(base,changed,remote),year);
   // Refresh the root lock after the annual GET and encryption. A different
   // device may have started rotation while we were awaiting either operation.
   const encrypted=await encryptJson('year',merged,this.unlocked(),this.salt);
   const latestIndex=await this.readIndex();
   checkIndex?.(latestIndex.index);
   try {
    await this.graph.write(this.storagePath('statements'),`${year}.enc`,encrypted,file,MAX_YEAR);
    const verify=await this.readYear(year);
    if(!verify.file)throw new Error('保存後に年別明細が見つかりません。');
    if(annualReadbackSignature(verify.doc)!==annualReadbackSignature(merged))
     throw new Error('年別明細の保存結果が一致しません。金額・勤務先ID・削除履歴などの変更結果を確認できないため、再読み込みしてください。');
    // If rotation started during the PUT/readback, never report success or
    // cache a snapshot that may belong to the superseded generation.
    await this.readIndex();
    this.shards.set(year,verify.doc);
    // The full read-back has just validated this shard under its current key.
    if(this.shardKey===this.key&&this.shardSalt===this.salt&&this.shardGeneration===this.index.generation)
      this.shardVersions.set(year,{id:verify.file.id,etag:verify.file.etag,size:verify.file.size});
    return;
   }catch(e){if(isCollision(e))continue;throw e;}
  }
  throw new Error(`${year}年の同時更新が続いています。再試行してください。`);
 }
 private async storeOriginal(record:SavedPayrollRecord,uuid:string,month:string,progress?:(stage:string,percent?:number)=>void,allowReceipt=false):Promise<void> {
  const key=this.unlocked();
  progress?.('原本PDFを暗号化しています…');
  const bytes=new Uint8Array(await record.pdf.arrayBuffer());
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  if([...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')!==record.fileHash)
   throw new Error('保存するPDF原本のSHA-256が一致しません。');
  const encrypted=await encryptBytes('original',bytes,key);
  const [year,mm]=month.split('-');
  progress?.('暗号化PDFをOneDriveへ送信しています…');
  try{const receipt=await this.graph.write(this.storagePath('originals',year,mm),`${uuid}.enc`,encrypted,null,MAX_ORIGINAL,(sent,total)=>{
   if(sent>0){const percent=Math.round(sent/total*100);progress?.(`暗号化PDFの送信 ${percent}%`,percent);}
  });
   if(allowReceipt&&receipt){progress?.('PDF原本の保存応答を確認しました');return;}
  }
  catch(e){
   if(!isCollision(e))throw e;
   const existing=await this.graph.read(this.storagePath('originals',year,mm),`${uuid}.enc`,MAX_ORIGINAL);
   if(!existing)throw new Error('既存原本を照合できません。');
   const restored=await decryptBytes('original',existing.text,key);
   if(restored.length!==bytes.length||restored.some((b,i)=>b!==bytes[i]))throw new Error('同じ原本IDに異なるPDFが保存されています。');
   return; // Existing authenticated bytes were already compared.
  }
  progress?.('暗号化PDFを読み戻して照合しています…');
  const check=await this.graph.read(this.storagePath('originals',year,mm),`${uuid}.enc`,MAX_ORIGINAL);
  if(!check)throw new Error('暗号化原本を読み戻せません。');
  const decoded=await decryptBytes('original',check.text,key);
  if(decoded.length!==bytes.length||decoded.some((b,i)=>b!==bytes[i]))throw new Error('原本PDFの読み戻し照合に失敗しました。');
 }
 /**
  * 複数の新規明細を1回のバッチとして保存する。暗号化PDFは最大2件並列、
  * 解析JSONは対象年度ごと、収入データは支給年ごとにそれぞれ1回だけ確定する。
  * 通常登録の原本は確定応答を利用し、復元・不完全な応答では読み戻す。年度ETag・3方向マージは維持。
  * 一部失敗時にOneDrive全体の原子性は保証できないので成功扱いにしない。
  */
 private assertRecordLimits(records:readonly CloudRecord[]):void {
  if(records.length>MAX_RECORDS)throw new Error('給与明細の保存上限2000件を超えます。');
  if(records.reduce((sum,r)=>sum+r.pdfSize,0)>MAX_TOTAL_PDF_BYTES)throw new Error('PDF原本の合計が480MiBを超えます。');
 }
 async saveBatch(records:SavedPayrollRecord[],progress?:PayrollSaveProgress,expectedExisting?:readonly CloudRecord[],authorized:()=>boolean=()=>true,state?:PayrollWriteState,uploadPreflight?:(baseline?:readonly CloudRecord[])=>Promise<{inventory:DetachedOriginalReport;matches:readonly DetachedUploadMatch[];candidateIncomeYears:readonly string[];scope?:readonly string[]}>):Promise<void> {
  const emit=(phase:PayrollSavePhase,title:string,count='',percent:number|null=null)=>progress?.({phase,title,count,percent});
  emit(0,'保存ロックを取得中');
  await this.graph.withWriteLock(async()=>{
  emit(0,'保存済みデータを再確認中');
  this.unlocked();
  if(!records.length)return;
  const ids=new Set<number>(),hashes=new Set<string>(),accepted:SavedPayrollRecord[]=[];
  for(const record of records) {
   if(!idOkay(record.id)||ids.has(record.id)||this.records().some(r=>r.id===record.id))
    throw new Error('保存対象の明細IDが重複しています。');
   if(!record.fileHash||!/^[a-f0-9]{64}$/.test(record.fileHash))throw new Error('PDFのSHA-256が必要です。');
   if(hashes.has(record.fileHash)||accepted.some(r=>payrollPeriodsConflict(r,record)))throw new Error('バッチ内に重複する明細または勤務先ID未確認の明細があります。');
   ids.add(record.id);hashes.add(record.fileHash);accepted.push(record);
   shardYear(record);incomeYear(record);
  }
  const added:CloudRecord[]=[];
  const snapshot=(items:readonly CloudRecord[])=>canonicalJson([...items].sort((a,b)=>a.id-b.id));
  const checkBaseline=(current:readonly CloudRecord[])=>{
   if(!authorized()||(expectedExisting&&snapshot(current)!==snapshot([...expectedExisting,...added])))
    throw new Error('保存前の照合後に明細または認証状態が変更されました。再検査してください。');
  };
  const preflightBaseline=expectedExisting?await this.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true}):undefined;
  if(preflightBaseline)checkBaseline(preflightBaseline);
  // Ordinary upload preflight runs under the same lock as the writes, so a
  // second client cannot leave another detached copy between the two stages.
  const reusable=new Map<string,DetachedOriginal>();
  const evidence=await uploadPreflight?.(preflightBaseline);
  if(evidence?.matches.length){
   const inventory=await this.inspectDetachedOriginals(true,evidence.scope);
   if(!same(inventory,evidence.inventory))throw new Error('原本一覧か年別明細が更新されました。再検査してください。');
   const matches=evidence.matches.filter(match=>hashes.has(match.fileHash));
   for(const match of matches){
    if(reusable.has(match.fileHash))throw new Error('同じPDFの未参照原本が複数あります。設定で原本を確認してください。');
    reusable.set(match.fileHash,match.original);
   }
   // Recheck detached membership and authenticated content before linking;
   // do not modify, move or delete the original, including across fiscal years.
   for(const record of records){
    const item=reusable.get(record.fileHash!);if(!item)continue;
    const {data}=await this.readDetachedOriginal(inventory,item);
    const bytes=new Uint8Array(await data.arrayBuffer()),selected=new Uint8Array(await record.pdf.arrayBuffer());
    if(bytes.length!==selected.length||bytes.some((b,i)=>b!==selected[i]))throw new Error('既存PDF原本が選択中のPDFと一致しません。');
   }
  }
  const completed:CloudRecord[]=new Array(records.length);
  let next=0,originalsDone=0,firstFailure:unknown=null,onlyRejectedWrites=true;
  // 独立したPDFのみ少数並列。失敗したら新規投入を止め、処理中は終わるまで待つ。
  const uploadWorker=async():Promise<void>=>{
   while(firstFailure===null) {
    const i=next++;
    if(i>=records.length)return;
    const record=records[i],reuse=reusable.get(record.fileHash!),originalId=reuse?.uuid??crypto.randomUUID(),month=reuse?.month??record.form.targetMonth;
    try {
     if(!authorized())throw new Error('認証状態が変更されました。');
     emit(1,'PDF原本を暗号化中',`${i+1} / ${records.length}件 · `);
     if(!reuse)await this.storeOriginal(record,originalId,month,(stage,percent)=>emit(1,percent===undefined?stage:'OneDriveへ保存中',`${i+1} / ${records.length}件 · `,percent??null),Boolean(uploadPreflight));
     const {pdf,...summary}=record;
     completed[i]={...summary,pdfSize:pdf.size,pdfType:pdf.type,originalId,originalMonth:month};
     originalsDone++;
     emit(1,'PDF原本の保存・照合',`${originalsDone} / ${records.length}件 · `);
    }catch(error){
     if(!(error instanceof GraphWriteRejectedError))onlyRejectedWrites=false;
     if(firstFailure===null)firstFailure=error;
    }
   }
  };
  await Promise.all(Array.from({length:Math.min(2,records.length)},()=>uploadWorker()));
  if(firstFailure!==null) {
   // All workers have settled. No annual write has begun; verified originals
   // remain detached. A rejected mutation is not a failed readback or lost reply.
   // The Graph checkpoint itself refuses to advance while any write is uncertain.
   if(state&&originalsDone>0&&onlyRejectedWrites&&authorized())this.graph.markUploadCheckpoint();
   if(state&&originalsDone===0&&firstFailure instanceof Error)throw firstFailure;
   const msg=firstFailure instanceof Error?firstFailure.message:String(firstFailure);
   throw new Error(`PDF原本 ${originalsDone}/${records.length}件の保存・照合後に失敗しました。解析明細は未確定ですが、暗号化原本が一部OneDriveに残っている可能性があります。原因: ${msg}`,{cause:firstFailure});
  }

  if(state)this.graph.markUploadCheckpoint();
  // 原本の全件検証後、最新の索引と全年度ETagを確認して重複・容量を検証。
  // 変更のない年度だけ復号済み本文を再利用。直後の初回年度保存と照合を共有する。
  // 保存本体は commit() のライブ索引、最新年度本文、条件付きETag書込で保護する。
  const verifiedBatchRefresh=()=>this.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
  // 別端末が間に保存した同一給与の存在をここで検出する。
  emit(2,'最新の明細と競合を確認中');
  let current:CloudRecord[];
  try { current=await verifiedBatchRefresh(); }
  catch(error) {
   const msg=error instanceof Error?error.message:String(error);
   throw new Error(`原本${records.length}件の保存・照合は完了しましたが、年度データの再取得に失敗しました。解析明細は未確定で、暗号化原本だけが残っている可能性があります。原因: ${msg}`,{cause:error});
  }
  checkBaseline(current);
  const collides=(candidate:CloudRecord,remote:readonly CloudRecord[]):boolean=>remote.some(r=>
   r.id!==candidate.id&&(r.fileHash===candidate.fileHash||payrollPeriodsConflict(r,candidate)));
  for(const rec of completed)if(current.some(r=>r.id===rec.id)||collides(rec,current))
   throw new Error('別端末で同じ明細またはIDが保存されました。原本は保持し、解析明細の確定を中止しました。');
  this.assertRecordLimits([...current,...completed]);

  const grouped=new Map<string,CloudRecord[]>();
  for(const rec of completed) {
   const year=shardYear(rec);
   const list=grouped.get(year)??[];list.push(rec);grouped.set(year,list);
  }
  let committed=0;
  try {
   for(const [year,items] of grouped) {
    emit(2,'年度データを保存・検証中',`${committed} / ${records.length}件 · `);
    // The original/post-commit boundary is also the next pre-commit boundary.
     // No cloud operation occurs between these boundaries; commit still reads
     // the live target year and index, and post-commit checks all years.
     const latest=current;
     checkBaseline(latest);
     if(items.some(rec=>latest.some(r=>r.id===rec.id||collides(rec,latest))))
      throw new Error('別端末が明細を追加しました。重複があるため保存を中止しました。');
     this.assertRecordLimits([...latest,...items]);
     const doc=copy(this.shards.get(year)??emptyDoc());
     doc.records.push(...items);
     await this.commit(year,doc,remote=>{
      if(!authorized()||(expectedExisting&&snapshot(remote.records)!==snapshot([...expectedExisting,...added].filter(r=>shardYear(r)===year))))
       throw new Error('保存前の照合後に年度明細が変更されました。再検査してください。');
      for(const rec of items)if(remote.records.some(r=>r.id===rec.id)||collides(rec,remote.records))
       throw new Error(`${year}年度に別端末が同じ給与を保存しました。重複登録を防ぐため中止しました。`);
      this.assertRecordLimits([...this.records().filter(r=>!remote.records.some(x=>x.id===r.id)),...remote.records,...items]);
     });
    committed+=items.length;added.push(...items);
    if(state)this.graph.markUploadCheckpoint();
    const after=await verifiedBatchRefresh();
    checkBaseline(after);
    current=after;
    try{this.assertRecordLimits(after);}catch(error){throw new Error('保存直後に別端末との同時更新で上限超過を検出しました。明細は保存済みの可能性があります。追加操作せず確認してください。',{cause:error});}
    emit(2,'年度データを保存・検証中',`${committed} / ${records.length}件 · `);
   }
   // All originals and annual statements have passed their readback and
   // baseline checks. Finance is derived data, not another payroll commit.
   if(state)state.payrollSaved=true;
   const years=new Set([...records.map(incomeYear),...(evidence?.candidateIncomeYears??[])]);
   emit(3,'Finance収入連携を確認中');
   await this.syncIncomeUnderLock(years);
   emit(4,'保存結果を確認中');
  }catch(error){
   if(state?.payrollSaved)throw new PayrollPartialSuccessError('income-sync','給与明細は保存済みですが、Finance連携を完了できませんでした。給与明細を再登録せず、保存結果を確認してください。',{cause:error});
   const msg=error instanceof Error?error.message:String(error);
   throw new Error(`原本${records.length}件を保存後、解析明細${committed}/${records.length}件を確定した段階で失敗しました。一部の年度ファイルや収入連携データが更新済みの可能性があります。保存結果を確認してから再操作してください。原因: ${msg}`,{cause:error});
  }
  },state);
  emit(4,`${records.length}件のOneDrive保存・読み戻し検証がすべて完了しました`);
 }
 async reconcileUploadLock(state:PayrollWriteState):Promise<void>{this.unlocked();await this.graph.reconcileUploadLock(state);}
 /** 旧暗号ファイルは上書きせず、新世代を全件検証してからルート索引だけを切り替える。
  * OneDriveの世代をまたいだ一括トランザクションは存在しないので、競合を禁止し
  * 切替前のエラーでは旧索引へ戻す。切替後の不明応答は必ず読戻して判定する。 */
 async changePassphrase(currentPassphrase:string,newPassphrase:string,onProgress?:(step:string)=>void):Promise<{key:CryptoKey;salt:string;generation:string}> {
  return this.graph.withWriteLock(async()=>{
  this.unlocked();
  if(this.rotationId)throw new Error('パスフレーズ変更はすでに実行中です。');
  if([...newPassphrase].length<12)throw new Error('新しいパスフレーズは12文字以上にしてください。');
  if(currentPassphrase===newPassphrase)throw new Error('新しいパスフレーズは現在と異なるものにしてください。');
  const oldKey=this.unlocked(),oldSalt=this.salt;
  const root=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
  if(!root||envelopeSalt(root.text)!==oldSalt)throw new Error('クラウドの暗号索引が変更されました。');
  const entered=await deriveKey(currentPassphrase,oldSalt);
  const originalIndex=validateIndex(await decryptJson<Index>('index',root.text,entered));
  this.ensureRotationAllowed(originalIndex);
  const orphans=await this.inspectOrphanYears();
  if(orphans.length)throw new Error(`索引未登録の年度ファイル（${orphans.map(v=>v.year).join('、')}年度）が存在します（空の年度ファイルを含みます）。パスフレーズを変更する前に、設定画面の「年度データの復旧」で確認・復旧してください。`);
  const originalInventory=await this.listOriginalFiles(originalIndex);
  const yearEndInventory=await this.listYearEndFiles(originalIndex);
  const gen=crypto.randomUUID(),newSalt=createSalt(),newKey=await deriveKey(newPassphrase,newSalt);
  const lockedIndex:Index={...originalIndex,rotation:{id:gen,startedAt:Date.now()}};
  const lockedText=await encryptJson('index',lockedIndex,oldKey,oldSalt);
  let locked=false,completed=false;
  try {
   onProgress?.('変更中の編集を停止しています…');
   await this.graph.write(['payroll'],'index.enc',lockedText,root,MAX_INDEX);
   this.rotationId=gen;locked=true;this.index=lockedIndex;
   const lockedRemote=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
   if(!lockedRemote||!same(await decryptJson<Index>('index',lockedRemote.text,oldKey),lockedIndex))throw new Error('変更ロックの確認に失敗しました。');
   const lockedOrphans=await this.inspectOrphanYears();
   if(lockedOrphans.length)throw new Error('変更ロック中に索引未登録の年度を検出しました。旧索引を復旧して中断します。');
   if(!same(await this.listOriginalFiles(originalIndex),originalInventory))throw new Error('PDF原本の一覧が変更されました。旧鍵を保持して中断します。');
   // 復旧用の元索引。旧原本も保持するので、失敗後も旧パスフレーズで復旧可能。
   await this.graph.write(['payroll','versions',gen,'recovery'],'previous-index.enc',root.text,null,MAX_INDEX,undefined,false);
   const sources:Array<{path:string[];name:string;etag:string;size?:number}>=[];
   const activeOriginals=new Map<string,CloudRecord[]>();
   let total=originalIndex.years.length+originalIndex.incomeYears.length;
   // 元の年度・給与情報を、ロックした状態でスナップショットとして取得。
   const annual:Array<{year:string;doc:AnnualDocument}>=[];
   for(const year of originalIndex.years) {
    const path=this.pathFor(originalIndex,'statements');
    const old=await this.graph.read(path,`${year}.enc`,MAX_YEAR);
    if(!old)throw new Error(`${year}年度の元データが見つかりません。`);
    const doc=validateDoc(await decryptJson<AnnualDocument>('year',old.text,oldKey),year);
    annual.push({year,doc});sources.push({path,name:`${year}.enc`,etag:old.etag,size:old.size});
    for(const rec of doc.records){const name=`${rec.originalMonth}/${rec.originalId}`;activeOriginals.set(name,[...(activeOriginals.get(name)??[]),rec]);}
   }
   const retainedIds=new Set(originalInventory.map(file=>`${file.month}/${file.uuid}`));
   for(const key of activeOriginals.keys())if(!retainedIds.has(key))throw new Error('現行明細が参照するPDF原本が一覧にありません。鍵変更を中断します。');
   total+=originalInventory.length;
   total+=yearEndInventory.length;
   const income:Array<{year:string;clear:Uint8Array}>=[];
   for(const year of originalIndex.incomeYears) {
    const path=this.pathFor(originalIndex,'income');
    const old=await this.graph.read(path,`${year}.enc`,MAX_YEAR);
    if(!old)throw new Error(`${year}年の収入連携データが見つかりません。`);
    income.push({year,clear:await decryptBytes('income',old.text,oldKey)});
    sources.push({path,name:`${year}.enc`,etag:old.etag,size:old.size});
   }
   let done=0;
   const staged=async(kind:'year'|'income'|'original'|'assist-index'|'assist-profile'|'assist-year'|'assist-original',path:string[],name:string,clear:Uint8Array,limit:number):Promise<void>=>{
    const text=await encryptBytes(kind,clear,newKey,(kind==='original'||kind==='assist-original')?undefined:newSalt);
    await this.graph.write(path,name,text,null,limit);
    const verified=await this.graph.read(path,name,limit);
    if(!verified)throw new Error('新しい暗号ファイルの読み戻しに失敗しました。');
    const output=await decryptBytes(kind,verified.text,newKey);
    if(output.length!==clear.length||output.some((byte,i)=>byte!==clear[i]))throw new Error('新しい暗号ファイルの照合に失敗しました。');
    done++;onProgress?.(`新しい鍵で暗号化・照合中：${done}/${total}ファイル`);
   };
   for(const {year,doc} of annual){
    const clear=new TextEncoder().encode(JSON.stringify(doc));
    await staged('year',['payroll','versions',gen,'statements'],`${year}.enc`,clear,MAX_YEAR);
   }
   for(const {year,clear} of income){
    await staged('income',['payroll','versions',gen,'income'],`${year}.enc`,clear,MAX_YEAR);
   }
   // Deleted and upload-interrupted PDFs have no active record, but still belong to the
   // encrypted archive. Re-encrypt ALL original files, not just referenced ones.
   for(const entry of originalInventory){
    const {month,uuid,path,name}=entry;
    const old=await this.graph.read(path,name,MAX_ORIGINAL);
    if(!old||old.etag!==entry.etag||old.size!==entry.size)throw new Error('PDF原本が鍵変更中に変更されました。');
    const clear=await decryptBytes('original',old.text,oldKey);
    if(clear.length<1)throw new Error('PDF原本を復号できません。');
    const metadata=activeOriginals.get(`${month}/${uuid}`)??[];
    for(const rec of metadata){
     if(clear.length!==rec.pdfSize)throw new Error('PDF原本のサイズが明細データと一致しません。');
     if(!rec.fileHash||!/^[a-f0-9]{64}$/.test(rec.fileHash))throw new Error('PDF原本のSHA-256が欠落または不正です。鍵変更を中止しました。');
     {
      const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(clear));
      const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      if(hash!==rec.fileHash)throw new Error('PDF原本のハッシュが一致しません。');
     }
    }
    sources.push({path,name,etag:old.etag,size:old.size});
    const [yyyy,mm]=month.split('-');
    await staged('original',['payroll','versions',gen,'originals',yyyy,mm],name,clear,MAX_ORIGINAL);
   }
   // Third-party documents are never inserted into the personal annual/Finance payloads.
   for(const asset of yearEndInventory){
    const limit=asset.kind==='assist-original'?MAX_ORIGINAL:asset.kind==='assist-year'?MAX_YEAR:MAX_INDEX;
    const prior=await this.graph.read(asset.path,asset.name,limit);
    if(!prior||prior.etag!==asset.etag||prior.size!==asset.size)throw new Error('年末調整データが鍵変更中に更新されました。');
    const clear=await decryptBytes(asset.kind,prior.text,oldKey);
    sources.push({path:asset.path,name:asset.name,etag:prior.etag,size:prior.size});
    await staged(asset.kind,['payroll','versions',gen,'year-end-assist',...asset.relative],asset.name,clear,limit);
   }
   if(!same(await this.listYearEndFiles(originalIndex),yearEndInventory))throw new Error('鍵変更中に第三者の給与データが変更されました。旧索引を保持して中断します。');
   // A new original created between listing and cutover must not be silently abandoned.
   if(!same(await this.listOriginalFiles(originalIndex),originalInventory))throw new Error('鍵変更中にPDF原本が増減しました。旧索引を保持して中断します。');
   if((await this.inspectOrphanYears()).length)throw new Error('鍵変更中に索引未登録の年度が追加されました。旧索引を保持して中断します。');
   onProgress?.('他端末からの同時更新を確認しています…');
   for(const src of sources){
    const now=await this.graph.metadata(src.path,src.name);
    if(!now||now.etag!==src.etag||now.size!==src.size)throw new Error('変更中に別端末の給与データが更新されました。旧データを維持して中止します。');
   }
   const nextIndex:Index={format:'payroll-index-v1',years:[...originalIndex.years],incomeYears:[...originalIndex.incomeYears],generation:gen,...(originalIndex.employers!==undefined?{employers:copy(originalIndex.employers)}:{}),...(originalIndex.originalTrashHistory!==undefined?{originalTrashHistory:copy(originalIndex.originalTrashHistory)}:{})};
   const currentRoot=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
   if(!currentRoot||!same(await decryptJson<Index>('index',currentRoot.text,oldKey),lockedIndex))throw new Error('保管庫の変更ロックが別端末から変更されました。');
   onProgress?.('暗号索引を新しい鍵に切り替えています…');
   const newIndexText=await encryptJson('index',nextIndex,newKey,newSalt);
   await this.graph.write(['payroll'],'index.enc',newIndexText,currentRoot,MAX_INDEX);
   const verified=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
   if(!verified||!same(await decryptJson<Index>('index',verified.text,newKey),nextIndex))throw new Error('新しい索引の読み戻し確認に失敗しました。');
   this.key=newKey;this.salt=newSalt;this.index=nextIndex;this.firstDashboardIndexUntil=0;completed=true;
   onProgress?.('パスフレーズ変更を完了しました。');
   return {key:newKey,salt:newSalt,generation:gen};
  } catch(error) {
   // 保存確定直後にネットワークが切れた場合、切替成功を確認してから結果を返す。
   if(locked && !completed){
    let recoveryError='';
    try {
     const current=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
     if(current) {
      if(envelopeSalt(current.text)===newSalt){
       const index=validateIndex(await decryptJson<Index>('index',current.text,newKey));
       if(index.generation===gen&&!index.rotation){
        this.key=newKey;this.salt=newSalt;this.index=index;this.firstDashboardIndexUntil=0;completed=true;
        onProgress?.('通信が中断しましたが、新しい暗号索引の保存を確認できました。');
        return {key:newKey,salt:newSalt,generation:gen};
       }
      }
      if(envelopeSalt(current.text)===oldSalt){
       const index=validateIndex(await decryptJson<Index>('index',current.text,oldKey));
       if(index.rotation?.id===gen){
        await this.graph.write(['payroll'],'index.enc',await encryptJson('index',originalIndex,oldKey,oldSalt),current,MAX_INDEX);
        this.index=originalIndex;
       }
      }
     }
    }catch(recovery){recoveryError=recovery instanceof Error?recovery.message:'通信エラー';}
    if(recoveryError)throw new Error('パスフレーズ変更が中断され、旧索引への復元も確認できません。再読み込みせず、保管庫の状態を確認してください。原因: '+recoveryError,{cause:error});
   }
   throw error;
  }finally{this.rotationId=null;}
  });
 }
 /** 旧鍵による未完了の変更ロックを明示的に取り消す。10分以上経過後のみ許可する。 */
 async recoverInterruptedChange(passphrase:string):Promise<boolean> {
  return this.graph.withWriteLock(async()=>{
  const file=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
  if(!file)return false;
  const salt=envelopeSalt(file.text),key=await deriveKey(passphrase,salt);
  const index=validateIndex(await decryptJson<Index>('index',file.text,key));
  if(!index.rotation)return false;
  if(Date.now()-index.rotation.startedAt<30*60*1000)throw new Error('ほかのタブで変更が進行中の可能性があります。30分後に再確認してください。');
  const prior={...index};delete prior.rotation;
  await this.graph.write(['payroll'],'index.enc',await encryptJson('index',prior,key,salt),file,MAX_INDEX);
  const verify=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
  if(!verify||!same(await decryptJson<Index>('index',verify.text,key),prior))throw new Error('復旧後の索引を確認できません。');
  return true;
  });
 }
 /** 旧暗号ファイルの整理候補。現行索引・保存世代を対象から除外する。 */
 async inspectOldEncryptedData():Promise<{generation:string;indexEtag:string;targets:Array<{parent:string[];item:CloudFolderItem}>;files:number;bytes:number}> {
  this.unlocked();
  const {index,file}=await this.readIndex();
  if(index.rotation)throw new Error('パスフレーズ変更中は整理できません。');
  if(!index.generation)throw new Error('保存世代の変更履歴がありません。旧暗号領域の削除は不要です。');
  const gen=index.generation;
  if((await this.inspectOrphanYears()).length)throw new Error('索引未登録の年度が残っています。先に復旧してから旧暗号データを整理してください。');
  // Check live references even for old copies with a receipt. An unexplained
  // missing current original must never be mistaken for approved deletion.
  const activeReport=await this.inspectDetachedOriginals();
  if(activeReport.indexEtag!==file.etag)throw new Error('原本検査中に索引が変更されました。');
  const evidence=new Set((index.originalTrashHistory??[]).map(trashEvidenceKey));
  // Every old original needs a current authenticated copy or exact evidence
  // of confirmed trash. Unknown/changed old files remain protected.
  const currentOriginalInventory=await this.listOriginalFiles(index);
  const retainedOriginals=new Set(currentOriginalInventory.map(file=>`${file.month}/${file.uuid}`));
  // Deleted and unreferenced PDFs have no current statement record. Authenticate
  // their ciphertext as well, rather than treating a matching filename as proof.
  for(const entry of currentOriginalInventory){
   const encrypted=await this.graph.read(entry.path,entry.name,MAX_ORIGINAL);
   if(!encrypted||encrypted.etag!==entry.etag||encrypted.size!==entry.size)
    throw new Error(`現行PDF原本 ${entry.month}/${entry.uuid} が検査中に変更されました。整理を中断します。`);
   const clear=await decryptBytes('original',encrypted.text,this.unlocked());
   if(clear.byteLength<1)throw new Error('現行のPDF原本が空です。旧暗号領域の整理を中断します。');
  }

  const verifyOldStatements=async(oldIndex:Index):Promise<void>=>{
   for(const file of await this.graph.listFolder(this.pathFor(oldIndex,'statements'))??[]){
    if(file.folder||!/^(19|20|21)\d{2}\.enc$/.test(file.name))throw new Error('旧年度ファイルに未知の項目があります。整理を中断します。');
    if(!index.years.includes(file.name.slice(0,-4)))throw new Error(`${file.name} は現行索引に登録されていません。旧世代に未移行の年度明細がある可能性があるため、フォルダーを削除できません。`);
   }
  };
  const verifyOldOriginals=async(oldIndex:Index):Promise<void>=>{
   for(const file of await this.listOriginalFiles(oldIndex)){
    if(!retainedOriginals.has(`${file.month}/${file.uuid}`)&&!evidence.has(trashEvidenceKey({generation:oldIndex.generation??'',month:file.month,uuid:file.uuid,id:file.id,etag:file.etag,size:file.size})))throw new Error(`旧保存世代のPDF原本 ${file.month}/${file.uuid} が現行世代にありません。削除済み明細の原本を失う可能性があるため、旧暗号領域の整理を中断します。`);
   }
  };
  const targets:Array<{parent:string[];item:CloudFolderItem}>=[];
  const old=(await this.graph.listFolder(['payroll']))??[];
  // Finance v1.1.1 が固定パス payroll/income/YYYY.enc を参照する可能性があるため、旧incomeは自動削除しない。
  for(const name of ['statements','originals','year-end-assist']) {
   const matching=old.filter(x=>x.name===name);
   if(matching.length>1||matching.some(x=>!x.folder))throw new Error('旧保存領域に想定外の項目があります。');
   if(matching[0])targets.push({parent:['payroll'],item:matching[0]});
  }
  const versions=await this.graph.listFolder(['payroll','versions']);
  if(!versions)throw new Error('保存世代フォルダーが見つかりません。');
  if(!versions.some(x=>x.name===gen&&x.folder))throw new Error('現行の保存世代が確認できません。');
  for(const item of versions){
   if(!item.folder||!/^[0-9a-f-]{36}$/i.test(item.name))throw new Error('保存世代に未知の項目があります。自動削除しません。');
   if(item.name!==gen)targets.push({parent:['payroll','versions'],item});
  }
  const current=await this.graph.listFolder(['payroll','versions',gen]);
  const recover=current?.filter(x=>x.name==='recovery')??[];
  if(recover.length>1||recover.some(x=>!x.folder))throw new Error('復旧用フォルダーの形式が不正です。');
  if(recover[0])targets.push({parent:['payroll','versions',gen],item:recover[0]});
  let files=0,bytes=0;
  const scan=async(parts:string[],context:'root'|'generation'|'statements'|'income'|'originals'|'year'|'month'|'recovery'|'assist-root'|'assist-persons'|'assist-person'|'assist-years'|'assist-originals',depth:number):Promise<void>=>{
   if(depth>6)throw new Error('旧暗号データの階層が想定より深いです。');
   const children=await this.graph.listFolder(parts);
   if(!children)throw new Error('整理対象が読み取れません。');
   for(const item of children){
    const n=item.name;
    const next=(kind:typeof context)=>scan([...parts,n],kind,depth+1);
    if(item.folder){
     if(context==='root'||context==='generation'){
      if(n==='statements'||n==='income'||n==='originals'||n==='recovery'||n==='year-end-assist')await next(n==='year-end-assist'?'assist-root':n);
      else throw new Error('旧暗号領域に未知のフォルダーがあります。削除しません。');
     }else if(context==='originals'&&/^(19|20|21)\d{2}$/.test(n))await next('year');
     else if(context==='year'&&/^(0[1-9]|1[0-2])$/.test(n))await next('month');
     else if(context==='assist-root'&&n==='persons')await next('assist-persons');
     else if(context==='assist-persons'&&/^[0-9a-f-]{36}$/i.test(n))await next('assist-person');
     else if(context==='assist-person'&&n==='years')await next('assist-years');
     else if(context==='assist-person'&&n==='originals')await next('assist-originals');
     else throw new Error('旧暗号領域のフォルダー構造が想定外です。');
    } else {
     const okay=(context==='statements'||context==='income')?/^(19|20|21)\d{2}\.enc$/.test(n):
       context==='month'?/^[0-9a-f-]{36}\.enc$/i.test(n):
       context==='recovery'?n==='previous-index.enc':
       context==='assist-root'?n==='index.enc':
       context==='assist-person'?n==='profile.enc':
       (context==='assist-years'||context==='assist-originals')?/^[0-9a-f-]{36}\.enc$/i.test(n):false;
     if(!okay)throw new Error('旧暗号領域に想定外のファイルがあります。削除しません。');
     files++;bytes+=item.size;
     if(files>5000)throw new Error('整理対象のファイルが多すぎます。');
    }
   }
  };
  // Validate every old generation before offering a cleanup action.
  // Even an old version of Payroll that rotated keys before this safeguard
  // may have left deleted originals behind.
  if(targets.some(t=>t.parent.length===1&&t.item.name==='statements'))await verifyOldStatements(emptyIndex());
  if(targets.some(t=>t.parent.length===1&&t.item.name==='originals'))await verifyOldOriginals(emptyIndex());
  for(const target of targets){
   if(target.parent.length===2 && target.parent[0]==='payroll' && target.parent[1]==='versions'){
    const oldIndex:Index={...emptyIndex(),generation:target.item.name};
    await verifyOldStatements(oldIndex);
    await verifyOldOriginals(oldIndex);
   }
   const context=target.item.name==='year-end-assist'?'assist-root':target.item.name==='recovery'?'recovery':target.item.name==='originals'?'originals':
     target.item.name==='statements'?'statements':target.item.name==='income'?'income':'generation';
   await scan([...target.parent,target.item.name],context,0);
  }
  return {generation:gen,indexEtag:file.etag,targets,files,bytes};
 }
 /** 現行世代の明細・原本・収入をすべて検証してから、旧世代のみごみ箱へ送る。 */
 async cleanupOldEncryptedData(expected:{generation:string;indexEtag:string;targets:Array<{parent:string[];item:CloudFolderItem}>},progress?:(message:string)=>void):Promise<number>{
  return this.graph.withWriteLock(async()=>{
  this.unlocked();
  const initial=await this.readIndex();
  if(initial.index.generation!==expected.generation||initial.file.etag!==expected.indexEtag||initial.index.rotation)
    throw new Error('確認後に暗号索引が変わりました。最初から確認し直してください。');
  progress?.('現行の年度別明細を読み戻しています…');
  const records=await this.refresh({forceFresh:true});
  const originals=new Set<string>();let verified=0;
  for(const rec of records){
   const id=rec.originalMonth+'/'+rec.originalId;
   if(originals.has(id))continue;
   originals.add(id);
   await this.original(rec);verified++;
   progress?.(`現行PDFを検証中：${verified}/${records.length}`);
  }
  for(const year of initial.index.incomeYears){
   const file=await this.graph.read(this.storagePath('income'),`${year}.enc`,MAX_YEAR);
   if(!file)throw new Error(`${year}年の収入連携データがありません。整理を中断しました。`);
   const clear=await decryptBytes('income',file.text,this.unlocked());
   const data=JSON.parse(new TextDecoder().decode(clear)) as {format?:string;year?:string};
   if(data.format!=='payroll-income-v1'||data.year!==year)throw new Error('収入連携データの形式が不正です。整理を中断しました。');
  }
  // Verify the active encrypted third-party archive before trashing any older generation.
  for(const asset of await this.listYearEndFiles(initial.index)){
   const limit=asset.kind==='assist-original'?MAX_ORIGINAL:asset.kind==='assist-year'?MAX_YEAR:MAX_INDEX;
   const file=await this.graph.read(asset.path,asset.name,limit);
   if(!file||file.etag!==asset.etag)throw new Error('現行の年末調整データを検証できません。旧世代の整理を中止します。');
   await decryptBytes(asset.kind,file.text,this.unlocked());
  }
  const current=await this.inspectOldEncryptedData();
  const signature=(plan:typeof current)=>JSON.stringify(plan.targets.map(t=>[t.parent.join('/'),t.item.name,t.item.id,t.item.etag]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if(current.generation!==expected.generation||current.indexEtag!==expected.indexEtag||signature(current)!==signature(expected as typeof current))
    throw new Error('整理対象が確認後に変更されました。再確認してください。');
  let done=0;
  for(const target of current.targets){
   // 削除直前に再チェック。別端末で索引が切り替わった場合は中断。
   const latest=await this.readIndex();
   if(latest.index.generation!==current.generation||latest.file.etag!==current.indexEtag)
    throw new Error('別端末が保管庫を更新しました。残りの整理を中断します。');
   const fresh=await this.inspectOldEncryptedData();
   const remaining=current.targets.slice(done);
   if(fresh.indexEtag!==current.indexEtag||signature(fresh)!==signature({...current,targets:remaining}))
    throw new Error('旧暗号領域が変わりました。残りの整理を中断します。');
   await this.graph.trashFolder(target.parent,target.item);
   done++;progress?.(`旧暗号フォルダーをOneDriveのごみ箱へ移動：${done}/${current.targets.length}`);
  }
  clearNavigationSnapshot();
  return done;
  });
 }
 private async readOriginalBytes(record:CloudRecord):Promise<{bytes:Uint8Array;file:RemoteFile}> {
  const [year,mm]=record.originalMonth.split('-');
  const file=await this.graph.read(this.storagePath('originals',year,mm),`${record.originalId}.enc`,MAX_ORIGINAL);
  if(!file)throw new Error('暗号化PDF原本が見つかりません。');
  const bytes=await decryptBytes('original',file.text,this.unlocked());
  if(bytes.byteLength!==record.pdfSize)throw new Error('PDF原本のファイルサイズが記録と一致しません。');
  return {bytes,file};
 }
 private async readVerifiedOriginal(record:CloudRecord):Promise<{data:Blob;file:RemoteFile}> {
  if(!record.fileHash||!/^[a-f0-9]{64}$/.test(record.fileHash))throw new Error('PDF原本のSHA-256が欠落または不正です。原本の検証を省略しません。');
  const {bytes,file}=await this.readOriginalBytes(record);
  const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));
  const hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==record.fileHash)throw new Error('PDF原本のSHA-256が明細の記録と一致しません。');
  return {data:new Blob([new Uint8Array(bytes)],{type:record.pdfType}),file};
 }
 /** Duplicate detection only, not a verified original or a cloud migration. */
 async legacyOriginalDigest(record:CloudRecord):Promise<string> {
  if(record.fileHash)throw new Error('既存ハッシュを省略できません。');
  const {bytes}=await this.readOriginalBytes(record);
  if(!(new TextDecoder().decode(bytes.subarray(0,1024))).includes('%PDF-'))throw new Error('旧PDF原本の形式が不正です。');
  const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
 }
 async original(record:CloudRecord):Promise<Blob> {return (await this.readVerifiedOriginal(record)).data;}
 async save(record:SavedPayrollRecord|SavedPayrollSummary,progress?:(stage:string)=>void,expectedMatch?:(current:CloudRecord)=>boolean,checkConflicts?:(records:readonly CloudRecord[],year:string)=>void,expectedDirectory?:string):Promise<void> {
  const state:PayrollWriteState={attempted:false,uncertain:false,completed:false,lock:'none'};
  return this.graph.withWriteLock(async()=>{
  this.unlocked();
  const checkDirectory=(index:Index)=>{
   if(expectedDirectory!==undefined&&employerDirectorySignature(index.employers??[])!==expectedDirectory)throw new Error('勤務先一覧が更新されました。再度確認してください。');
  };
  const year=shardYear(record);
  await this.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
  checkDirectory(this.index);
  if(!record.fileHash||!/^[a-f0-9]{64}$/.test(record.fileHash))throw new Error('PDF原本のSHA-256が必要です。');
  const originalPrior=this.records().find(r=>r.id===record.id);
  const metadataOnly=!('pdf' in record);
  if(metadataOnly&&(!originalPrior||!expectedMatch||!expectedMatch(originalPrior)))
   throw new Error('明細が変更・削除されました。最新の明細を開き直してください。');
  const month=originalPrior?.originalMonth??record.form.targetMonth;
  const id=originalPrior?.originalId??crypto.randomUUID();
  let next:CloudRecord;
  if('pdf' in record){
   if(!originalPrior){
    await this.storeOriginal(record,id,month,progress);
    progress?.('PDF原本の読み戻し照合が完了しました');
   }
   const {pdf,...summary}=record;
   next={...summary,pdfSize:pdf.size,pdfType:pdf.type,originalId:id,originalMonth:month};
  }else{
   // Never substitute an empty Blob. The original remains encrypted at its old ID.
   const previous=originalPrior!;
   if(record.fileHash!==previous.fileHash||record.pdfSize!==previous.pdfSize||
      record.pdfType!==previous.pdfType||record.pages!==previous.pages||
      record.originalFileName!==previous.originalFileName||record.savedAt!==previous.savedAt)
    throw new Error('PDF原本の保存情報が変化しました。最新の明細を開き直してください。');
   next={...previous,fileName:record.fileName,form:copy(record.form),
    warningsAcknowledged:record.warningsAcknowledged,reviewedIssues:record.reviewedIssues,
    reviewedAt:record.reviewedAt,revision:record.revision};
   if(record.employerId===undefined)delete next.employerId;else next.employerId=record.employerId;
   if(record.zeroResolution===undefined)delete next.zeroResolution;else next.zeroResolution=copy(record.zeroResolution);
   validateDoc({format:'payroll-annual-v1',records:[next],deleted:[]});
   // A fiscal-year move requires a live source record before publishing the target.
   const sourceYear=shardYear(previous);
   if(sourceYear!==year){
    const {doc:source}=await this.readYear(sourceYear);
    const sourceRecord=source.records.find(r=>r.id===record.id);
    if(!sourceRecord||!expectedMatch!(sourceRecord))
     throw new Error('年度移動中に明細が変更されました。保存を中断しました。');
   }
  }
  const doc=copy(this.shards.get(year)??emptyDoc());
  const at=doc.records.findIndex(r=>r.id===record.id);
  if(at>=0)doc.records[at]=next;else doc.records.push(next);
  doc.deleted=doc.deleted.filter(n=>n!==record.id);
  progress?.('解析済み給与データを保存・検証しています…');
  await this.commit(year,doc,expectedMatch?remote=>{
   checkConflicts?.(remote.records,year);
   const current=remote.records.find(r=>r.id===record.id);
   if(originalPrior&&shardYear(originalPrior)===year){
    if(!current||!expectedMatch(current))throw new Error('保存直前に明細が更新されました。再読み込みしてください。');
   }else if(current)throw new Error('年度移動先に同じ明細IDが存在します。保存を中断しました。');
  }:undefined,checkDirectory);
  // 対象年変更時は移動元を削除履歴へ。原本は回復のため削除しない。
  for(const [other,base] of [...this.shards])if(other!==year&&base.records.some(r=>r.id===record.id)) {
   const changed=copy(base);changed.records=changed.records.filter(r=>r.id!==record.id);changed.deleted.push(record.id);
   try{await this.commit(other,changed,expectedMatch?remote=>{
    checkConflicts?.(remote.records,other);
    const source=remote.records.find(r=>r.id===record.id);
    if(!source||!expectedMatch(source))throw new Error('移動元年度の明細が更新されました。除外を中断しました。');
   }:undefined,checkDirectory);}
   catch(error){
    let status='移動先年度への保存が完了しましたが、移動元年度の除外は完了していない可能性があります。';
    try{
     await this.refresh({forceFresh:true});
     const sourceStillHasRecord=[...this.shards].filter(([y,d])=>y!==year&&d.records.some(r=>r.id===record.id)).map(([y])=>y);
     status=sourceStillHasRecord.length
      ? `移動先の${year}年度には保存済みですが、移動元の${sourceStillHasRecord.join('、')}年度に明細が残っています。`
      : '移動先年度への保存は完了しました。移動元の除外処理結果を再検証しました。';
    }catch{ /* Keep a cautious partial-success message if revalidation also fails. */ }
    throw new PayrollPartialSuccessError('year-move',`明細ID ${record.id} の年度移動が一部完了しました。${status} 明細を再読込して整合性を確認してください。原因: ${error instanceof Error?error.message:String(error)}`,{cause:error});
   }
  }
  state.payrollSaved=true;
  progress?.('Finance連携用の収入データを同期しています…');
  try{await this.syncIncomeUnderLock(new Set([incomeYear(record),...(originalPrior?[incomeYear(originalPrior)]:[])]));}
  catch(error){throw new PayrollPartialSuccessError('income-sync',`明細ID ${record.id} の変更は保存済みですが、Finance連携用収入ファイルの同期に失敗しました。設定画面で連携データを再生成してください。原因: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
  progress?.('クラウド保存と検証が完了しました');
  },state);
 }
 async remove(id:number,expectedMatch?:(current:CloudRecord)=>boolean,checkConflicts?:(records:readonly CloudRecord[],year:string)=>void):Promise<void> {
  const state:PayrollWriteState={attempted:false,uncertain:false,completed:false,lock:'none'};
  return this.graph.withWriteLock(async()=>{
  await this.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
  const prior=this.records().find(r=>r.id===id);
  if(expectedMatch&&(!prior||!expectedMatch(prior)))throw new Error('削除対象が変更されました。再確認してください。');
  const years=[...this.shards].filter(([,d])=>d.records.some(r=>r.id===id)).map(([year])=>year);
  for(const year of years){const d=copy(this.shards.get(year)!);d.records=d.records.filter(r=>r.id!==id);if(!d.deleted.includes(id))d.deleted.push(id);await this.commit(year,d,expectedMatch?remote=>{checkConflicts?.(remote.records,year);const current=remote.records.find(r=>r.id===id);if(!current||!expectedMatch(current))throw new Error('削除対象が変更されました。再確認してください。');}:undefined);}
  state.payrollSaved=true;
  if(prior){
   try{await this.syncIncomeUnderLock(new Set([incomeYear(prior)]));}
   catch(error){throw new PayrollPartialSuccessError('income-sync',`明細ID ${id} は削除済みですが、Finance連携用収入ファイルの更新に失敗しました。設定画面の「連携データを再生成」で再同期してください。原因: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
  }
  // PDF原本は事故時の復元と監査のためOneDriveに保持。
  },state);
 }
 /** Capture the actual original identities before the approved metadata removal. */
 async captureDeletionOriginals(records:readonly CloudRecord[]):Promise<Map<string,DetachedOriginal>> {
  // Capture the exact encrypted original before deleting any metadata. Never
  // auto-trash unrelated orphans (including interrupted uploads).
  const originals=new Map<string,DetachedOriginal>();
  for(const item of records){
   const {data,file}=await this.readVerifiedOriginal(item);
   if(!file.id||!file.etag||!file.size||!(await data.slice(0,1024).text()).includes('%PDF-'))
    throw new Error('削除対象のPDF原本を確認できません。明細は削除していません。');
   const ref=`${item.originalMonth}/${item.originalId.toLowerCase()}`;
   const identity={id:file.id,month:item.originalMonth,uuid:item.originalId,etag:file.etag,size:file.size};
   const prior=originals.get(ref);
   if(prior&&!same(prior,identity))throw new Error('PDF原本が検証中に変更されました。');
   originals.set(ref,identity);
  }
  return originals;
 }
 /** Assign only previously unassigned statements. No PDF upload, deletion, or other field edits. */
 async assignEmployerBatch(expected:readonly CloudRecord[],ids:readonly number[],employerId:string,directorySignature:string,authorized:()=>boolean):Promise<CloudRecord[]> {
  const state:PayrollWriteState={attempted:false,uncertain:false,completed:false,lock:'none'};
  return this.graph.withWriteLock(async()=>{
  const options={forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true} as const;
  const selected=new Set(ids);
  if(!ids.length||selected.size!==ids.length||ids.some(id=>!idOkay(id)))throw new Error('勤務先設定の対象が不正です。');
  const snapshot=(rows:readonly CloudRecord[])=>canonicalJson([...rows].sort((a,b)=>a.id-b.id));
  let baseline=expected.map(copy);
  const checkIndex=(index:Index)=>{
   if(!authorized()||employerDirectorySignature(index.employers??[])!==directorySignature)throw new Error('勤務先一覧または認証状態が変更されました。再確認してください。');
  };
  const checkSnapshot=(live:readonly CloudRecord[],directory:readonly EmployerEntry[])=>{
   if(!authorized()||employerDirectorySignature(directory)!==directorySignature)throw new Error('勤務先一覧または認証状態が変更されました。再確認してください。');
   if(snapshot(live)!==snapshot(baseline)||[...this.shards.values()].reduce((n,d)=>n+d.records.length,0)!==live.length)
    throw new Error('明細が変更されたか年度移動が未完了です。再確認してください。');
  };
  const checkState=async()=>{
   let directory:EmployerEntry[]=[];
   const live=await this.refresh({...options,onEmployerDirectory:value=>{directory=value;}});
   checkSnapshot(live,directory);
   return {live,directory};
  };
  // Orphan discovery is read-only. Validate the approved baseline once after it,
  // immediately before the annual mutations.
  if((await this.inspectOrphanYears()).length)throw new Error('未登録の年度データがあります。設定で復旧してから再検査してください。');
  // Derived income is updated after the authoritative statements.
  const {directory}=await checkState();
  const entry=directory.find(e=>e.id===employerId);
  if(!entry||employerDirectorySignature(directory)!==directorySignature||!authorized())throw new Error('勤務先一覧が変更されました。');
  const targets=baseline.filter(r=>selected.has(r.id));
  if(targets.length!==ids.length||targets.some(r=>r.employerId!==undefined||r.form.job!==entry.role||!Number.isSafeInteger((r.revision??0)+1)))
   throw new Error('勤務先未設定で勤務区分が一致する明細だけを選択してください。');
  const changed=targets.map(r=>({...copy(r),employerId,revision:(r.revision??0)+1}));
  const final=baseline.map(r=>changed.find(x=>x.id===r.id)??r);
  for(const item of changed)if(final.some(r=>r.id!==item.id&&payrollPeriodsConflict(r,item)))throw new Error('同じ期間の明細が重複するか勤務先を確定できません。対象を確認してください。');
  const years=new Set(changed.map(shardYear)),paymentYears=new Set(changed.map(incomeYear));
  let attempted=false;
  try{
   for(const year of years){
    const doc=copy(this.shards.get(year)!);
    const before=canonicalJson(doc);
    const next=changed.filter(r=>shardYear(r)===year);
    doc.records=doc.records.map(r=>next.find(x=>x.id===r.id)??r);
    validateDoc(doc);
    attempted=true;
    await this.commit(year,doc,remote=>{if(!authorized()||canonicalJson(remote)!==before)throw new Error('年度書き込み直前に明細が変更されました。');},checkIndex);
    this.graph.markUploadCheckpoint();
    baseline=baseline.map(r=>next.find(x=>x.id===r.id)??r);
    await checkState();
   }
   state.payrollSaved=true;
   await this.syncIncomeUnderLock(paymentYears,()=>checkSnapshot(this.records(),validateEmployerDirectory(this.index.employers??[])));
   return (await checkState()).live;
  }catch(error){
   if(!attempted)throw error;
   if(state.payrollSaved)throw new PayrollPartialSuccessError('income-sync','選択した明細の勤務先は保存済みです。Finance連携を確認できませんでした。必要に応じて連携データを再生成してください。',{cause:error});
   throw new PayrollPartialSuccessError('employer-assignment','勤務先設定は一部確定した可能性があります。最新明細を読み直し、未設定の明細だけを選択してください。',{cause:error});
  }
  },state);
 }
 /** Confirmed personal deletion batch. Preserve verified originals after income sync.
  * Each annual write is ETag-protected; separate years are not an atomic transaction. */
 async removeBatch(targets:readonly {id:number;matches:(current:CloudRecord)=>boolean}[]):Promise<void> {
  const state:PayrollWriteState={attempted:false,uncertain:false,completed:false,lock:'none'};
  return this.graph.withWriteLock(async()=>{
  if(!targets.length||targets.some(t=>!idOkay(t.id))||new Set(targets.map(t=>t.id)).size!==targets.length)
   throw new Error('削除対象が不正です。');
  const options={forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true} as const;
  await this.refresh(options);
  const grouped=new Map<string,CloudRecord[]>(),paymentYears=new Set<string>();
  for(const target of targets){
   const located=[...this.shards].flatMap(([year,doc])=>doc.records.filter(r=>r.id===target.id).map(record=>({year,record})));
   if(located.length!==1||!target.matches(located[0].record)||shardYear(located[0].record)!==located[0].year)
    throw new Error('削除対象が変更・削除されたか、年度移動が未完了です。最新データを確認してください。');
   const {year,record}=located[0],list=grouped.get(year)??[];
   list.push(copy(record));grouped.set(year,list);paymentYears.add(incomeYear(record));
  }
  await this.captureDeletionOriginals([...grouped.values()].flat());
  const ids=new Set(targets.map(t=>t.id));
  const completedYears=new Set<string>();
  try{
   for(const [year,items] of grouped){
    await this.refresh(options);
    // Check every remaining target, including cross-year moves, before another write.
    for(const [pendingYear,expected] of grouped){
     if(!completedYears.has(pendingYear)){
      for(const item of expected){
       const live=[...this.shards].flatMap(([y,doc])=>doc.records.filter(r=>r.id===item.id).map(record=>({y,record})));
       if(live.length!==1||live[0].y!==pendingYear||canonicalJson(live[0].record)!==canonicalJson(item))
        throw new Error('削除対象が変更されました。最新データを確認してください。');
      }
     }
    }
    const doc=copy(this.shards.get(year)!);
    const removing=new Set(items.map(item=>item.id));
    doc.records=doc.records.filter(item=>!removing.has(item.id));
    for(const id of removing)if(!doc.deleted.includes(id))doc.deleted.push(id);
    await this.commit(year,doc,remote=>{
     for(const item of items){
      const live=remote.records.find(r=>r.id===item.id);
      if(!live||canonicalJson(live)!==canonicalJson(item))throw new Error('削除直前に明細が変更されました。');
     }
    });
    completedYears.add(year);
   }
   await this.refresh(options);
   if([...this.shards.values()].some(doc=>doc.records.some(r=>ids.has(r.id))))throw new Error('削除後に対象明細が残っています。');
  }catch(error){
   throw new Error('明細削除の結果を確定できません。年度ごとに一部確定した可能性があります。最新データを確認し、設定からFinance連携を再生成してください。',{cause:error});
  }
  state.payrollSaved=true;
  try{await this.syncIncomeUnderLock(paymentYears,()=>{
   if([...this.shards.values()].some(doc=>doc.records.some(r=>ids.has(r.id))))throw new Error('収入連携中に削除対象の明細が再登録されました。最新データを確認してください。');
  });}
  catch(error){throw new PayrollPartialSuccessError('income-sync','対象明細の削除は確認済みですが、Finance連携の更新が完了していません。',{cause:error});}
  // Preserve encrypted originals. Explicit Settings cleanup is a separate,
  // freshly verified operation with its own remote write lock.
  },state);
 }
 /** Read-only Finance consistency check for payment years, including the live
  * index registration. Do not regenerate income or overwrite any cloud file. */
 async inspectIncomeConsistency(years:ReadonlySet<string>):Promise<string[]> {
  const {index,file:indexFile}=await this.readIndex();
  const records=this.records();
  const unsynced:string[]=[],observed=new Map<string,{id:string;etag:string}|null>();
  const path=this.pathFor(index,'income');
  for(const year of [...years].sort()){
   if(!/^(19|20|21)\d{2}$/.test(year))throw new Error('収入連携の支給年が不正です。');
   const current:IncomeDocument={format:'payroll-income-v1',year,records:records.filter(r=>incomeYear(r)===year).map(toPublicIncomeRecord).sort((a,b)=>a.id-b.id)};
   const file=await this.graph.read(path,`${year}.enc`,MAX_YEAR);
   observed.set(year,file?{id:file.id,etag:file.etag}:null);
   const registered=index.incomeYears.includes(year);
   if(!file){if(registered||current.records.length)unsynced.push(year);continue;}
   const env=parseEnvelope(file.text,'income');
   if(env.salt!==this.salt)throw new Error('収入連携ファイルの暗号鍵が異なります。');
   const saved=await decryptJson<IncomeDocument>('income',file.text,this.unlocked());
   if(!registered||canonicalJson(saved)!==canonicalJson(current))unsynced.push(year);
  }
  for(const [year,prior] of observed){
   const actual=await this.graph.metadata(path,`${year}.enc`);
   if(Boolean(prior)!==Boolean(actual)||(prior&&actual&&(prior.id!==actual.id||prior.etag!==actual.etag)))
    throw new Error('Finance連携データが照合中に変更されました。再確認してください。');
  }
  if((await this.readIndex()).file.etag!==indexFile.etag)throw new Error('収入連携の索引が照合中に変更されました。');
  return unsynced;
 }
 /** One verified source snapshot per batch boundary, with independent
  * conditional writes/readbacks. A source race retries the whole projection,
  * not the authoritative payroll writes. No change to the Finance format. */
 async syncIncome(changedYears?:ReadonlySet<string>,state?:PayrollWriteState):Promise<void> {
  return this.graph.withWriteLock(()=>this.syncIncomeUnderLock(changedYears),state,Boolean(state));
 }
 private async syncIncomeUnderLock(changedYears?:ReadonlySet<string>,checkSource?:()=>void):Promise<void> {
  const perf=beginPerfOperation('finance-income-sync');
  let success=false;
  const requested=changedYears?new Set(changedYears):undefined;
  const options={forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true} as const;
  const yearsForSource=()=>[...(requested??new Set([...this.index.incomeYears,...this.records().map(incomeYear)]))].sort();
  const documents=(years:readonly string[]):IncomeDocument[]=>{
   const records=this.records();
   return years.map(year=>({format:'payroll-income-v1',year,records:records.filter(r=>incomeYear(r)===year).map(toPublicIncomeRecord).sort((a,b)=>a.id-b.id)}));
  };
  try {
   for(let attempt=0;attempt<8;attempt++){
    await perf.measure('source-refresh',()=>this.refresh(options));
    checkSource?.();
    const years=yearsForSource();
    if(years.some(year=>!/^(19|20|21)\d{2}$/.test(year)))throw new Error('収入連携の支給年が不正です。');
    if(!years.length){success=true;return;}
    const expected=documents(years),path=this.storagePath('income');
    const plans:Array<{current:IncomeDocument;file:Pick<RemoteFile,'id'|'etag'>|null;equal:boolean}>=[];
    for(const current of expected){
     const file=await perf.measure('income-read',()=>this.graph.read(path,`${current.year}.enc`,MAX_YEAR));
     let equal=false;
     if(file){
      const env=parseEnvelope(file.text,'income');if(env.salt!==this.salt)throw new Error('収入連携ファイルの暗号鍵が異なります。');
      equal=same(await decryptJson<IncomeDocument>('income',file.text,this.unlocked()),current);
     }
     plans.push({current,file:file?{id:file.id,etag:file.etag}:null,equal});
    }
    // Recheck all source years once before the first write, including new
    // payment years discovered during a full rebuild.
    await perf.measure('income-prewrite-refresh',()=>this.refresh(options));
    checkSource?.();
    if(!same(yearsForSource(),years)||!same(documents(years),expected))continue;
    const verified=new Map<string,Pick<RemoteFile,'id'|'etag'|'size'>>();
    let collision=false;
    for(const {current,file,equal} of plans){
     const name=`${current.year}.enc`;
     if(!equal){
      try{await perf.measure('income-write',async()=>this.graph.write(path,name,await encryptJson('income',current,this.unlocked(),this.salt),file,MAX_YEAR));}
      catch(error){if(isCollision(error)){collision=true;break;}throw error;}
     }
     const live=await perf.measure('income-verify',()=>this.graph.read(path,name,MAX_YEAR));
     if(!live)throw new Error(`${current.year}年の収入ファイルを確認できません。`);
     if(!same(await decryptJson<IncomeDocument>('income',live.text,this.unlocked()),current)){collision=true;break;}
     verified.set(name,{id:live.id,etag:live.etag,size:live.size});
    }
    if(collision)continue;
    // Register once, then revalidate the authoritative source. This also
    // catches a source change during the index write itself.
    await perf.measure('income-register',()=>this.registerYears(years,'incomeYears'));
    await perf.measure('income-postwrite-refresh',()=>this.refresh(options));
    checkSource?.();
    if(!years.every(year=>this.index.incomeYears.includes(year))||!same(yearsForSource(),years)||!same(documents(years),expected))continue;
    // Earlier income files can change while later ones are written. Verify
    // their identities at the shared final boundary, without decrypting again.
    // Bulk mutations previously performed a separate full income audit here.
    // Reuse the authenticated readbacks, checking their live identities and
    // the index around that sweep (also for a single payment year).
    const finalIndex=checkSource?await this.readIndex():undefined;
    if(finalIndex&&!same(finalIndex.index,this.index))continue;
    if(years.length>1||checkSource){
     for(const [name,prior] of verified){
      const live=typeof this.graph.metadata==='function'?await this.graph.metadata(path,name):await this.graph.read(path,name,MAX_YEAR);
      if(!live||live.id!==prior.id||live.etag!==prior.etag||live.size!==prior.size){collision=true;break;}
     }
     if(collision)continue;
    }
    if(finalIndex&&(await this.readIndex()).file.etag!==finalIndex.file.etag)continue;
    checkSource?.();
    success=true;return;
   }
   throw new Error('収入同期中に明細または連携データが更新され続けたため、中断しました。後で「連携データを再生成」を実行してください。');
  } finally{perf.finish(success);}
 }

}
