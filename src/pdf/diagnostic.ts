/**
 * PDF解析の調査専用ユーティリティ。
 * - PDFの文字と座標を、元の値のままブラウザ内で抽出する。
 * - 氏名・会社名・金額などは一切自動マスクしない。
 * - 出力をチャット等で共有するときは、利用者が内容を確認して手動で伏せる。
 * - PDFや抽出結果をネットワーク・IndexedDB・localStorageへ送信/保存しない。
 */
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;

const MAX_PAGES = 3;
const MAX_ITEMS = 2000;
const MAX_OUTPUT_CHARACTERS = 200000;

interface DiagnosticItem {
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function itemLine(item: DiagnosticItem): string {
  // JSON.stringifyで改行・タブ・引用符などを安全に表示する。元の値は書き換えない。
  return `[${String(item.index).padStart(3, "0")}] x=${item.x.toFixed(1)} y=${item.y.toFixed(1)} w=${item.width.toFixed(1)} h=${item.height.toFixed(1)}  ${JSON.stringify(item.text)}`;
}

export interface CoordinateDiagnostic {
  raw: string;
  pageCount: number;
  itemCount: number;
}

export async function createCoordinateDiagnostic(file: File): Promise<CoordinateDiagnostic> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({
    data: bytes,
    cMapUrl: new URL("./cmaps/", import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("./standard_fonts/", import.meta.url).href,
    wasmUrl: new URL("./wasm/", import.meta.url).href,
    iccUrl: new URL("./iccs/", import.meta.url).href,
  });

  try {
    const pdf = await task.promise;
    const pagesToRead = Math.min(pdf.numPages, MAX_PAGES);
    const lines = [
      "Payroll PDF診断（元テキスト・座標／自動マスクなし）",
      "※個人情報・給与金額を含む可能性があります。共有前に必ず手動で編集してください。",
      `ページ数: ${pdf.numPages} / 調査ページ数: ${pagesToRead}`,
      "PDF.js getTextContent() の取得順で列挙。x/y はPDF座標（PDF内部のページ座標系）。",
      "",
    ];
    let count = 0;
    let truncated = false;

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageLines: string[] = [];
      for (let index = 0; index < content.items.length; index++) {
        const item = content.items[index];
        if (!("str" in item) || !item.str.trim()) continue;
        if (count >= MAX_ITEMS) {
          truncated = true;
          break;
        }
        const x = item.transform[4];
        const y = item.transform[5];
        pageLines.push(itemLine({
          index,
          text: item.str,
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          width: item.width,
          height: item.height,
        }));
        count++;
      }
      lines.push(`===== ${pageNumber}ページ =====`, ...pageLines, "");
      if (truncated) break;
    }

    if (pagesToRead < pdf.numPages || truncated) {
      lines.push(`※長いPDFのため一部のみ表示（最大${MAX_PAGES}ページ・${MAX_ITEMS}項目）。`);
    }
    const result = lines.join("\n");
    return {
      raw: result.length > MAX_OUTPUT_CHARACTERS
        ? result.slice(0, MAX_OUTPUT_CHARACTERS) + "\n※文字数の上限により省略しました。"
        : result,
      pageCount: pdf.numPages,
      itemCount: count,
    };
  } finally {
    await task.destroy();
  }
}
