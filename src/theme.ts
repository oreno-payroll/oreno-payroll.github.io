/** Payroll shared appearance control. The only persisted value is light/dark. */
(() => {
  'use strict';
  const key = 'payroll:theme';
  const root = document.documentElement;
  const read = (): 'light' | 'dark' => {
    try { return localStorage.getItem(key) === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  };
  const sync = (theme: 'light' | 'dark'): void => {
    const dark = theme === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0d1522' : '#f5f7fb');
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-label', dark ? 'ライトモードに切り替える' : 'ダークモードに切り替える');
      button.setAttribute('title', dark ? 'ライトモードに切り替える' : 'ダークモードに切り替える');
      button.setAttribute('aria-pressed', String(dark));
    });
  };
  sync(read()); // Runs in <head>, before CSS/first paint. No inline script or OS theme detection.
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-theme-toggle]') : null;
    if (!button) return;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    sync(next);
    try { localStorage.setItem(key, next); } catch { /* Storage blocked: current tab still works. */ }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) sync(read());
  });
  document.addEventListener('DOMContentLoaded', () => sync(root.dataset.theme === 'dark' ? 'dark' : 'light'));
})();
