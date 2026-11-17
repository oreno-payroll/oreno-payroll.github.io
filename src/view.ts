/** PDF原本はクリック時だけ取得する。Chrome内蔵PDFビューアには名前付きURLで渡す。 */
import { getRecord } from './storage/payrollStore';

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
  const record = await getRecord(id);
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
