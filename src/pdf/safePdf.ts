/** PDF-only viewer boundary. Never trust File.type or filename for executable Blob URLs. */
const MAX_PDF_BYTES=50_000_000;
/** Verify the PDF magic bytes before making a correctly typed Blob. No Graph writes. */
export async function asVerifiedPdfBlob(source:Blob):Promise<Blob>{
 if(!(source instanceof Blob)||source.size<5||source.size>MAX_PDF_BYTES)
  throw new Error('PDF原本のサイズ・形式が正しくありません。');
 const prefix=new Uint8Array(await source.slice(0,5).arrayBuffer());
 if(prefix[0]!==37||prefix[1]!==80||prefix[2]!==68||prefix[3]!==70||prefix[4]!==45)
  throw new Error('PDF形式を確認できません。PDF以外のファイルは表示できません。');
 return new Blob([source],{type:'application/pdf'});
}
/** A message sent by another tab must already be a verified PDF-only Blob. */
export function requirePdfMime(source:Blob):void{
 if(!(source instanceof Blob)||source.type!=='application/pdf')
  throw new Error('PDF以外のMIME形式は閲覧できません。');
}
