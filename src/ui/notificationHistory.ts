/** Tab-local operation feedback. No arbitrary message, identifier or exception is serialized. */
export const NOTICE_LABELS={
 general:'操作',home:'明細一覧',upload:'PDFの読み取り・登録',edit:'明細編集',view:'PDF原本の閲覧',yearEnd:'年末調整',settings:'設定',auth:'認証',
 'upload-saved':'明細の登録','edit-saved':'明細の変更','delete-saved':'明細の削除',
 'edit-income-partial':'明細の変更・Finance連携','edit-cleanup-partial':'明細の変更・重複整理','edit-year-partial':'明細の年度移動',
 'delete-income-partial':'明細削除・Finance連携','delete-original-partial':'明細削除・原本整理',
 'payroll-income-publish':'Finance連携の更新','employer-directory-load':'勤務先一覧の確認','employer-directory-save':'勤務先の保存','employer-bulk-save':'勤務先の一括設定',
 'export-button':'バックアップ作成','verify-button':'バックアップ検証','restore-button':'バックアップ復元','restore-add-inspect':'追加復元の確認','restore-add-button':'明細の追加復元',
 'change-passphrase-button':'パスフレーズ変更','cloud-cleanup-check':'旧暗号データ確認','cloud-cleanup-delete':'旧暗号データ整理','orphan-year-check':'年度データ検査','orphan-year-recover':'年度データ復旧',
 'detached-original-check':'未参照PDF検査','migrate-legacy-cloud':'旧データ移行','legacy-cleanup-check':'旧データ検査','legacy-cleanup-delete':'旧データ削除','backup-cloud-load':'明細取得',
 'ye-backup-export':'従業員バックアップ作成','ye-restore-verify':'従業員バックアップ検証','ye-restore-commit':'従業員データ復元','ye-restore-resume':'従業員データ復元再開',
 'ye-document-save':'年末調整明細の保存','ye-document-recovery':'年末調整明細の保存状態確認','ye-person-delete':'従業員データの削除','ye-person-rename':'従業員名の変更','ye-person-create':'従業員登録','ye-forecast-save':'年末調整見込みの保存','ye-memo-save':'年別メモの保存',
 'pdf-download':'PDFダウンロード','pdf-zip':'PDFのZIP作成','upload-recovery':'明細保存状態の確認',
} as const;
export type NoticeCode=keyof typeof NOTICE_LABELS;
export type ResultKind='success'|'warning'|'partial'|'error';
export interface NoticeEntry {code:NoticeCode;kind:ResultKind;at:number;seen:boolean}
export const NOTICE_HISTORY_KEY='payroll-notification-history-v1';
const AUTH='payroll-navigation-identity-epoch-v1',LOCK='payroll-global-vault-lock-epoch-v1';
const LIMIT=200,MAX_BYTES=40_000;
const kinds:readonly ResultKind[]=['success','warning','partial','error'];
const validEpoch=(value:unknown):value is string=>typeof value==='string'&&(value===''||/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value));
export function noticeCode(value:unknown):NoticeCode{return typeof value==='string'&&Object.hasOwn(NOTICE_LABELS,value)?value as NoticeCode:'general';}
type Boundary={auth:string;lock:string};
function boundary():Boundary|null{try{const auth=sessionStorage.getItem(AUTH)??'',lock=localStorage.getItem(LOCK)??'';return validEpoch(auth)&&validEpoch(lock)?{auth,lock}:null;}catch{return null;}}
const equal=(a:Boundary|null,b:Boundary|null)=>a?.auth===b?.auth&&a?.lock===b?.lock;
let entries:NoticeEntry[]=[],omitted=0,active=false,blocked=false,suspended=false,generation=0;
let bound:Boundary|null=null,guard:(()=>boolean)|undefined,persisted=false;
const listeners=new Set<()=>void>(),resets=new Set<()=>void>();
function emit(){for(const fn of listeners){try{fn();}catch{/* feedback must not change an operation result */}}}
function resetViews(){for(const fn of resets){try{fn();}catch{}}}
function drop(){persisted=false;try{sessionStorage.removeItem(NOTICE_HISTORY_KEY);}catch{}}
function persist(){if(!active||!bound||blocked||suspended)return;try{sessionStorage.setItem(NOTICE_HISTORY_KEY,JSON.stringify({v:1,...bound,omitted,entries}));persisted=true;}catch{drop();}}
function validEntry(x:unknown):x is NoticeEntry{
 if(!x||typeof x!=='object'||Array.isArray(x))return false;
 const v=x as NoticeEntry;
 return Object.keys(v).length===4&&typeof v.code==='string'&&Object.hasOwn(NOTICE_LABELS,v.code)&&kinds.includes(v.kind)&&Number.isSafeInteger(v.at)&&v.at>0&&v.at<=Date.now()&&typeof v.seen==='boolean'&&(v.kind!=='success'||v.seen);
}
function restore():boolean{
 if(!bound)return false;
 try{
  const raw=sessionStorage.getItem(NOTICE_HISTORY_KEY);if(!raw)return false;
  if(raw.length>MAX_BYTES)throw Error();
  const value=JSON.parse(raw);
  if(!value||Object.keys(value).length!==5||value.v!==1||!equal(value,bound)||!Number.isSafeInteger(value.omitted)||value.omitted<0||!Array.isArray(value.entries)||value.entries.length>LIMIT||!value.entries.every(validEntry))throw Error();
  entries=value.entries.sort((a:NoticeEntry,b:NoticeEntry)=>b.at-a.at);omitted=value.omitted;persisted=true;return true;
 }catch{drop();return false;}
}
function trim(){while(entries.length>LIMIT){let confirmed=entries.length-1;while(confirmed>=0&&!entries[confirmed].seen)confirmed--;entries.splice(confirmed<0?entries.length-1:confirmed,1);omitted=Math.min(Number.MAX_SAFE_INTEGER,omitted+1);}}
/** Called only after the existing vault/authentication path has succeeded. */
export function activateNotificationHistory(authorized:()=>boolean):void{
 if(active&&notificationAllowed())return;
 try{if(!authorized())return;}catch{return;}
 // Only a freshly verified vault can re-enable recording after invalidation.
 blocked=false;
 const previous=entries;bound=boundary();guard=authorized;active=true;
 // An auxiliary window must not inherit its opener's sessionStorage snapshot.
 if(typeof window!=='undefined'&&window.opener)drop();
 if(restore()){entries=[...previous,...entries];trim();}
 persist();emit();
}
export function resetNotificationHistory():void{
 blocked=true;active=false;generation++;entries=[];omitted=0;bound=null;guard=undefined;drop();
 resetViews();emit();
}
export function notificationAllowed():boolean{
 if(blocked||suspended)return false;
 if(active){
  let valid=false;try{valid=equal(bound,boundary())&&!!guard?.();}catch{}
  if(!valid){if(!blocked)resetNotificationHistory();return false;}
 }
 return true;
}
export function notificationGeneration():number{return generation;}
export function subscribeNotificationReset(fn:()=>void):void{resets.add(fn);}
export function subscribeNotificationHistory(fn:()=>void):void{listeners.add(fn);}
export function recordNotification(code:NoticeCode,kind:ResultKind):void{
 if(!notificationAllowed()||!kinds.includes(kind))return;
 entries.unshift({code:noticeCode(code),kind,at:Date.now(),seen:kind==='success'});trim();persist();emit();
}
export function notificationHistory(){
 const allowed=notificationAllowed();return {entries:allowed?entries.map(x=>({...x})):[],omitted:allowed?omitted:0};
}
export function confirmNotificationHistory():void{
 if(!notificationAllowed())return;entries=entries.map(x=>({...x,seen:true}));persist();emit();
}
export function noticeSummary(entry:NoticeEntry):string{
 return NOTICE_LABELS[entry.code]+({success:'が完了しました。',warning:'に確認が必要です。',partial:'は一部完了しました。必要な確認を行ってください。',error:'が完了しませんでした。状態を確認してください。'}[entry.kind]);
}
if(typeof window!=='undefined'){
 window.addEventListener('storage',event=>{if(event.key===null)resetNotificationHistory();else if(event.key===LOCK)notificationAllowed();});
 window.addEventListener('focus',()=>{notificationAllowed();});
 window.addEventListener('pagehide',()=>{suspended=true;generation++;resetViews();emit();});
 window.addEventListener('pageshow',event=>{
  suspended=false;if(event.persisted&&notificationAllowed()&&active&&bound&&persisted){entries=[];omitted=0;restore();}emit();
 });
}
