/** Non-sensitive labels for already-existing Payroll operations. No I/O or storage. */
export type DashboardFreshness='checking'|'rechecking'|'snapshot'|'verified'|'stale'|'unavailable';
export function dashboardFreshnessLabel(state:DashboardFreshness):string {
 switch(state){
  case 'checking':return 'OneDrive確認中';
  case 'rechecking':return '再確認中・前回の表示を維持';
  case 'snapshot':return '有効期限内の暗号化スナップショット（表示専用）';
  case 'verified':return 'OneDrive確認済み';
  case 'stale':return '確認失敗・前回の表示（変更操作は停止）';
  case 'unavailable':return '確認失敗・データは未表示';
 }
}
export type PayrollSavePhase=0|1|2|3|4;
export interface PayrollSaveFeedback {phase:PayrollSavePhase;title:string;count:string;percent:number|null}
/**
 * Map actual Vault progress signals to stable UI stages. Never infer an overall
 * completion percentage from a PDF upload percentage or a committed shard count.
 */
export function describePayrollSaveProgress(message:string):PayrollSaveFeedback {
 const counts=/(\d+)\s*\/\s*(\d+)\s*件/.exec(message);
 const count=counts&&Number(counts[2])>0&&Number(counts[1])<=Number(counts[2])
  ? `${counts[1]} / ${counts[2]}件 · `:'';
 const percentMatch=/暗号化PDFの送信\s+(\d{1,3})%/.exec(message);
 const percent=percentMatch&&Number(percentMatch[1])<=100?Number(percentMatch[1]):null;
 if(/OneDrive保存・読み戻し検証がすべて完了|クラウドへ保存しました/.test(message))
  return {phase:4,title:'保存・検証完了',count,percent:null};
 if(/収入データを.*同期|Finance.*同期|収入ファイル/.test(message))
  return {phase:3,title:'Finance収入連携を確認中',count,percent:null};
 if(/年度の解析データ|年度別データ|解析済み明細|解析済み給与データ|競合を確認|年度データ/.test(message))
  return {phase:2,title:'年度データを保存・検証中',count,percent:null};
 if(/原本PDF|暗号化PDF|PDF\s+\d+\s*\/\s*\d+件/.test(message))
  return {phase:1,title:'PDF原本を暗号化・照合中',count,percent};
 return {phase:0,title:'接続・重複・保存条件を確認中',count,percent:null};
}
