/** One-time, tab-local outcome handoff. Never store arbitrary messages or statement fields. */
export type NavigationNotice =
 | {operation:'upload-saved';count:number}
 | {operation:'edit-saved'|'delete-saved'|'edit-income-partial'|'edit-cleanup-partial'|'edit-year-partial'|'delete-income-partial'|'delete-original-partial'};
export type NavigationFeedback = {kind:'success'|'partial';message:string};
const KEY='payroll-navigation-notice-v1';
const TTL=120_000;
function valid(value:unknown):value is NavigationNotice {
 if(!value||typeof value!=='object')return false;
 const item=value as Record<string,unknown>;
 if(item.operation==='upload-saved')return Object.keys(item).length===2&&typeof item.count==='number'&&Number.isSafeInteger(item.count)&&item.count>=1&&item.count<=30;
 return Object.keys(item).length===1&&['edit-saved','delete-saved','edit-income-partial','edit-cleanup-partial','edit-year-partial','delete-income-partial','delete-original-partial'].some(op=>item.operation===op);
}
export function clearNavigationNotice():void {try{sessionStorage.removeItem(KEY);}catch{}}
export function rememberNavigationNotice(notice:NavigationNotice,epoch:string):void {
 clearNavigationNotice();
 if(!valid(notice))return;
 try{sessionStorage.setItem(KEY,JSON.stringify({notice,epoch,created:Date.now()}));}catch{/* Navigation still works when storage is unavailable. */}
}
export function takeNavigationNotice(epoch:string):NavigationNotice|null {
 try{
  const raw=sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY); // consume before parsing, including malformed entries
  if(!raw||raw.length>512)return null;
  const value=JSON.parse(raw) as {notice:unknown;epoch:unknown;created:unknown};
  if(!value||value.epoch!==epoch||typeof value.created!=='number'||!Number.isFinite(value.created)||value.created>Date.now()||Date.now()-value.created>TTL||!valid(value.notice))return null;
  return value.notice;
 }catch{return null;}
}
export function navigationFeedback(notice:NavigationNotice):NavigationFeedback {
 switch(notice.operation){
  case 'upload-saved':return {kind:'success',message:`明細${notice.count}件を保存しました。Finance連携データも更新済みです。`};
  case 'edit-saved':return {kind:'success',message:'明細の変更を保存しました。Finance連携データも更新済みです。'};
  case 'delete-saved':return {kind:'success',message:'明細を削除しました。Finance連携を確認しました。暗号化PDF原本は保全しています。'};
  case 'edit-income-partial':return {kind:'partial',message:'明細の変更は保存済みです。設定画面からFinance連携を更新してください。'};
  case 'edit-cleanup-partial':return {kind:'partial',message:'明細の変更は保存済みですが、重複明細の整理は未完了です。最新データを確認してください。'};
  case 'edit-year-partial':return {kind:'partial',message:'明細の変更は移動先年度に保存済みですが、移動元年度の整理は未完了の可能性があります。最新データを確認してください。'};
  case 'delete-income-partial':return {kind:'partial',message:'明細の削除は完了しました。再削除は不要です。設定画面からFinance連携を更新し、未参照PDF原本を確認してください。'};
  case 'delete-original-partial':return {kind:'partial',message:'明細削除・Finance連携は完了しました。PDF原本の整理は未確認です。設定の未参照PDF原本の管理とOneDriveのごみ箱を確認してください。'};
 }
}
