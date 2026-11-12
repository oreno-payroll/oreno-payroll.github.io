/**
 * 給与明細PDFの座標付き文字から当月の値を抽出する。
 * ブラウザ内の純粋な関数。実際のPDFや個人情報はコードに含めない。
 * 対応書式: 本業・副業それぞれの給与明細および賞与明細。
 */
export interface PdfTextCell {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PayrollField =
  | "job" | "kind" | "targetMonth" | "paymentDate"
  | "gross" | "net" | "taxable" | "nonTaxable"
  | "transportation" | "reimbursedExpenses" | "workDays" | "incomeTax" | "residentTax"
  | "healthInsurance" | "careInsurance" | "childcareSupport" | "pension" | "employmentInsurance" | "otherDeductions"
  | "bonusBase" | "performanceBonus" | "yearEndAdjustment";

export interface MissingPdfField {
  /** 給与明細上で期待する欄の名称。 */
  label: string;
  /** フォーム上で対応する項目。控除合計など、フォームにない場合は省略。 */
  field?: PayrollField;
  /** ラベル自体が存在しない / ラベルはあるが値を抽出できない。 */
  reason: "absent" | "unreadable";
}

export interface PayrollParseResult {
  profile: "main" | "side" | null;
  fields: Partial<Record<PayrollField, string>>;
  warnings: string[];
  missingFields: MissingPdfField[];
}

type Region = { labelMinX: number; labelMaxX: number; valueMinX: number; valueMaxX: number; minY?: number; maxY?: number };
const MAIN_WORK: Region = { labelMinX: 25, labelMaxX: 145, valueMinX: 95, valueMaxX: 145, minY: 570, maxY: 645 };
const MAIN_PAY: Region = { labelMinX: 145, labelMaxX: 287, valueMinX: 235, valueMaxX: 286, minY: 450, maxY: 645 };
/** 交通費欄と立替経費欄が共存したら、別の支給内訳として保管する。 */
const MAIN_TRANSPORT_LABELS = ["通勤手当/非課", "非課税通勤費"] as const;
const MAIN_EXPENSE_LABELS = ["立替経費", "立替費用"] as const;
const MAIN_TAX: Region = { labelMinX: 287, labelMaxX: 425, valueMinX: 375, valueMaxX: 425, minY: 450, maxY: 645 };
const MAIN_NET: Region = { labelMinX: 423, labelMaxX: 568, valueMinX: 510, valueMaxX: 568, minY: 585, maxY: 650 };
const SIDE_PAY: Region = { labelMinX: 20, labelMaxX: 164, valueMinX: 127, valueMaxX: 163, minY: 520, maxY: 720 };
const SIDE_TAX: Region = { labelMinX: 160, labelMaxX: 298, valueMinX: 250, valueMaxX: 298, minY: 600, maxY: 720 };
const SIDE_WORK: Region = { labelMinX: 295, labelMaxX: 440, valueMinX: 400, valueMaxX: 440, minY: 660, maxY: 720 };
const MAIN_BONUS_PAY: Region = { labelMinX: 25, labelMaxX: 205, valueMinX: 160, valueMaxX: 206, minY: 450, maxY: 645 };
const MAIN_BONUS_TAX: Region = { labelMinX: 205, labelMaxX: 385, valueMinX: 340, valueMaxX: 385, minY: 450, maxY: 645 };
const MAIN_BONUS_NET: Region = { labelMinX: 385, labelMaxX: 570, valueMinX: 515, valueMaxX: 570, minY: 580, maxY: 645 };
const SIDE_NET: Region = { labelMinX: 295, labelMaxX: 440, valueMinX: 400, valueMaxX: 440, minY: 550, maxY: 640 };
/** 副業の年末調整還付は控除合計の外に別掲される（支給合計にも含まれない）。 */
const SIDE_REFUND: Region = { labelMinX: 20, labelMaxX: 164, valueMinX: 127, valueMaxX: 163, minY: 460, maxY: 510 };

function norm(text: string): string {
  return text.normalize("NFKC").replace(/[\s\u3000]/gu, "");
}

function inRange(cell: PdfTextCell, region: Region, role: "label" | "value"): boolean {
  const minX = role === "label" ? region.labelMinX : region.valueMinX;
  const maxX = role === "label" ? region.labelMaxX : region.valueMaxX;
  return cell.x >= minX && cell.x <= maxX
    && cell.y >= (region.minY ?? -Infinity) && cell.y <= (region.maxY ?? Infinity);
}

/** テキストと座標がほぼ同一の二重描画を排除する。 */
function deduplicate(items: PdfTextCell[]): PdfTextCell[] {
  // 座標を近傍バケットに分ける。大量文字をO(n²)で逐次照合しない。
  const byCell = new Map<string, PdfTextCell[]>();
  const kept: PdfTextCell[] = [];
  for (const item of items) {
    if (!item.text.trim()) continue;
    const text = norm(item.text);
    const bx = Math.floor(item.x / 0.85);
    const by = Math.floor(item.y / 0.6);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = byCell.get(`${item.page}|${text}|${bx + dx}|${by + dy}`);
        if (bucket?.some(previous => Math.abs(previous.x - item.x) <= 0.85 && Math.abs(previous.y - item.y) <= 0.6)) {
          duplicate = true; break;
        }
      }
    }
    if (duplicate) continue;
    kept.push(item);
    const key = `${item.page}|${text}|${bx}|${by}`;
    const bucket = byCell.get(key) ?? [];
    bucket.push(item);
    byCell.set(key, bucket);
  }
  return kept;
}

