/** 本業賞与の最新月給方式がソースとビルドに入ったかを確認する。読み取り専用。 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const checks = [
  ['src/forecast/annualForecast.ts', ['latestBonusSalary', 'estimateMainBonus(month, [latestBonusSalary])', 'const latest = [...samples].sort']],
  ['src/forecast/calendarForecast.ts', ['latestBonusSalary', 'bonusCandidates.filter(month => !actualBonusMonths.has(month))']],
  ['src/main.ts', ['1回あたり額面', 'bonusSampleMonth', '最新の通常給与1件']],
  ['dist/main.js', ['1回あたり額面', 'bonusSampleMonth', 'latestBonusSalary']],
];
let fails = 0;
for (const [file, markers] of checks) {
  const absolute = path.join(root, file);
  const contents = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  const missed = markers.filter(marker => !contents.includes(marker));
  if (missed.length) { console.error(`NG ${file}: ${missed.join(', ')}`); fails++; }
  else console.log(`OK ${file}`);
}
if (fails) {
  console.error('NG: パッチ適用先またはnpm run buildの実行結果を確認してください。');
  process.exitCode = 1;
} else console.log('OK: 本業賞与見込みの最新通常給与方式を src/dist で確認しました。');
