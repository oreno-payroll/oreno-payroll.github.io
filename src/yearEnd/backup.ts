/** Separate, password-encrypted employee year-end backup; no personal Payroll or Finance data. */
import {readZip,writeZip,type ZipFile} from '../storage/zipArchive';
import {verifyPdfBytes,verifyPdfWithPdfJs} from '../storage/pdfIntegrity';
import {MAX_ARCHIVE_BYTES,MAX_MANIFEST_BYTES} from '../storage/storageLimits';
import {asPersonId,asDocumentId,validateProfile,validateYear,validYear,
 type PersonProfile,type YearData,type DocumentId} from './model';

export interface YearEndBackupPerson {
 profile:PersonProfile;
 years:YearData[];
 originals:Array<{id:DocumentId;bytes:Uint8Array}>;
}
export interface YearEndBackupData {exportedAt:string;persons:YearEndBackupPerson[]}
interface BackupOriginal {id:string;path:string;sha256:string;size:number}
interface BackupPersonManifest {profile:PersonProfile;years:YearData[];originals:BackupOriginal[]}
interface Manifest {app:'Payroll-YearEnd';schemaVersion:1;exportedAt:string;persons:BackupPersonManifest[]}
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
function guard(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(message);}
async function sha256(bytes:Uint8Array):Promise<string>{
 const result=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>);
 return [...new Uint8Array(result)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function validatePersons(data:YearEndBackupData):void {
 guard(typeof data.exportedAt==='string'&&Number.isFinite(Date.parse(data.exportedAt)),'作成日時が不正です。');
 guard(Array.isArray(data.persons)&&data.persons.length<=2000,'従業員数が不正です。');
 const ids=new Set<string>();
 for(const person of data.persons){
  const id=asPersonId(person.profile?.id);
  guard(!ids.has(id),'同じ従業員IDが重複しています。');ids.add(id);
  validateProfile(person.profile,id);
  guard(Array.isArray(person.years)&&Array.isArray(person.originals),'年度・原本の構造が不正です。');
  const years=new Set<string>(),docs=new Map<string,{size:number;hash:string}>();
  guard(person.years.length===Object.keys(person.profile.yearFiles).length,'年度ファイルの件数が一致しません。');
  for(const year of person.years){
   guard(validYear(year.calendarYear)&&!years.has(String(year.calendarYear))&&
    Object.hasOwn(person.profile.yearFiles,String(year.calendarYear)),'年度の参照先が不正です。');
   years.add(String(year.calendarYear));
   validateYear(year,id,year.calendarYear);
   for(const doc of year.documents){
    guard(!docs.has(doc.id),'明細IDが同じ従業員内で重複しています。');
    docs.set(doc.id,{size:doc.pdfSize,hash:doc.fileHash});
   }
  }
  guard(person.originals.length===docs.size,'PDF原本の件数が一致しません。');
  const seen=new Set<string>();
  for(const original of person.originals){
   const doc=docs.get(asDocumentId(original.id));
   guard(doc&&!seen.has(original.id)&&original.bytes instanceof Uint8Array,'PDF原本の参照が不正です。');
   seen.add(original.id);
   guard(original.bytes.length===doc.size,'PDF原本のサイズが一致しません。');
  }
 }
}
export async function createYearEndBackup(data:YearEndBackupData):Promise<Blob>{
 validatePersons(data);
 const manifest:Manifest={app:'Payroll-YearEnd',schemaVersion:1,exportedAt:data.exportedAt,persons:[]};
 const files:ZipFile[]=[];
 let counter=0;
 for(const person of data.persons){
  const known=new Map(person.years.flatMap(year=>year.documents.map(doc=>[doc.id,doc] as const)));
  const originals:BackupOriginal[]=[];
  for(const original of person.originals){
   verifyPdfBytes(original.bytes);
   const doc=known.get(original.id)!;
   const digest=await sha256(original.bytes);
   guard(digest===doc.fileHash,'PDF原本のSHA-256が一致しません。');
   const path=`pdf/${String(++counter).padStart(6,'0')}.pdf`;
   originals.push({id:original.id,path,sha256:digest,size:original.bytes.byteLength});
   files.push({name:path,data:original.bytes});
  }
  manifest.persons.push({profile:person.profile,years:person.years,originals});
 }
 const meta=encoder.encode(JSON.stringify(manifest));
 guard(meta.length<=MAX_MANIFEST_BYTES,'従業員バックアップの管理情報が大きすぎます。');
 return writeZip([{name:'manifest.json',data:meta},...files]);
}
export async function readYearEndBackup(file:Blob):Promise<YearEndBackupData>{
 guard(file.size>0&&file.size<=MAX_ARCHIVE_BYTES,'バックアップファイルの容量が不正です。');
 const files=readZip(await file.arrayBuffer());
 const manifestBytes=files.get('manifest.json');
 guard(manifestBytes&&manifestBytes.length<=MAX_MANIFEST_BYTES,'バックアップの管理情報が不正です。');
 const raw:unknown=JSON.parse(decoder.decode(manifestBytes));
 guard(raw&&typeof raw==='object'&&!Array.isArray(raw),'バックアップの形式が不正です。');
 const m=raw as Partial<Manifest>;
 guard(m.app==='Payroll-YearEnd'&&m.schemaVersion===1&&typeof m.exportedAt==='string'&&Array.isArray(m.persons),
  '年末調整専用のバックアップではありません。');
 guard(m.persons.length<=2000,'従業員数が上限を超えています。');
 const persons:YearEndBackupPerson[]=[];
 const usedPaths=new Set<string>();
 for(const entry of m.persons){
  guard(entry&&Array.isArray(entry.years)&&Array.isArray(entry.originals),'従業員の構造が不正です。');
  const originals:YearEndBackupPerson['originals']=[];
  for(const original of entry.originals){
   guard(original&&typeof original.path==='string'&&/^pdf\/[0-9]{6}\.pdf$/.test(original.path)&&
     !usedPaths.has(original.path)&&typeof original.sha256==='string'&&/^[a-f0-9]{64}$/.test(original.sha256)&&
     Number.isSafeInteger(original.size)&&original.size>0,'PDF原本の管理情報が不正です。');
   usedPaths.add(original.path);
   const bytes=files.get(original.path);
   guard(bytes&&bytes.length===original.size,'PDF原本が欠落または容量不一致です。');
   verifyPdfBytes(bytes);
   guard(await sha256(bytes)===original.sha256,'PDF原本のSHA-256が一致しません。');
   await verifyPdfWithPdfJs(bytes);
   originals.push({id:asDocumentId(original.id),bytes});
  }
  persons.push({profile:entry.profile,years:entry.years,originals});
 }
 guard(files.size===usedPaths.size+1,'バックアップ内に不要なファイルがあります。');
 const result={exportedAt:m.exportedAt,persons};
 validatePersons(result);
 return result;
}
