/**
 * 年末調整用PDFは本人Payrollの「副業」給与・賞与と同じ書式のみ受け付ける。
 * PDF.jsのテキスト/座標取得と検証済み帳票パーサーは共通化し、
 * 保存・暗号化・Finance公開処理は年末調整専用のものを使う。
 */
import {getDocument,GlobalWorkerOptions} from 'pdfjs-dist';
import {parsePayroll,type PdfTextCell} from '../pdf/payrollParser';
import type {DraftDocument} from './model';

const MAX_BYTES=25*1024*1024;
const MAX_PAGES=100;
const MAX_TEXT_ITEMS=100_000;
const normalized=(s:string)=>s.normalize('NFKC').replace(/[\s\u3000]/g,'');
function positiveInteger(value:string|undefined):number|null {
 if(value===undefined||!/^(?:0|[1-9]\d{0,8})$/.test(value.replace(/,/g,'')))return null;
 const n=Number(value.replace(/,/g,''));return Number.isSafeInteger(n)&&n<=999_999_999?n:null;
}
function documentName(cells:PdfTextCell[]):string|null {
 const found=new Set<string>();
 for(const cell of cells){
  const t=normalized(cell.text);
  if(!/^(?:従業員)?氏名[:：]?/.test(t))continue;
  const suffix=t.replace(/^(?:従業員)?氏名[:：]?/,'');
  const candidates=[suffix,...cells.filter(c=>c.page===cell.page&&c!==cell&&c.x>=cell.x+2&&c.x<cell.x+230&&Math.abs(c.y-cell.y)<7).map(c=>normalized(c.text))];
  for(const candidate of candidates)if(/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{2,30}$/u.test(candidate))found.add(candidate);
 }
 return found.size===1?[...found][0]:null;
}
export async function parseAssistedPdf(file:File,existingBytes?:ArrayBuffer):Promise<DraftDocument>{
 if(file.size<5||file.size>MAX_BYTES)throw new Error('PDFは1件25MB以内にしてください。');
 const bytes=existingBytes??await file.arrayBuffer();
 if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('PDF形式ではありません。');
 GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.min.mjs',import.meta.url).href;
 const task=getDocument({data:new Uint8Array(bytes),cMapUrl:new URL('./cmaps/',import.meta.url).href,cMapPacked:true,
  standardFontDataUrl:new URL('./standard_fonts/',import.meta.url).href,wasmUrl:new URL('./wasm/',import.meta.url).href,
  iccUrl:new URL('./iccs/',import.meta.url).href});
 const cells:PdfTextCell[]=[];
 try {
  const pdf=await task.promise;
  if(pdf.numPages<1||pdf.numPages>MAX_PAGES)throw new Error('PDFのページ数が上限を超えています。');
  for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
   const page=await pdf.getPage(pageNumber),content=await page.getTextContent();
   for(const item of content.items){
    if(!('str' in item)||!item.str.trim())continue;
    if(cells.length>=MAX_TEXT_ITEMS)throw new Error('PDFの文字情報が上限を超えています。');
    cells.push({page:pageNumber,text:item.str,x:item.transform[4],y:item.transform[5],width:item.width,height:item.height});
   }
  }
 } finally {await task.destroy();}
 const parsed=parsePayroll(cells);
 // 勤務先を本人用のmain/side識別子として保存するのではなく、帳票の書式判定にのみ使う。
 // 見出しが移動した疑わしい書式や未対応帳票は、手動入力に進ませず拒否する。
 if(parsed.profile!=='side'||parsed.layout?.status!=='matched')
  throw new Error('副業の給与・賞与明細として書式を確認できません。対象外のPDFは取り込めません。');
 if(parsed.warnings.some(message=>/PDF内の\d+ページで明細を検出/.test(message)))
  throw new Error('1つのPDFに複数の明細が含まれています。明細ごとにファイルを分けてください。');
 const fields=parsed.fields;
 if(fields.kind!=='salary'&&fields.kind!=='bonus')throw new Error('給与・賞与の種別を判定できませんでした。');
 const warnings=[...parsed.warnings];
 const gross=positiveInteger(fields.gross);
 const nonTaxable=positiveInteger(fields.nonTaxable),transport=positiveInteger(fields.transportation);
 const bonusTaxable=fields.kind==='bonus'&&gross!==null&&
  (nonTaxable===null||nonTaxable===0)&&(transport===null||transport===0);
 if(positiveInteger(fields.taxable)===null&&!bonusTaxable)warnings.push('課税支給合計を原本で確認して入力してください。');
 if(!fields.paymentDate)warnings.push('実際の支給日を原本と照合してください。');
 if(!fields.targetMonth)warnings.push('対象年月を原本と照合してください。');
 if(parsed.missingFields.length)warnings.push(`未取得：${parsed.missingFields.map(f=>f.label).join('、')}`);
 return {
  kind:fields.kind,paymentDate:fields.paymentDate??'',targetMonth:fields.targetMonth??'',
  taxable:positiveInteger(fields.taxable)??(bonusTaxable?gross:null),gross,transportation:positiveInteger(fields.transportation),
  nonTaxable:positiveInteger(fields.nonTaxable),healthInsurance:positiveInteger(fields.healthInsurance),
  pension:positiveInteger(fields.pension),employmentInsurance:positiveInteger(fields.employmentInsurance),
  incomeTax:positiveInteger(fields.incomeTax),residentTax:positiveInteger(fields.residentTax),
  detectedName:documentName(cells),warnings,
 };
}
