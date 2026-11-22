/** Current calendar-year feature smoke check after build. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=f=>readFileSync(path.join(root,f),'utf8');
for(const file of ['public/index.html','dist/index.html']){
 const data=read(file);
 for(const id of ['mode-fiscal','mode-calendar','fiscal-year'])assert.ok(data.includes(`id="${id}"`),`${file}: ${id}`);
}
const calculation=read('src/forecast/calendarForecast.ts');
assert.match(calculation,/Math\.max\(start, latest \+ 1, todayMonth\)/,'past missing salary months must never be forecast');
const main=read('src/main.ts');
assert.match(main,/calculateCalendarForecast/);
assert.match(main,/過去月の未登録給与は補完しません/);
// esbuild の ASCII 文字列エスケープも同じ意味の文字列として検証する。
const mainJs = read('dist/main.js');
const decodedMainJs = mainJs.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
assert.ok(decodedMainJs.includes('12月までの見込み計算根拠'), 'ビルド済みの暦年見込み見出しが見つかりません');
console.log('PASS: fiscal/calendar switch and current-month forecasting are built');
