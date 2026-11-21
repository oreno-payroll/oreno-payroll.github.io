/** Isolated encrypted third-party namespace. Never calls payrollStore or income publication. */
import {cloudVault} from '../cloud/auth';
import {encryptJson,decryptJson,encryptBytes,decryptBytes} from '../cloud/crypto';
import {isCollision,type RemoteFile} from '../cloud/graph';
import type {YearEndBackupData} from './backup';
import {
 asPersonId,asDocumentId,randomPersonId,randomDocumentId,isUuid,validYear,validDate,monthOf,checkedMoney,documentAmountWarnings,
 emptyIndex,emptyYear,validateIndex,validateProfile,validateYear,forecastPreview,bonusEstimatePreview,validYearMemo,type PersonId,type PersonIndex,
 type PersonProfile,type YearData,type DocumentRecord,type DraftDocument,type ForecastPreview,type EstimateMethod,type Estimate,
} from './model';

const MAX_INDEX=1_500_000, MAX_PROFILE=200_000,MAX_YEAR=8_000_000,MAX_PDF=70_000_000,MAX_UPLOAD=25_000_000;
const kinds={index:'assist-index',profile:'assist-profile',year:'assist-year',original:'assist-original'} as const;
type Kind=keyof typeof kinds;
interface Access {path:string[];key:CryptoKey;salt:string;graph:Awaited<ReturnType<typeof cloudVault>>['graph']}
interface Read<T> {value:T;file:RemoteFile|null}
const safeText=(s:string,max=80)=>typeof s==='string'&&s.trim().length>0&&s.trim().length<=max&&!/[\u0000-\u001f]/.test(s);
const clean=(v:string)=>v.trim();
const base64Name=(value:string)=>value.replace(/[\\/\u0000-\u001f]/g,'').slice(0,250)||'原本.pdf';
const hash=async(bytes:ArrayBuffer):Promise<string>=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');

/** Read-only report for an incomplete employee restore. No cloud mutation is performed. */
export interface YearEndRestoreOrphan {
 id:string; label:string; state:'unindexed'|'deleted'|'deleting'|'unexpected';
 profile:boolean; yearFiles:number; originals:number; inBackup:boolean; unexpectedFiles:number;
}
export interface YearEndRestoreInspection {items:YearEndRestoreOrphan[]; canAttemptResume:boolean}

export class YearEndRepository {
 private async access():Promise<Access> {const vault=await cloudVault();return vault.yearEndAccess();}
 private personPath(a:Access,id:PersonId):string[]{return [...a.path,'persons',id];}
 private async readJson<T>(a:Access,kind:Exclude<Kind,'original'>,path:string[],name:string,max:number):Promise<Read<T>|null>{
  const file=await a.graph.read(path,name,max);if(!file)return null;
  return {value:await decryptJson<T>(kinds[kind],file.text,a.key),file};
 }
 private async writeJson(a:Access,kind:Exclude<Kind,'original'>,path:string[],name:string,value:unknown,prior:RemoteFile|null,max:number):Promise<RemoteFile>{
  const live=await this.access();
  if(live.path.join('/')!==a.path.join('/'))throw new Error('暗号世代が変更されています。再読み込みしてください。');
  const encrypted=await encryptJson(kinds[kind],value,a.key,a.salt);
  await a.graph.write(path,name,encrypted,prior,max);
  const saved=await a.graph.read(path,name,max);
  if(!saved)throw new Error('暗号化ファイルを読み戻せません。保存状態を確認してください。');
  const check=await decryptJson<unknown>(kinds[kind],saved.text,a.key);
  if(JSON.stringify(check)!==JSON.stringify(value))throw new Error('暗号化ファイルの保存検証に失敗しました。');
  return saved;
 }
 private async readIndex(a:Access):Promise<Read<PersonIndex>>{
  const result=await this.readJson<PersonIndex>(a,'index',a.path,'index.enc',MAX_INDEX);
  if(result)return {...result,value:validateIndex(result.value)};
  const unexpected=await a.graph.listFolder([...a.path,'persons']);
  if(unexpected?.length)throw new Error('暗号化された従業員フォルダーがありますが索引がありません。自動初期化を拒否しました。');
  return {value:emptyIndex(),file:null};
 }
 async people():Promise<Array<PersonProfile & {state:'active'|'deleting'}>>{
  const a=await this.access(),idx=await this.readIndex(a),result:Array<PersonProfile & {state:'active'|'deleting'}>=[];
  for(const row of idx.value.persons){if(row.state==='deleted')continue;
   const file=await this.readJson<PersonProfile>(a,'profile',this.personPath(a,row.id),'profile.enc',MAX_PROFILE);
   if(!file){if(row.state==='deleting'){result.push({format:'payroll-year-end-person-v1',id:row.id,displayName:'削除未完了',alias:'',createdAt:row.createdAt,updatedAt:row.updatedAt,yearFiles:{},state:'deleting'});continue;}throw new Error('従業員プロフィールが存在しません。');}
   result.push({...validateProfile(file.value,row.id),state:row.state});
  }
  return result.sort((x,y)=>x.createdAt.localeCompare(y.createdAt));
 }
 private async assertActive(a:Access,id:PersonId):Promise<void>{
  const idx=await this.readIndex(a);
  if(!idx.value.persons.some(p=>p.id===id&&p.state==='active'))throw new Error('対象の従業員は未登録または削除処理中です。');
 }
 private async profile(a:Access,id:PersonId):Promise<Read<PersonProfile>>{
  await this.assertActive(a,id);
  const current=await this.readJson<PersonProfile>(a,'profile',this.personPath(a,id),'profile.enc',MAX_PROFILE);
  if(!current)throw new Error('従業員プロフィールが見つかりません。');
  return {...current,value:validateProfile(current.value,id)};
 }
 async createPerson(displayName:string,alias=''):Promise<PersonId>{
  if(!safeText(displayName)||alias.length>80||/[\u0000-\u001f]/.test(alias))throw new Error('表示名・補助識別名の形式が不正です。');
  const a=await this.access(),id=randomPersonId(),at=new Date().toISOString();
  // Establish an empty encrypted index before placing any person profile in the folder.
  const initial=await this.readIndex(a);
  if(!initial.file){
   try{await this.writeJson(a,'index',a.path,'index.enc',emptyIndex(),null,MAX_INDEX);}
   catch(error){if(!isCollision(error))throw error;}
  }
  const profile:PersonProfile={format:'payroll-year-end-person-v1',id,displayName:clean(displayName),alias:clean(alias),createdAt:at,updatedAt:at,yearFiles:{}};
  await this.writeJson(a,'profile',this.personPath(a,id),'profile.enc',profile,null,MAX_PROFILE);
  for(let attempt=0;attempt<4;attempt++){
   const idx=await this.readIndex(a);if(idx.value.persons.some(p=>p.id===id))throw new Error('従業員IDが重複しました。');
   const next:PersonIndex={...idx.value,persons:[...idx.value.persons,{id,state:'active',createdAt:at,updatedAt:at}]};
   try{await this.writeJson(a,'index',a.path,'index.enc',next,idx.file,MAX_INDEX);return id;}
   catch(error){if(isCollision(error))continue;throw error;}
  }
  throw new Error('従業員登録が競合しました。再実行してください。孤立したプロフィールは自動削除しません。');
 }
 async renamePerson(id:PersonId,name:string,alias:string):Promise<void>{
  asPersonId(id);if(!safeText(name)||alias.length>80||/[\u0000-\u001f]/.test(alias))throw new Error('表示名が不正です。');
  const a=await this.access(),current=await this.profile(a,id);
  const next={...current.value,displayName:clean(name),alias:clean(alias),updatedAt:new Date().toISOString()};
  await this.assertActive(a,id);await this.writeJson(a,'profile',this.personPath(a,id),'profile.enc',next,current.file,MAX_PROFILE);
 }
 private async yearContext(a:Access,id:PersonId,year:number,create:boolean):Promise<{profile:Read<PersonProfile>;data:YearData;file:RemoteFile|null;yearFile:string|null}>{
  asPersonId(id);if(!validYear(year))throw new Error('暦年が不正です。');
  let profile=await this.profile(a,id);let name=profile.value.yearFiles[String(year)];
  if(!name){if(!create)return {profile,data:emptyYear(id,year),file:null,yearFile:null};
   name=crypto.randomUUID() as typeof name;
   const blank=emptyYear(id,year);await this.writeJson(a,'year',[...this.personPath(a,id),'years'],name+'.enc',blank,null,MAX_YEAR);
   const next:PersonProfile={...profile.value,yearFiles:{...profile.value.yearFiles,[String(year)]:name},updatedAt:new Date().toISOString()};
   try{await this.writeJson(a,'profile',this.personPath(a,id),'profile.enc',next,profile.file,MAX_PROFILE);}
   catch(error){throw new Error('年度の登録確認に失敗しました。再読み込みしてください。未参照の暗号化ファイルが残った可能性があります。',{cause:error});}
   profile=await this.profile(a,id);
  }
  if(!isUuid(name))throw new Error('年度ファイルIDが不正です。');
  const file=await this.readJson<YearData>(a,'year',[...this.personPath(a,id),'years'],name+'.enc',MAX_YEAR);
  if(!file)throw new Error('年度ファイルが見つかりません。');
  return {profile,data:validateYear(file.value,id,year),file:file.file,yearFile:name};
 }
 async year(id:PersonId,year:number):Promise<YearData>{const a=await this.access();return (await this.yearContext(a,id,year,false)).data;}
 /** Read-only comparison across other years; names remain in encrypted annual files. */
 async otherYearDetectedNames(id:PersonId,exceptYear:number):Promise<string[]>{
  const a=await this.access(),profile=await this.profile(a,id),names:string[]=[];
  const years=Object.entries(profile.value.yearFiles).filter(([y])=>Number(y)!==exceptYear);
  // A single decrypted year JSON per year; do not repeat index/profile network reads.
  for(let i=0;i<years.length;i+=2){
   const results=await Promise.all(years.slice(i,i+2).map(async([year,fileId])=>{
    const remote=await this.readJson<YearData>(a,'year',[...this.personPath(a,id),'years'],fileId+'.enc',MAX_YEAR);
    if(!remote)throw new Error('他年度のファイルが見つかりません。');
    return validateYear(remote.value,id,Number(year)).documents;
   }));
   for(const docs of results)for(const record of docs)if(record.detectedName)names.push(record.detectedName);
  }
  return names;
 }

