/** Payroll v2: 保存の正本はOneDriveの暗号化保管庫だけ。旧IndexedDBはmigration専用。 */
import {payrollPeriodKey,validatePayrollForm} from './payrollValidation';
import {isValidPayrollSemantics,type PayrollStatementSemantics} from './payrollSemantics';
import {isValidPayrollZeroResolution,type PayrollZeroResolutionV1} from './payrollZeroResolution';
import {validEmployerId} from './employerIdentity';
import {cloudVault} from '../cloud/auth';
import type {CloudRecord} from '../cloud/vault';
import {PayrollPartialSuccessError} from './operationError';
import {MAX_RECORDS,MAX_PDF_SIZE,MAX_TOTAL_PDF_BYTES} from './storageLimits';

export interface SavedPayrollRecordInput {
 fileName:string;originalFileName?:string;pdf:Blob;fileHash?:string;
 form:Record<string,string>;pages:number;warningsAcknowledged:boolean;
 /** Optional for legacy statements; no automatic data migration on read. */
 semantics?:PayrollStatementSemantics;
 /** Optional import-time distinction: PDF zero, missing value, explicit zero approval. */
 zeroResolution?:PayrollZeroResolutionV1;
 /** Optional opaque permanent employer ID, independent of form.job main/side. */
 employerId?:string;
 reviewedIssues?:string[];reviewedAt?:string;
}
export interface SavedPayrollRecord extends SavedPayrollRecordInput {
 id:number;savedAt:string;revision?:number;
}
export interface SavedPayrollSummary extends Omit<SavedPayrollRecord,'pdf'> {
 pdfSize:number;pdfType:string;
}
export function toSummary(record:SavedPayrollRecord):SavedPayrollSummary {
 const {pdf,...rest}=record;return {...rest,pdfSize:pdf.size,pdfType:pdf.type};
}
export interface ReplacementConflict {
 id:number;fileName:string;period:string;reasons:('same-pdf'|'same-period')[];
 signature:string;legacyHash?:string;
}
export function recordSignature(record:SavedPayrollRecord|SavedPayrollSummary):string {
 const pdfSize='pdf' in record?record.pdf.size:record.pdfSize;
 const pdfType='pdf' in record?record.pdf.type:record.pdfType;
 return JSON.stringify([record.id,record.savedAt,record.fileName,record.originalFileName??'',record.fileHash??'',pdfSize,pdfType,record.pages,record.revision??0,record.warningsAcknowledged,record.reviewedAt??'',record.reviewedIssues??[],record.form,record.semantics??null,record.zeroResolution??null,record.employerId??null]);
}
const conflicts=(old:SavedPayrollSummary,incoming:Pick<SavedPayrollSummary,'fileHash'|'form'>):('same-pdf'|'same-period')[]=>{
 const result:('same-pdf'|'same-period')[]=[];
 if(old.fileHash&&incoming.fileHash&&old.fileHash===incoming.fileHash)result.push('same-pdf');
 if(payrollPeriodKey(old.form)===payrollPeriodKey(incoming.form))result.push('same-period');
 return result;
};
function assertValid(input:SavedPayrollRecordInput,legacy=false):void {
 if('personId' in input||'employeeId' in input||'yearEndAssist' in input)throw new Error('第三者の年末調整データは本人用Payrollに保存できません。');
 if(!validEmployerId(input.employerId))throw new Error('勤務先IDが不正です。');
 if(input.semantics!==undefined&&!isValidPayrollSemantics(input.semantics))throw new Error('保存した明細の解析バージョン情報が不正です。');
 if(input.zeroResolution!==undefined&&!isValidPayrollZeroResolution(input.zeroResolution,input.form))
  throw new Error('保存した明細の0円確認情報が不正です。');
 const {errors,warnings}=validatePayrollForm(input.form);
 if(errors.length)throw new Error(errors[0]);
 if(!legacy&&warnings.length&&!input.warningsAcknowledged)throw new Error('金額の検算警告が未確認です。');
 if(!(input.pdf instanceof Blob)||input.pdf.size===0||input.pdf.size>MAX_PDF_SIZE)throw new Error('PDF原本は1件50MB以内が必要です。');
}
/** A metadata-only edit does not fabricate a Blob or weaken field validation. */
function assertValidMetadata(input:SavedPayrollSummary):void {
 if(!validEmployerId(input.employerId))throw new Error('勤務先IDが不正です。');
 if('personId' in input||'employeeId' in input||'yearEndAssist' in input)
  throw new Error('第三者の年末調整データは本人用Payrollに保存できません。');
 const {errors,warnings}=validatePayrollForm(input.form);
 if(errors.length)throw new Error(errors[0]);
 if(warnings.length&&!input.warningsAcknowledged)throw new Error('金額の検算警告が未確認です。');
 if(input.zeroResolution!==undefined&&!isValidPayrollZeroResolution(input.zeroResolution,input.form))
  throw new Error('保存した明細の0円確認情報が不正です。');
 if(!Number.isSafeInteger(input.pdfSize)||input.pdfSize<1||input.pdfSize>MAX_PDF_SIZE||
   typeof input.pdfType!=='string')throw new Error('PDF原本の保存済み情報が不正です。');
}
function checkLimits(current:readonly SavedPayrollSummary[],incoming:readonly SavedPayrollRecordInput[]):void {
 if(current.length+incoming.length>MAX_RECORDS)throw new Error('給与明細は最大2000件です。');
 if(current.reduce((sum,r)=>sum+r.pdfSize,0)+incoming.reduce((sum,r)=>sum+r.pdf.size,0)>MAX_TOTAL_PDF_BYTES)throw new Error('PDF原本の合計容量が480MiBを超えます。');
}
async function cloudSummaries():Promise<CloudRecord[]> {
 const vault=await cloudVault();return vault.refresh();
}
/** Read-only exports verify the *latest* index and every annual ETag.
 * Reuse authenticated annual JSON only when its remote ID/ETag/size still match.
 * Never use this option for save/delete/migration or to skip the final PDF check.
 * Cross-page reuse is limited to the already encrypted, tab-scoped CE snapshot.
 */
