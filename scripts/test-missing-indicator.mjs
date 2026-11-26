/** 未入力/0円の判別とダッシュボード表示の配置をチェックする。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setMissingIndicator } from '../src/ui/missingIndicator.ts';
import { summary } from '../src/forecast/summary.ts';

class FakeElement extends EventTarget {
  constructor(id = '', text = '') {
    super();
    this.id = id;
    this.textContent = text;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.title = '';
    this.attributes = new Map();
    this.classNames = new Set();
    this.classList = { toggle: (name, enabled) => {
      if (enabled) this.classNames.add(name);
      else this.classNames.delete(name);
    }};
  }
  append(child) {
    this.children.push(child);
    child.parentElement = this;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }
  querySelector(selector) {
    assert.equal(selector, '.partial-count');
    return this.children.find(child => child.className === 'partial-count') ?? null;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(item => item !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'title') this.title = ''; }
}
class FakeButton extends FakeElement {}
globalThis.HTMLButtonElement=FakeButton;
globalThis.document = { createElement: tag => tag==='button'?new FakeButton():new FakeElement() };
let cases = 0;
function check(name, test) { test(); console.log(`PASS ${++cases}: ${name}`); }
const makeRow = (amount='0円') => {
  const row = new FakeElement();
  const label = new FakeElement('', '所得税');
  const value = new FakeElement('total-income-tax', amount);
  row.append(label);
  row.append(value);
  return {row,label,value};
};

check('0円が入力済みなら、欠損注記なしで0円を維持', () => {
  const result = summary([{ form: {kind:'salary', incomeTax:'0', gross:'0', net:'0'} }]);
  assert.equal(result.observed.incomeTax, true);
  assert.equal(result.missingCounts.incomeTax, 0);
  const {label,value} = makeRow('0円');
  setMissingIndicator(value,result.missingCounts.incomeTax,1);
  assert.equal(value.textContent,'0円');
  assert.equal(label.children.length,0);
});
check('空欄は0円とみなさず、計算不能は--を維持', () => {
  const result = summary([{form:{kind:'salary',incomeTax:'',gross:'0',net:'0'}}]);
  assert.equal(result.observed.incomeTax,false);
  assert.equal(result.missingCounts.incomeTax,1);
  const {label,value} = makeRow('--');
  setMissingIndicator(value,1,1);
  assert.equal(value.textContent,'--');
  assert.equal(label.children[0].textContent,'未入力 1/1件');
  assert.match(value.title,/計算できる値がありません/);
});
check('一部未入力でも数字は単独表示し、未入力件数をラベル直下へ置く', () => {
  const {row,label,value} = makeRow('28,000円');
  setMissingIndicator(value,2,12);
  assert.equal(value.textContent,'28,000円');
  assert.equal(value.children.length,0);
  assert.equal(label.querySelector('.partial-count').textContent,'未入力 2/12件');
  assert.ok(row.classNames.has('has-missing-data'));
  assert.match(value.attributes.get('aria-label'),/12件中2件/);
});
check('年度切り替えでも注記が重複せず、欠損が消えれば注記とaria-labelも消える', () => {
  const {row,label,value} = makeRow('8,000円');
  setMissingIndicator(value,2,12);
  setMissingIndicator(value,1,6);
  assert.equal(label.children.length,1);
  assert.equal(label.children[0].textContent,'未入力 1/6件');
  setMissingIndicator(value,0,6);
  assert.equal(label.children.length,0);
  assert.equal(value.attributes.has('aria-label'),false);
  assert.ok(!row.classNames.has('has-missing-data'));
});
check('ラベルを持たない数値欄は表示構造の異常として検出', () => {
  assert.throws(() => setMissingIndicator(new FakeElement('unattached','0円'),1,2),/配置先が見つかりません/);
});
check('CSS上も金額の横ではなくラベルの下に配置', () => {
  const css = readFileSync(new URL('../public/styles/dashboard.css',import.meta.url),'utf8');
  assert.match(css,/\.partial-count\s*\{\s*display:\s*block/);
  assert.match(css,/\.details-list > div\.has-missing-data/);
  const main = readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(main,/setMissingIndicator\(element,/);
  assert.match(main,/setMissingIndicator\(days,/);
  assert.doesNotMatch(main,/\$\{result\.partial\[key\] \? ' ※'/);
});
check('クリック対象は件数だけであり、見込み不足は実績未入力と分ける',()=>{
  const {label,value}=makeRow('100円');let clicked;
  setMissingIndicator(value,3,10,button=>{clicked=button;},1);
  const button=label.children[0];
  assert.ok(button instanceof FakeButton);assert.equal(button.type,'button');
  assert.equal(button.textContent,'未入力 2件・見込み不足 1件');
  assert.equal(button.attributes.get('aria-haspopup'),'dialog');
  button.dispatchEvent(new Event('click'));assert.equal(clicked,button);
  setMissingIndicator(value,0,10,()=>{});assert.equal(label.children.length,0);
});
console.log(`OK: 未入力注記レイアウトと0円判別 ${cases}件`);
