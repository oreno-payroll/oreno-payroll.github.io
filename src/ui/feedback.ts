/** 画面ごとに分岐しない、インラインエラーの表示・解除。 */
export function showInlineError(element: HTMLElement, message: string): void {
  element.textContent = message;
  element.hidden = false;
  element.setAttribute('role', 'alert');
}
export function clearInlineError(element: HTMLElement): void {
  element.textContent = '';
  element.hidden = true;
  element.removeAttribute('role');
}
