/** PDF原本はクリック時だけ取得する。Chrome内蔵PDFビューアには名前付きURLで渡す。 */
import { getRecord } from './storage/payrollStore';
import { receivePdfHandoff } from './pdf/handoff';

const status = document.getElementById('pdf-status');
const reader = document.getElementById('pdf-reader') as HTMLIFrameElement | null;
let fallbackUrl: string | undefined;

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
  const raw = new URLSearchParams(location.search).get('id') ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error('PDF原本のIDが不正です。');
  }
  // 通常のクリックでは、認証済みのホームタブから検証済みPDFのみを受け取る。
  // 直接URLを開いた場合やBroadcastChannel非対応時は、従来の認証経路へ戻る。
  const ticket = new URLSearchParams((location.hash ?? '').slice(1)).get('handoff');
  if (ticket) status.textContent = '元のPayrollタブからPDFを受信しています…';
  const transferred = ticket ? await receivePdfHandoff(id,ticket,()=>{
    status.textContent = 'OneDriveからPDF原本を取得・検証しています…';
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
  document.title = record.fileName;
  reader.title = record.fileName;
  await removeLegacyWorker();
  fallbackUrl = URL.createObjectURL(record.pdf);
  reader.src = fallbackUrl;
  reader.hidden = false;
  status.hidden = true;
}

void start().catch(error => {
  if (status) {
    status.hidden = false;
    status.textContent = `PDFを表示できませんでした：${error instanceof Error ? error.message : String(error)}`;
    status.setAttribute('role', 'alert');
  }
});
