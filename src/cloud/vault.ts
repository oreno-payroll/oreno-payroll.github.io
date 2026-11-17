import {createSalt,deriveKey,encryptBytes,decryptBytes,encryptJson,decryptJson,envelopeSalt,parseEnvelope} from './crypto';
import {PayrollGraph,isCollision,type RemoteFile,type CloudFolderItem} from './graph';
import type {SavedPayrollRecord,SavedPayrollSummary} from '../storage/payrollStore';
import {fiscalYearOfTargetMonth} from '../forecast/payrollCalendar';
import {payrollPeriodKey} from '../storage/payrollValidation';
import {rememberNavigationSnapshot,restoredNavigationSnapshot,clearNavigationSnapshot} from './snapshot';
import {toPublicIncomeRecord,type PublicIncomeRecord} from './income';

export interface CloudRecord extends SavedPayrollSummary {
  originalId: string;
  originalMonth: string;
}
export interface AnnualDocument { format:'payroll-annual-v1'; records:CloudRecord[]; deleted:number[] }
interface Index {format:'payroll-index-v1'; years:string[]; incomeYears:string[]; generation?:string; rotation?:{id:string;startedAt:number}}
type IncomeRecord = PublicIncomeRecord;
interface IncomeDocument {format:'payroll-income-v1';year:string;records:IncomeRecord[]}
const emptyDoc=():AnnualDocument=>({format:'payroll-annual-v1',records:[],deleted:[]});
const emptyIndex=():Index=>({format:'payroll-index-v1',years:[],incomeYears:[]});
const copy=<T>(v:T):T=>structuredClone(v);
const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
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
function validateDoc(value:AnnualDocument):AnnualDocument {
 if(!value||value.format!=='payroll-annual-v1'||!Array.isArray(value.records)||!Array.isArray(value.deleted)||value.records.length>10000||value.deleted.length>20000)throw new Error('年別明細の形式が不正です。');
 const ids=new Set<number>();
 for(const rec of value.records) {
  if(!rec||!idOkay(rec.id)||ids.has(rec.id)||!rec.form||typeof rec.form!=='object'||typeof rec.originalId!=='string'||!/^[\da-f-]{36}$/i.test(rec.originalId)||!/^\d{4}-\d{2}$/.test(rec.originalMonth)||!Number.isSafeInteger(rec.pdfSize)||rec.pdfSize<1||typeof rec.fileName!=='string')throw new Error('年別明細のレコードが不正です。');
  ids.add(rec.id);
 }
 for(const id of value.deleted)if(!idOkay(id))throw new Error('削除履歴が不正です。');
 return value;
}
function validateIndex(value:Index):Index {
 if(!value||value.format!=='payroll-index-v1'||!Array.isArray(value.years)||!Array.isArray(value.incomeYears)||value.years.length>300||value.incomeYears.length>300||![...value.years,...value.incomeYears].every(v=>typeof v==='string'&&/^(19|20|21)\d{2}$/.test(v)))throw new Error('Payroll索引の形式が不正です。');
 if(value.generation!==undefined&&!/^[0-9a-f-]{36}$/i.test(value.generation))throw new Error('保存世代が不正です。');
 if(value.rotation!==undefined&&(!/^[0-9a-f-]{36}$/i.test(value.rotation?.id??'')||!Number.isFinite(value.rotation?.startedAt)))throw new Error('保管庫の変更処理情報が不正です。');
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

export class PayrollVault {
 private key:CryptoKey|null=null;
 private salt='';
 private index=emptyIndex();
 private shards=new Map<string,AnnualDocument>();
 private pdfDrafts=new WeakMap<Blob,{id:string;month:string;encrypted:string}>();
 // The verified index from unlock is fresh enough for one immediate dashboard load.
 // Mutations and later refreshes always revalidate the remote index.
 private firstDashboardIndexUntil=0;
 private rotationId:string|null=null;
 private snapshotScope='';
 private reusedSnapshot=false;
 private snapshotDeadline=0;
 navigationDeadline():number{return this.snapshotDeadline;}
 setNavigationScope(scope:string):void {this.snapshotScope=scope;}
 isShowingSnapshot():boolean{return this.reusedSnapshot;}
 /** Display-only cache; rejected if the index, year list or record schema differs. */
 async resumeFromSnapshot(key:CryptoKey,salt:string):Promise<boolean> {
  if(!this.snapshotScope)return false;
  const cached=await restoredNavigationSnapshot(this.snapshotScope,salt,key);
  if(!cached?.data||typeof cached.data!=='object')return false;
  try {
   const value=cached.data as {index:Index;years:Array<[string,AnnualDocument]>};
   const index=validateIndex(value.index);
   if(index.rotation||!Array.isArray(value.years)||value.years.length!==index.years.length)return false;
   const docs=new Map<string,AnnualDocument>();
   for(const row of value.years){
    if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||docs.has(row[0])||!index.years.includes(row[0]))return false;
    docs.set(row[0],validateDoc(row[1]));
   }
   if(docs.size!==index.years.length)return false;
   this.key=key;this.salt=salt;this.index=index;this.shards=docs;
   this.reusedSnapshot=true;this.snapshotDeadline=cached.expires;this.firstDashboardIndexUntil=0;
   return true;
  }catch{clearNavigationSnapshot();return false;}
 }

 private storagePath(segment:string,...rest:string[]):string[]{return this.pathFor(this.index,segment,...rest);}
 private pathFor(index:Index,segment:string,...rest:string[]):string[]{return index.generation?['payroll','versions',index.generation,segment,...rest]:['payroll',segment,...rest];}
 private ensureRotationAllowed(index:Index):void{if(index.rotation?.id && index.rotation.id!==this.rotationId)throw new InterruptedRotationError();}
 constructor(readonly graph:PayrollGraph){}
 isUnlocked():boolean{return this.key!==null;}
 lock():void{this.key=null;this.salt='';this.index=emptyIndex();this.shards.clear();this.firstDashboardIndexUntil=0;this.rotationId=null;this.reusedSnapshot=false;this.snapshotDeadline=0;clearNavigationSnapshot();}
 private unlocked():CryptoKey{if(!this.key)throw new Error('OneDriveの給与保管庫を解除してください。');return this.key;}
 async unlock(passphrase:string, createIfMissing=false, onVerifiedMaterial?: (raw:Uint8Array,salt:string)=>void):Promise<boolean> {
  let transient:Uint8Array|null=null;
  const derive=async (salt:string):Promise<CryptoKey> => deriveKey(passphrase,salt,onVerifiedMaterial ? bytes=>{transient=new Uint8Array(bytes);} : undefined);
  const accept=(salt:string):void=>{
   const raw=transient;transient=null;
   if(!raw)return;
   try {onVerifiedMaterial?.(raw,salt);} finally {raw.fill(0);}
  };
  try {
  let file:RemoteFile|null;
  try {file=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);}
  catch(error){throw new Error('暗号索引 index.enc の初回取得に失敗しました（Graph API/配信応答）。OneDriveは変更していません。',{cause:error});}
  if (!file) {
   if(!createIfMissing)return false;
   const salt=createSalt(),key=await derive(salt);
   try{await this.graph.write(['payroll'],'index.enc',await encryptJson('index',emptyIndex(),key,salt),null,MAX_INDEX);}
   catch(e){if(!isCollision(e))throw e;throw new Error('別の端末で保管庫が作成されました。読み直してください。');}
   const verify=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);
   if(!verify)throw new Error('暗号化索引を読み戻せません。');
   const decoded=validateIndex(await decryptJson<Index>('index',verify.text,key));
   this.key=key;this.salt=salt;this.index=decoded;this.firstDashboardIndexUntil=Date.now()+15_000;accept(salt);return true;
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
  this.key=key;this.salt=salt;this.index=index;this.firstDashboardIndexUntil=Date.now()+15_000;accept(salt);
  // 起動時は索引の検証だけにする。全年度の取得と収入ファイル再保存は画面表示/更新時のみ。
  return true;
  } finally {(transient as Uint8Array|null)?.fill(0);}
 }
 /** ページ移動後、SharedWorkerのメモリにある非抽出CryptoKeyで再開する。
  * 認証済みOneDriveの現在の索引を必ず復号して、アカウント/鍵の取り違えを拒否する。 */
 async unlockWithKey(key:CryptoKey,salt:string):Promise<void> {
  let file:RemoteFile|null;
  try {file=await this.graph.read(['payroll'],'index.enc',MAX_INDEX);}
  catch(error){throw new Error('暗号索引 index.enc の取得に失敗しました（Graph API/配信応答）。OneDriveは変更していません。',{cause:error});}
  if(!file||envelopeSalt(file.text)!==salt)throw new Error('クラウド索引の暗号鍵が以前と一致しません。');
  const index=validateIndex(await decryptJson<Index>('index',file.text,key));
  this.ensureRotationAllowed(index);
  this.key=key;this.salt=salt;this.index=index;this.firstDashboardIndexUntil=Date.now()+15_000;
 }
 /** パスフレーズの代わりに安全なメモリ連携へ渡す。鍵はextractable:false。 */
 sessionKey():{key:CryptoKey;salt:string} {
  return {key:this.unlocked(),salt:this.salt};
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
 private async registerYear(year:string,type:'years'|'incomeYears'):Promise<void> {
  for(let retry=0;retry<5;retry++){
   const {index,file}=await this.readIndex();
   if(index[type].includes(year)){this.index=index;return;}
   const changed={...index,[type]:[...index[type],year].sort()};
   try{await this.graph.write(['payroll'],'index.enc',await encryptJson('index',changed,this.unlocked(),this.salt),file,MAX_INDEX);this.index=changed;return;}
   catch(e){if(isCollision(e))continue;throw e;}
  }
  throw new Error('OneDrive索引の同時変更が続いています。再試行してください。');
 }
 private async readYear(year:string,sourceIndex:Index=this.index):Promise<{doc:AnnualDocument;file:RemoteFile|null}> {
  const storage=sourceIndex.generation?'変更後の保存世代':'従来の保存領域';
  let file:RemoteFile|null;
  try {file=await this.graph.read(this.pathFor(sourceIndex,'statements'),`${year}.enc`,MAX_YEAR);}
  catch(error) {
    throw new Error(`${year}年度の明細取得に失敗しました（${storage}、Graph API/配信応答）。OneDriveのデータは変更していません。`,{cause:error});
  }
  if(!file)return {doc:emptyDoc(),file:null};
  try {
    const env=parseEnvelope(file.text,'year');
    if(env.salt!==this.salt)throw new Error('暗号ファイルの鍵情報が索引と一致しません。');
    const doc=validateDoc(await decryptJson<AnnualDocument>('year',file.text,this.unlocked()));
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
  priorityYears?:readonly string[];
  onProgress?:(loaded:number,total:number,year:string)=>void;
 }):Promise<CloudRecord[]> {
  if(options?.dashboardStartup && !options.forceFresh && this.reusedSnapshot){return this.records();}
  this.reusedSnapshot=false;
  const useVerifiedIndex=options?.dashboardStartup===true && Date.now()<this.firstDashboardIndexUntil;
  this.firstDashboardIndexUntil=0;
  const index=useVerifiedIndex?copy(this.index):(await this.readIndex()).index;
  const priorities=new Map((options?.priorityYears??[]).map((year,i)=>[year,i]));
  const years=[...index.years].sort((a,b)=>{
   const ap=priorities.get(a),bp=priorities.get(b);
   if(ap!==undefined||bp!==undefined)return (ap??Infinity)-(bp??Infinity);
   return Number(b)-Number(a);
  });
  const docs=new Map<string,AnnualDocument>();
  let next=0,loaded=0,failed=false;
  const worker=async():Promise<void>=>{
   for(;;){
    const at=next++;
    if(at>=years.length)return;
    const year=years[at];
    const {doc,file}=await this.readYear(year,index);
    if(!file)throw new Error(`${year}年の明細ファイルがありません。`);
    docs.set(year,doc);
    loaded++;
    if(!failed)options?.onProgress?.(loaded,years.length,year);
   }
  };
  try {
   await Promise.all(Array.from({length:Math.min(4,years.length)},()=>worker()));
  } catch(error){failed=true;throw error;}
  // Atomic handover: a failed load cannot replace the last complete in-memory snapshot.
  this.index=index;this.shards=docs;
  this.snapshotDeadline=Date.now()+120_000;
  if(this.snapshotScope&&!index.rotation)await rememberNavigationSnapshot(this.snapshotScope,this.salt,this.unlocked(),{index,years:[...docs]});
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
 private async commit(year:string,changed:AnnualDocument,checkRemote?:(remote:AnnualDocument)=>void):Promise<void> {
  const base=copy(this.shards.get(year)??emptyDoc());
  for(let retry=0;retry<5;retry++) {
   await this.readIndex(); // 最終更新前に保管庫の変更ロックと保存世代を確認。
   const {doc:remote,file}=await this.readYear(year);
   checkRemote?.(remote);
   const merged=mergeAnnual(base,changed,remote);
   try {
    await this.graph.write(this.storagePath('statements'),`${year}.enc`,await encryptJson('year',merged,this.unlocked(),this.salt),file,MAX_YEAR);
    const verify=await this.readYear(year);
    if(!verify.file)throw new Error('保存後に年別明細が見つかりません。');
    for(const rec of changed.records)if(!verify.doc.records.some(r=>r.id===rec.id))throw new Error('年別明細の保存結果が一致しません。');
    this.shards.set(year,verify.doc);
    await this.registerYear(year,'years');return;
   }catch(e){if(isCollision(e))continue;throw e;}
  }
  throw new Error(`${year}年の同時更新が続いています。再試行してください。`);
 }
 private async storeOriginal(record:SavedPayrollRecord,uuid:string,month:string,progress?:(stage:string)=>void):Promise<void> {
  const key=this.unlocked();
  progress?.('原本PDFを暗号化しています…');
  const bytes=new Uint8Array(await record.pdf.arrayBuffer());
  const encrypted=await encryptBytes('original',bytes,key);
  const [year,mm]=month.split('-');
  progress?.('暗号化PDFをOneDriveへ送信しています…');
  try{await this.graph.write(this.storagePath('originals',year,mm),`${uuid}.enc`,encrypted,null,MAX_ORIGINAL,(sent,total)=>{
   if(sent>0)progress?.(`暗号化PDFの送信 ${Math.round(sent/total*100)}%`);
  });}
  catch(e){
   if(!isCollision(e))throw e;
   const existing=await this.graph.read(this.storagePath('originals',year,mm),`${uuid}.enc`,MAX_ORIGINAL);
   if(!existing)throw new Error('既存原本を照合できません。');
   const restored=await decryptBytes('original',existing.text,key);
   if(!same([...restored],[...bytes]))throw new Error('同じ原本IDに異なるPDFが保存されています。');
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
  * オリジナルの検証・ETag・3方向マージは既存の個別保存と同じ。
  * 一部失敗時にOneDrive全体の原子性は保証できないので成功扱いにしない。
  */
 async saveBatch(records:SavedPayrollRecord[],progress?:(stage:string)=>void):Promise<void> {
  this.unlocked();
  if(!records.length)return;
  const ids=new Set<number>(),hashes=new Set<string>(),periods=new Set<string>();
  for(const record of records) {
   if(!idOkay(record.id)||ids.has(record.id)||this.records().some(r=>r.id===record.id))
    throw new Error('保存対象の明細IDが重複しています。');
   if(!record.fileHash||!/^[a-f0-9]{64}$/.test(record.fileHash))throw new Error('PDFのSHA-256が必要です。');
   const period=payrollPeriodKey(record.form);
   if(hashes.has(record.fileHash)||periods.has(period))throw new Error('バッチ内に重複する明細があります。');
   ids.add(record.id);hashes.add(record.fileHash);periods.add(period);
   shardYear(record);incomeYear(record);
  }
  const start=performance.now();
  const elapsed=()=>`（経過 ${Math.round((performance.now()-start)/1000)}秒）`;
  const completed:CloudRecord[]=new Array(records.length);
  let next=0,originalsDone=0,firstFailure:unknown=null;
  // 独立したPDFのみ少数並列。失敗したら新規投入を止め、処理中は終わるまで待つ。
  const uploadWorker=async():Promise<void>=>{
   while(firstFailure===null) {
    const i=next++;
    if(i>=records.length)return;
    const record=records[i],originalId=crypto.randomUUID(),month=record.form.targetMonth;
    try {
     progress?.(`原本PDFを保存中 ${i+1}/${records.length}件 ${elapsed()}`);
     await this.storeOriginal(record,originalId,month,stage=>progress?.(`PDF ${i+1}/${records.length}件：${stage} ${elapsed()}`));
     const {pdf,...summary}=record;
     completed[i]={...summary,pdfSize:pdf.size,pdfType:pdf.type,originalId,originalMonth:month};
     originalsDone++;
     progress?.(`原本PDFの保存・照合 ${originalsDone}/${records.length}件完了 ${elapsed()}`);
    }catch(error){if(firstFailure===null)firstFailure=error;}
   }
  };
  await Promise.all(Array.from({length:Math.min(2,records.length)},()=>uploadWorker()));
  if(firstFailure!==null) {
   const msg=firstFailure instanceof Error?firstFailure.message:String(firstFailure);
   throw new Error(`PDF原本 ${originalsDone}/${records.length}件の保存・照合後に失敗しました。解析明細は未確定ですが、暗号化原本が一部OneDriveに残っている可能性があります。原因: ${msg}`,{cause:firstFailure});
  }

  // 原本の全件検証後、最新のクラウド年度データを再取得して重複・容量を確認。
  // 別端末が間に保存した同一給与の存在をここで検出する。
  progress?.(`最新の明細と競合を確認しています ${elapsed()}`);
  let current:CloudRecord[];
  try { current=await this.refresh(); }
  catch(error) {
   const msg=error instanceof Error?error.message:String(error);
   throw new Error(`原本${records.length}件の保存・照合は完了しましたが、年度データの再取得に失敗しました。解析明細は未確定で、暗号化原本だけが残っている可能性があります。原因: ${msg}`,{cause:error});
  }
  const collides=(candidate:CloudRecord,remote:readonly CloudRecord[]):boolean=>remote.some(r=>
   r.id!==candidate.id&&(r.fileHash===candidate.fileHash||payrollPeriodKey(r.form)===payrollPeriodKey(candidate.form)));
  for(const rec of completed)if(current.some(r=>r.id===rec.id)||collides(rec,current))
   throw new Error('別端末で同じ明細またはIDが保存されました。原本は保持し、解析明細の確定を中止しました。');

  const grouped=new Map<string,CloudRecord[]>();
  for(const rec of completed) {
   const year=shardYear(rec);
   const list=grouped.get(year)??[];list.push(rec);grouped.set(year,list);
  }
  let committed=0;
  try {
   for(const [year,items] of grouped) {
    progress?.(`${year}年度の解析データを保存・検証しています（${committed}/${records.length}件確定）${elapsed()}`);
    const doc=copy(this.shards.get(year)??emptyDoc());
    doc.records.push(...items);
    // ETag再試行直前の最新年別ファイルでも、別IDの同じ給与を拒否する。
    await this.commit(year,doc,remote=>{
     for(const rec of items)if(collides(rec,remote.records))
      throw new Error(`${year}年度に別端末が同じ給与を保存しました。重複登録を防ぐため中止しました。`);
    });
    committed+=items.length;
    progress?.(`解析済み明細 ${committed}/${records.length}件を確定 ${elapsed()}`);
   }
   // indexと年別JSONがすべて成功した後で、変更のあった支給年のみ更新。
   const years=new Set(records.map(incomeYear));
   progress?.(`収入データを支給年${years.size}件分同期しています ${elapsed()}`);
   await this.syncIncome(years);
   progress?.(`${records.length}件のOneDrive保存・読み戻し検証がすべて完了しました ${elapsed()}`);
  }catch(error){
   const msg=error instanceof Error?error.message:String(error);
   throw new Error(`原本${records.length}件を保存後、解析明細${committed}/${records.length}件を確定した段階で失敗しました。一部の年度ファイルや収入連携データが更新済みの可能性があります。再読込して保存済み一覧を確認してください。原因: ${msg}`,{cause:error});
  }
 }
 /** 旧暗号ファイルは上書きせず、新世代を全件検証してからルート索引だけを切り替える。
  * OneDriveの世代をまたいだ一括トランザクションは存在しないので、競合を禁止し
  * 切替前のエラーでは旧索引へ戻す。切替後の不明応答は必ず読戻して判定する。 */
 async changePassphrase(currentPassphrase:string,newPassphrase:string,onProgress?:(step:string)=>void):Promise<{key:CryptoKey;salt:string;generation:string}> {
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
   // 復旧用の元索引。旧原本も保持するので、失敗後も旧パスフレーズで復旧可能。
   await this.graph.write(['payroll','versions',gen,'recovery'],'previous-index.enc',root.text,null,MAX_INDEX);
   const sources:Array<{path:string[];name:string;etag:string;size?:number}>=[];
   const seenOriginals=new Set<string>();
   let total=originalIndex.years.length+originalIndex.incomeYears.length;
   // 元の年度・給与情報を、ロックした状態でスナップショットとして取得。
   const annual:Array<{year:string;doc:AnnualDocument}>=[];
   for(const year of originalIndex.years) {
    const path=this.pathFor(originalIndex,'statements');
    const old=await this.graph.read(path,`${year}.enc`,MAX_YEAR);
    if(!old)throw new Error(`${year}年度の元データが見つかりません。`);
    const doc=validateDoc(await decryptJson<AnnualDocument>('year',old.text,oldKey));
    annual.push({year,doc});sources.push({path,name:`${year}.enc`,etag:old.etag,size:old.size});
    for(const rec of doc.records)seenOriginals.add(`${rec.originalMonth}/${rec.originalId}`);
   }
   total+=seenOriginals.size;
   const income:Array<{year:string;clear:Uint8Array}>=[];
   for(const year of originalIndex.incomeYears) {
    const path=this.pathFor(originalIndex,'income');
    const old=await this.graph.read(path,`${year}.enc`,MAX_YEAR);
    if(!old)throw new Error(`${year}年の収入連携データが見つかりません。`);
    income.push({year,clear:await decryptBytes('income',old.text,oldKey)});
    sources.push({path,name:`${year}.enc`,etag:old.etag,size:old.size});
   }
   let done=0;
   const staged=async(kind:'year'|'income'|'original',path:string[],name:string,clear:Uint8Array,limit:number):Promise<void>=>{
    const text=await encryptBytes(kind,clear,newKey,kind==='original'?undefined:newSalt);
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
   const originals=[...seenOriginals];
   for(const filename of originals){
    const [month,uuid]=filename.split('/'),[yyyy,mm]=month.split('-');
    if(!/^[0-9a-f-]{36}$/i.test(uuid)||!/^\d{4}$/.test(yyyy)||!/^\d{2}$/.test(mm))throw new Error('PDF原本の識別子が不正です。');
    const path=this.pathFor(originalIndex,'originals',yyyy,mm),name=`${uuid}.enc`;
    const old=await this.graph.read(path,name,MAX_ORIGINAL);
    if(!old)throw new Error('元のPDF原本が見つかりません。');
    const clear=await decryptBytes('original',old.text,oldKey);
    const metadata=annual.flatMap(a=>a.doc.records).find(rec=>rec.originalId===uuid&&rec.originalMonth===month);
    if(!metadata||clear.length!==metadata.pdfSize)throw new Error('PDFのサイズが明細データと一致しません。');
    if(metadata.fileHash && /^[a-f0-9]{64}$/.test(metadata.fileHash)) {
     const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(clear));
     const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
     if(hash!==metadata.fileHash)throw new Error('PDF原本のハッシュが一致しません。');
    }
    sources.push({path,name,etag:old.etag,size:old.size});
    await staged('original',['payroll','versions',gen,'originals',yyyy,mm],name,clear,MAX_ORIGINAL);
   }
   onProgress?.('他端末からの同時更新を確認しています…');
   for(const src of sources){
    const now=await this.graph.metadata(src.path,src.name);
    if(!now||now.etag!==src.etag||now.size!==src.size)throw new Error('変更中に別端末の給与データが更新されました。旧データを維持して中止します。');
   }
   const nextIndex:Index={format:'payroll-index-v1',years:[...originalIndex.years],incomeYears:[...originalIndex.incomeYears],generation:gen};
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
 }
 /** 旧鍵による未完了の変更ロックを明示的に取り消す。10分以上経過後のみ許可する。 */
 async recoverInterruptedChange(passphrase:string):Promise<boolean> {
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
 }
 /** 旧暗号ファイルの整理候補。現行索引・保存世代を対象から除外する。 */
 async inspectOldEncryptedData():Promise<{generation:string;indexEtag:string;targets:Array<{parent:string[];item:CloudFolderItem}>;files:number;bytes:number}> {
  this.unlocked();
  const {index,file}=await this.readIndex();
  if(index.rotation)throw new Error('パスフレーズ変更中は整理できません。');
  if(!index.generation)throw new Error('保存世代の変更履歴がありません。旧暗号領域の削除は不要です。');
  const gen=index.generation;
  const targets:Array<{parent:string[];item:CloudFolderItem}>=[];
  const old=(await this.graph.listFolder(['payroll']))??[];
  // Finance v1.1.1 が固定パス payroll/income/YYYY.enc を参照する可能性があるため、旧incomeは自動削除しない。
  for(const name of ['statements','originals']) {
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
  const scan=async(parts:string[],context:'root'|'generation'|'statements'|'income'|'originals'|'year'|'month'|'recovery',depth:number):Promise<void>=>{
   if(depth>6)throw new Error('旧暗号データの階層が想定より深いです。');
   const children=await this.graph.listFolder(parts);
   if(!children)throw new Error('整理対象が読み取れません。');
   for(const item of children){
    const n=item.name;
    const next=(kind:typeof context)=>scan([...parts,n],kind,depth+1);
    if(item.folder){
     if(context==='root'||context==='generation'){
      if(n==='statements'||n==='income'||n==='originals'||n==='recovery')await next(n);
      else throw new Error('旧暗号領域に未知のフォルダーがあります。削除しません。');
     }else if(context==='originals'&&/^(19|20|21)\d{2}$/.test(n))await next('year');
     else if(context==='year'&&/^(0[1-9]|1[0-2])$/.test(n))await next('month');
     else throw new Error('旧暗号領域のフォルダー構造が想定外です。');
    } else {
     const okay=(context==='statements'||context==='income')?/^(19|20|21)\d{2}\.enc$/.test(n):
       context==='month'?/^[0-9a-f-]{36}\.enc$/i.test(n):
       context==='recovery'?n==='previous-index.enc':false;
     if(!okay)throw new Error('旧暗号領域に想定外のファイルがあります。削除しません。');
     files++;bytes+=item.size;
     if(files>5000)throw new Error('整理対象のファイルが多すぎます。');
    }
   }
  };
  for(const target of targets){
   const context=target.item.name==='recovery'?'recovery':target.item.name==='originals'?'originals':
     target.item.name==='statements'?'statements':target.item.name==='income'?'income':'generation';
   await scan([...target.parent,target.item.name],context,0);
  }
  return {generation:gen,indexEtag:file.etag,targets,files,bytes};
 }
 /** 現行世代の明細・原本・収入をすべて検証してから、旧世代のみごみ箱へ送る。 */
 async cleanupOldEncryptedData(expected:{generation:string;indexEtag:string;targets:Array<{parent:string[];item:CloudFolderItem}>},progress?:(message:string)=>void):Promise<number>{
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
   await this.graph.trashFolder(target.parent,target.item);
   done++;progress?.(`旧暗号フォルダーをOneDriveのごみ箱へ移動：${done}/${current.targets.length}`);
  }
  clearNavigationSnapshot();
  return done;
 }
 async original(record:CloudRecord):Promise<Blob> {
  const [year,mm]=record.originalMonth.split('-');
  const file=await this.graph.read(this.storagePath('originals',year,mm),`${record.originalId}.enc`,MAX_ORIGINAL);
  if(!file)throw new Error('暗号化PDF原本が見つかりません。');
  const bytes=await decryptBytes('original',file.text,this.unlocked());
  if(bytes.byteLength!==record.pdfSize)throw new Error('PDF原本のファイルサイズが記録と一致しません。');
  if(record.fileHash && /^[a-f0-9]{64}$/.test(record.fileHash)) {
   const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));
   const hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(hash!==record.fileHash)throw new Error('PDF原本のSHA-256が明細の記録と一致しません。');
  }
  return new Blob([new Uint8Array(bytes)],{type:record.pdfType});
 }
 async save(record:SavedPayrollRecord,progress?:(stage:string)=>void):Promise<void> {
  this.unlocked();
  const year=shardYear(record);
  const originalPrior=this.records().find(r=>r.id===record.id);
  const month=originalPrior?.originalMonth??record.form.targetMonth;
  const id=originalPrior?.originalId??crypto.randomUUID();
  if(!originalPrior) {
   await this.storeOriginal(record,id,month,progress);
   progress?.('PDF原本の読み戻し照合が完了しました');
  }
  const {pdf,...summary}=record;
  const next:CloudRecord={...summary,pdfSize:pdf.size,pdfType:pdf.type,originalId:id,originalMonth:month};
  const doc=copy(this.shards.get(year)??emptyDoc());
  const at=doc.records.findIndex(r=>r.id===record.id);
  if(at>=0)doc.records[at]=next;else doc.records.push(next);
  doc.deleted=doc.deleted.filter(n=>n!==record.id);
  progress?.('解析済み給与データを保存・検証しています…');
  await this.commit(year,doc);
  // 対象年変更時は移動元を削除履歴へ。原本は回復のため削除しない。
  for(const [other,base] of [...this.shards])if(other!==year&&base.records.some(r=>r.id===record.id)) {
   const changed=copy(base);changed.records=changed.records.filter(r=>r.id!==record.id);changed.deleted.push(record.id);
   await this.commit(other,changed);
  }
  progress?.('Finance連携用の収入データを同期しています…');
  await this.syncIncome(new Set([incomeYear(record),...(originalPrior?[incomeYear(originalPrior)]:[])]));
  progress?.('クラウド保存と検証が完了しました');
 }
 async remove(id:number):Promise<void> {
  const prior=this.records().find(r=>r.id===id);
  const years=[...this.shards].filter(([,d])=>d.records.some(r=>r.id===id)).map(([year])=>year);
  for(const year of years){const d=copy(this.shards.get(year)!);d.records=d.records.filter(r=>r.id!==id);if(!d.deleted.includes(id))d.deleted.push(id);await this.commit(year,d);}
  if(prior)await this.syncIncome(new Set([incomeYear(prior)]));
  // PDF原本は事故時の復元と監査のためOneDriveに保持。
 }
 /** 収入情報は支給日ベース・年度別、個別のAADを割り当てる。 */
 async syncIncome(changedYears?:ReadonlySet<string>):Promise<void> {
  // 書き込み直前の年別ファイルのみ読み直す。全年度を再アップロードしない。
  await this.refresh();
  const allYears=changedYears??new Set<string>([...this.index.incomeYears,...this.records().map(incomeYear)]);
  for(const year of allYears) {
   let committed=false;
   for(let retry=0;retry<5;retry++) {
    if(retry>0)await this.refresh();
    const doc:IncomeDocument={format:'payroll-income-v1',year,records:this.records().filter(r=>incomeYear(r)===year).map(toPublicIncomeRecord).sort((a,b)=>a.id-b.id)};
    const file=await this.graph.read(this.storagePath('income'),`${year}.enc`,MAX_YEAR);
    if(file) {
     const env=parseEnvelope(file.text,'income');if(env.salt!==this.salt)throw new Error('収入連携ファイルの暗号鍵が異なります。');
     const actual=await decryptJson<IncomeDocument>('income',file.text,this.unlocked());
     if(same(actual,doc)){committed=true;break;}
    }
    try {
     await this.graph.write(this.storagePath('income'),`${year}.enc`,await encryptJson('income',doc,this.unlocked(),this.salt),file,MAX_YEAR);
     const verify=await this.graph.read(this.storagePath('income'),`${year}.enc`,MAX_YEAR);
     if(!verify||!same(await decryptJson<IncomeDocument>('income',verify.text,this.unlocked()),doc))throw new Error('収入連携ファイルの保存結果が一致しません。');
     committed=true;break;
    }catch(e){if(isCollision(e)&&retry<4)continue;throw e;}
   }
   if(!committed)throw new Error(`${year}年の収入情報を確定できません。`);
   await this.registerYear(year,'incomeYears');
  }
 }
}