 private async saveYear(a:Access,id:PersonId,year:number,prior:RemoteFile|null,data:YearData,name:string|null):Promise<void>{
  validateYear(data,id,year);if(!name)throw new Error('年度ファイルが未登録です。');
  // Earlier versions stored deleted salary amounts in history. Never write them again.
  const live=new Set(data.documents.map(d=>d.id));
  data={...data,history:data.history.flatMap(event=>{
   if(!event.documentId||live.has(event.documentId))return [event];
   return event.kind==='document-deleted'?[{at:event.at,kind:event.kind,month:event.month,documentId:event.documentId}]:[];
  })};
  await this.assertActive(a,id);
  const current=await this.profile(a,id);
  if(current.value.yearFiles[String(year)]!==name)throw new Error('年度ファイルの参照先が更新されました。再読み込みしてください。');
  // Check the current generation/rotation marker immediately before writing.
  const currentVault=await this.access();if(currentVault.path.join('/')!==a.path.join('/'))throw new Error('保管庫の暗号世代が変更されました。');
  await this.writeJson(a,'year',[...this.personPath(a,id),'years'],name+'.enc',data,prior,MAX_YEAR);
 }
 async addDocument(id:PersonId,year:number,file:File,draft:DraftDocument,confirmed:boolean):Promise<DocumentRecord>{
  if(!confirmed)throw new Error('登録先と解析結果の最終確認が必要です。');
  asPersonId(id);if(!validYear(year)||!validDate(draft.paymentDate)||Number(draft.paymentDate.slice(0,4))!==year)throw new Error('選択した暦年と支給年月日が一致しません。');
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(draft.targetMonth)||!['salary','bonus'].includes(draft.kind))throw new Error('給与・賞与の区分または対象月が不正です。');
  const taxable=checkedMoney(draft.taxable);if(documentAmountWarnings(draft).length)throw new Error('支給額の検算に矛盾があります。一括保存画面から確認してください。');if(!(file instanceof Blob)||file.size<5||file.size>MAX_UPLOAD||file.type&&!['application/pdf','application/x-pdf',''].includes(file.type))throw new Error('PDF原本は25MB以内で指定してください。');
  const bytes=await file.arrayBuffer();if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('PDFのヘッダーが不正です。');
  const digest=await hash(bytes);const a=await this.access(),current=await this.yearContext(a,id,year,true);
  if(current.data.documents.some(x=>x.fileHash===digest))throw new Error('同じPDFがこの従業員の年度に登録済みです。');
  // A PDF registered in another calendar year for the SAME person is still a duplicate.
  for(const otherYear of Object.keys(current.profile.value.yearFiles)){
   if(Number(otherYear)===year)continue;
   const old=await this.year(id,Number(otherYear));
   if(old.documents.some(x=>x.fileHash===digest))throw new Error('同じPDFがこの従業員の別の暦年に登録されています。');
  }
  if(current.data.documents.some(x=>x.kind==='salary'&&draft.kind==='salary'&&monthOf(x.paymentDate)===monthOf(draft.paymentDate)))throw new Error('同一支給月の給与は1件のみです。既存明細を訂正してください。');
  const documentId=randomDocumentId(),record:DocumentRecord={id:documentId,personId:id,kind:draft.kind,paymentDate:draft.paymentDate,targetMonth:draft.targetMonth,
   taxable,gross:draft.gross,transportation:draft.transportation,nonTaxable:draft.nonTaxable,
   healthInsurance:draft.healthInsurance,pension:draft.pension,employmentInsurance:draft.employmentInsurance,incomeTax:draft.incomeTax,residentTax:draft.residentTax,
   fileName:base64Name(file.name),pdfSize:bytes.byteLength,fileHash:digest,detectedName:draft.detectedName??null,confirmedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'pdf-reviewed',revision:1};
  for(const key of ['gross','transportation','nonTaxable','healthInsurance','pension','employmentInsurance','incomeTax','residentTax'] as const)if(record[key]!==null)checkedMoney(record[key]);
  // Store original first. A metadata failure can leave an unreferenced encrypted original;
  // never claim an all-or-nothing rollback and never publish any plain PDF.
  const originalPath=[...this.personPath(a,id),'originals'],encrypted=await encryptBytes(kinds.original,new Uint8Array(bytes),a.key);
  await a.graph.write(originalPath,documentId+'.enc',encrypted,null,MAX_PDF);
  const stored=await a.graph.read(originalPath,documentId+'.enc',MAX_PDF);
  if(!stored)throw new Error('原本PDFの保存照合に失敗しました。');
  const restored=await decryptBytes(kinds.original,stored.text,a.key);
  if(restored.byteLength!==bytes.byteLength||await hash(restored.buffer as ArrayBuffer)!==digest)throw new Error('暗号化PDF原本のSHA-256照合に失敗しました。');
  const m=monthOf(record.paymentDate);
  const estimates=current.data.estimates.filter(e=>e.month!==m||record.kind==='bonus');
  const bonusEstimates=current.data.bonusEstimates.filter(e=>e.month!==m||record.kind==='salary');
  const old=current.data.estimates.find(e=>e.month===m);
  const next:YearData={...current.data,documents:[...current.data.documents,record],estimates,bonusEstimates,
   noPaymentMonths:current.data.noPaymentMonths.filter(x=>record.kind!=='salary'||x!==m),confirmedAt:null,
   history:old&&record.kind==='salary'?[...current.data.history,{at:new Date().toISOString(),kind:'estimate-replaced',month:m,oldValue:old.amount,newValue:record.taxable,documentId}]:current.data.history};
  try{await this.saveYear(a,id,year,current.file,next,current.yearFile);}
  catch(error){throw new Error('原本PDFは暗号化保存されましたが、年度データの確定に失敗しました。二重登録せず状態を確認してください。',{cause:error});}
  return record;
 }
 /** Update all payroll fields, optionally staging a different PDF original.
  * A replacement uses a NEW immutable encrypted original. The annual ETag is
  * switched only after SHA-256 verification, so a failed update keeps the old
  * document and PDF usable. The old encrypted PDF is trashed only after cutover. */
 /** Fast year-end workspace save: upload each immutable original with full SHA-256
  * read-back verification, then commit the complete year JSON ONCE with its ETag.
  * Never publishes plaintext, never drops verification, never overwrites a stale year. */
 async saveDocumentsBatch(id:PersonId,year:number,
   updates:Array<{documentId:string;expectedRevision:number;draft:DraftDocument}>,
   additions:Array<{file:File;draft:DraftDocument}>,acknowledgedAmountWarning=false):Promise<{data:YearData;yearFiles:PersonProfile['yearFiles']}>{
  asPersonId(id);if(!validYear(year))throw new Error('保存先の暦年が不正です。');
  if(!updates.length&&!additions.length)throw new Error('保存する明細がありません。');
  if(updates.length+additions.length>50)throw new Error('一度に保存できる明細が多すぎます。');
  // Validate every field before creating files on OneDrive.
  const verifyDraft=(d:DraftDocument)=>{
   if(!['salary','bonus'].includes(d.kind)||!validDate(d.paymentDate)||Number(d.paymentDate.slice(0,4))!==year||
     !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(d.targetMonth))throw new Error('明細の種類・支給日・対象年月を確認してください。');
   checkedMoney(d.taxable);
   for(const k of ['gross','transportation','nonTaxable','healthInsurance','pension','employmentInsurance','incomeTax','residentTax'] as const)
    if(d[k]!==null)checkedMoney(d[k]);
  };
  if(!acknowledgedAmountWarning&&[...updates.map(u=>u.draft),...additions.map(a=>a.draft)].some(d=>documentAmountWarnings(d).length))
   throw new Error('支給額に矛盾があります。原本を確認し、警告を明示的に承認してください。');
  for(const x of updates)verifyDraft(x.draft);
  for(const x of additions){verifyDraft(x.draft);
   if(!(x.file instanceof Blob)||x.file.size<5||x.file.size>MAX_UPLOAD||x.file.type&&!['application/pdf','application/x-pdf',''].includes(x.file.type))
    throw new Error('PDF原本は25MB以内で選択してください。');
  }
  const a=await this.access(),context=await this.yearContext(a,id,year,Boolean(additions.length));
  const now=new Date().toISOString();
  let working:YearData={...context.data,documents:[...context.data.documents],estimates:[...context.data.estimates],
   bonusEstimates:[...context.data.bonusEstimates],noPaymentMonths:[...context.data.noPaymentMonths],history:[...context.data.history]};
  const changes=new Set<string>();
  for(const update of updates){
   asDocumentId(update.documentId);
   if(changes.has(update.documentId))throw new Error('同じ明細が重複編集されています。');
   changes.add(update.documentId);
   const prior=working.documents.find(r=>r.id===update.documentId);
   if(!prior||prior.revision!==update.expectedRevision)throw new Error('他の画面で明細が更新されています。年度を読み直してください。');
   const d=update.draft;
   const record:DocumentRecord={...prior,kind:d.kind,paymentDate:d.paymentDate,targetMonth:d.targetMonth,
    taxable:checkedMoney(d.taxable),gross:d.gross,transportation:d.transportation,nonTaxable:d.nonTaxable,
    healthInsurance:d.healthInsurance,pension:d.pension,employmentInsurance:d.employmentInsurance,
    incomeTax:d.incomeTax,residentTax:d.residentTax,detectedName:d.detectedName??prior.detectedName??null,revision:prior.revision+1,
    source:'manual-confirmed',updatedAt:now,confirmedAt:now};
   const month=monthOf(record.paymentDate);
   working={...working,documents:working.documents.map(r=>r.id===prior.id?record:r),
    estimates:working.estimates.filter(e=>(record.kind!=='salary'||e.month!==month)&&!e.references.includes(prior.id)),
    bonusEstimates:working.bonusEstimates.filter(e=>record.kind!=='bonus'||e.month!==month),
    noPaymentMonths:working.noPaymentMonths.filter(m=>record.kind!=='salary'||m!==month),
    history:[...working.history,{at:now,kind:'document-corrected',month:monthOf(prior.paymentDate),oldValue:prior.taxable,newValue:record.taxable,documentId:record.id}]};
  }
  if(working.history.length>1000)throw new Error('変更履歴の保存上限です。');
  const pending:Array<{file:File;bytes:ArrayBuffer;digest:string;record:DocumentRecord}>=[];
  for(const x of additions){
   const bytes=await x.file.arrayBuffer();
   if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('PDF原本のヘッダーが不正です。');
   const digest=await hash(bytes);
   if(working.documents.some(r=>r.fileHash===digest)||pending.some(p=>p.digest===digest))
    throw new Error('同一内容のPDFが保存済みまたは保存対象にあります。');
   const d=x.draft;
   const record:DocumentRecord={id:randomDocumentId(),personId:id,kind:d.kind,paymentDate:d.paymentDate,targetMonth:d.targetMonth,
    taxable:checkedMoney(d.taxable),gross:d.gross,transportation:d.transportation,nonTaxable:d.nonTaxable,
    healthInsurance:d.healthInsurance,pension:d.pension,employmentInsurance:d.employmentInsurance,
    incomeTax:d.incomeTax,residentTax:d.residentTax,fileName:base64Name(x.file.name),pdfSize:bytes.byteLength,
    fileHash:digest,detectedName:d.detectedName??null,confirmedAt:now,updatedAt:now,source:'pdf-reviewed',revision:1};
   const month=monthOf(record.paymentDate),old=working.estimates.find(e=>e.month===month);
   working={...working,documents:[...working.documents,record],
    estimates:working.estimates.filter(e=>record.kind==='bonus'||e.month!==month),
    bonusEstimates:working.bonusEstimates.filter(e=>record.kind==='salary'||e.month!==month),
    noPaymentMonths:working.noPaymentMonths.filter(m=>record.kind!=='salary'||m!==month),
    history:old&&record.kind==='salary'?[...working.history,{at:now,kind:'estimate-replaced',month,oldValue:old.amount,newValue:record.taxable,documentId:record.id}]:working.history};
   pending.push({file:x.file,bytes,digest,record});
  }
  // Whole-year model verification catches duplicate salary months, forecast reference
  // conflicts, and yearly limits BEFORE any original upload begins.
  working={...working,confirmedAt:null};validateYear(working,id,year);
  if(pending.length){
   // Same person, other year: never store an existing PDF twice.
   const otherYears=Object.keys(context.profile.value.yearFiles).map(Number).filter(y=>y!==year);
   const otherRecords=await Promise.all(otherYears.map(async y=>(await this.year(id,y)).documents));
   const otherHashes=new Set(otherRecords.flat().map(r=>r.fileHash));
   if(pending.some(x=>otherHashes.has(x.digest)))throw new Error('同じ従業員の別年度に登録済みのPDFがあります。');
  }
  // A bounded two-file pipeline reduces wall-clock time while keeping memory sane.
  const originalPath=[...this.personPath(a,id),'originals'];
  const uploadAndCheck=async (entry:typeof pending[number])=>{
   const encrypted=await encryptBytes(kinds.original,new Uint8Array(entry.bytes),a.key);
   await a.graph.write(originalPath,entry.record.id+'.enc',encrypted,null,MAX_PDF);
   const stored=await a.graph.read(originalPath,entry.record.id+'.enc',MAX_PDF);
   if(!stored)throw new Error('原本PDFの暗号化保存照合に失敗しました。');
   const restored=await decryptBytes(kinds.original,stored.text,a.key);
   if(restored.byteLength!==entry.bytes.byteLength||await hash(restored.buffer as ArrayBuffer)!==entry.digest)
    throw new Error('暗号化PDF原本のSHA-256照合に失敗しました。');
  };
  for(let i=0;i<pending.length;i+=2){
   try{await Promise.all(pending.slice(i,i+2).map(uploadAndCheck));}
   catch(error){throw new Error('PDFの暗号化保存中に問題が発生しました。未参照の暗号化PDFが残った可能性があります。再読み込みして状況を確認してください。',{cause:error});}
  }
  try{await this.saveYear(a,id,year,context.file,working,context.yearFile);}
  catch(error){throw new Error(pending.length?'暗号化PDF原本は保存されましたが、年度データの確定に失敗しました。二重登録せず再読み込みしてください。':'年度データの保存に失敗しました。再読み込みしてください。',{cause:error});}
  return {data:working,yearFiles:context.profile.value.yearFiles};
 }
 async updateDocument(id:PersonId,year:number,documentId:string,draft:DraftDocument,replacement:File|null=null):Promise<{cleanupPending:boolean}> {
  asDocumentId(documentId);asPersonId(id);
  if(!validYear(year)||!validDate(draft.paymentDate)||Number(draft.paymentDate.slice(0,4))!==year)
   throw new Error('支給日が選択中の年と一致しません。');
  if(!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(draft.targetMonth)||!['salary','bonus'].includes(draft.kind))
   throw new Error('明細種別または対象月が不正です。');
  checkedMoney(draft.taxable);
  if(documentAmountWarnings(draft).length)throw new Error('支給額の検算に矛盾があります。一括保存画面から確認してください。');
  for(const k of ['gross','transportation','nonTaxable','healthInsurance','pension','employmentInsurance','incomeTax','residentTax'] as const)
   if(draft[k]!==null)checkedMoney(draft[k]);
  const a=await this.access(),context=await this.yearContext(a,id,year,false);
  const prior=context.data.documents.find(r=>r.id===documentId);
  if(!prior)throw new Error('変更対象の明細が見つかりません。再読み込みしてください。');
  const incomingMonth=monthOf(draft.paymentDate);
  if(draft.kind==='salary'&&context.data.documents.some(r=>r.id!==prior.id&&r.kind==='salary'&&monthOf(r.paymentDate)===incomingMonth))
   throw new Error('この支給月の給与はほかの明細で登録済みです。');
  let nextId=prior.id, nextName=prior.fileName, nextSize=prior.pdfSize, nextHash=prior.fileHash;
  let bytes:ArrayBuffer|null=null;
  if(replacement){
   if(!(replacement instanceof Blob)||replacement.size<5||replacement.size>MAX_UPLOAD||replacement.type&&!['application/pdf','application/x-pdf',''].includes(replacement.type))
    throw new Error('PDF原本は25MB以内で指定してください。');
   bytes=await replacement.arrayBuffer();
   if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('PDF原本の形式が不正です。');
   nextHash=await hash(bytes);
   if(nextHash===prior.fileHash)throw new Error('元のPDFと同じ内容です。金額等の訂正だけ保存してください。');
   if(context.data.documents.some(r=>r.id!==prior.id&&r.fileHash===nextHash))throw new Error('ほかの登録済み明細と同一のPDFです。');
   for(const otherYear of Object.keys(context.profile.value.yearFiles)){
    if(Number(otherYear)===year)continue;
    if((await this.year(id,Number(otherYear))).documents.some(r=>r.fileHash===nextHash))
     throw new Error('この従業員の別年度に同じPDFが登録されています。');
   }
   nextId=randomDocumentId();nextName=base64Name(replacement.name);nextSize=bytes.byteLength;
  }
  const now=new Date().toISOString();
  const updated:DocumentRecord={...prior,id:nextId,kind:draft.kind,paymentDate:draft.paymentDate,targetMonth:draft.targetMonth,
   taxable:checkedMoney(draft.taxable),gross:draft.gross,transportation:draft.transportation,nonTaxable:draft.nonTaxable,
   healthInsurance:draft.healthInsurance,pension:draft.pension,employmentInsurance:draft.employmentInsurance,
   incomeTax:draft.incomeTax,residentTax:draft.residentTax,fileName:nextName,pdfSize:nextSize,fileHash:nextHash,detectedName:draft.detectedName??prior.detectedName??null,
   revision:prior.revision+1,source:bytes?'pdf-reviewed':'manual-confirmed',updatedAt:now,confirmedAt:now};
  if(bytes){
   const path=[...this.personPath(a,id),'originals'];
   await a.graph.write(path,nextId+'.enc',await encryptBytes(kinds.original,new Uint8Array(bytes),a.key),null,MAX_PDF);
   const saved=await a.graph.read(path,nextId+'.enc',MAX_PDF);
   if(!saved)throw new Error('差し替えPDFの暗号化保存を確認できません。');
   const decrypted=await decryptBytes(kinds.original,saved.text,a.key);
   if(decrypted.byteLength!==bytes.byteLength||await hash(decrypted.buffer as ArrayBuffer)!==nextHash)
    throw new Error('差し替えPDFのSHA-256照合に失敗しました。');
  }
  const estimates=context.data.estimates.filter(e=>e.month!==incomingMonth||draft.kind!=='salary')
   .filter(e=>!e.references.includes(prior.id));
  const bonusEstimates=context.data.bonusEstimates.filter(e=>e.month!==incomingMonth||draft.kind!=='bonus');
  if(context.data.history.length>=1000)throw new Error('変更履歴の保存上限です。データを保護するため更新を中断しました。');
  const next:YearData={...context.data,
   documents:context.data.documents.map(r=>r.id===prior.id?updated:r),estimates,bonusEstimates,
   noPaymentMonths:context.data.noPaymentMonths.filter(m=>draft.kind!=='salary'||m!==incomingMonth),confirmedAt:null,
   history:[...context.data.history,{at:now,kind:'document-corrected',month:monthOf(prior.paymentDate),oldValue:prior.taxable,newValue:updated.taxable,documentId:updated.id}]};
  try{await this.saveYear(a,id,year,context.file,next,context.yearFile);}
  catch(error){throw new Error(bytes?'差し替えPDFは暗号化保存されましたが、明細の確定に失敗しました。元の明細は保持されています。再読み込みしてください。':'明細の更新に失敗しました。',{cause:error});}
  let cleanupPending=false;
  if(bytes){
   try{
    const originalPath=[...this.personPath(a,id),'originals'];
    const old=(await a.graph.listFolder(originalPath))?.find(f=>f.name===prior.id+'.enc');
    if(!old||old.folder)throw new Error('旧PDF原本の所在を確認できません。');
    await a.graph.trashFile(originalPath,old);
   }catch{cleanupPending=true;}
  }
  return {cleanupPending};
 }
 /** Delete one saved record with optimistic ETag protection. Invalidate forecasts
  * that reference it; move the encrypted PDF to OneDrive trash after the cutover. */
 async deleteDocument(id:PersonId,year:number,documentId:string):Promise<{cleanupPending:boolean}>{
  asDocumentId(documentId);asPersonId(id);
  const a=await this.access(),context=await this.yearContext(a,id,year,false);
  const record=context.data.documents.find(r=>r.id===documentId);
  if(!record)throw new Error('削除対象の明細が見つかりません。最新データを読み込み直してください。');
  if(context.data.history.length>=1000)throw new Error('変更履歴の保存上限です。削除を中断しました。');
  const next:YearData={...context.data,
   documents:context.data.documents.filter(r=>r.id!==documentId),
   estimates:context.data.estimates.filter(e=>!e.references.includes(record.id)),
   confirmedAt:null,
   history:[...context.data.history.filter(event=>event.documentId!==record.id),{at:new Date().toISOString(),kind:'document-deleted',month:monthOf(record.paymentDate),documentId:record.id}]};
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
  let cleanupPending=false;
  try{
   const path=[...this.personPath(a,id),'originals'];
   const file=(await a.graph.listFolder(path))?.find(f=>f.name===record.id+'.enc');
   if(!file||file.folder)throw new Error('削除済みPDF原本の所在を確認できません。');
   await a.graph.trashFile(path,file);
  }catch{cleanupPending=true;}
  return {cleanupPending};
 }
 async correctDocument(id:PersonId,year:number,documentId:string,newTaxable:number):Promise<void>{
  asDocumentId(documentId);checkedMoney(newTaxable);
  const a=await this.access(),context=await this.yearContext(a,id,year,false);
  const prior=context.data.documents.find(r=>r.id===documentId);if(!prior)throw new Error('対象の明細が見つかりません。');
  if(documentAmountWarnings({...prior,taxable:newTaxable}).length)throw new Error('金額の検算に矛盾があります。一括保存画面から確認してください。');
  const now=new Date().toISOString();const updated={...prior,taxable:newTaxable,revision:prior.revision+1,updatedAt:now,source:'manual-confirmed' as const};
  const next:YearData={...context.data,documents:context.data.documents.map(r=>r.id===documentId?updated:r),confirmedAt:null,
   history:[...context.data.history,{at:now,kind:'document-corrected' as const,month:monthOf(prior.paymentDate),oldValue:prior.taxable,newValue:newTaxable,documentId:prior.id}]};
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
 }
 async preview(id:PersonId,year:number,method:EstimateMethod,months:string[],manual:Record<string,number>):Promise<ForecastPreview>{
  return forecastPreview(await this.year(id,year),method,months,manual);
 }
 async commitForecast(id:PersonId,year:number,preview:ForecastPreview):Promise<void>{
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  const manual:Record<string,number>={};for(const e of preview.estimated)Object.assign(manual,{[e.month]:e.amount});
  const fresh=forecastPreview(context.data,preview.method,preview.months,manual);
  if(JSON.stringify(fresh.references)!==JSON.stringify(preview.references))throw new Error('参考給与の金額が変更されました。見込みを再計算してください。');
  if(JSON.stringify(fresh.estimated.map(e=>[e.month,e.amount,e.references]))!==JSON.stringify(preview.estimated.map(e=>[e.month,e.amount,e.references])))throw new Error('見込み計算の根拠が更新されました。プレビューし直してください。');
  const next={...context.data,estimates:[...context.data.estimates.filter(e=>!preview.months.includes(e.month)),...fresh.estimated],confirmedAt:null};
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
 }
 /** Replace the complete salary forecast only after the user presses Save.
  * Legacy no-payment markers are folded into explicit zero-yen estimates on this write.
  * The original forecast state and calculation references prevent stale-tab overwrites. */
 async replaceForecast(id:PersonId,year:number,method:EstimateMethod,months:string[],overrides:Record<string,number>,
   previousEstimates:Estimate[],previousNoPaymentMonths:string[],expectedReferences:ForecastPreview['references']):Promise<void>{
  asPersonId(id);
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  if(JSON.stringify(context.data.estimates)!==JSON.stringify(previousEstimates)||
   JSON.stringify(context.data.noPaymentMonths)!==JSON.stringify(previousNoPaymentMonths))
   throw new Error('別の画面で見込みが更新されました。再読み込みしてから保存してください。');
  const compatible={...context.data,noPaymentMonths:[]};
  const fresh=months.length?forecastPreview(compatible,method,months,overrides):null;
  if(JSON.stringify(fresh?.references??[])!==JSON.stringify(expectedReferences))
   throw new Error('参考給与の金額が更新されました。再読み込みしてから保存してください。');
  const next:YearData={...context.data,estimates:fresh?.estimated??[],noPaymentMonths:[],confirmedAt:null};
  if(!next.noPaymentMonths.length&&JSON.stringify(next.estimates)===JSON.stringify(context.data.estimates)&&
    !context.data.noPaymentMonths.length)return;
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
 }
 /** Commit salary and bonus draft in a single encrypted annual-file update.
  * Protect against changed salary references, old estimates and other-tab edits. */
 async replaceIncomeForecasts(id:PersonId,year:number,method:EstimateMethod,months:string[],overrides:Record<string,number>,
  previousEstimates:Estimate[],previousNoPaymentMonths:string[],expectedReferences:ForecastPreview['references'],
  previousBonusEstimates:Estimate[],bonusDraft?:{month:string;amount:number}|{month:string;remove:true}):Promise<void>{
  asPersonId(id);
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  if(JSON.stringify(context.data.estimates)!==JSON.stringify(previousEstimates)||
   JSON.stringify(context.data.noPaymentMonths)!==JSON.stringify(previousNoPaymentMonths)||
   JSON.stringify(context.data.bonusEstimates)!==JSON.stringify(previousBonusEstimates))
   throw new Error('別の画面で見込みが変更されました。再読み込みしてから保存してください。');
  const compatible={...context.data,noPaymentMonths:[]};
  const fresh=months.length?forecastPreview(compatible,method,months,overrides):null;
  if(JSON.stringify(fresh?.references??[])!==JSON.stringify(expectedReferences))
   throw new Error('確定給与の参照先が変更されました。再読み込みしてから保存してください。');
  let bonusEstimates=context.data.bonusEstimates;
  if(bonusDraft){
   if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(bonusDraft.month)||!bonusDraft.month.startsWith(String(year)+'-'))
    throw new Error('賞与見込みの支給月が不正です。');
   if('remove' in bonusDraft){
    // A deletion targets just one saved estimate, never confirmed bonus documents.
    if(bonusDraft.remove!==true)throw new Error('賞与見込みの削除指定が不正です。');
    if(bonusEstimates.some(e=>e.month===bonusDraft.month))
     bonusEstimates=bonusEstimates.filter(e=>e.month!==bonusDraft.month);
   }else{
    checkedMoney(bonusDraft.amount);
    bonusEstimatePreview(context.data,bonusDraft.month,bonusDraft.amount);
    const previous=bonusEstimates.find(e=>e.month===bonusDraft.month);
    if(!previous||previous.amount!==bonusDraft.amount){
     const forecast:Estimate={month:bonusDraft.month,amount:bonusDraft.amount,method:'manual',references:[],updatedAt:new Date().toISOString()};
     bonusEstimates=[...bonusEstimates.filter(e=>e.month!==bonusDraft.month),forecast];
    }
   }
  }
  const next:YearData={...context.data,estimates:fresh?.estimated??[],noPaymentMonths:[],bonusEstimates,confirmedAt:null};
  if(!context.data.noPaymentMonths.length&&
   JSON.stringify(next.estimates.map(e=>[e.month,e.amount,e.method,e.references]))===JSON.stringify(context.data.estimates.map(e=>[e.month,e.amount,e.method,e.references]))&&
   bonusEstimates===context.data.bonusEstimates)return;
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
 }
 async commitBonusEstimate(id:PersonId,year:number,month:string,amount:number):Promise<void>{
  asPersonId(id);checkedMoney(amount);
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  bonusEstimatePreview(context.data,month,amount);
  const forecast={month,amount,method:'manual' as const,references:[],updatedAt:new Date().toISOString()};
  const next:YearData={...context.data,bonusEstimates:[...context.data.bonusEstimates.filter(e=>e.month!==month),forecast],confirmedAt:null};
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
 }
 async setNoPay(id:PersonId,year:number,month:string,noPay:boolean):Promise<void>{
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||Number(month.slice(0,4))!==year)throw new Error('対象月が不正です。');
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  if(noPay&&(context.data.documents.some(d=>d.kind==='salary'&&monthOf(d.paymentDate)===month)||context.data.estimates.some(e=>e.month===month)))throw new Error('実績または見込みが存在する月は支給なしにできません。');
  const next={...context.data,noPaymentMonths:noPay?[...new Set([...context.data.noPaymentMonths,month])]:context.data.noPaymentMonths.filter(m=>m!==month),confirmedAt:null};
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
 }
 /** No silent autosave: encrypted year JSON, checked with ETag and the existing write verification. */
 async saveYearMemo(id:PersonId,year:number,memo:string):Promise<void>{
  asPersonId(id);
  if(!validYearMemo(memo))throw new Error('年度メモは16,000文字以内で入力してください。');
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  if((context.data.memo??'')===memo)return;
  const next:YearData={...context.data,memo};
  await this.saveYear(a,id,year,context.file,next,context.yearFile);
 }
 async recordConfirmation(id:PersonId,year:number):Promise<void>{
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  await this.saveYear(a,id,year,context.file,{...context.data,confirmedAt:new Date().toISOString()},context.yearFile);
 }
 /** Read-only complete snapshot of the separate year-end namespace. All plaintext stays in RAM. */
 async exportBackupSnapshot(progress:(message:string)=>void=()=>{}):Promise<YearEndBackupData>{
  const a=await this.access(),initial=await this.readIndex(a);
  if(initial.value.persons.some(p=>p.state==='deleting'))throw new Error('従業員の削除処理が未完了です。バックアップを中止しました。');
  const active=initial.value.persons.filter(p=>p.state==='active');
  const persons:YearEndBackupData['persons']=[];
  const inspected:Array<{path:string[];name:string;etag:string}>=[];
  const observe=(path:string[],name:string,file:RemoteFile)=>inspected.push({path,name,etag:file.etag});
  if(initial.file)observe(a.path,'index.enc',initial.file);
  for(const row of active){
   const root=this.personPath(a,row.id),profile=await this.profile(a,row.id);
   if(!profile.file)throw new Error('従業員情報が見つかりません。');
   observe(root,'profile.enc',profile.file);
   const years:YearData[]=[],originals:YearEndBackupData['persons'][number]['originals']=[];
   const used=new Set<string>();
   for(const [rawYear,fileId] of Object.entries(profile.value.yearFiles)){
    const year=Number(rawYear);
    const path=[...root,'years'],file=await this.readJson<YearData>(a,'year',path,fileId+'.enc',MAX_YEAR);
    if(!file?.file)throw new Error('年度ファイルが欠落しています。バックアップを中止しました。');
    years.push(validateYear(file.value,row.id,year));observe(path,fileId+'.enc',file.file);
    for(const record of file.value.documents){
     if(used.has(record.id))throw new Error('従業員内で明細IDが重複しています。');
     used.add(record.id);
     const path=[...root,'originals'],original=await a.graph.read(path,record.id+'.enc',MAX_PDF);
     if(!original)throw new Error('原本PDFが欠落しています。バックアップを中止しました。');
     const bytes=await decryptBytes(kinds.original,original.text,a.key);
     if(bytes.byteLength!==record.pdfSize||await hash(bytes.buffer as ArrayBuffer)!==record.fileHash)
      throw new Error('PDF原本の完全性が一致しません。バックアップを中止しました。');
     originals.push({id:record.id,bytes});
     progress(`従業員 ${persons.length+1}/${active.length}、原本 ${originals.length}件を検証しました`);
    }
   }
   persons.push({profile:profile.value,years,originals});
  }
  // Reject a newly created, deleted or modified index, including an initially absent index.
  const latestIndex=await this.readJson<PersonIndex>(a,'index',a.path,'index.enc',MAX_INDEX);
  if((latestIndex?.file?.etag??null)!==(initial.file?.etag??null))
   throw new Error('バックアップ作成中に従業員索引が更新されました。最初からやり直してください。');
  // Reject an inconsistent multi-file snapshot if any profile/year/index changed while downloading.
  for(const file of inspected){
   const current=await a.graph.metadata(file.path,file.name);
   if(!current||current.etag!==file.etag)throw new Error('バックアップ作成中に別タブでデータが更新されました。最初からやり直してください。');
  }
  const live=await this.access();
  if(live.path.join('/')!==a.path.join('/'))throw new Error('バックアップ中に暗号化保管庫が切り替わりました。');
  return {exportedAt:new Date().toISOString(),persons};
 }
 /** Inspect orphan folders without writing or deleting files. The backup is optional and stays in memory. */
 async inspectRestoreOrphans(backup?:YearEndBackupData):Promise<YearEndRestoreInspection>{
  const a=await this.access();
  const indexFile=await this.readJson<PersonIndex>(a,'index',a.path,'index.enc',MAX_INDEX);
  const index=indexFile?validateIndex(indexFile.value):emptyIndex();
  const indexed=new Map(index.persons.map(p=>[p.id,p.state]));
  const expected=new Map((backup?.persons??[]).map(p=>[p.profile.id,p.profile]));
  const folders=await a.graph.listFolder([...a.path,'persons'])??[];
  const items:YearEndRestoreOrphan[]=[];
  for(const folder of folders){
   const state=indexed.get(folder.name as PersonId);
   if(folder.folder&&state==='active')continue;
   const valid=folder.folder&&isUuid(folder.name);
   const root=[...a.path,'persons',folder.name];
   const content=valid?await a.graph.listFolder(root)??[]:[];
   const years=valid?await a.graph.listFolder([...root,'years'])??[]:[];
   const originals=valid?await a.graph.listFolder([...root,'originals'])??[]:[];
   const unexpectedFiles=!valid?1:
    content.filter(x=>!((x.name==='profile.enc'&&!x.folder)||
      ((x.name==='years'||x.name==='originals')&&x.folder))).length+
    years.filter(x=>x.folder||!/^[-a-f0-9]{36}\.enc$/i.test(x.name)).length+
    originals.filter(x=>x.folder||!/^[-a-f0-9]{36}\.enc$/i.test(x.name)).length;
   const known=expected.get(folder.name as PersonId);
   items.push({id:folder.name,label:known?.displayName??`ID ${folder.name.slice(0,8)}`,
    state:!valid?'unexpected':state==='deleted'?'deleted':state==='deleting'?'deleting':'unindexed',
    profile:content.some(x=>x.name==='profile.enc'&&!x.folder),
    yearFiles:years.length,originals:originals.length,inBackup:Boolean(known),unexpectedFiles});
  }
  return {items,canAttemptResume:items.length>0&&Boolean(backup)&&
   items.every(item=>item.inBackup&&item.state!=='deleting'&&item.state!=='unexpected'&&!item.unexpectedFiles)};
 }
 /** Compare an interrupted restore with exactly the same backup, before allowing any further writes.
  * A different document, an extra file, or invalid ciphertext always blocks resume. */
 private async verifiedRestoreFiles(a:Access,person:YearEndBackupData['persons'][number]):Promise<Map<string,RemoteFile>>{
  const id=asPersonId(person.profile.id),root=this.personPath(a,id);
  const tracked=new Map<string,RemoteFile>();
  const checkNames=(items:Awaited<ReturnType<Access['graph']['listFolder']>>,
   expected:Set<string>,kind:'root'|'file')=>{
   for(const file of items??[]){
    if(!expected.has(file.name)||(kind==='file'&&file.folder)||
     (kind==='root'&&((file.name==='profile.enc')===file.folder)))
     throw new Error('復元途中のフォルダーにバックアップと異なる項目があります。自動削除せず停止しました。');
   }
  };
  checkNames(await a.graph.listFolder(root),new Set(['profile.enc','originals','years']),'root');
  // The two expected subfolders must never contain unreferenced encrypted files.
  checkNames(await a.graph.listFolder([...root,'years']),
   new Set(Object.values(person.profile.yearFiles).map(v=>v+'.enc')),'file');
  checkNames(await a.graph.listFolder([...root,'originals']),
   new Set(person.originals.map(o=>o.id+'.enc')),'file');
  const profile=await this.readJson<PersonProfile>(a,'profile',root,'profile.enc',MAX_PROFILE);
  if(profile){
   validateProfile(profile.value,id);
   if(JSON.stringify(profile.value)!==JSON.stringify(person.profile))
    throw new Error('復元途中の従業員情報がバックアップと一致しません。上書きせず停止しました。');
   tracked.set('profile.enc',profile.file!);
  }
  for(const year of person.years){
   const name=person.profile.yearFiles[String(year.calendarYear)]+'.enc';
   const file=await this.readJson<YearData>(a,'year',[...root,'years'],name,MAX_YEAR);
   if(!file)continue;
   validateYear(file.value,id,year.calendarYear);
   if(JSON.stringify(file.value)!==JSON.stringify(year))
    throw new Error('復元途中の年度データがバックアップと一致しません。上書きせず停止しました。');
   tracked.set('years/'+name,file.file!);
  }
  const documents=new Map(person.years.flatMap(y=>y.documents.map(d=>[d.id,d] as const)));
  for(const original of person.originals){
   const name=original.id+'.enc';
   const file=await a.graph.read([...root,'originals'],name,MAX_PDF);
   if(!file)continue;
   const actual=await decryptBytes(kinds.original,file.text,a.key);
   const expected=documents.get(original.id)!;
   if(actual.length!==expected.pdfSize||await hash(actual.slice().buffer as ArrayBuffer)!==expected.fileHash)
    throw new Error('復元途中のPDF原本がバックアップと一致しません。上書きせず停止しました。');
   tracked.set('originals/'+name,file);
  }
  return tracked;
 }
 /** Non-destructive restore: bring back missing or deleted people, keep active people untouched. */
 async restoreBackupSnapshot(data:YearEndBackupData,progress:(message:string)=>void=()=>{},
  options:{resumeVerifiedOrphans?:boolean}={}):Promise<{restored:number;skipped:number}>{
  const a=await this.access();
  // Do not use readIndex() here: an interrupted first restore can have files but no index yet.
  const storedIndex=await this.readJson<PersonIndex>(a,'index',a.path,'index.enc',MAX_INDEX);
  const current:Read<PersonIndex>=storedIndex?{...storedIndex,value:validateIndex(storedIndex.value)}:
   {value:emptyIndex(),file:null};
  const indexed=new Map(current.value.persons.map(p=>[p.id,p]));
  if(current.value.persons.some(p=>p.state==='deleting'))
   throw new Error('削除途中の従業員がいます。先に状態を確認してください。');
  const folders=await a.graph.listFolder([...a.path,'persons'])??[];
  const expectedIds=new Set(data.persons.map(p=>asPersonId(p.profile.id)));
  const unfinished=new Set<string>();
  for(const folder of folders){
   if(!folder.folder||!isUuid(folder.name))
    throw new Error('従業員フォルダーに不正な項目があります。誤上書きを防ぐため復元を中断しました。');
   const state=indexed.get(folder.name as PersonId)?.state;
   if(state==='active')continue;
   if(!options.resumeVerifiedOrphans||!expectedIds.has(folder.name as PersonId))
    throw new Error('索引未登録または削除済みの従業員フォルダーがあります。復元を中断しました。復元状態を確認してください。');
   unfinished.add(folder.name);
  }
  const ids=new Set<string>(),selected:YearEndBackupData['persons']=[];
  const resumed=new Map<string,Map<string,RemoteFile>>();
  let skipped=0;
  // Validate every backup record and every existing orphan BEFORE any new cloud write.
  for(const person of data.persons){
   const id=asPersonId(person.profile.id);
   if(ids.has(id))throw new Error('バックアップ内で従業員IDが重複しています。');ids.add(id);
   validateProfile(person.profile,id);
   if(person.years.length!==Object.keys(person.profile.yearFiles).length)
    throw new Error('従業員の年度索引と年度データが一致しません。');
   const docs=new Map<string,DocumentRecord>();
   for(const year of person.years){
    if(!person.profile.yearFiles[String(year.calendarYear)])throw new Error('年度の参照先が一致しません。');
    validateYear(year,id,year.calendarYear);
    for(const record of year.documents){
     if(docs.has(record.id))throw new Error('従業員内で明細IDが重複しています。');
     docs.set(record.id,record);
    }
   }
   if(person.originals.length!==docs.size)throw new Error('PDF原本の件数が一致しません。');
   const seen=new Set<string>();
   for(const original of person.originals){
    const doc=docs.get(asDocumentId(original.id));
    if(!doc||seen.has(original.id)||doc.pdfSize!==original.bytes.length||
       await hash(original.bytes.slice().buffer as ArrayBuffer)!==doc.fileHash)
     throw new Error('PDF原本のSHA-256照合に失敗しました。');
    seen.add(original.id);
   }
   const prior=indexed.get(id);
   if(prior?.state==='active'){skipped++;continue;}
   if(unfinished.has(id))resumed.set(id,await this.verifiedRestoreFiles(a,person));
   selected.push(person);
  }
  if(!selected.length)return {restored:0,skipped};
  if(current.value.persons.length+selected.filter(p=>!indexed.has(p.profile.id)).length>2000)
   throw new Error('従業員数の上限を超えています。');
  let count=0;
  const entries:PersonIndex['persons']=[];
  // Files are always create-only. An exact, cryptographically verified preexisting file is reused.
  for(const person of selected){
   const id=asPersonId(person.profile.id),root=this.personPath(a,id),pdfPath=[...root,'originals'];
   const tracked=resumed.get(id)??new Map<string,RemoteFile>();
   for(const original of person.originals){
    const name=original.id+'.enc';
    if(!tracked.has('originals/'+name)){
     await a.graph.write(pdfPath,name,await encryptBytes(kinds.original,original.bytes,a.key),null,MAX_PDF);
     const stored=await a.graph.read(pdfPath,name,MAX_PDF);
     if(!stored)throw new Error('原本PDFの保存照合に失敗しました。');
     const verified=await decryptBytes(kinds.original,stored.text,a.key);
     const record=person.years.flatMap(y=>y.documents).find(d=>d.id===original.id)!;
     if(verified.byteLength!==record.pdfSize||await hash(verified.buffer as ArrayBuffer)!==record.fileHash)
      throw new Error('原本PDFの読み戻し照合に失敗しました。');
     tracked.set('originals/'+name,stored);
    }
    progress(`PDF原本を復元・照合しました：${++count}件`);
   }
   for(const year of person.years){
    const fileId=person.profile.yearFiles[String(year.calendarYear)];
    if(!tracked.has('years/'+fileId+'.enc')){
     const saved=await this.writeJson(a,'year',[...root,'years'],fileId+'.enc',year,null,MAX_YEAR);
     tracked.set('years/'+fileId+'.enc',saved);
    }
   }
   if(!tracked.has('profile.enc')){
    const saved=await this.writeJson(a,'profile',root,'profile.enc',person.profile,null,MAX_PROFILE);
    tracked.set('profile.enc',saved);
   }
   entries.push({id,state:'active',createdAt:person.profile.createdAt,updatedAt:person.profile.updatedAt});
   resumed.set(id,tracked);
  }
  // Recheck every file, including resumed files, and refuse unexpected additions before index commit.
  for(const person of selected){
   const root=this.personPath(a,asPersonId(person.profile.id)),files=resumed.get(person.profile.id)!;
   const expectedRoot=new Set(['profile.enc','years','originals']);
   const expectedYears=new Set(Object.values(person.profile.yearFiles).map(v=>v+'.enc'));
   const expectedPdfs=new Set(person.originals.map(o=>o.id+'.enc'));
   for(const [path,names] of [[root,expectedRoot],[[...root,'years'],expectedYears],[[...root,'originals'],expectedPdfs]] as Array<[string[],Set<string>]>){
    for(const entry of await a.graph.listFolder(path)??[])
     if(!names.has(entry.name))throw new Error('復元中に予期しないファイルが追加されました。索引の更新を中断しました。');
   }
   for(const [key,file] of files){
    const parts=key.split('/'),name=parts.pop()!;
    const remote=await a.graph.metadata([...root,...parts],name);
    if(!remote||remote.etag!==file.etag)
     throw new Error('復元中に別タブでデータが更新されました。索引の更新を中断しました。');
   }
  }
  const latest=await this.readJson<PersonIndex>(a,'index',a.path,'index.enc',MAX_INDEX);
  if((latest?.file?.etag??null)!==(current.file?.etag??null))
   throw new Error('復元中に従業員索引が変更されました。復元を中断しました。');
  const revived=new Map(entries.map(p=>[p.id,p]));
  const merged=[...current.value.persons.map(p=>revived.get(p.id)??p),...entries.filter(p=>!indexed.has(p.id))];
  await this.writeJson(a,'index',a.path,'index.enc',{...emptyIndex(),persons:merged},current.file,MAX_INDEX);
  return {restored:entries.length,skipped};
 }
 async original(id:PersonId,year:number,documentId:string):Promise<Blob>{
  asDocumentId(documentId);
  const a=await this.access(),context=await this.yearContext(a,id,year,false);
  const record=context.data.documents.find(d=>d.id===documentId&&d.personId===id);if(!record)throw new Error('従業員の原本が見つかりません。');
  const file=await a.graph.read([...this.personPath(a,id),'originals'],documentId+'.enc',MAX_PDF);
  if(!file)throw new Error('原本PDFが見つかりません。');
  const bytes=await decryptBytes(kinds.original,file.text,a.key);
  if(bytes.length!==record.pdfSize||await hash(bytes.buffer as ArrayBuffer)!==record.fileHash)throw new Error('PDF原本の完全性が一致しません。');
  return new Blob([new Uint8Array(bytes)],{type:'application/pdf'});
 }
 /** Tombstone before trash: any stale client is refused by assertActive(). */
 async deletePerson(id:PersonId):Promise<{trashed:number;otherVersions:number}> {
  asPersonId(id);const a=await this.access();let index=await this.readIndex(a);
  let person=index.value.persons.find(p=>p.id===id);if(!person||person.state==='deleted')throw new Error('対象の従業員は登録されていません。');
  if(person.state==='active'){
   const next:PersonIndex={...index.value,persons:index.value.persons.map(p=>p.id===id?{...p,state:'deleting',updatedAt:new Date().toISOString()}:p)};
   await this.writeJson(a,'index',a.path,'index.enc',next,index.file,MAX_INDEX);
   index=await this.readIndex(a);person=index.value.persons.find(p=>p.id===id);
  }
  if(person?.state!=='deleting')throw new Error('削除状態が変更されました。');
  const parents:string[][]=[...new Map([[a.path.join('/'),[...a.path,'persons']]]).values()];
  // Earlier generations are inspected so a previously rotated copy cannot be left active.
  const versions=await a.graph.listFolder(['payroll','versions']);
  for(const v of versions??[]){if(!v.folder||!isUuid(v.name))continue;parents.push(['payroll','versions',v.name,'year-end-assist','persons']);}
  parents.push(['payroll','year-end-assist','persons']);
  let trashed=0,checked=0;
  for(const parent of parents){const entries=await a.graph.listFolder(parent);checked++;
   const target=entries?.find(v=>v.name===id);
   if(target){if(!target.folder)throw new Error('従業員の削除先がフォルダーではありません。');await a.graph.trashFolder(parent,target);trashed++;}
   const remaining=(await a.graph.listFolder(parent))?.find(v=>v.name===id);
   if(remaining)throw new Error('従業員のフォルダー削除が完了していません。');
  }
  index=await this.readIndex(a);
  if(index.value.persons.find(p=>p.id===id)?.state!=='deleting')throw new Error('削除記録が他端末で更新されました。');
  await this.writeJson(a,'index',a.path,'index.enc', {...index.value,persons:index.value.persons.map(p=>p.id===id?{...p,state:'deleted',updatedAt:new Date().toISOString()}:p)},index.file,MAX_INDEX);
  return {trashed,otherVersions:checked-1};
 }
}
