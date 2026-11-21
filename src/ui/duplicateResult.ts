/** Describes only the files excluded from an upload. All names stay in the DOM, never in logs. */
import type {SkippedPayroll} from '../storage/payrollStore';
export interface UploadDuplicateDetail {fileName:string;reason:string}
export interface RepeatedUpload {fileName:string;firstFileName:string}
export function describeUploadDuplicates(skipped:readonly SkippedPayroll[],withinUpload:readonly RepeatedUpload[]):UploadDuplicateDetail[]{
  const reasons:Record<SkippedPayroll['reason'],string>={
    'saved-pdf':'OneDriveに同一PDF原本が登録済み',
    'saved-period':'OneDriveに同じ勤務先・対象年月・種別の明細が登録済み',
    'batch-pdf':'今回の保存対象に同一PDF原本がある',
    'batch-period':'今回の保存対象に同じ勤務先・対象年月・種別の明細がある',
  };
  return [
    ...skipped.map(item=>({fileName:item.originalFileName||item.fileName,reason:reasons[item.reason]})),
    ...withinUpload.map(item=>({fileName:item.fileName,reason:`今回のアップロード内の同一PDF（先に追加: ${item.firstFileName}）`})),
  ];
}
