/*
 * Payroll PDF閲覧専用Service Worker。
 * PDF原本は外部送信しない。IndexedDBから指定の1件を取り出して、
 * 元ファイル名のURLおよびContent-Dispositionでブラウザ標準ビューアへ渡す。
 * 制御範囲はこの/view/フォルダのみ。
 */
'use strict';
const DB_NAME = 'payroll-local-v1';
const STORE = 'payroll-records';

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// src/storage/fileNaming.ts の safePdfFileName (デフォルト設定) と同じ仕様。
// SWはビルド時にpublic/からそのままコピーされるため、差異は回帰テストでも検出する。
function safePdfName(original) {
  const fallback = '給与明細';
  const cleaned = original.replace(/[\/\\\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  let stem = cleaned.replace(/\.pdf$/i, '').replace(/[. ]+$/g, '');
  if (!stem) stem = fallback;
  return `${stem}.pdf`;
}

function getRecord(id) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onupgradeneeded = () => {
      // 想定外の新規DBを作成しない。
      open.transaction.abort();
    };
    open.onerror = () => reject(open.error || new Error('IndexedDBを開けませんでした。'));
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        reject(new Error('給与明細が見つかりません。'));
        return;
      }
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('PDFを読み込めませんでした。'));
      tx.oncomplete = () => db.close();
      tx.onabort = () => db.close();
    };
  });
}

function errorResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function contentDisposition(name) {
  // HTTPヘッダーはASCIIを基本とし、日本語の元名はRFC 5987形式で指定する。
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="payroll.pdf"; filename*=UTF-8''${encoded}`;
}

async function servePdf(request, id, expectedName) {
  try {
    const record = await getRecord(id);
    if (!record || !record.pdf || typeof record.fileName !== 'string') {
      return errorResponse('保存済みPDFがありません。', 404);
    }
    const fileName = safePdfName(record.fileName);
    if (fileName !== expectedName) return errorResponse('ファイル名が変更されています。開き直してください。', 409);
    const blob = record.pdf;
    const size = blob.size;
    const headers = new Headers({
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(fileName),
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    const range = request.headers.get('Range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        return errorResponse('複数範囲の取得には対応していません。', 416);
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
        headers.set('Content-Range', `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(request.method === 'HEAD' ? null : blob.slice(start, end + 1, 'application/pdf'), {
        status: 206, headers,
      });
    }
    return new Response(request.method === 'HEAD' ? null : blob, { status: 200, headers });
  } catch (error) {
    return errorResponse('PDF原本を取得できませんでした。', 500);
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const url = new URL(request.url);
  const prefix = new URL('pdf/', self.registration.scope).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  const match = /^(\d+)\/([^/]+)$/.exec(url.pathname.slice(prefix.length));
  if (!match) return;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id < 1) {
    event.respondWith(errorResponse('不正な明細IDです。', 400));
    return;
  }
  let name;
  try { name = decodeURIComponent(match[2]); }
  catch { event.respondWith(errorResponse('ファイル名が不正です。', 400)); return; }
  event.respondWith(servePdf(request, id, name));
});