const freshReadOnlyOptions = {forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true} as const;
/** PDFを取りに行かず、年度別の暗号化JSONだけを取得する。 */
export interface DashboardLoadOptions {
 forceFresh?:boolean;
 priorityYears?:readonly string[];
 onProgress?:(status:string)=>void;
}
/** Dashboard startup reuses only the freshly verified index, never for saving or editing. */
export async function loadRecordSummaries(options?:DashboardLoadOptions):Promise<SavedPayrollSummary[]> {
 if(!options){const vault=await cloudVault();return vault.refresh(freshReadOnlyOptions);}
 const start=performance.now();
 options.onProgress?.('Microsoft接続と暗号保管庫を確認しています…');
 const vault=await cloudVault();
 const authMs=Math.round(performance.now()-start);
 options.onProgress?.('暗号索引と年度別明細を確認しています…');
 const result=await vault.refresh({dashboardStartup:true,forceFresh:options.forceFresh,priorityYears:options.priorityYears,onProgress:(loaded,total)=>{
  options.onProgress?.(`OneDriveから年度別データを読み込み中：${loaded}/${total}年度（経過 ${Math.round((performance.now()-start)/1000)}秒）`);
 }});
 // Diagnostic timings contain no filenames, salary values, tokens, or Microsoft identity.
 console.info(`[Payroll startup] source=${vault.isShowingSnapshot()?'encrypted-tab-cache':'OneDrive'}, authentication/unlock=${authMs}ms, annual-records=${Math.round(performance.now()-start)-authMs}ms, total=${Math.round(performance.now()-start)}ms`);
 return result;
}
export async function summaryCacheInfo():Promise<{cached:boolean;deadline:number}>{const vault=await cloudVault();return {cached:vault.isShowingSnapshot(),deadline:vault.navigationDeadline()};}
/** Edit screen: fetch and authenticate statement metadata only, never the original PDF. */
export async function getRecordSummary(id:number,untrustedYearHint?:string):Promise<SavedPayrollSummary|undefined> {
 if(!Number.isSafeInteger(id)||id<=0)throw new Error('明細IDが不正です。');
 // The URL hint only determines fetch priority. Never use it for the record
 // identity, physical PDF path, year selection, or any write target.
 const hint=untrustedYearHint&&/^(19|20|21)\d{2}$/.test(untrustedYearHint)?untrustedYearHint:undefined;
 const vault=await cloudVault();
 const list=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true,
  priorityYears:hint?[hint]:[]});
 const record=list.find(r=>r.id===id);
 if(!record)return undefined;
 const {originalId:_,originalMonth:__,...summary}=record;
 return summary;
}
/** A direct edit-page download verifies the current signature before fetching the PDF. */
export async function getOriginalForVerifiedEdit(id:number,expectedSignature:string):Promise<Blob> {
 if(!Number.isSafeInteger(id)||id<=0||!expectedSignature)throw new Error('原本の取得条件が不正です。');
 const vault=await cloudVault();
 const current=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
 const record=current.find(r=>r.id===id);
 if(!record||recordSignature(record)!==expectedSignature)
  throw new Error('明細が別の画面で更新されました。再読み込みして原本を開いてください。');
 const pdf=await vault.original(record); // size + SHA-256 authenticated
 const after=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
 const latest=after.find(r=>r.id===id);
 if(!latest||recordSignature(latest)!==expectedSignature)
  throw new Error('PDF取得中に明細が更新されました。再読み込みしてください。');
 return pdf;
}
export async function getRecord(id:number):Promise<SavedPayrollRecord|undefined> {
 const vault=await cloudVault();const list=await vault.refresh();const rec=list.find(r=>r.id===id);
 if(!rec)return undefined;
 const {originalId:_,originalMonth:__,pdfSize:___,pdfType:____,...rest}=rec;
 const pdf=await vault.original(rec);
 return {...rest,pdf};
}
/**
 * 閲覧専用: ホームで読み込み・検証済みの年度別明細を再利用する。
 * 読み取りに限り索引の全年度再取得を省き、暗号化PDF原本だけを取得する。
 * 元タブの認証済み鍵を使い、PDFサイズ・SHA-256の照合は vault.original() が行う。
 * 保存・編集・削除の際のOneDrive再検証には一切影響しない。
 */
