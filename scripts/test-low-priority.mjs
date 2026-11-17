/** 低優先度: 原本名の安全な統一と診断の共有用マスクを検証する。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safePdfFileName, storedPdfName } from '../src/storage/fileNaming.ts';
import { redactCoordinateDiagnostic } from '../src/pdf/redactDiagnostic.ts';
let count = 0;
const check = (name, callback) => { callback(); console.log(`PASS ${++count}: ${name}`); };
check('本業は保存時の原本名を変更しない', () => assert.equal(storedPdfName('main','salary','2026-11-27','Original.pdf'),'Original.pdf'));
check('副業は支給年月の保存名を維持', () => assert.equal(storedPdfName('side','bonus','2026-11-27','Original.pdf'),'202611_賞与明細.pdf'));
check('既存のPDF名をそのまま扱える', () => assert.equal(safePdfFileName('明細_2026.pdf'),'明細_2026.pdf'));
check('OSで使用できない区切り文字を置換', () => assert.equal(safePdfFileName('../日本語\\給与.pdf'),'.._日本語_給与.pdf'));
check('拡張子の大文字と拡張子なしを正規化', () => { assert.equal(safePdfFileName('A.PDF'),'A.pdf');assert.equal(safePdfFileName('A'),'A.pdf'); });
check('危険な制御文字や予約文字を除去', () => assert.equal(safePdfFileName('a\u0000:b?c.pdf'),'a__b_c.pdf'));
check('空の元名は安全なPDF名へ', () => { assert.equal(safePdfFileName('..'),'給与明細.pdf');assert.equal(safePdfFileName(' .pdf '),'給与明細.pdf'); });
check('ZIP用の従来フォールバックと文字数上限', () => {
  assert.equal(safePdfFileName('',{fallbackStem:'statement',maxStemLength:100}),'statement.pdf');
  assert.equal(safePdfFileName('x'.repeat(120),{fallbackStem:'statement',maxStemLength:100}),'x'.repeat(100)+'.pdf');
});
const dummyPhone = ['090', '1234', '5678'].join('-');
const dummyEmail = ['x', 'y.jp'].join(String.fromCharCode(64));
const raw = [
  'Payroll PDF診断（元テキスト・座標／自動マスクなし）',
  'ページ数: 1 / 調査ページ数: 1',
  '===== 1ページ =====',
  '[001] x=100.0 y=200.0 w=80.0 h=9.0  "氏名 田中太郎"',
  `[002] x=-13.4 y=72.1 w=120.0 h=10.0  "¥500000 ${dummyPhone}"`,
  '秘密情報：おーぷん',
].join('\n');
const masked = redactCoordinateDiagnostic(raw);
check('共有用はPDF座標を維持', () => { assert.match(masked,/x=100\.0 y=200\.0 w=80\.0 h=9\.0/);assert.match(masked,/x=-13\.4/); });
check('共有用は生の個人情報と自由記述を出力しない', () => {
  for(const word of ['田中太郎','500000','090-1234','おーぷん','氏名']) assert.ok(!masked.includes(word),word);
});
check('JSONエスケープを含む文字も一括マスクする', () => {
  const text=redactCoordinateDiagnostic('[101] x=1.0 y=2.0 w=3.0 h=4.0  '+JSON.stringify(`\"太郎\nメール ${dummyEmail}`));
  assert.ok(!text.includes('太郎') && !text.includes(dummyEmail));
});
check('偽装した診断行や説明欄は共有用に転載しない', () => {
  const text=redactCoordinateDiagnostic('[007] x=1 y=2 w=3 h=4  not-JSON\nプライベート');
  assert.ok(!text.includes('not-JSON') && !text.includes('プライベート'));
});
const read=(rel)=>readFileSync(new URL(`../${rel}`,import.meta.url),'utf8');
check('閲覧・一件ダウンロード・ZIPが同じ共通命名ルールを利用', () => {
  for (const rel of ['src/main.ts','src/edit.ts','src/export/sidePdfs.ts']) assert.match(read(rel),/safePdfFileName/);
  assert.match(read('src/view.ts'),/removeLegacyWorker/);
});
check('診断を生データとして確認でき、共有用マスクは任意の別操作', () => {
  assert.match(read('src/upload.ts'),/redactCoordinateDiagnostic/);
  assert.match(read('public/upload/index.html'),/id="diagnostic-redact"/);
  assert.match(read('src/pdf/diagnostic.ts'),/createCoordinateDiagnostic/);
});
check('低画面・小画面のスクロール対策が存在', () => {
  assert.match(read('public/styles/upload.css'),/max-height: 620px/);
  assert.match(read('public/styles/dashboard.css'),/max-width: 480px/);
  assert.match(read('public/styles/vault.css'),/max-width: 480px/);
});
console.log(`OK: 低優先度回帰テスト ${count}件`);
