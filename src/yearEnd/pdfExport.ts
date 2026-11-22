/** 従業員の保存済み原本だけを、ローカルで平文PDF ZIPにまとめる。復元用バックアップとは別形式。 */
import {writeYearEndPdfZip,type ZipFile} from '../storage/zipArchive';
import {safePdfFileName,yearEndVisiblePdfName} from '../storage/fileNaming';
import type {DocumentRecord} from './model';

export interface VerifiedYearEndPdf {record:DocumentRecord;bytes:Uint8Array}
export function createYearEndPdfZip(items:readonly VerifiedYearEndPdf[]):Blob {
 if(!items.length)throw new Error('ZIPに含める保存済みPDFがありません。');
 const ordered=[...items].sort((a,b)=>a.record.paymentDate.localeCompare(b.record.paymentDate)||
  (a.record.kind==='salary'?0:1)-(b.record.kind==='salary'?0:1)||a.record.id.localeCompare(b.record.id));
 const used=new Set<string>();
 const files:ZipFile[]=ordered.map(({record,bytes})=>{
  if(!(bytes instanceof Uint8Array)||bytes.length!==record.pdfSize)throw new Error('PDF原本のサイズが一致しません。');
  const name=safePdfFileName(yearEndVisiblePdfName(record.kind,record.paymentDate,record.fileName),
   {fallbackStem:'給与明細',maxStemLength:100}).replace(/^[.]+/,'')||'給与明細.pdf';
  const stem=name.slice(0,-4);let unique=name,serial=2;
  // 同月の複数賞与などの重複名だけ末尾に番号を付け、通常は自動採番名をそのまま使う。
  while(used.has(unique.toLocaleLowerCase('ja-JP'))){unique=`${stem}_${serial++}.pdf`;}
  used.add(unique.toLocaleLowerCase('ja-JP'));
  return {name:unique,data:bytes};
 });
 return writeYearEndPdfZip(files);
}
