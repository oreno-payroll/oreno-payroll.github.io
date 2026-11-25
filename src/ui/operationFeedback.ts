/** Non-sensitive labels for already-existing Payroll operations. No I/O or storage. */
export type DashboardFreshness='checking'|'rechecking'|'snapshot'|'verified'|'stale'|'unavailable';
export function dashboardFreshnessLabel(state:DashboardFreshness):string {
 switch(state){
  case 'checking':return '読み込み中';
  case 'rechecking':return '最新データを確認中';
  case 'snapshot':return '前回のデータ（表示専用）';
  case 'verified':return '最新データ確認済み';
  case 'stale':return '更新失敗・前回のデータ（変更操作は停止）';
  case 'unavailable':return '読み込み失敗・データは未表示';
 }
}
export type PayrollSavePhase=0|1|2|3|4;
export interface PayrollSaveFeedback {phase:PayrollSavePhase;title:string;count:string;percent:number|null}
/** Progress originates at the actual operation boundary, not from UI text. */
export type PayrollSaveProgress=(event:PayrollSaveFeedback)=>void;
