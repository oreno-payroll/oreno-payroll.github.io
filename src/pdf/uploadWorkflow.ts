/** PDF取り込み画面の純粋な状態判定。IndexedDBやUIに依存しない。 */
export interface HashedEntry { id: number; hash?: string }
/** 先に追加されたファイルを優先し、後続の同一PDFだけを重複扱いにする。 */
export function duplicateOwners<T extends HashedEntry>(items: readonly T[]): Map<number, number> {
  const seen = new Map<string, number>();
  const duplicates = new Map<number, number>();
  for (const item of items) {
    if (!item.hash) continue;
    const first = seen.get(item.hash);
    if (first === undefined) seen.set(item.hash, item.id);
    else duplicates.set(item.id, first);
  }
  return duplicates;
}
/** PDF.jsの例外名とメッセージを分類。原本の内容をエラー表示へ転写しない。 */
export function pdfFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const raw = error instanceof Error ? error.message : String(error);
  if (/PasswordException|password/i.test(name + ' ' + raw)) return 'パスワード付きPDFです。解除したPDFを追加してください。';
  if (/^PDFのページ数が上限|^PDFの文字情報が上限/u.test(raw)) return raw;
  if (/InvalidPDFException|FormatError|invalid PDF|bad XRef|corrupt|破損/i.test(name + ' ' + raw))
    return 'PDFの内部構造が破損している可能性があります。原本を再取得してください。';
  if (/MissingPDFException|missing PDF|not found/i.test(name + ' ' + raw))
    return 'PDFを読み込めませんでした。ファイルを選び直してください。';
  if (/UnexpectedResponseException|network|fetch/i.test(name + ' ' + raw))
    return 'PDF関連リソースを取得できませんでした。ネットワークと配信ファイルを確認してください。';
  return 'PDF形式が未対応か、テキストの解析に失敗しました。原本を確認してください。';
}
/** 診断文に原本のファイル名を含めても表示が壊れないよう、切り詰める。 */
export function shortFileName(name: string, limit = 52): string {
  return name.length > limit ? `${name.slice(0, limit - 1)}…` : name;
}
