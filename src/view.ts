import { createAppStatus } from './ui/appStatus';
/** PDF原本はクリック時だけ取得する。ファイル名を履歴・タブタイトルに渡さない。 */
import {readNavigationParams,replaceNavigationParams} from './ui/navigationParams';
import { getRecord } from './storage/payrollStore';
import { receivePdfHandoff } from './pdf/handoff';
import {receiveYearEndPdf} from './pdf/yearEndHandoff';
import {asVerifiedPdfBlob,requirePdfMime} from './pdf/safePdf';
import {createTabLockCoordinator} from './cloud/tabLock';

const status = document.getElementById('pdf-status');
const appStatus=createAppStatus(status);
const reader = document.getElementById('pdf-reader') as HTMLIFrameElement | null;
document.title='Payroll | PDF原本';
if(reader)reader.title='PDF原本';
let fallbackUrl: string | undefined;
let locked=false;
const locks=createTabLockCoordinator(()=>{
 locked=true;
 document.title='Payroll | PDF原本';
 if(reader){reader.hidden=true;reader.removeAttribute('src');reader.title='PDF原本';}
 if(fallbackUrl){URL.revokeObjectURL(fallbackUrl);fallbackUrl=undefined;}
 appStatus.error('保管庫がロックされました。このPDFは閉じてください。');
});
function assertUnlocked(start:string){
 if(locked||!locks.check()||locks.epoch()!==start)throw new Error('保管庫がロックされました。PDFを開き直してください。');
}


window.addEventListener('pagehide', () => {
  if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
});

/** 閲覧URLのPDF名は、ほかの出力経路と同じ共通ルールで整える。 */
// 旧閲覧Service WorkerはIndexedDBから読み込むため廃止。初回に登録解除する。
async function removeLegacyWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration(new URL('./', location.href).href);
  if (registration?.active?.scriptURL.endsWith('/pdf-sw.js')) await registration.unregister();
}

async function start(): Promise<void> {
  if (!status || !reader) throw new Error('PDF表示画面の構成に問題があります。');
  const startEpoch=locks.epoch();
  const keys=['id','yearend','handoff'] as const;
  const params=readNavigationParams(location,keys);
  const ticket=params.get('handoff');
  const ambiguous=keys.some(key=>params.getAll(key).length>1)||(params.has('id')&&params.has('yearend'));
  // Retain the selected ID, but remove a one-use ticket before any async work,
  // including failures. Old query links are converted after the initial request.
  params.delete('handoff');
  replaceNavigationParams(params,keys);
  if(ambiguous)throw new Error('PDF原本のIDが不正です。');
  const yearEndId=params.get('yearend');
  if(yearEndId!==null){
   if(!ticket)throw new Error('年末調整画面からPDFを開いてください。');
    const payload=await receiveYearEndPdf(yearEndId,ticket);
    requirePdfMime(payload.pdf);
    const verifiedPdf=await asVerifiedPdfBlob(payload.pdf);
    assertUnlocked(startEpoch);
   await removeLegacyWorker();assertUnlocked(startEpoch);
    fallbackUrl=URL.createObjectURL(verifiedPdf);
   reader.src=fallbackUrl;reader.hidden=false;
   appStatus.success('PDF原本を表示しました');
   return;
  }
  const raw = params.get('id') ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error('PDF原本のIDが不正です。');
  }
  // 通常のクリックでは、認証済みのホームタブから検証済みPDFのみを受け取る。
  // 直接URLを開いた場合やBroadcastChannel非対応時は、従来の認証経路へ戻る。
  if (ticket!==null && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(ticket))throw new Error('PDF閲覧チケットが不正です。');
  if (ticket) appStatus.loading('元のタブからPDFを受信しています…');
  const transferred = ticket ? await receivePdfHandoff(id,ticket,()=>{
    appStatus.loading('PDF原本を取得・検証しています…');
  }) : null;
  const record = transferred ?? await getRecord(id);
  if (!record) throw new Error('このPDF原本は削除済みか、保存されていません。');

  assertUnlocked(startEpoch);
  await removeLegacyWorker();
  assertUnlocked(startEpoch);
  const verifiedPdf=await asVerifiedPdfBlob(record.pdf);
  assertUnlocked(startEpoch);
  fallbackUrl = URL.createObjectURL(verifiedPdf);
  reader.src = fallbackUrl;
  reader.hidden = false;
  appStatus.success('PDFを表示しました');
}

appStatus.loading('PDF原本を取得しています…');
void start().catch(error => {
  if (status) {
    appStatus.error(`PDFを表示できませんでした：${error instanceof Error ? error.message : String(error)}`);
  }
});
