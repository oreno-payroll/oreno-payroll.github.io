/** Read-only, fail-closed inspection before and after an uncertain multi-file upload.
 * No token, PDF bytes, salary data or recovery state is persisted by this module. */
import type {DetachedOriginalReport,DetachedUploadMatch} from '../cloud/vault';
import {validEmployerId} from './employerIdentity.ts';
import {payrollPeriodRelation} from './payrollValidation.ts';
export interface UploadRecoveryAttempt {targetMonth:string;fileHash:string;job:string;kind:string;employerId?:string;paymentYear:string}
export interface UploadRecoveryRecord {id:number;fileHash?:string;form:Record<string,string>;employerId?:string}
export interface UploadRecoveryVault<T extends UploadRecoveryRecord> {
 refresh(options:{forceFresh:true;reuseVerifiedYears:true;bulkYearMetadata:true}):Promise<T[]>;
 inspectDetachedOriginals(reuseVerifiedYears?:boolean,scope?:readonly string[],expectedRecords?:readonly T[]):Promise<DetachedOriginalReport>;
 inspectDetachedUploadMatches(report:DetachedOriginalReport,attempt:readonly UploadRecoveryAttempt[],selected?:ReadonlyMap<string,Blob>):Promise<readonly DetachedUploadMatch[]>;
 inspectIncomeConsistency(years:ReadonlySet<string>):Promise<string[]>;
 original(record:T):Promise<Blob>;
 legacyOriginalDigest(record:T):Promise<string>;
}
export interface UploadRecoveryEvidence {inventory:DetachedOriginalReport;matches:readonly DetachedUploadMatch[];candidateIncomeYears:readonly string[];scope?:readonly string[]}
export interface UploadRecoveryReport {saved:number;attempted:number;originalsVerified:number;detached:number;incomeUnsyncedYears:string[]}
export function uploadRecoveryAttempt(record:{fileHash?:string;form:Record<string,string>;employerId?:string}):UploadRecoveryAttempt {
 const {targetMonth,job,kind,paymentDate}=record.form;
 return {targetMonth,job,kind,employerId:record.employerId,fileHash:record.fileHash??'',paymentYear:(paymentDate??'').slice(0,4)};
}
const exact=(p:UploadRecoveryAttempt,item:UploadRecoveryRecord,hash:string|undefined):boolean=>p.fileHash===hash&&p.targetMonth===item.form.targetMonth&&p.job===item.form.job&&p.kind===item.form.kind&&p.employerId===item.employerId&&p.paymentYear===item.form.paymentDate?.slice(0,4);
/** Legacy metadata without SHA-256 must not be assumed to describe a different PDF. */
export async function pdfSha256(blob:Blob):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function resolveLegacyOriginalHashes<T extends UploadRecoveryRecord>(vault:{legacyOriginalDigest(record:T):Promise<string>},records:readonly T[]):Promise<Map<number,string>>{
 const hashes=new Map<number,string>();
 for(const record of records){
  if(!record.fileHash)hashes.set(record.id,await vault.legacyOriginalDigest(record));
  else if(!/^[a-f0-9]{64}$/.test(record.fileHash))throw new Error('PDF原本のSHA-256が不正です。');
 }
 return hashes;
}
export async function inspectUploadRecovery<T extends UploadRecoveryRecord>(
 vault:UploadRecoveryVault<T>,attempt:readonly UploadRecoveryAttempt[],signature:(item:T)=>string,progress?:(stage:string)=>void,
 baseline?:readonly T[],evidence?:(value:UploadRecoveryEvidence)=>void,checkIncome=true,scope?:readonly string[],deferMatchedInventoryToSaveBatch=false,initialInventory?:DetachedOriginalReport,selected?:ReadonlyMap<string,Blob>,
):Promise<UploadRecoveryReport>{
 if(!attempt.length||attempt.some(item=>!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(item.targetMonth)||!/^[a-f0-9]{64}$/.test(item.fileHash)||
   !/^(19|20|21)\d{2}$/.test(item.paymentYear)||!['main','side'].includes(item.job)||!['salary','bonus'].includes(item.kind)||!validEmployerId(item.employerId)))
  throw new Error('保存対象を確認できません。勤務先・年月・PDFを確認してください。');
 const options={forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true} as const;
 progress?.('保存済みデータを確認中…');
 const before=baseline??await vault.refresh(options);
 // Locked ordinary uploads inspect only their scoped months at the final
 // boundary. Explicit recovery/restore retain the full inventory and detached checks.
 const ordinary=baseline!==undefined&&!checkIncome;
 const scan=(expectedRecords?:readonly T[])=>{progress?.('PDF原本の一覧を確認中…');return vault.inspectDetachedOriginals(baseline!==undefined,scope,expectedRecords);};
 const match=async(inventory:DetachedOriginalReport)=>{
  if(baseline!==undefined&&!inventory.originals.length)return [];
  progress?.('未参照PDF原本を確認中…');
  return vault.inspectDetachedUploadMatches(inventory,attempt,ordinary&&scope!==undefined?selected:undefined);
 };
 let firstInventory=ordinary?undefined:await scan();
 let detached=firstInventory?await match(firstInventory):[];
 // A matching hash or a conflicting period can cause a subsequent upload to skip
 // a record. Authenticate its original rather than trusting the metadata alone.
 const legacy=await resolveLegacyOriginalHashes(vault,before);
 const hashOf=(item:T)=>item.fileHash||legacy.get(item.id);
 const candidates=before.filter(item=>attempt.some(p=>p.fileHash===hashOf(item)||payrollPeriodRelation(item,{form:{job:p.job,kind:p.kind,targetMonth:p.targetMonth},employerId:p.employerId})!=='different'));
 for(const item of candidates)if(!legacy.has(item.id))await vault.original(item);
 // A locked complete inventory may replace the following scan only when no
 // candidate/legacy read intervened and the caller supplied this exact scope.
 if(ordinary&&scope!==undefined&&initialInventory&&!candidates.length&&!legacy.size)firstInventory=initialInventory;
 const incomeYears=new Set([...attempt.map(p=>p.paymentYear),...candidates.map(item=>item.form.paymentDate.slice(0,4))]);
 // Ordinary new uploads synchronize derived income only after payroll is committed.
 let incomeUnsyncedYears:string[]=[];
 if(checkIncome){
  progress?.('Finance連携データを確認中…');
  incomeUnsyncedYears=await vault.inspectIncomeConsistency(incomeYears);
 }
 const fingerprints=(records:readonly T[])=>JSON.stringify(records.map(signature).sort());
 const verifyRecords=async()=>{
  const after=await vault.refresh(options);
  if(fingerprints(before)!==fingerprints(after))
   throw new Error('OneDriveの明細が照合中に変更されました。再確認してください。');
  return after;
 };
 // Scoped ordinary uploads can prove the baseline within the strict inventory.
 // Explicit recovery and cross-month retries retain their separate refresh.
 const scopedOrdinary=ordinary&&scope!==undefined;
 let after=scopedOrdinary?before:await verifyRecords();
 if(!firstInventory){
  firstInventory=await scan(scopedOrdinary?before:undefined);
  if(firstInventory.originals.length){
   detached=await match(firstInventory);
   if(!scopedOrdinary)after=await verifyRecords();
  }
 }
 if(firstInventory===initialInventory&&firstInventory.originals.length)detached=await match(firstInventory);
 let lastInventory=firstInventory;
 // saveBatch performs the same strict final inventory before its first write
 // for matched originals. Only that explicit caller may defer this duplicate.
 const deferred=scopedOrdinary&&deferMatchedInventoryToSaveBatch&&Boolean(evidence)&&detached.length>0;
 if((!ordinary||firstInventory.originals.length)&&!deferred){
  progress?.('PDF原本の一覧を再確認中…');
  lastInventory=await vault.inspectDetachedOriginals(baseline!==undefined,scope,scopedOrdinary?before:undefined);
  if(JSON.stringify(firstInventory)!==JSON.stringify(lastInventory))
   throw new Error('PDF原本の一覧が照合中に変更されました。再保存せず、再検査してください。');
 }
 evidence?.({inventory:lastInventory,matches:detached,scope,candidateIncomeYears:[...new Set(candidates.map(item=>item.form.paymentDate.slice(0,4)))]});
 const saved=attempt.filter(p=>after.some(item=>exact(p,item,hashOf(item)))).length;
 const originalsVerified=attempt.filter(p=>after.some(item=>hashOf(item)===p.fileHash)||detached.some(item=>item.fileHash===p.fileHash)).length;
 return {saved,attempted:attempt.length,originalsVerified,detached:detached.length,incomeUnsyncedYears};
}
export function requireSafeUploadRecovery(report:UploadRecoveryReport,allowDetached=false):void {
 if(report.detached&&!allowDetached)throw new Error('同じPDFの未参照原本がOneDriveにあります。設定画面の「未参照の原本を検査」で回収・内容確認を行い、不要な未参照原本を個別整理してください。原本を自動削除・再保存しません。');
 if(report.incomeUnsyncedYears.length)throw new Error('Finance連携の収入データが未同期です。給与明細を再登録せず、設定画面の「連携データを再生成」を実行してください。');
}
export function uploadRecoveryMessage(report:UploadRecoveryReport):string {
 return `PDF原本：${report.originalsVerified}/${report.attempted}件を確認（未参照原本 ${report.detached}件）・給与明細：${report.saved}/${report.attempted}件保存済み・Finance連携：${report.incomeUnsyncedYears.length?'未同期':'一致'}。`;
}
