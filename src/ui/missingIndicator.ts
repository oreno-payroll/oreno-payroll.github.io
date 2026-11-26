/** 集計額と欠損状態を分けて描画する。金額文字列や給与データには触れない。 */
export function setMissingIndicator(valueElement: HTMLElement, missing: number, total: number, onOpen?: (trigger: HTMLButtonElement) => void, forecastMissing = 0): void {
  // ダッシュボードの全金額欄は、直前の兄弟要素が項目ラベルとなる。
  const label = valueElement.previousElementSibling;
  if (!label) throw new Error(`未入力表示の配置先が見つかりません: ${valueElement.id}`);
  label.querySelector('.partial-count')?.remove();
  const hasMissing = total > 0 && missing > 0;
  label.parentElement?.classList.toggle('has-missing-data', hasMissing);
  if (!hasMissing) {
    valueElement.removeAttribute('title');
    valueElement.removeAttribute('aria-label');
    return;
  }
  const note = document.createElement(onOpen ? 'button' : 'small');
  if (onOpen && note instanceof HTMLButtonElement) {
    note.type = 'button';
    note.setAttribute('aria-haspopup', 'dialog');
    note.addEventListener('click', () => onOpen(note));
  }
  note.className = 'partial-count';
  note.textContent = forecastMissing
    ? `未入力 ${missing - forecastMissing}件・見込み不足 ${forecastMissing}件`
    : `未入力 ${missing}/${total}件`;
  label.append(note);
  const amount = valueElement.textContent?.trim() ?? '';
  const description = forecastMissing ? `${total}件中、登録済み明細の未入力${missing - forecastMissing}件、見込みの算出不足${forecastMissing}件です。` : amount === '--'
    ? `${total}件中${missing}件が未入力です。計算できる値がありません。`
    : `${total}件中${missing}件が未入力です。表示値は入力済みの項目から集計しています。`;
  valueElement.title = description;
  valueElement.setAttribute('aria-label', `${amount}。${description}`);
}
