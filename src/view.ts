import { createAppStatus } from './ui/appStatus';
/** PDF原本はクリック時だけ取得する。Chrome内蔵PDFビューアには名前付きURLで渡す。 */
import { getRecord } from './storage/payrollStore';
import { receivePdfHandoff } from './pdf/handoff';
import {receiveYearEndPdf} from './pdf/yearEndHandoff';
import {asVerifiedPdfBlob,requirePdfMime} from './pdf/safePdf';
import {createTabLockCoordinator} from './cloud/tabLock';

const status = document.getElementById('pdf-status');
const appStatus=createAppStatus(status);
const reader = document.getElementById('pdf-reader') as HTMLIFrameElement | null;
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
  const params=new URLSearchParams(location.search);
  const yearEndId=params.get('yearend');
  if(yearEndId!==null){
   const ticket=new URLSearchParams((location.hash??'').slice(1)).get('handoff')??'';
   if(!ticket)throw new Error('年末調整画面からPDFを開いてください。');
    const payload=await receiveYearEndPdf(yearEndId,ticket);
    requirePdfMime(payload.pdf);
    const verifiedPdf=await asVerifiedPdfBlob(payload.pdf);
    assertUnlocked(startEpoch);
   const clean=new URL(location.href);clean.hash='';window.history.replaceState(window.history.state,'',clean.href);
   document.title=payload.fileName;reader.title=payload.fileName;
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
  const ticket = new URLSearchParams((location.hash ?? '').slice(1)).get('handoff');
  if (ticket) appStatus.loading('元のタブからPDFを受信しています…');
  const transferred = ticket ? await receivePdfHandoff(id,ticket,()=>{
    appStatus.loading('PDF原本を取得・検証しています…');
  }) : null;
  if (transferred) {
    // 閲覧用の一時的なチケットをブラウザの履歴に残さない。
    const clean = new URL(location.href);
    clean.hash = '';
    window.history.replaceState(window.history.state,'',clean.href);
  }
  const record = transferred ?? await getRecord(id);
  if (!record) throw new Error('このPDF原本は削除済みか、保存されていません。');

  // 外側のタブ名は常に保存済みファイル名を使用。
  assertUnlocked(startEpoch);
  document.title = record.fileName;
  reader.title = record.fileName;
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
