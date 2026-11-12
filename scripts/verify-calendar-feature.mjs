/** 暦年切り替えがソースとビルド成果物の両方へ反映されたか、読み取り専用で検査。 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => {
  const p = path.join(root, file);
  if (!existsSync(p)) throw new Error(`必要なファイルがありません: ${file}`);
  return readFileSync(p, 'utf8');
};
const checks = [
  ['public/index.html', ['id="mode-fiscal"', 'id="mode-calendar"', 'id="forecast-toggle-label"', 'id="fiscal-year"']],
  ['src/main.ts', ['calculateCalendarForecast', 'calendarYearOfPaymentDate', '12月まで見込み', 'editPeriodQuery()']],
  ['src/edit.ts', ['originMode', 'originYear', 'mode=${originMode}']],
  ['src/forecast/calendarForecast.ts', ['calculateCalendarForecast', 'paymentDate', 'latest + 1']],
  ['dist/index.html', ['id="mode-fiscal"', 'id="mode-calendar"', 'id="forecast-toggle-label"']],
  ['dist/main.js', ['calculateCalendarForecast', '12月まで見込み', 'calendar']],
  ['dist/edit.js', ['mode=', 'calendar']],
  ['dist/styles/dashboard.css', ['period-switcher__option']],
];
let failures = 0;
for (const [file, markers] of checks) {
  try {
    const content = read(file);
    const missing = markers.filter(marker => !content.includes(marker));
    if (missing.length) throw new Error(`期待する記述がありません: ${missing.join(', ')}`);
    console.log(`OK ${file}`);
  } catch (error) {
    failures++;
    console.error(`NG ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failures) {
  console.error(`NG: ${failures}ファイルで反映を確認できません。npm run buildとZIPの展開場所を確認してください。`);
  process.exitCode = 1;
} else {
  console.log('OK: 暦年集計・12月見込み・編集からの復帰が src/dist の両方に反映されています。');
}