export async function getOriginalForCurrentView(id:number,expectedSignature:string):Promise<Blob> {
 const vault=await cloudVault();
 const rec=vault.records().find(r=>r.id===id);
 if(!rec||recordSignature(rec)!==expectedSignature)
  throw new Error('表示中の明細が更新されました。ホームを最新の状態にして開き直してください。');
 return vault.original(rec);
}
/** バックアップ用。一度取得した年度JSONを使い、PDF原本だけ最大2件並行取得する。
 * すべてのPDFが揃った後にもう一度明細の署名を確認し、途中更新を拒否する。 */
export async function loadRecords(onProgress?:(completed:number,total:number)=>void):Promise<SavedPayrollRecord[]> {
 const vault=await cloudVault();
 const list=await vault.refresh(freshReadOnlyOptions);
 const snapshot=payrollSnapshot(list);
 const result=new Array<SavedPayrollRecord>(list.length);
 let next=0,completed=0;
 const worker=async():Promise<void>=>{
  for(;;){
   const i=next++;
   if(i>=list.length)return;
   const item=list[i];
   const {originalId:_,originalMonth:__,pdfSize:___,pdfType:____,...summary}=item;
   const pdf=await vault.original(item);
   result[i]={...summary,pdf};
   completed++;
   onProgress?.(completed,list.length);
  }
 };
 await Promise.all(Array.from({length:Math.min(2,list.length)},()=>worker()));
 const latest=await vault.refresh(freshReadOnlyOptions);
 if(JSON.stringify(payrollSnapshot(latest))!==JSON.stringify(snapshot))
  throw new Error('バックアップ中に明細が更新されました。最新の明細を読み込み直して再実行してください。');
 return result;
}
export async function inspectReplacementConflicts(records:Array<SavedPayrollRecordInput|SavedPayrollSummary>,excludeId?:number):Promise<ReplacementConflict[]> {
 if(!records.length)throw new Error('保存対象がありません。');
 for(const record of records){if('pdf' in record)assertValid(record);else assertValidMetadata(record);}
 const old=await cloudSummaries();
 return old.filter(r=>r.id!==excludeId).flatMap(r=>{
  const reasons=[...new Set(records.flatMap(v=>conflicts(r,v)))];
  return reasons.length?[{id:r.id,fileName:r.fileName,period:payrollPeriodKey(r.form),reasons,signature:recordSignature(r)}]:[];
 });
}
function newNumericId(used:Set<number>):number {
 for(let n=0;n<100;n++){
  const values=crypto.getRandomValues(new Uint32Array(2));
  const id=(values[0]&0x1fffff)*4294967296+values[1];
  if(id>0&&!used.has(id))return id;
 }
 throw new Error('新しい明細IDを生成できません。');
}
export interface SkippedPayroll {fileName:string;originalFileName?:string;reason:'saved-pdf'|'saved-period'|'batch-pdf'|'batch-period'}
export interface SaveSkipResult {saved:number;skipped:SkippedPayroll[]}
/** 新規明細を年度単位のバッチで確定。PDFは最大2件並列、年度JSONと収入はまとめて更新。 */
export async function saveRecordsSkippingDuplicates(records:SavedPayrollRecordInput[],onProgress?:(status:string)=>void):Promise<SaveSkipResult> {
 if(!records.length)throw new Error('保存対象がありません。');
 onProgress?.('OneDriveの保存済み明細を確認しています…');
 const vault=await cloudVault();const existing=await vault.refresh();
 const savedHashes=new Set(existing.map(r=>r.fileHash).filter(Boolean));
 const savedPeriods=new Set(existing.map(r=>payrollPeriodKey(r.form)));
 const batchHashes=new Set<string>(),batchPeriods=new Set<string>();
 const accepted:SavedPayrollRecordInput[]=[],skipped:SkippedPayroll[]=[];
 for(const record of records) {
  assertValid(record);
  if(!record.fileHash||!/^[a-f0-9]{64}$/.test(record.fileHash))throw new Error('PDFのSHA-256が必要です。');
  const period=payrollPeriodKey(record.form);
  let reason:SkippedPayroll['reason']|undefined;
  if(savedHashes.has(record.fileHash))reason='saved-pdf';
  else if(savedPeriods.has(period))reason='saved-period';
  else if(batchHashes.has(record.fileHash))reason='batch-pdf';
  else if(batchPeriods.has(period))reason='batch-period';
  if(reason){skipped.push({fileName:record.fileName,originalFileName:record.originalFileName,reason});continue;}
  accepted.push(record);batchHashes.add(record.fileHash);batchPeriods.add(period);
 }
 checkLimits(existing,accepted);
 const used=new Set(existing.map(x=>x.id));
 const batch:SavedPayrollRecord[]=accepted.map(item=>{
  const id=newNumericId(used);used.add(id);
  return {...item,id,savedAt:new Date().toISOString(),revision:1};
 });
 if(!batch.length)return {saved:0,skipped};
 await vault.saveBatch(batch,onProgress);
 return {saved:batch.length,skipped};
}
export async function updateRecord(record:SavedPayrollRecord,approvals:ReplacementConflict[]=[],expectedSignature?:string):Promise<void> {
 assertValid(record);const vault=await cloudVault();const current=await vault.refresh();
 const prior=current.find(r=>r.id===record.id);
 if(!prior||!expectedSignature||recordSignature(prior)!==expectedSignature)throw new Error('別端末で明細が変更されました。読み直してから保存してください。');
 const conflicting=current.filter(r=>r.id!==record.id&&conflicts(r,record).length);
 const allowed=new Map(approvals.map(a=>[a.id,a]));
 if(conflicting.length!==allowed.size||conflicting.some(r=>allowed.get(r.id)?.signature!==recordSignature(r)))throw new Error('重複する明細が変更されました。再度確認してください。');
 await vault.save({...record,revision:(prior.revision??0)+1});
 let removed=0;
 for(const other of conflicting){
  try{await vault.remove(other.id);removed++;}
  catch(error){throw new PayrollPartialSuccessError('duplicate-cleanup',`編集した明細は保存済みですが、重複明細の整理は${removed}/${conflicting.length}件まで完了しました。処理が一部進んでいる可能性があります。画面を再読み込みして確認してください。原因: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
 }
}
/** Edit an existing cloud record without requiring or uploading its original PDF. */
export async function updateRecordMetadata(record:SavedPayrollSummary,approvals:ReplacementConflict[]=[],expectedSignature?:string,onProgress?:(stage:string)=>void):Promise<void> {
 assertValidMetadata(record);
 const vault=await cloudVault();
 const current=await vault.refresh({forceFresh:true});
 const prior=current.find(r=>r.id===record.id);
 if(!prior||!expectedSignature||recordSignature(prior)!==expectedSignature)
  throw new Error('別端末で明細が変更されました。読み直してから保存してください。');
 if(prior.fileHash!==record.fileHash||prior.pdfSize!==record.pdfSize||prior.pdfType!==record.pdfType||
    prior.pages!==record.pages||prior.savedAt!==record.savedAt||prior.originalFileName!==record.originalFileName)
  throw new Error('PDF原本の保存情報が変更されています。再読み込みしてください。');
 const conflicting=current.filter(r=>r.id!==record.id&&conflicts(r,record).length);
 const allowed=new Map(approvals.map(a=>[a.id,a]));
 if(conflicting.length!==allowed.size||conflicting.some(r=>allowed.get(r.id)?.signature!==recordSignature(r)))
  throw new Error('重複する明細が変更されました。再度確認してください。');
 // The vault always takes physical PDF id/month/hash/size/type from the live source,
 // and verifies the expected revision/signature again at the conditional year write.
 await vault.save({...record,revision:(prior.revision??0)+1},onProgress,
  remote=>recordSignature(remote)===expectedSignature);
 let removed=0;
 if(conflicting.length)onProgress?.('明細データを保存済み。重複した明細の除外を確認しています…');
 for(const other of conflicting){
  try{await vault.remove(other.id);removed++;}
  catch(error){throw new PayrollPartialSuccessError('duplicate-cleanup',`編集した明細は保存済みですが、重複明細の整理は${removed}/${conflicting.length}件まで完了しました。処理が一部進んでいる可能性があります。画面を再読み込みして確認してください。原因: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
 }
}
export async function deleteRecord(id:number,expectedSignature:string):Promise<void> {
 if(!Number.isSafeInteger(id)||id<=0||!expectedSignature)throw new Error('削除対象が不正です。');
 const vault=await cloudVault();const current=await vault.refresh();const record=current.find(r=>r.id===id);
 if(!record)throw new Error('対象明細はすでに削除されています。');
 if(recordSignature(record)!==expectedSignature)throw new Error('別の端末で明細が更新されました。削除を中断します。');
 await vault.remove(id);
}
export function payrollSnapshot(records:readonly SavedPayrollSummary[]):string[] {return records.map(recordSignature).sort();}
/** Legacy hashes may be missing. Compare actual PDF bytes before changing any records. */
async function pdfSha256(blob:Blob):Promise<string> {
 const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
/** バックアップ復元：旧データを先に消さず、クラウドへ全件アップロード・照合してから余剰明細を論理削除。 */
export async function replaceAllRecords(records:SavedPayrollRecord[],expectedSnapshot:readonly string[]):Promise<void> {
 const vault=await cloudVault();const old=await vault.refresh();
 if(JSON.stringify(payrollSnapshot(old))!==JSON.stringify(expectedSnapshot))throw new Error('復元開始前にクラウドデータが変更されました。');
 const ids=new Set<number>();
 for(const record of records){assertValid(record,true);if(!Number.isSafeInteger(record.id)||record.id<=0||ids.has(record.id))throw new Error('復元元のIDが不正です。');ids.add(record.id);}
 if(records.length>MAX_RECORDS||records.reduce((sum,r)=>sum+r.pdf.size,0)>MAX_TOTAL_PDF_BYTES)throw new Error('復元データが容量上限を超えています。');
 // Check all matching IDs first: never partially restore records before a PDF mismatch is discovered.
 const byId=new Map(old.map(r=>[r.id,r]));
 for(const record of records){
  const prior=byId.get(record.id);
  if(!prior)continue;
  const original=await vault.original(prior);
  const [storedHash,backupHash]=await Promise.all([pdfSha256(original),pdfSha256(record.pdf)]);
  if(storedHash!==backupHash)throw new Error(`明細ID ${record.id} のPDF原本がバックアップと異なります。既存データは更新していません。`);
  if(record.fileHash&&record.fileHash!==backupHash)throw new Error(`明細ID ${record.id} のバックアップ内PDFハッシュが不正です。`);
 }
 const afterCheck=await vault.refresh({forceFresh:true});
 if(JSON.stringify(payrollSnapshot(afterCheck))!==JSON.stringify(expectedSnapshot))throw new Error('PDF照合中に別端末が明細を変更しました。復元を中断しました。');
 for(const record of records){
  const current=await vault.refresh({forceFresh:true}),prior=current.find(r=>r.id===record.id);
  // Never assume an ID found after preflight belongs to the same physical PDF.
  if(prior&&!byId.has(record.id))throw new Error('復元中に別端末が同じIDの明細を追加しました。復元を中断します。');
  if(!prior&&byId.has(record.id))throw new Error('復元中に元の明細が削除されました。復元を中断します。');
  if(prior&&recordSignature(prior)===recordSignature(record))continue;
  if(prior&&byId.has(record.id)&&recordSignature(prior)!==recordSignature(byId.get(record.id)!))throw new Error('復元中に同じIDの明細が更新されました。再確認してください。');
  await vault.save(record);
 }
 for(const record of old){if(!ids.has(record.id))await vault.remove(record.id);}
 await vault.refresh();
 if(JSON.stringify(payrollSnapshot(vault.records()))!==JSON.stringify(payrollSnapshot(records.map(toSummary))))throw new Error('復元後の照合に失敗しました。旧IndexedDBやバックアップは削除していません。');
}
/** 移行用：一度も旧DBへ書かない。読取前に全件を原本ごと検証する。 */
export async function migrateFromLegacyIndexedDb(progress:(message:string)=>void):Promise<{found:number;migrated:number}> {
 if(!('indexedDB' in window))return {found:0,migrated:0};
 if('databases' in indexedDB){const list=await indexedDB.databases();if(!list.some(x=>x.name==='payroll-local-v1'))return {found:0,migrated:0};}
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const req=indexedDB.open('payroll-local-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
 let legacy:SavedPayrollRecord[];
 try{
  if(!db.objectStoreNames.contains('payroll-records'))return {found:0,migrated:0};
  legacy=await new Promise((resolve,reject)=>{
   const request=db.transaction('payroll-records','readonly').objectStore('payroll-records').getAll();
   request.onsuccess=()=>resolve(request.result as SavedPayrollRecord[]);request.onerror=()=>reject(request.error);
  });
 }finally{db.close();}
 const vault=await cloudVault();let migrated=0;
 for(const record of legacy){
  assertValid(record,true);
  const current=await vault.refresh();
  const sameId=current.find(x=>x.id===record.id);
  if(sameId){
   if(sameId.fileHash!==record.fileHash||recordSignature(sameId)!==recordSignature(record))throw new Error(`旧明細ID ${record.id} とクラウドの内容が異なります。手動調査が必要です。`);
   continue;
  }
  if(current.some(x=>(x.fileHash&&x.fileHash===record.fileHash)||payrollPeriodKey(x.form)===payrollPeriodKey(record.form)))throw new Error(`旧明細ID ${record.id} はクラウドに同じ期間の明細があります。自動統合を中断しました。`);
  progress(`旧IndexedDBから暗号化移行中 ${migrated+1}/${legacy.length}件`);
  await vault.save(record);
  const after=await vault.refresh();const saved=after.find(x=>x.id===record.id);
  if(!saved||recordSignature(saved)!==recordSignature(record))throw new Error(`明細ID ${record.id} の移行後データが一致しません。`);
  const pdf=await vault.original(saved);
  const a=new Uint8Array(await record.pdf.arrayBuffer()),b=new Uint8Array(await pdf.arrayBuffer());
  if(a.length!==b.length||a.some((v,i)=>v!==b[i]))throw new Error(`明細ID ${record.id} の原本照合に失敗しました。`);
  migrated++;
 }
 progress(`旧IndexedDB ${legacy.length}件を照合。新規移行 ${migrated}件。旧データは残しています。`);
 return {found:legacy.length,migrated};
}

/** Read-only pre-deletion check: every old PDF and metadata must already exist in
 * OneDrive's encrypted vault. Never migrate or delete during this check. */
export async function verifyLegacyIndexedDbCloudBeforeDelete(expectedCount:number,progress?:(text:string)=>void):Promise<number>{
 if(!Number.isSafeInteger(expectedCount)||expectedCount<0)throw new Error('旧DBの確認件数が不正です。');
 const info=await inspectLegacyIndexedDb();
 if(!info.exists||info.count!==expectedCount)throw new Error('旧DBの件数が変更されました。削除を中断します。');
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const req=indexedDB.open('payroll-local-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
 let local:SavedPayrollRecord[];
 try{
  if(!db.objectStoreNames.contains('payroll-records'))throw new Error('旧DBの形式が想定と異なります。');
  local=await new Promise((resolve,reject)=>{
   const req=db.transaction('payroll-records','readonly').objectStore('payroll-records').getAll();
   req.onsuccess=()=>resolve(req.result as SavedPayrollRecord[]);req.onerror=()=>reject(req.error);
  });
 }finally{db.close();}
 if(local.length!==expectedCount)throw new Error('旧DBの件数が検査中に変わりました。削除を中断します。');
 progress?.('OneDriveの明細とPDF原本を照合しています…');
 const vault=await cloudVault(),remote=await vault.refresh({forceFresh:true}),snapshot=payrollSnapshot(remote);
 for(let i=0;i<local.length;i++){
  const record=local[i];assertValid(record,true);
  const saved=remote.find(r=>r.id===record.id);
  if(!saved||recordSignature(saved)!==recordSignature(record))
   throw new Error('旧DBにOneDriveと一致しない明細があります。削除を中断し、先に移行してください。');
  const original=await vault.original(saved);
  const [localHash,remoteHash]=await Promise.all([pdfSha256(record.pdf),pdfSha256(original)]);
  if(localHash!==remoteHash||(record.fileHash&&record.fileHash!==localHash))
   throw new Error('旧DBのPDF原本がOneDriveと一致しません。削除を中断します。');
  progress?.(`PDF原本を照合中 ${i+1}/${local.length}件`);
 }
 if(JSON.stringify(payrollSnapshot(await vault.refresh({forceFresh:true})))!==JSON.stringify(snapshot))
  throw new Error('照合中にOneDriveのデータが更新されました。削除を中断します。');
 return local.length;
}
/** 削除前に既知の旧DBだけを照合する。現行のMSAL/セッション領域は調べず、触れない。 */
export async function inspectLegacyIndexedDb():Promise<{exists:boolean;count:number}> {
 if(!('indexedDB' in window)||typeof indexedDB.databases!=='function')throw new Error('このブラウザでは旧DBの安全な列挙に対応していません。');
 const list=await indexedDB.databases();
 if(!list.some(item=>item.name==='payroll-local-v1'))return {exists:false,count:0};
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const req=indexedDB.open('payroll-local-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
 try{
  if(!db.objectStoreNames.contains('payroll-records'))throw new Error('旧DBの保存形式が想定と異なります。削除しません。');
  const count=await new Promise<number>((resolve,reject)=>{
   const req=db.transaction('payroll-records','readonly').objectStore('payroll-records').count();
   req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  return {exists:true,count};
 }finally{db.close();}
}
/** 現行OneDriveとは独立して、既知の旧IndexedDBだけを削除する。明細の移行・照合は行わない。 */
export async function deleteLegacyIndexedDb(expectedCount:number,progress?:(text:string)=>void):Promise<number>{
 if(!Number.isSafeInteger(expectedCount)||expectedCount<0)throw new Error('旧DBの削除対象件数が不正です。');
 const info=await inspectLegacyIndexedDb();
 if(!info.exists)return 0;
 if(info.count!==expectedCount)throw new Error('確認後に旧DBの件数が変わりました。削除を中断します。');
 progress?.('この端末の旧IndexedDBだけを削除しています…');
 await new Promise<void>((resolve,reject)=>{
  // Microsoft/MSAL・OneDrive・その他のIndexedDBには一切触れない。
  const req=indexedDB.deleteDatabase('payroll-local-v1');
  req.onsuccess=()=>resolve();
  req.onerror=()=>reject(req.error??new Error('旧DBの削除に失敗しました。'));
  req.onblocked=()=>progress?.('ほかのタブが旧DBを使用中です。旧画面を閉じると削除が進みます。');
 });
 return expectedCount;
}
