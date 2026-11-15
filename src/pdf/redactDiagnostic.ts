/**
 * 共有用の座標診断を生成する。原文の文字列は出力に一切載せない。
 * 座標と元の文字番号だけを保ち、会社名・氏名・金額・口座などを一括マスクする。
 * 文字列の一部だけをマスクする方式は、PDF内で分割された氏名等を漏らし得るため採用しない。
 */
const COORDINATE_ROW = /^(\[\d+\] x=-?\d+(?:\.\d+)? y=-?\d+(?:\.\d+)? w=-?\d+(?:\.\d+)? h=-?\d+(?:\.\d+)? {2})(.+)$/;
const PAGE_HEADER = /^===== (\d+)ページ =====$/;

export function redactCoordinateDiagnostic(raw: string): string {
  const output = [
    'Payroll PDF診断（共有用：原文はすべてマスク済み）',
    '※原本に含まれる文字情報はすべて伏せています。',
    'PDF.js getTextContent() の取得順。x/y はPDF座標。',
    '',
  ];
  for (const line of raw.split(/\r?\n/)) {
    const page = PAGE_HEADER.exec(line);
    if (page) {
      output.push(`===== ${page[1]}ページ =====`);
      continue;
    }
    const row = COORDINATE_ROW.exec(line);
    if (row && row[2].startsWith('"')) {
      output.push(`${row[1]}"[マスク済み]"`);
    }
  }
  return output.join('\n');
}
