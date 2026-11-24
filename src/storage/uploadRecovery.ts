/** Read-only, fail-closed inspection after an uncertain multi-file Payroll upload.
 * No token, PDF bytes, salary data or recovery state is persisted by this module. */
export interface UploadRecoveryAttempt {targetMonth:string;fileHash:string}
export interface UploadRecoveryRecord {id:number;fileHash?:string;form:Record<string,string>}
export interface UploadRecoveryVault<T extends UploadRecoveryRecord> {
 refresh(options:{forceFresh:true;reuseVerifiedYears:true;bulkYearMetadata:true}):Promise<T[]>;
 inspectDetachedOriginals():Promise<{originals:readonly {month:string}[]}>;
 original(record:T):Promise<Blob>;
}
export interface UploadRecoveryReport {saved:number;attempted:number}
export async function inspectUploadRecovery<T extends UploadRecoveryRecord>(
 vault:UploadRecoveryVault<T>,attempt:readonly UploadRecoveryAttempt[],signature:(item:T)=>string,
):Promise<UploadRecoveryReport>{
 if(!attempt.length||attempt.some(item=>!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(item.targetMonth)||!/^[a-f0-9]{64}$/.test(item.fileHash)))
  throw new Error('前回の保存対象を確認できません。ページを開き直して最新状態を確認してください。');
 const months=new Set(attempt.map(item=>item.targetMonth));
 const options={forceFresh:true,reuseVerifiedYears:true,bulkYearMetadata:true} as const;
 const before=await vault.refresh(options);
 const firstInventory=await vault.inspectDetachedOriginals();
 if(firstInventory.originals.some(item=>months.has(item.month)))
  throw new Error('保存対象の年月に未参照PDF原本があります。削除済みの原本か保存中断の原本かは区別できません。設定画面の「未参照PDFの検査」で確認し、再保存しないでください。');
 // Matching hashes and periods are the only entries that a subsequent upload could skip.
 // Validate their encrypted original bytes rather than trusting a metadata-only listing.
 const candidates=before.filter(item=>months.has(item.form.targetMonth)||attempt.some(p=>p.fileHash===item.fileHash));
 for(const item of candidates)await vault.original(item);
 const after=await vault.refresh(options);
 const fingerprints=(records:readonly T[])=>JSON.stringify(records.map(signature).sort());
 if(fingerprints(before)!==fingerprints(after))
  throw new Error('OneDriveの明細が照合中に変更されました。再確認してください。');
 const lastInventory=await vault.inspectDetachedOriginals();
 if(lastInventory.originals.some(item=>months.has(item.month)))
  throw new Error('PDF原本の一覧が照合中に変更されました。再保存せず、未参照PDFの検査を実行してください。');
 const saved=attempt.filter(p=>after.some(item=>item.fileHash===p.fileHash)).length;
 return {saved,attempted:attempt.length};
}
