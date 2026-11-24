/** Payroll v2: 保存の正本はOneDriveの暗号化保管庫だけ。旧IndexedDBはmigration専用。 */
import {payrollPeriodKey,payrollPeriodRelation,PayrollEmployerConfirmationError,validatePayrollForm} from './payrollValidation';
import {isValidPayrollSemantics,type PayrollStatementSemantics} from './payrollSemantics';
import {isValidPayrollZeroResolution,type PayrollZeroResolutionV1} from './payrollZeroResolution';
import {validEmployerId} from './employerIdentity';
import {employerDirectorySignature,mergeEmployerDirectories,type EmployerEntry} from './employerDirectory';
import {cloudVault} from '../cloud/auth';
import type {CloudRecord} from '../cloud/vault';
import {PayrollPartialSuccessError} from './operationError';
import {inspectUploadRecovery,requireSafeUploadRecovery,uploadRecoveryAttempt,pdfSha256,resolveLegacyOriginalHashes} from './uploadRecovery';
import {fiscalYearOfTargetMonth} from '../forecast/payrollCalendar';
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
 signature:string;legacyHash?:string;employerId?:string;
}
export function recordSignature(record:SavedPayrollRecord|SavedPayrollSummary):string {
 const pdfSize='pdf' in record?record.pdf.size:record.pdfSize;
 const pdfType='pdf' in record?record.pdf.type:record.pdfType;
 return JSON.stringify([record.id,record.savedAt,record.fileName,record.originalFileName??'',record.fileHash??'',pdfSize,pdfType,record.pages,record.revision??0,record.warningsAcknowledged,record.reviewedAt??'',record.reviewedIssues??[],record.form,record.semantics??null,record.zeroResolution??null,record.employerId??null]);
}
const conflicts=(old:SavedPayrollSummary,incoming:Pick<SavedPayrollSummary,'fileHash'|'form'|'employerId'>):('same-pdf'|'same-period')[]=>{
 const result:('same-pdf'|'same-period')[]=[];
 if(old.fileHash&&incoming.fileHash&&old.fileHash===incoming.fileHash)result.push('same-pdf');
 const relation=payrollPeriodRelation(old,incoming);
 if(relation==='ambiguous'&&!result.includes('same-pdf'))throw new PayrollEmployerConfirmationError();
 if(relation==='same')result.push('same-period');
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
 onEmployerDirectory?:(directory:EmployerEntry[])=>void;
}
/** Dashboard startup reuses only the freshly verified index, never for saving or editing. */
export async function loadRecordSummaries(options?:DashboardLoadOptions):Promise<SavedPayrollSummary[]> {
 if(!options){const vault=await cloudVault();return vault.refresh(freshReadOnlyOptions);}
 const start=performance.now();
 options.onProgress?.('Microsoft接続と暗号保管庫を確認しています…');
 const vault=await cloudVault();
 const authMs=Math.round(performance.now()-start);
 options.onProgress?.('暗号索引と年度別明細を確認しています…');
 const result=await vault.refresh({dashboardStartup:true,forceFresh:options.forceFresh,reuseVerifiedYears:true,bulkYearMetadata:true,priorityYears:options.priorityYears,onProgress:(loaded,total)=>{
  options.onProgress?.(`OneDriveから年度別データを読み込み中：${loaded}/${total}年度（経過 ${Math.round((performance.now()-start)/1000)}秒）`);
 }});
 options.onEmployerDirectory?.(vault.dashboardEmployerDirectory());
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
/** Compare the physical original reference as well as user-visible metadata. */
function originalReferenceSignature(record:CloudRecord):string {
 return JSON.stringify([record.originalId,record.originalMonth]);
}
/** All single-PDF operations verify the live annual inventory before and after fetching. */
export async function getOriginalForVerifiedEdit(id:number,expectedSignature:string):Promise<Blob> {
 if(!Number.isSafeInteger(id)||id<=0||!expectedSignature)throw new Error('原本の取得条件が不正です。');
 const vault=await cloudVault();
 const current=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
 const record=current.find(r=>r.id===id);
 if(!record||recordSignature(record)!==expectedSignature)
  throw new Error('明細が別の画面で更新されました。再読み込みして原本を開いてください。');
 const reference=originalReferenceSignature(record);
 const pdf=await vault.original(record); // size + SHA-256 authenticated
 const after=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
 const latest=after.find(r=>r.id===id);
 if(!latest||recordSignature(latest)!==expectedSignature||originalReferenceSignature(latest)!==reference)
  throw new Error('PDF取得中に明細が更新されました。再読み込みしてください。');
 return pdf;
}
export async function getRecord(id:number):Promise<SavedPayrollRecord|undefined> {
 if(!Number.isSafeInteger(id)||id<=0)throw new Error('明細IDが不正です。');
 const vault=await cloudVault();
 const list=await vault.refresh(freshReadOnlyOptions);
 const rec=list.find(r=>r.id===id);
 if(!rec)return undefined;
 const signature=recordSignature(rec),reference=originalReferenceSignature(rec);
 const {originalId:_,originalMonth:__,pdfSize:___,pdfType:____,...rest}=rec;
 const pdf=await vault.original(rec);
 const after=await vault.refresh(freshReadOnlyOptions);
 const latest=after.find(r=>r.id===id);
 if(!latest||recordSignature(latest)!==signature||originalReferenceSignature(latest)!==reference)
  throw new Error('PDF取得中に明細が更新されました。再読み込みしてください。');
 return {...rest,pdf};
}
/** Only for a batch export bracketed by fresh full-inventory checks in the caller.
 * Single-PDF viewing and downloads must use the verified pre/post paths above.
 */
export async function getOriginalForBatchExport(id:number,expectedSignature:string):Promise<Blob> {
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
  return reasons.length?[{id:r.id,fileName:r.fileName,period:payrollPeriodKey(r.form,r.employerId),reasons,signature:recordSignature(r),...(r.employerId?{employerId:r.employerId}:{})}]:[];
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
 const legacyHashes=await resolveLegacyOriginalHashes(vault,existing);
 const savedHashes=new Set(existing.map(r=>r.fileHash||legacyHashes.get(r.id)).filter(Boolean));
 const batchHashes=new Set<string>();
 const accepted:SavedPayrollRecordInput[]=[],skipped:SkippedPayroll[]=[];
 for(const record of records) {
  assertValid(record);
  if(!record.fileHash||!/^[a-f0-9]{64}$/.test(record.fileHash)||await pdfSha256(record.pdf)!==record.fileHash)throw new Error('PDFのSHA-256が一致しません。');
  let reason:SkippedPayroll['reason']|undefined;
  if(savedHashes.has(record.fileHash))reason='saved-pdf';
  else if(batchHashes.has(record.fileHash))reason='batch-pdf';
  else {
   const savedRelations=existing.map(r=>payrollPeriodRelation(r,record));
   const batchRelations=accepted.map(r=>payrollPeriodRelation(r,record));
   if(savedRelations.includes('ambiguous')||batchRelations.includes('ambiguous'))throw new PayrollEmployerConfirmationError();
   if(savedRelations.includes('same'))reason='saved-period';
   else if(batchRelations.includes('same'))reason='batch-period';
  }
  if(reason){skipped.push({fileName:record.fileName,originalFileName:record.originalFileName,reason});continue;}
  accepted.push(record);batchHashes.add(record.fileHash);
 }
 // Even after a reload, inspect cloud-side originals and income before writing.
 // Include skipped PDFs so an income-only partial success cannot be called saved.
 onProgress?.('OneDriveの保存済み明細を確認しています…');
 const preflight=await inspectUploadRecovery(vault,records.map(uploadRecoveryAttempt),recordSignature);
 requireSafeUploadRecovery(preflight);
 // The preflight is read-only; recheck the exact source snapshot before using
 // the previously computed accepted list. saveBatch independently checks races.
 const latest=await vault.refresh({forceFresh:true});
 if(physicalRestoreSnapshot(latest)!==physicalRestoreSnapshot(existing))
  throw new Error('保存前の照合中に明細が変更されました。最新状態を確認してください。');
 checkLimits(latest,accepted);
 const used=new Set(latest.map(x=>x.id));
 const batch:SavedPayrollRecord[]=accepted.map(item=>{
  const id=newNumericId(used);used.add(id);
  return {...item,id,savedAt:new Date().toISOString(),revision:1};
 });
 if(!batch.length)return {saved:0,skipped};
 await vault.saveBatch(batch,onProgress,latest);
 return {saved:batch.length,skipped};
}
export async function updateRecord(record:SavedPayrollRecord,approvals:ReplacementConflict[]=[],expectedSignature?:string):Promise<void> {
 assertValid(record);const vault=await cloudVault();const current=await vault.refresh();
 const prior=current.find(r=>r.id===record.id);
 if(!prior||!expectedSignature||recordSignature(prior)!==expectedSignature)throw new Error('別端末で明細が変更されました。読み直してから保存してください。');
 const conflicting=current.filter(r=>r.id!==record.id&&conflicts(r,record).length);
 const allowed=new Map(approvals.map(a=>[a.id,a]));
 if(conflicting.length!==allowed.size||conflicting.some(r=>allowed.get(r.id)?.signature!==recordSignature(r)))throw new Error('重複する明細が変更されました。再度確認してください。');
 await vault.save({...record,revision:(prior.revision??0)+1},undefined,remote=>recordSignature(remote)===expectedSignature,remote=>{
  if(remote.some(r=>r.id!==record.id&&conflicts(r,record).length&&allowed.get(r.id)?.signature!==recordSignature(r)))throw new Error('保存直前に重複する明細が変更されました。再度確認してください。');
 });
 if(conflicting.length){
  try{await vault.removeBatch(conflicting.map(other=>({id:other.id,matches:remote=>recordSignature(remote)===recordSignature(other)})));}
  catch(error){throw new PayrollPartialSuccessError('duplicate-cleanup','編集した明細は保存済みですが、重複明細・原本の整理は一部未確認です。最新明細とFinance連携、未参照PDF原本を確認してください。',{cause:error});}
 }
}
/** Edit an existing cloud record without requiring or uploading its original PDF. */
export async function updateRecordMetadata(record:SavedPayrollSummary,approvals:ReplacementConflict[]=[],expectedSignature?:string,onProgress?:(stage:string)=>void,expectedDirectory?:string):Promise<void> {
 assertValidMetadata(record);
 const vault=await cloudVault();
 const current=await vault.refresh({forceFresh:true});
 const prior=current.find(r=>r.id===record.id);
 if(!prior||!expectedSignature||recordSignature(prior)!==expectedSignature)
  throw new Error('別端末で明細が変更されました。読み直してから保存してください。');
 if(expectedDirectory!==undefined||(record.employerId!==undefined&&record.form.job!==prior.form.job)){
  const directory=await vault.readEmployerDirectory();
  if(expectedDirectory!==undefined&&employerDirectorySignature(directory)!==expectedDirectory)throw new Error('勤務先一覧が更新されました。再度確認してください。');
  if(record.employerId!==undefined&&(record.employerId!==prior.employerId||record.form.job!==prior.form.job)&&!directory.some(e=>e.id===record.employerId&&e.role===record.form.job))throw new Error('勤務区分に対応する勤務先を選択してください。');
 }
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
  remote=>recordSignature(remote)===expectedSignature,remote=>{
   const liveConflicts=remote.filter(r=>r.id!==record.id&&conflicts(r,record).length);
   if(liveConflicts.some(r=>allowed.get(r.id)?.signature!==recordSignature(r)))
    throw new Error('保存直前に重複する明細が変更されました。再度確認してください。');
  });
 if(conflicting.length){
  onProgress?.('明細データを保存済み。重複した明細と原本の整理を確認しています…');
  try{await vault.removeBatch(conflicting.map(other=>({id:other.id,matches:remote=>recordSignature(remote)===recordSignature(other)})));}
  catch(error){throw new PayrollPartialSuccessError('duplicate-cleanup','編集した明細は保存済みですが、重複明細・原本の整理は一部未確認です。最新明細とFinance連携、未参照PDF原本を確認してください。',{cause:error});}
 }
}
export async function deleteRecord(id:number,expectedSignature:string):Promise<void> {
 if(!Number.isSafeInteger(id)||id<=0||!expectedSignature)throw new Error('削除対象が不正です。');
 const vault=await cloudVault();const current=await vault.refresh();const record=current.find(r=>r.id===id);
 if(!record)throw new Error('対象明細はすでに削除されています。');
 if(recordSignature(record)!==expectedSignature)throw new Error('別の端末で明細が更新されました。削除を中断します。');
 await vault.removeBatch([{id,matches:remote=>recordSignature(remote)===expectedSignature}]);
}
/** All selected revisions are checked before the first annual mutation. */
export async function deleteRecords(targets:readonly {id:number;signature:string}[]):Promise<void> {
 if(!targets.length||targets.some(t=>!Number.isSafeInteger(t.id)||t.id<=0||!t.signature)||new Set(targets.map(t=>t.id)).size!==targets.length)
  throw new Error('削除対象が不正です。');
 const vault=await cloudVault();
 await vault.removeBatch(targets.map(t=>({id:t.id,matches:remote=>recordSignature(remote)===t.signature})));
}
export function payrollSnapshot(records:readonly SavedPayrollSummary[]):string[] {return records.map(recordSignature).sort();}
/** The plan is read-only and binds exact records, physical references and directory. */
export interface EmployerAssignmentPlan {signature:string;count:number;employerId:string}
export interface EmployerAssignmentTarget {id:number;signature:string}
async function planEmployerAssignment(vault:Awaited<ReturnType<typeof cloudVault>>,targets:readonly EmployerAssignmentTarget[],employerId:string,directorySignature:string,authorized:()=>boolean){
 if(!authorized()||!targets.length||targets.length>MAX_RECORDS||new Set(targets.map(t=>t.id)).size!==targets.length)throw new Error('勤務先設定の対象または認証状態が不正です。');
 const live=await vault.refresh({forceFresh:true}),directory=await vault.readEmployerDirectory();
 const entry=directory.find(e=>e.id===employerId);
 if(!entry||employerDirectorySignature(directory)!==directorySignature||!authorized())throw new Error('勤務先一覧が変更されました。');
 const selected=new Map(targets.map(t=>[t.id,t.signature]));
 const items=live.filter(r=>selected.has(r.id));
 if(items.length!==targets.length||items.some(r=>r.employerId!==undefined||r.form.job!==entry.role||recordSignature(r)!==selected.get(r.id)))throw new Error('対象明細が変更されました。最新データを確認してください。');
 const final=live.map(r=>selected.has(r.id)?{...r,employerId}:r);
 for(const item of final.filter(r=>selected.has(r.id)))if(final.some(r=>r.id!==item.id&&payrollPeriodRelation(r,item)!=='different'))throw new Error('同じ期間の明細が重複するか勤務先を確定できません。対象を確認してください。');
 const physical=physicalRestoreSnapshot(live);
 if(physicalRestoreSnapshot(await vault.refresh({forceFresh:true}))!==physical||employerDirectorySignature(await vault.readEmployerDirectory())!==directorySignature||!authorized())throw new Error('検査中に明細または勤務先が変更されました。');
 const signature=JSON.stringify([physical,directorySignature,employerId,[...selected.keys()].sort((a,b)=>a-b)]);
 return {preview:{signature,count:items.length,employerId},live};
}
export async function inspectEmployerAssignment(targets:readonly EmployerAssignmentTarget[],employerId:string,directorySignature:string,authorized:()=>boolean):Promise<EmployerAssignmentPlan>{
 return (await planEmployerAssignment(await cloudVault(),targets,employerId,directorySignature,authorized)).preview;
}
export async function assignEmployers(targets:readonly EmployerAssignmentTarget[],employerId:string,directorySignature:string,expectedSignature:string,authorized:()=>boolean):Promise<void>{
 const vault=await cloudVault(),plan=await planEmployerAssignment(vault,targets,employerId,directorySignature,authorized);
 if(plan.preview.signature!==expectedSignature||!authorized())throw new Error('承認した勤務先設定の対象が変更されました。');
 await vault.assignEmployerBatch(plan.live,targets.map(t=>t.id),employerId,directorySignature,authorized);
}
/** Read-only additive restore plan. Nothing is overwritten, even on ID collision. */
export interface AdditiveRestorePreview {
 signature:string; add:number; samePdf:number; sameId:number; samePeriod:number; ambiguous:number; backupConflict:number; employersAdded:number;
}
const physicalRestoreSnapshot=(records:readonly CloudRecord[])=>JSON.stringify(records.map(r=>JSON.stringify([recordSignature(r),r.originalId,r.originalMonth])).sort());
async function planAdditiveRestore(vault:Awaited<ReturnType<typeof cloudVault>>,records:readonly SavedPayrollRecord[],employers?:readonly EmployerEntry[]) {
 const live=await vault.refresh({forceFresh:true});const before=physicalRestoreSnapshot(live);
 const directory=await vault.readEmployerDirectory(),merged=employers===undefined?directory:mergeEmployerDirectories(directory,employers);
 const directorySignature=employerDirectorySignature(directory);
 const nextDirectorySignature=employerDirectorySignature(merged);
 const used=new Set<number>(),normalized:SavedPayrollRecord[]=[];
 if(records.length>MAX_RECORDS||records.reduce((sum,r)=>sum+r.pdf.size,0)>MAX_TOTAL_PDF_BYTES)throw new Error('復元データが容量上限を超えています。');
 for(const record of records){
  assertValid(record,true);
  if(!Number.isSafeInteger(record.id)||record.id<=0||used.has(record.id))throw new Error('復元元のIDが不正です。');
  used.add(record.id);const hash=await pdfSha256(record.pdf);
  if(record.fileHash&&record.fileHash!==hash)throw new Error('バックアップ内のPDFハッシュが一致しません。');
  normalized.push({...record,fileHash:hash,form:{...record.form}});
 }
 const liveHashes=new Set<string>();
 // A legacy record without a hash must be compared by actual bytes, not assumed distinct.
 // Authenticate matching PDFs too, so a damaged existing original is not reported as recovered.
 const backupHashes=new Set(normalized.map(r=>r.fileHash));
 for(const item of live){
  const hash=!item.fileHash||backupHashes.has(item.fileHash)?await pdfSha256(await vault.original(item)):item.fileHash;
  if(item.fileHash&&item.fileHash!==hash)throw new Error('既存PDFのハッシュが一致しません。');
  liveHashes.add(hash);
 }
 const preview:AdditiveRestorePreview={signature:'',add:0,samePdf:0,sameId:0,samePeriod:0,ambiguous:0,backupConflict:0,employersAdded:merged.length-directory.length};
 const accepted:SavedPayrollRecord[]=[],candidates:SavedPayrollRecord[]=[];
 for(const record of normalized){
  if(liveHashes.has(record.fileHash!)){preview.samePdf++;continue;}
  if(live.some(r=>r.id===record.id)){preview.sameId++;continue;}
  const relations=live.map(r=>payrollPeriodRelation(r,record));
  if(relations.includes('ambiguous')){preview.ambiguous++;continue;}
  if(relations.includes('same')){preview.samePeriod++;continue;}
  candidates.push(record);
 }
 // Never select an arbitrary winner from a conflicting group inside a backup.
 for(const record of candidates){
  if(normalized.some(other=>other!==record&&(other.fileHash===record.fileHash||payrollPeriodRelation(other,record)!=='different'))){preview.backupConflict++;continue;}
  accepted.push(record);
 }
 preview.add=accepted.length;checkLimits(live,accepted);
 if(normalized.length){
  const recovery=await inspectUploadRecovery(vault,normalized.map(uploadRecoveryAttempt),recordSignature);
  requireSafeUploadRecovery(recovery);
 }
 if(physicalRestoreSnapshot(await vault.refresh({forceFresh:true}))!==before||employerDirectorySignature(await vault.readEmployerDirectory())!==directorySignature)
  throw new Error('復元内容の照合中にOneDriveが変更されました。再検査してください。');
 preview.signature=JSON.stringify([before,directorySignature,nextDirectorySignature,normalized.map(recordSignature),accepted.map(r=>r.id),[...liveHashes].sort(),preview]);
 return {preview,accepted,live,directory,merged};
}
export async function inspectAdditiveRestore(records:readonly SavedPayrollRecord[],employers?:readonly EmployerEntry[]):Promise<AdditiveRestorePreview>{
 return (await planAdditiveRestore(await cloudVault(),records,employers)).preview;
}
/** Rebuild the approved plan before any write. Allocate fresh local IDs so deleted IDs
 * and old revision histories are never resurrected or reused; PDF hash is the resume key. */