function asAmount(text: string): number | undefined {
  const s = norm(text).replace(/[￥¥円]/gu, "");
  if (!/^[+\-−△▲]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(s)) return undefined;
  const negative = /^[\-−△▲]/u.test(s);
  const value = Number(s.replace(/[+\-−△▲,]/gu, ""));
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? (negative ? -value : value) : undefined;
}

/** 書式・位置で限定したラベルと、右側の同一行にある数値の組を取得する。 */
function findAmount(
  items: PdfTextCell[],
  labels: readonly string[],
  region: Region,
  options: { startsWith?: boolean; yTolerance?: number } = {},
): number | undefined {
  const names = labels.map(norm);
  const candidates = items.filter(cell => inRange(cell, region, "label") && names.some(name =>
    options.startsWith ? norm(cell.text).startsWith(name) : norm(cell.text) === name));
  for (const label of candidates) {
    const matches = items.filter(value => value.page === label.page
      && inRange(value, region, "value")
      && value.x >= label.x + 10
      && Math.abs(value.y - label.y) <= (options.yTolerance ?? 3.0)
      && asAmount(value.text) !== undefined)
      .sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y)
        || Math.abs(a.x - (region.valueMaxX - 5)) - Math.abs(b.x - (region.valueMaxX - 5)));
    if (matches.length) return asAmount(matches[0].text);
  }
  return undefined;
}

function put(fields: PayrollParseResult["fields"], field: PayrollField, value: number | undefined): void {
  if (value !== undefined) fields[field] = String(value);
}

