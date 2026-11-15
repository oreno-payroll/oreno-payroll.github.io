/** PDF原本はクリック時だけ取得する。Chrome内蔵PDFビューアには名前付きURLで渡す。 */
import { getRecord } from './storage/payrollStore';
import { safePdfFileName } from './storage/fileNaming';

const status = document.getElementById('pdf-status');
const reader = document.getElementById('pdf-reader') as HTMLIFrameElement | null;
let fallbackUrl: string | undefined;

window.addEventListener('pagehide', () => {
  if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
});

/** 閲覧URLのPDF名は、ほかの出力経路と同じ共通ルールで整える。 */
const safePdfName = safePdfFileName;

/**
 * blob: URLをiframeに渡すとChrome内蔵PDFビューアはUUIDをファイル名として表示する。
 * Service Workerで /view/pdf/<id>/<元ファイル名>.pdf という同一オリジンURLを
 * IndexedDBのPDF原本から提供し、ブラウザ標準のPDF操作を残したまま名前を復元する。
 */
async function namedPdfUrl(id: number, fileName: string): Promise<string | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  const script = new URL('./pdf-sw.js', location.href);
  try {
    await navigator.serviceWorker.register(script.href, { scope: './' });
    // 初回インストール時はclients.claim()によるcontrollerchangeを待つ。
    const controlledByViewer = () => navigator.serviceWorker.controller?.scriptURL === script.href;
    if (!controlledByViewer()) {
      const controlled = await new Promise<boolean>(resolve => {
        let finished = false;
        const complete = (ok: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener('controllerchange', onChange);
          resolve(ok);
        };
        const onChange = () => { if (controlledByViewer()) complete(true); };
        const timeout = window.setTimeout(() => complete(false), 6000);
        navigator.serviceWorker.addEventListener('controllerchange', onChange);
        onChange();
      });
      if (!controlled) return null;
    }
    return `./pdf/${id}/${encodeURIComponent(safePdfName(fileName))}`;
  } catch (error) {
    console.warn('名前付きPDF表示を利用できません。標準表示に切り替えます。', error);
    return null;
  }
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
  const namedUrl = await namedPdfUrl(id, record.fileName);
  if (namedUrl) {
    reader.src = namedUrl;
  } else {
    // Service Worker非対応の環境でもPDF閲覧自体は従来どおり利用できる。
    fallbackUrl = URL.createObjectURL(record.pdf);
    reader.src = fallbackUrl;
  }
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