export async function restoreAdditiveRecords(records:readonly SavedPayrollRecord[],expectedSignature:string,employers?:readonly EmployerEntry[],authorized:()=>boolean=()=>true,onProgress?:(stage:string)=>void):Promise<AdditiveRestorePreview>{
 const vault=await cloudVault();if(!authorized())throw new Error('認証状態が変更されました。再確認してください。');
 const plan=await planAdditiveRestore(vault,records,employers);
 if(!authorized()||plan.preview.signature!==expectedSignature)throw new Error('追加復元の対象が変更されました。再検査してください。');
 if(plan.preview.employersAdded){
  await vault.writeEmployerDirectory(plan.directory,plan.merged);
 }
 if(!authorized()||physicalRestoreSnapshot(await vault.refresh({forceFresh:true}))!==physicalRestoreSnapshot(plan.live)||employerDirectorySignature(await vault.readEmployerDirectory())!==employerDirectorySignature(plan.merged))
  throw new Error('追加復元の直前にOneDriveが変更されました。再検査してください。');
 const used=new Set([...plan.live.map(r=>r.id),...records.map(r=>r.id)]);
 const batch=plan.accepted.map(record=>{const id=newNumericId(used);used.add(id);return {...record,id};});
 if(batch.length){
  await vault.saveBatch(batch,onProgress,plan.live,authorized);
  const latest=await vault.refresh({forceFresh:true});
  const ids=new Set(batch.map(r=>r.id));
  if(physicalRestoreSnapshot(latest.filter(r=>!ids.has(r.id)))!==physicalRestoreSnapshot(plan.live)||batch.some(r=>!latest.some(v=>v.id===r.id&&recordSignature(v)===recordSignature(r))))
   throw new Error('追加復元後の明細照合が一致しません。再検査してください。');
  for(const r of latest.filter(r=>ids.has(r.id)))await vault.original(r);
  const years=new Set(batch.map(r=>r.form.paymentDate.slice(0,4)));
  if((await vault.inspectIncomeConsistency(years)).length)throw new Error('追加復元後のFinance連携が一致しません。連携データを再生成してください。');
 }
 return plan.preview;
}