function dateFrom(text: string): string | undefined {
  const s = norm(text);
  const slash = s.match(/(20\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})/u);
  const japanese = s.match(/(20\d{2})(?:\([^)]*\))?年(\d{1,2})月(\d{1,2})日/u);
  const match = slash ?? japanese;
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthFrom(text: string): string | undefined {
  const match = norm(text).match(/(20\d{2})(?:\([^)]*\))?年(\d{1,2})月分/u);
  if (!match) return undefined;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${String(month).padStart(2, "0")}` : undefined;
}

function getDate(items: PdfTextCell[], label?: string): string | undefined {
  if (!label) return items.map(i => dateFrom(i.text)).find((d): d is string => Boolean(d));
  // 「支給日：YYYY年...」のような同一TextItemも扱う。
  const inSame = items.filter(i => norm(i.text).startsWith(label))
    .map(i => dateFrom(i.text)).find((d): d is string => Boolean(d));
  if (inSame) return inSame;
  const labels = items.filter(i => norm(i.text) === label);
  for (const l of labels) {
    const date = items.filter(i => i.page === l.page && i.x > l.x && Math.abs(i.y - l.y) <= 3)
      .sort((a, b) => a.x - b.x)
      .map(i => dateFrom(i.text)).find((d): d is string => Boolean(d));
    if (date) return date;
  }
  // 一部の賞与PDFは「支」「 給日：YYYY...」と分割される。
  // 支給日以外の数字を拾わないよう、給日: を含む断片に限定する。
  const fragments = items.filter(i => /^(?:給日|支給日)[:：]/u.test(norm(i.text)));
  const fragmented = fragments.map(i => dateFrom(i.text)).find((d): d is string => Boolean(d));
  return fragmented;
}

/** 検証済み帳票に存在するはずの欄を、未検出と読取失敗に分けて記録する。 */
interface ExpectedPdfField {
  label: string;
  names: readonly string[];
  region?: Region;
  field?: PayrollField;
  startsWith?: boolean;
}
function checkExpectedFields(
  result: PayrollParseResult,
  items: PdfTextCell[],
  expected: readonly ExpectedPdfField[],
  specialValues: Readonly<Record<string, number | undefined>> = {},
): void {
  for (const spec of expected) {
    const labelExists = items.some(item => {
      if (spec.region && !inRange(item, spec.region, "label")) return false;
      const content = norm(item.text);
      return spec.names.some(name => spec.startsWith
        ? content.startsWith(norm(name))
        : content === norm(name) || (spec.label === "支給日" && content.startsWith(norm(name))));
    });
    const valueExists = spec.field
      ? result.fields[spec.field] !== undefined
      : specialValues[spec.label] !== undefined;
    if (!labelExists || !valueExists) {
      result.missingFields.push({
        label: spec.label,
        ...(spec.field ? { field: spec.field } : {}),
        reason: labelExists ? "unreadable" : "absent",
      });
    }
  }
}

/** 制度追加や任意手当のように、「欄がなくても正常・あれば読めるべき」項目を検査。 */
function checkOptionalIfPresent(result: PayrollParseResult, items: PdfTextCell[], expected: readonly ExpectedPdfField[]): void {
  for (const spec of expected) {
    const present = items.some(item => (!spec.region || inRange(item, spec.region, "label"))
      && spec.names.some(name => norm(item.text) === norm(name)));
    if (present && spec.field && result.fields[spec.field] === undefined) {
      result.missingFields.push({ label: spec.label, field: spec.field, reason: "unreadable" });
    }
  }
}

function validate(result: PayrollParseResult, deductionTotal?: number, yearEndRefundOutsideDeductions = false): void {
  const f = result.fields;
  const number = (field: PayrollField): number | undefined =>
    f[field] === undefined ? undefined : Number(f[field]);
  const gross = number("gross");
  const net = number("net");
  const taxable = number("taxable");
  const nonTaxable = number("nonTaxable");
  // 本業の年調過不足税額は控除合計に含まれる。一方、副業の「年末調整還付」は
  // 支給合計・控除合計のどちらにも含まれないため、差引支給額に別途加算される。
  const outsideRefund = yearEndRefundOutsideDeductions ? -(number("yearEndAdjustment") ?? 0) : 0;
  if (gross !== undefined && net !== undefined && deductionTotal !== undefined
      && gross - deductionTotal + outsideRefund !== net) {
    result.warnings.push("支給合計 − 控除合計 ＋ 年末調整還付（別掲）と手取り額が一致しません。原本を確認してください。");
  }
  if (gross !== undefined && taxable !== undefined && nonTaxable !== undefined && gross !== taxable + nonTaxable) {
    result.warnings.push("課税支給額＋非課税支給額が支給合計と一致しません。");
  }
  // 控除項目の取りこぼしを検出する。差額を勝手に「その他控除」に割り振らない。
  if (deductionTotal !== undefined) {
    const components: PayrollField[] = ["incomeTax", "yearEndAdjustment", "residentTax", "healthInsurance", "careInsurance", "childcareSupport", "pension", "employmentInsurance", "otherDeductions"];
    const recorded = components.map(number).filter((v): v is number => v !== undefined);
    const knownSum = recorded.reduce((sum, value) => sum + value, 0);
    // 年末調整還付が控除欄の外にある帳票では、内訳との照合からだけ除外する。
    const printedDeductionComponents = knownSum - (yearEndRefundOutsideDeductions ? (number("yearEndAdjustment") ?? 0) : 0);
    if (printedDeductionComponents !== deductionTotal) {
      result.warnings.push("控除の内訳と控除合計が一致しません。未取得の控除項目がないか確認してください。");
    }
  }
  if (!f.paymentDate || !f.gross || !f.net || !f.targetMonth) {
    result.warnings.push("対象月・支給日・支給合計・手取り額の一部が読めませんでした。手動確認してください。");
  }
}

function mainPayroll(items: PdfTextCell[]): PayrollParseResult {
  const fields: PayrollParseResult["fields"] = { job: "main", kind: "salary" };
  const result: PayrollParseResult = { profile: "main", fields, warnings: [], missingFields: [] };
  fields.targetMonth = items.map(i => monthFrom(i.text)).find((m): m is string => Boolean(m));
  fields.paymentDate = getDate(items, "支給日:") ?? getDate(items, "支給日");
  put(fields, "gross", findAmount(items, ["支給合計"], MAIN_PAY));
  put(fields, "net", findAmount(items, ["振込支給額"], MAIN_NET));
  put(fields, "workDays", findAmount(items, ["出勤日数(平日)", "出勤日数"], MAIN_WORK));
  // 帳票上は「立替経費」だけでは実際の経費か都度交通費か識別できない。
  // 通勤手当等と併記されたときだけ「経費」として分離し、
  // 立替経費しかない月はその全額を交通費に分類する（ユーザー指定の規則）。
  const labeled = [...MAIN_TRANSPORT_LABELS, ...MAIN_EXPENSE_LABELS].map(label => ({
    label,
    present: items.some(item => inRange(item, MAIN_PAY, "label") && norm(item.text) === norm(label)),
    amount: findAmount(items, [label], MAIN_PAY),
  }));
  const travelLines = labeled.filter(line => (MAIN_TRANSPORT_LABELS as readonly string[]).includes(line.label));
  const expenseLines = labeled.filter(line => (MAIN_EXPENSE_LABELS as readonly string[]).includes(line.label));
  const hasExplicitTravel = travelLines.some(line => line.present);
  const sumOf = (lines: typeof labeled): number | undefined => {
    const values = lines.filter(line => line.present && line.amount !== undefined);
    return values.length ? values.reduce((sum, line) => sum + line.amount!, 0) : undefined;
  };
  const travelAmount = sumOf(travelLines);
  const expenseAmount = sumOf(expenseLines);
  if (hasExplicitTravel) {
    put(fields, "transportation", travelAmount);
    put(fields, "reimbursedExpenses", expenseAmount);
  } else {
    put(fields, "transportation", expenseAmount);
  }
  for (const line of labeled) {
    if (line.present && line.amount === undefined) {
      const field = hasExplicitTravel && (MAIN_EXPENSE_LABELS as readonly string[]).includes(line.label)
        ? "reimbursedExpenses" : "transportation";
      result.missingFields.push({ label: line.label, field, reason: "unreadable" });
    }
  }
  put(fields, "incomeTax", findAmount(items, ["所得税"], MAIN_TAX));
  // 年調過不足税額は所得税とは独立して保持する。マイナスは還付（控除の減額）。
  put(fields, "yearEndAdjustment", findAmount(items, ["年調過不足税額", "年末調整過不足額", "年末調整税額"], MAIN_TAX));
  put(fields, "residentTax", findAmount(items, ["住民税", "市民税", "市府民税"], MAIN_TAX));
  put(fields, "healthInsurance", findAmount(items, ["健康保険料"], MAIN_TAX));
  put(fields, "careInsurance", findAmount(items, ["介護保険料"], MAIN_TAX));
  put(fields, "childcareSupport", findAmount(items, ["子ども・子育て支援金", "子ども子育て支援金"], MAIN_TAX));
  put(fields, "pension", findAmount(items, ["厚生年金保険料"], MAIN_TAX));
  put(fields, "employmentInsurance", findAmount(items, ["雇用保険料"], MAIN_TAX));
  put(fields, "otherDeductions", findAmount(items, ["その他控除"], MAIN_TAX));

  const gross = fields.gross === undefined ? undefined : Number(fields.gross);
  const basic = findAmount(items, ["基本給"], MAIN_PAY);
  const fixed = findAmount(items, ["固定残業手当"], MAIN_PAY, { startsWith: true, yTolerance: 8 });
  // 本年累計の課税支給額は使用しない。立替経費が独立記録であっても、
  // この帳票の支給側では交通費＋経費を合わせて非課税支給額として検算する。
  const hasNonTaxableLabel = labeled.some(line => line.present);
  const hasUnreadableNonTaxable = labeled.some(line => line.present && line.amount === undefined);
  const nonTaxableAmount = (travelAmount ?? 0) + (expenseAmount ?? 0);
  if (gross !== undefined && basic !== undefined && fixed !== undefined
      && hasNonTaxableLabel && !hasUnreadableNonTaxable
      && basic + fixed + nonTaxableAmount === gross) {
    put(fields, "nonTaxable", nonTaxableAmount);
    put(fields, "taxable", basic + fixed);
  } else if (gross !== undefined && basic !== undefined && fixed !== undefined
      && !hasNonTaxableLabel && basic + fixed === gross) {
    // 交通費・立替経費の記載がない場合、非課税額は空欄のままにする。
    put(fields, "taxable", basic + fixed);
  } else {
    result.warnings.push("課税・非課税の当月額は検算できないため空欄です（本年累計欄は使用しません）。");
  }
  const deductionTotal = findAmount(items, ["控除合計"], MAIN_TAX);
  // 支援金欄が存在しない旧書式は正常扱い。
  // 欄があるのに金額を読めないときだけ警告する。
  checkOptionalIfPresent(result, items, [
    { label: "子ども・子育て支援金", names: ["子ども・子育て支援金", "子ども子育て支援金"], field: "childcareSupport", region: MAIN_TAX },
    { label: "介護保険料", names: ["介護保険料"], field: "careInsurance", region: MAIN_TAX },
    { label: "年調過不足税額", names: ["年調過不足税額", "年末調整過不足額", "年末調整税額"], field: "yearEndAdjustment", region: MAIN_TAX },
  ]);
  checkExpectedFields(result, items, [
    { label: "支給日", names: ["支給日"], field: "paymentDate", startsWith: true },
    { label: "基本給", names: ["基本給"], region: MAIN_PAY },
    { label: "固定残業手当", names: ["固定残業手当"], region: MAIN_PAY, startsWith: true },
    { label: "支給合計", names: ["支給合計"], field: "gross", region: MAIN_PAY },
    { label: "振込支給額", names: ["振込支給額"], field: "net", region: MAIN_NET },
    { label: "出勤日数", names: ["出勤日数(平日)", "出勤日数"], field: "workDays", region: MAIN_WORK },
    { label: "健康保険料", names: ["健康保険料"], field: "healthInsurance", region: MAIN_TAX },
    { label: "厚生年金保険料", names: ["厚生年金保険料"], field: "pension", region: MAIN_TAX },
    { label: "雇用保険料", names: ["雇用保険料"], field: "employmentInsurance", region: MAIN_TAX },
    { label: "所得税", names: ["所得税"], field: "incomeTax", region: MAIN_TAX },
    { label: "控除合計", names: ["控除合計"], region: MAIN_TAX },
  ], { "基本給": basic, "固定残業手当": fixed, "控除合計": deductionTotal });
  validate(result, deductionTotal);
  return result;
}

function sidePayroll(items: PdfTextCell[]): PayrollParseResult {
  const fields: PayrollParseResult["fields"] = { job: "side", kind: "salary" };
  const result: PayrollParseResult = { profile: "side", fields, warnings: [], missingFields: [] };
  fields.paymentDate = getDate(items, "支給日");
  // 副業は毎月10日締め・当月25日支払い。管理対象月は支給月。
  if (fields.paymentDate) fields.targetMonth = fields.paymentDate.slice(0, 7);
  put(fields, "gross", findAmount(items, ["支給合計"], SIDE_PAY));
  put(fields, "net", findAmount(items, ["差引支給合計"], SIDE_NET));
  put(fields, "taxable", findAmount(items, ["課税支給合計"], SIDE_PAY));
  put(fields, "nonTaxable", findAmount(items, ["非税支給合計", "非課税支給合計"], SIDE_PAY));
  put(fields, "transportation", findAmount(items, ["非課税通勤費"], SIDE_PAY));
  put(fields, "incomeTax", findAmount(items, ["所得税"], SIDE_TAX));
  // この帳票の「その他」は控除欄(x=164〜298)にある。支給欄の他項目とは混同しない。
  put(fields, "otherDeductions", findAmount(items, ["その他", "その他控除"], SIDE_TAX));
  // 控除合計の外にある別掲の還付額は、共通の控除計算ではマイナス値として持つ。
  // PDF自体の総支給額や控除合計を改変せず、総支給−控除＋還付＝手取りを成立させる。
  const outsideRefund = findAmount(items, ["年末調整還付", "年調還付"], SIDE_REFUND);
  if (outsideRefund !== undefined) put(fields, "yearEndAdjustment", -outsideRefund);
  put(fields, "workDays", findAmount(items, ["出勤日数"], SIDE_WORK));
  // 書式にない社会保険料・住民税は「0」ではなく未入力のまま。
  const deductionTotal = findAmount(items, ["控除合計"], SIDE_TAX);
  checkExpectedFields(result, items, [
    { label: "支給日", names: ["支給日"], field: "paymentDate" },
    { label: "課税支給合計", names: ["課税支給合計"], field: "taxable", region: SIDE_PAY },
    { label: "非税支給合計", names: ["非税支給合計", "非課税支給合計"], field: "nonTaxable", region: SIDE_PAY },
    { label: "非課税通勤費", names: ["非課税通勤費"], field: "transportation", region: SIDE_PAY },
    { label: "支給合計", names: ["支給合計"], field: "gross", region: SIDE_PAY },
    { label: "所得税", names: ["所得税"], field: "incomeTax", region: SIDE_TAX },
    { label: "控除合計", names: ["控除合計"], region: SIDE_TAX },
    { label: "出勤日数", names: ["出勤日数"], field: "workDays", region: SIDE_WORK },
    { label: "差引支給合計", names: ["差引支給合計"], field: "net", region: SIDE_NET },
  ], { "控除合計": deductionTotal });
  // 任意項目は欄自体がなければ正常、欄はあるのに値が読めなければ要確認。
  checkOptionalIfPresent(result, items, [
    { label: "その他", names: ["その他", "その他控除"], field: "otherDeductions", region: SIDE_TAX },
    { label: "年末調整還付", names: ["年末調整還付", "年調還付"], field: "yearEndAdjustment", region: SIDE_REFUND },
  ]);
  validate(result, deductionTotal, outsideRefund !== undefined);
  return result;
}

/** 副業の賞与明細。交通費/出勤日数はこの帳票では期待しない。 */
function sideBonus(items: PdfTextCell[]): PayrollParseResult {
  const fields: PayrollParseResult["fields"] = { job: "side", kind: "bonus" };
  const result: PayrollParseResult = { profile: "side", fields, warnings: [], missingFields: [] };
  fields.paymentDate = getDate(items, "支給日");
  if (fields.paymentDate) fields.targetMonth = fields.paymentDate.slice(0, 7);
  put(fields, "bonusBase", findAmount(items, ["賞与"], SIDE_PAY));
  put(fields, "gross", findAmount(items, ["支給合計"], SIDE_PAY));
  put(fields, "net", findAmount(items, ["差引支給合計"], SIDE_NET));
  put(fields, "healthInsurance", findAmount(items, ["健康保険料"], SIDE_TAX));
  put(fields, "careInsurance", findAmount(items, ["介護保険料"], SIDE_TAX));
  put(fields, "pension", findAmount(items, ["厚生年金保険", "厚生年金保険料"], SIDE_TAX));
  put(fields, "employmentInsurance", findAmount(items, ["雇用保険料"], SIDE_TAX));
  put(fields, "incomeTax", findAmount(items, ["所得税"], SIDE_TAX));
  const deductionTotal = findAmount(items, ["控除合計"], SIDE_TAX);
  checkExpectedFields(result, items, [
    { label: "支給日", names: ["支給日"], field: "paymentDate" },
    { label: "賞与", names: ["賞与"], field: "bonusBase", region: SIDE_PAY },
    { label: "支給合計", names: ["支給合計"], field: "gross", region: SIDE_PAY },
    { label: "所得税", names: ["所得税"], field: "incomeTax", region: SIDE_TAX },
    { label: "控除合計", names: ["控除合計"], region: SIDE_TAX },
    { label: "差引支給合計", names: ["差引支給合計"], field: "net", region: SIDE_NET },
  ], { "控除合計": deductionTotal });
  checkOptionalIfPresent(result, items, [
    { label: "健康保険料", names: ["健康保険料"], field: "healthInsurance", region: SIDE_TAX },
    { label: "介護保険料", names: ["介護保険料"], field: "careInsurance", region: SIDE_TAX },
    { label: "厚生年金保険", names: ["厚生年金保険", "厚生年金保険料"], field: "pension", region: SIDE_TAX },
    { label: "雇用保険料", names: ["雇用保険料"], field: "employmentInsurance", region: SIDE_TAX },
  ]);
  if (fields.bonusBase !== undefined && fields.gross !== undefined && fields.bonusBase !== fields.gross) {
    result.warnings.push("賞与額と支給合計が一致しません。別の支給項目がないか確認してください。");
  }
  validate(result, deductionTotal);
  return result;
}

/** 一部の賞与0円明細は「振込支給額」を印字せず、上部の差引支給額だけを表示する。 */
function mainBonusHeaderNet(items: PdfTextCell[]): number | undefined {
  const label = items.find(item => norm(item.text) === norm("差引支給額") && item.x >= 420 && item.y >= 650);
  if (!label) return undefined;
  const candidates = items.filter(item => item.page === label.page && item.x >= 490 && item.x <= 555
    && Math.abs(item.y - label.y) <= 5 && asAmount(item.text) !== undefined)
    .sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y));
  return candidates.length ? asAmount(candidates[0].text) : undefined;
}

/** 本業の賞与明細。業績手当は支給される場合だけ抽出する任意項目。 */
function mainBonus(items: PdfTextCell[]): PayrollParseResult {
  const fields: PayrollParseResult["fields"] = { job: "main", kind: "bonus" };
  const result: PayrollParseResult = { profile: "main", fields, warnings: [], missingFields: [] };
  // 「支」「 給日:...」というPDF分割にもgetDateが対応する。
  fields.paymentDate = getDate(items, "支給日") ?? getDate(items);
  if (fields.paymentDate) fields.targetMonth = fields.paymentDate.slice(0, 7);
  put(fields, "bonusBase", findAmount(items, ["賞与手当"], MAIN_BONUS_PAY));
  put(fields, "performanceBonus", findAmount(items, ["業績手当", "業績給"], MAIN_BONUS_PAY));
  put(fields, "gross", findAmount(items, ["支給合計"], MAIN_BONUS_PAY));
  put(fields, "net", findAmount(items, ["振込支給額"], MAIN_BONUS_NET) ?? mainBonusHeaderNet(items));
  put(fields, "healthInsurance", findAmount(items, ["健康保険料"], MAIN_BONUS_TAX));
  put(fields, "careInsurance", findAmount(items, ["介護保険料"], MAIN_BONUS_TAX));
  put(fields, "childcareSupport", findAmount(items, ["子ども・子育て支援金", "子ども子育て支援金"], MAIN_BONUS_TAX));
  put(fields, "pension", findAmount(items, ["厚生年金保険料"], MAIN_BONUS_TAX));
  put(fields, "employmentInsurance", findAmount(items, ["雇用保険料"], MAIN_BONUS_TAX));
  put(fields, "incomeTax", findAmount(items, ["所得税"], MAIN_BONUS_TAX));
  const deductionTotal = findAmount(items, ["控除合計"], MAIN_BONUS_TAX);
  // 本業の「賞与実績なし」帳票では、支給・控除・差引がすべて0円で、
  // 賞与手当・税額・振込欄自体が存在しない。この場合は正常な0円明細として扱う。
  const zeroPayment = fields.gross === "0" && deductionTotal === 0 && fields.net === "0";
  if (zeroPayment) {
    result.warnings.push("支給実績がない0円の賞与明細です。原本を確認してから保存してください。");
  }
  checkExpectedFields(result, items, [
    // 本業賞与の支給日文字列は複数itemに分かれる場合があるため、日付値だけを検査する。
    ...(!zeroPayment ? [{ label: "賞与手当", names: ["賞与手当"], field: "bonusBase" as const, region: MAIN_BONUS_PAY }] : []),
    { label: "支給合計", names: ["支給合計"], field: "gross", region: MAIN_BONUS_PAY },
    ...(!zeroPayment ? [{ label: "振込支給額", names: ["振込支給額"], field: "net" as const, region: MAIN_BONUS_NET }] : []),
    ...(!zeroPayment ? [{ label: "健康保険料", names: ["健康保険料"], field: "healthInsurance" as const, region: MAIN_BONUS_TAX }] : []),
    ...(!zeroPayment ? [{ label: "厚生年金保険料", names: ["厚生年金保険料"], field: "pension" as const, region: MAIN_BONUS_TAX }] : []),
    ...(!zeroPayment ? [{ label: "雇用保険料", names: ["雇用保険料"], field: "employmentInsurance" as const, region: MAIN_BONUS_TAX }] : []),
    ...(!zeroPayment ? [{ label: "所得税", names: ["所得税"], field: "incomeTax" as const, region: MAIN_BONUS_TAX }] : []),
    { label: "控除合計", names: ["控除合計"], region: MAIN_BONUS_TAX },
  ], { "控除合計": deductionTotal });
  checkOptionalIfPresent(result, items, [
    { label: "業績手当", names: ["業績手当", "業績給"], field: "performanceBonus", region: MAIN_BONUS_PAY },
    { label: "子ども・子育て支援金", names: ["子ども・子育て支援金", "子ども子育て支援金"], field: "childcareSupport", region: MAIN_BONUS_TAX },
    { label: "介護保険料", names: ["介護保険料"], field: "careInsurance", region: MAIN_BONUS_TAX },
  ]);
  const base = fields.bonusBase === undefined ? undefined : Number(fields.bonusBase);
  const performance = fields.performanceBonus === undefined ? 0 : Number(fields.performanceBonus);
  if (base !== undefined && fields.gross !== undefined && base + performance !== Number(fields.gross)) {
    result.warnings.push("賞与手当＋業績手当が支給合計と一致しません。ほかの支給項目がないか確認してください。");
  }
  validate(result, deductionTotal);
  return result;
}

/** 書式・種類を判別して、検証済み帳票だけを自動入力する。 */
function parseSinglePage(cells: PdfTextCell[]): PayrollParseResult {
  const texts = new Set(cells.map(item => norm(item.text)));
  const has = (value: string) => texts.has(norm(value));
  const hasBonusTitle = cells.some(item => /賞与明細|賞与支給明細/u.test(norm(item.text)));
  if (hasBonusTitle) {
    // 書式の特徴と座標を組み合わせる。タイトルだけで勤務先を決めない。
    const sideBonusScore = Number(has("差引支給合計")) + Number(has("賞与"))
      + Number(has("介護保険料")) + Number(cells.some(item => item.text.includes("TCPDF")));
    const mainBonusScore = Number(has("振込支給額")) + Number(has("賞与手当"))
      + Number(has("本年累計")) + Number(has("支給合計"));
    if (sideBonusScore >= 2 && sideBonusScore > mainBonusScore) return sideBonus(cells);
    if (mainBonusScore >= 2 && mainBonusScore > sideBonusScore) return mainBonus(cells);
    return { profile: null, fields: {}, warnings: ["賞与明細の書式を特定できませんでした。手動で確認してください。"], missingFields: [] };
  }
  const sideScore = Number(has("差引支給合計")) + Number(has("非税支給合計"))
    + Number(has("課税支給合計")) + Number(has("基本給(時給)"));
  const mainScore = Number(has("振込支給額")) + Number(has("本年累計"))
    + Number(cells.some(item => norm(item.text).startsWith("固定残業手当")))
    + Number(has("出勤日数(平日)"));
  if (sideScore >= 2 && sideScore > mainScore) return sidePayroll(cells);
  if (mainScore >= 2 && mainScore > sideScore) return mainPayroll(cells);
  return { profile: null, fields: {}, warnings: ["この給与明細の書式はまだ登録されていません。手動入力してください。"], missingFields: [] };
}

/** 全ページを調べ、帳票構造が判別できたページを採用する。
 * 複数の明細が1つのPDFにある場合は、別月の情報を混ぜずに警告する。
 */
export function parsePayroll(items: PdfTextCell[]): PayrollParseResult {
  const cells = deduplicate(items);
  const pages = [...new Set(cells.map(item => item.page))].sort((a, b) => a - b);
  if (!pages.length) return parseSinglePage([]);
  const candidates = pages.map(page => ({
    page, result: parseSinglePage(cells.filter(item => item.page === page)),
  }));
  const recognized = candidates.filter(c => c.result.profile !== null);
  if (!recognized.length) return candidates[0].result;
  recognized.sort((a, b) =>
    Object.keys(b.result.fields).length - Object.keys(a.result.fields).length
    || a.result.missingFields.length - b.result.missingFields.length
    || a.page - b.page);
  const best = recognized[0];
  // 結果オブジェクトは書き換えず警告だけを新しい配列に載せる。
  const warnings = [...best.result.warnings];
  if (recognized.length > 1) {
    warnings.push(`PDF内の${recognized.length}ページで明細を検出しました。${best.page}ページ目のみ自動入力しています。別月の明細や追加情報がないか確認してください。`);
  } else if (pages.length > 1) {
    warnings.push(`全${pages.length}ページを調査し、${best.page}ページ目から給与情報を取得しました。ほかのページに追加項目がないか確認してください。`);
  }
  return { ...best.result, warnings };
}