/** The approved baseline includes physical references, not only displayed metadata. */
export interface ReplacementRestoreBaseline {physical:string;directory:string;count:number;bytes:number}
export async function inspectReplacementRestoreBaseline():Promise<ReplacementRestoreBaseline>{
 const vault=await cloudVault();
 const records=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true}),physical=physicalRestoreSnapshot(records);
 const directory=employerDirectorySignature(await vault.readEmployerDirectory());
 if(physicalRestoreSnapshot(await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true}))!==physical||employerDirectorySignature(await vault.readEmployerDirectory())!==directory)
  throw new Error('全件置換の確認中に明細または勤務先が変更されました。再確認してください。');
 return {physical,directory,count:records.length,bytes:records.reduce((sum,r)=>sum+r.pdfSize,0)};
}
/** 全件置換は事前承認した明細と勤務先を境界ごとに照合する。
 * 置換対象外の原本は全明細・Finance照合後にのみ整理する。複数年度にまたがる処理は原子的ではない。 */
export async function replaceAllRecords(records:SavedPayrollRecord[],baseline:ReplacementRestoreBaseline,employers?:readonly EmployerEntry[],authorized:()=>boolean=()=>true):Promise<void> {
 const vault=await cloudVault();
 const old=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true}),directory=await vault.readEmployerDirectory();
 if(!authorized()||physicalRestoreSnapshot(old)!==baseline.physical||employerDirectorySignature(directory)!==baseline.directory)
  throw new Error('復元開始前に明細・勤務先または認証状態が変更されました。再検査してください。');
 const ids=new Set<number>(),byId=new Map(old.map(r=>[r.id,r]));
 let expected=old.slice(),expectedDirectory=baseline.directory;
 const checkState=async()=>{
  const current=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true});
  if(!authorized()||physicalRestoreSnapshot(current)!==physicalRestoreSnapshot(expected)||employerDirectorySignature(await vault.readEmployerDirectory())!==expectedDirectory||!authorized())
   throw new Error('復元中に明細・勤務先または認証状態が変更されました。再検査してください。');
  return current;
 };
 const checkYear=(remote:readonly CloudRecord[],year:string)=>{
  if(!authorized()||physicalRestoreSnapshot(remote)!==physicalRestoreSnapshot(expected.filter(r=>String(fiscalYearOfTargetMonth(r.form.targetMonth))===year)))
   throw new Error('復元の年度書き込み直前に明細が変更されました。再検査してください。');
 };
 for(const record of records){assertValid(record,true);if(!Number.isSafeInteger(record.id)||record.id<=0||ids.has(record.id))throw new Error('復元元のIDが不正です。');ids.add(record.id);}
 if(records.length>MAX_RECORDS||records.reduce((sum,r)=>sum+r.pdf.size,0)>MAX_TOTAL_PDF_BYTES)throw new Error('復元データが容量上限を超えています。');
 // Verify all incoming hashes, including new IDs, before the first write.
 const hashes:Array<{targetMonth:string;fileHash:string}>=[];
 for(const record of records){
  const backupHash=await pdfSha256(record.pdf),prior=byId.get(record.id);
  hashes.push({targetMonth:record.form.targetMonth,fileHash:backupHash});
  if(prior&&await pdfSha256(await vault.original(prior))!==backupHash)throw new Error('同じ明細IDのPDF原本がバックアップと異なります。既存データは更新していません。');
  if(record.fileHash&&record.fileHash!==backupHash)throw new Error('バックアップ内PDFハッシュが不正です。');
 }
 // An interrupted earlier restore may have detached originals. Never blindly
 // upload the same PDF again, even if its month was corrected.
 {
  const report=await vault.inspectDetachedOriginals();
  if(hashes.length&&(await vault.inspectDetachedUploadMatches(report,hashes)).length)throw new Error('復元対象と同じ未参照原本があります。設定で原本を確認・整理してから再検査してください。');
  if(JSON.stringify(await vault.inspectDetachedOriginals())!==JSON.stringify(report))throw new Error('復元対象の原本検査中に一覧が変更されました。再検査してください。');
 }
 const excluded=old.filter(r=>!ids.has(r.id));
 const excludedOriginals=await vault.captureDeletionOriginals(excluded);
 await checkState();
 if(employers!==undefined){
  const merged=mergeEmployerDirectories(directory,employers);
  if(employerDirectorySignature(merged)!==expectedDirectory)await vault.writeEmployerDirectory(directory,merged);
  expectedDirectory=employerDirectorySignature(merged);
  await checkState();
 }
 for(const record of records){
  const prior=expected.find(r=>r.id===record.id);
  if(prior&&recordSignature(prior)===recordSignature(record))continue;
  await checkState();
  const matches=(remote:CloudRecord)=>!!prior&&physicalRestoreSnapshot([remote])===physicalRestoreSnapshot([prior]);
  await vault.save(record,undefined,matches,checkYear);
  const current=await vault.refresh({forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true}),actual=current.find(r=>r.id===record.id);
  if(!actual||recordSignature(actual)!==recordSignature(record)||prior&&(actual.originalId!==prior.originalId||actual.originalMonth!==prior.originalMonth))
   throw new Error('復元した明細・原本の照合に失敗しました。');
  if(await pdfSha256(await vault.original(actual))!==await pdfSha256(record.pdf))throw new Error('復元したPDF原本が一致しません。');
  expected=[...expected.filter(r=>r.id!==record.id),actual];
  await checkState();
 }
 for(const record of old){
  if(ids.has(record.id))continue;
  await checkState();
  await vault.remove(record.id,remote=>physicalRestoreSnapshot([remote])===physicalRestoreSnapshot([record]),checkYear);
  expected=expected.filter(r=>r.id!==record.id);
  await checkState();
 }
 const latest=await checkState();
 if(JSON.stringify(payrollSnapshot(latest))!==JSON.stringify(payrollSnapshot(records.map(toSummary))))throw new Error('復元後の照合に失敗しました。旧IndexedDBやバックアップは削除していません。');
 const years=new Set([...old,...latest].map(r=>r.form.paymentDate.slice(0,4)));
 if((await vault.inspectIncomeConsistency(years)).length)throw new Error('全件置換後のFinance連携が一致しません。連携データを再生成してください。');
 await checkState();
 await vault.trashConfirmedDeletionOriginals(excludedOriginals,new Set(excluded.map(r=>r.id)),years,checkState);
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
  if(current.some(x=>(x.fileHash&&x.fileHash===record.fileHash)||payrollPeriodRelation(x,record)!=='different'))throw new Error(`旧明細ID ${record.id} はクラウドに同じ期間の明細があります。自動統合を中断しました。`);
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
