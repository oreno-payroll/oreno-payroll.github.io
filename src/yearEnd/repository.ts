/** Isolated encrypted third-party namespace. Never calls payrollStore or income publication. */
import {cloudVault,captureOperationAuthorization} from '../cloud/auth';
import {mutationEpoch} from '../cloud/snapshot';
import {encryptJson,decryptJson,encryptBytes,decryptBytes} from '../cloud/crypto';
import {isCollision,type RemoteFile} from '../cloud/graph';
import {beginPerfOperation} from '../cloud/perf';
import {yearEndPdfName,yearEndUpdatedPdfName} from '../storage/fileNaming';
import {MAX_TOTAL_PDF_BYTES} from '../storage/storageLimits';
import type {VerifiedYearEndPdf} from './pdfExport';
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
/** Bound to one year-end edit only. Never saved to storage or shared between operations. */
interface ActiveWriteProof {profile:Read<PersonProfile>; activeIndex:Read<PersonIndex>}
interface VerifiedRead {value:unknown;id:string;etag:string;size?:number}
const safeText=(s:string,max=80)=>typeof s==='string'&&s.trim().length>0&&s.trim().length<=max&&!/[\u0000-\u001f]/.test(s);
const clean=(v:string)=>v.trim();
const base64Name=(value:string)=>value.replace(/[\\/\u0000-\u001f]/g,'').slice(0,250)||'原本.pdf';
const hash=async(bytes:ArrayBuffer):Promise<string>=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
// Production imports beginPerfOperation. The fallback is used solely by existing
// isolated VM regression fixtures that strip all imports before evaluation.
const yearEndPerf=(operation:Parameters<typeof beginPerfOperation>[0])=>
 typeof beginPerfOperation==='function'?beginPerfOperation(operation):{
  measure:<T>(_phase:string,work:()=>Promise<T>):Promise<T>=>work(),
  finish:(_success:boolean):void=>{},
 };
const copyReadOnly=<T>(value:T):T=>
 typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value)) as T;

/** Read-only report for an incomplete employee restore. No cloud mutation is performed. */
export interface YearEndRestoreOrphan {
 id:string; label:string; state:'unindexed'|'deleted'|'deleting'|'unexpected';
 profile:boolean; yearFiles:number; originals:number; inBackup:boolean; unexpectedFiles:number;
}
export interface YearEndRestoreInspection {items:YearEndRestoreOrphan[]; canAttemptResume:boolean}
/** Read-only preview. A plan can become stale; restoreBackupSnapshot validates again. */
export interface YearEndRestorePreview {
 items:Array<{id:PersonId;label:string;status:'restore'|'skip'|'blocked';reason:string;sameNameCollision:boolean}>;
 restorable:number;skipped:number;blocked:number;sameNameCollisions:number;canRestore:boolean;warning:string;
}

export class YearEndRepository {
 // Read-only, bounded, verified in-memory snapshots. No persistent cache.
 // Save/modify/delete paths intentionally NEVER use these snapshots.
 private readOnlyProfiles=new Map<string,VerifiedRead>();
 private readOnlyYears=new Map<string,VerifiedRead>();
 private readOnlyScope:{graph:Access['graph'];key:CryptoKey;salt:string;path:string}|null=null;
 private checkReadOnlyScope(a:Access):void {
  const path=a.path.join('/'),old=this.readOnlyScope;
  if(!old||old.graph!==a.graph||old.key!==a.key||old.salt!==a.salt||old.path!==path){
   this.readOnlyProfiles.clear();this.readOnlyYears.clear();
   this.readOnlyScope={graph:a.graph,key:a.key,salt:a.salt,path};
  }
 }
 /** A fresh Graph metadata GET is required even for an in-memory cache hit.
  * ETag, item identity and size must all match; any failure aborts instead of
  * serving old data. The result never includes a reusable write ETag. */
 private async readOnlyJson<T>(a:Access,kind:'profile'|'year',path:string[],name:string,max:number,
  validate:(value:T)=>T,captureVerified?:(entry:VerifiedRead)=>void,directChild=false):Promise<T|null>{
  this.checkReadOnlyScope(a);
  const scope=this.readOnlyScope;
  const cache=kind==='profile'?this.readOnlyProfiles:this.readOnlyYears;
  const cacheKey=path.join('/')+'/'+name;
  const prior=cache.get(cacheKey);
  if(prior&&typeof a.graph.metadata==='function'){
   const current=await a.graph.metadata(path,name);
   if(scope!==this.readOnlyScope)throw new Error('保管庫の接続先または鍵が変更されました。読み直してください。');
   if(!current){cache.delete(cacheKey);return null;}
   if(current.size!==undefined&&(!Number.isSafeInteger(current.size)||current.size<1||current.size>max))
    throw new Error('OneDriveファイルの容量が不正です。');
   if(prior.id===current.id&&prior.etag===current.etag&&prior.size===current.size){
    const value=copyReadOnly(prior.value) as T;
    captureVerified?.({value:copyReadOnly(value),id:prior.id,etag:prior.etag,size:prior.size});
    return value;
   }
  }
  // A new file, changed ETag, or missing cache requires a full authenticated
  // decrypt+schema validation, never a metadata-only result.
  cache.delete(cacheKey);
  const fresh=await this.readJson<T>(a,kind,path,name,max,directChild);
  if(scope!==this.readOnlyScope)throw new Error('保管庫の接続先または鍵が変更されました。読み直してください。');
  if(!fresh)return null;
  const validated=validate(fresh.value);
  if(fresh.file?.id&&fresh.file.etag){
   const bound=kind==='profile'?128:8;
   if(cache.size>=bound)cache.delete(cache.keys().next().value!);
   const entry={value:copyReadOnly(validated),id:fresh.file.id,etag:fresh.file.etag,size:fresh.file.size};
   cache.set(cacheKey,entry);
   // Couple the version proof with the exact returned profile in this turn.
   // Never retrieve an identity from the shared Map after another await.
   captureVerified?.({value:copyReadOnly(entry.value),id:entry.id,etag:entry.etag,size:entry.size});
  }
  return validated;
 }
 /** Used only for display. Mutations use profile() and always fetch live index and profile. */
 private async readOnlyProfile(a:Access,id:PersonId,captureVerified?:(entry:VerifiedRead)=>void):Promise<PersonProfile>{
  await this.assertActive(a,id);
  const value=await this.readOnlyJson<PersonProfile>(a,'profile',this.personPath(a,id),'profile.enc',MAX_PROFILE,
   profile=>validateProfile(profile,id),captureVerified);
  if(!value)throw new Error('従業員プロフィールが見つかりません。');
  return value;
 }
 private async access():Promise<Access> {const vault=await cloudVault();return vault.yearEndAccess();}
 private personPath(a:Access,id:PersonId):string[]{return [...a.path,'persons',id];}
 private async readJson<T>(a:Access,kind:Exclude<Kind,'original'>,path:string[],name:string,max:number,directChild=false):Promise<Read<T>|null>{
  const file=directChild?await a.graph.read(path,name,max,true):await a.graph.read(path,name,max);if(!file)return null;
  return {value:await decryptJson<T>(kinds[kind],file.text,a.key),file};
 }
 private async writeJson(a:Access,kind:Exclude<Kind,'original'>,path:string[],name:string,value:unknown,prior:RemoteFile|null,max:number):Promise<RemoteFile>{
  const live=await this.access();
  if(live.path.join('/')!==a.path.join('/')||live.key!==a.key||live.salt!==a.salt)
   throw new Error('保管庫の暗号世代または鍵が変更されています。再読み込みしてください。');
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
 async people(useNavigation=false,forceFresh=false,onProgress?:(done:number,total:number)=>void):Promise<Array<PersonProfile & {state:'active'|'deleting'}>>{
  const perf=yearEndPerf('yearend-people');let success=false;
  try{
  const vault=useNavigation?await cloudVault():null;
  const epoch=useNavigation?mutationEpoch():'',authorized=useNavigation?captureOperationAuthorization():()=>true;
  const a=await perf.measure('yearend-access',()=>vault?vault.yearEndAccess():this.access());
  const guard=()=>authorized()&&(!useNavigation||epoch===mutationEpoch());
  if(vault&&!forceFresh){
   const cached=await vault.readPeopleNavigation(a.path);
   if(!guard())throw new Error('接続状態が変更されました。読み直してください。');
   if(Array.isArray(cached)&&cached.length<=2000){
    try{
     const ids=new Set<string>();
     const list=cached.map(row=>{
      if(!row||!['active','deleting'].includes(row.state)||ids.has(row.id))throw new Error('invalid employee cache');
      const profile=validateProfile(row,asPersonId(row.id));ids.add(profile.id);
      return {...profile,state:row.state as 'active'|'deleting'};
     });
     success=true;return list;
    }catch{/* Fall back to authenticated live profiles. */}
   }
  }
  const idx=await perf.measure('yearend-index',()=>this.readIndex(a));
  const rows=idx.value.persons.filter(row=>row.state!=='deleted');
  const result:Array<PersonProfile & {state:'active'|'deleting'}|undefined>=new Array(rows.length);
  // Profile GETs are independent. Limit concurrency to avoid Graph throttling, and
  // publish the list only after every profile passes its existing validation.
  let cursor=0,completed=0;
  onProgress?.(0,rows.length);
  const worker=async():Promise<void>=>{
   while(cursor<rows.length){
    const position=cursor++,row=rows[position];
    const profile=await perf.measure('yearend-profile',()=>this.readOnlyJson<PersonProfile>(a,'profile',this.personPath(a,row.id),'profile.enc',MAX_PROFILE,
     value=>validateProfile(value,row.id),undefined,true));
    if(!profile){
     if(row.state!=='deleting')throw new Error('従業員プロフィールが存在しません。');
     result[position]={format:'payroll-year-end-person-v1',id:row.id,displayName:'削除未完了',alias:'',createdAt:row.createdAt,updatedAt:row.updatedAt,yearFiles:{},state:'deleting'};
    }else result[position]={...profile,state:row.state==='active'?'active':'deleting'};
    if(!guard())throw new Error('接続状態が変更されました。読み直してください。');
    onProgress?.(++completed,rows.length);
   }
  };
  await Promise.all(Array.from({length:Math.min(5,rows.length)},()=>worker()));
  const list=result.map(profile=>{if(!profile)throw new Error('従業員一覧の取得が完了しませんでした。');return profile;}).sort((x,y)=>x.createdAt.localeCompare(y.createdAt));
  if(vault){
   if(!guard())throw new Error('接続状態が変更されました。読み直してください。');
   await vault.rememberPeopleNavigation(a.path,list,epoch);
   if(!guard())throw new Error('接続状態が変更されました。読み直してください。');
  }
  success=true;return list;
  }finally{perf.finish(success);}
 }
 private async assertActive(a:Access,id:PersonId):Promise<void>{
  const idx=await this.readIndex(a);
  if(!idx.value.persons.some(p=>p.id===id&&p.state==='active'))throw new Error('対象の従業員は未登録または削除処理中です。');
 }
 /** Fetch a fresh active-state index and a validated profile together, once per edit. */
 private async activeProfile(a:Access,id:PersonId):Promise<ActiveWriteProof>{
  const activeIndex=await this.readIndex(a);
  if(!activeIndex.value.persons.some(p=>p.id===id&&p.state==='active'))
   throw new Error('対象の従業員は未登録または削除処理中です。');
  const current=await this.readJson<PersonProfile>(a,'profile',this.personPath(a,id),'profile.enc',MAX_PROFILE);
  if(!current)throw new Error('従業員プロフィールが見つかりません。');
  return {activeIndex,profile:{...current,value:validateProfile(current.value,id)}};
 }
 private async profile(a:Access,id:PersonId):Promise<Read<PersonProfile>>{
  return (await this.activeProfile(a,id)).profile;
 }
 async createPerson(displayName:string,alias=''):Promise<PersonProfile>{
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
   try{await this.writeJson(a,'index',a.path,'index.enc',next,idx.file,MAX_INDEX);return profile;}
   catch(error){if(isCollision(error))continue;throw error;}
  }
  throw new Error('従業員登録が競合しました。再実行してください。孤立したプロフィールは自動削除しません。');
 }
 async renamePerson(id:PersonId,name:string,alias:string,expectedName?:string):Promise<PersonProfile>{
  asPersonId(id);if(!safeText(name)||alias.length>80||/[\u0000-\u001f]/.test(alias))throw new Error('表示名が不正です。');
  const a=await this.access(),current=await this.profile(a,id);
  if(expectedName!==undefined&&(current.value.displayName!==expectedName||current.value.alias!==alias))throw new Error('従業員名が更新されました。最新の一覧を確認してください。');
  const next={...current.value,displayName:clean(name),alias:clean(alias),updatedAt:new Date().toISOString()};
  await this.assertActive(a,id);await this.writeJson(a,'profile',this.personPath(a,id),'profile.enc',next,current.file,MAX_PROFILE);return next;
 }
 private async yearContext(a:Access,id:PersonId,year:number,create:boolean):Promise<{profile:Read<PersonProfile>;activeIndex:Read<PersonIndex>;data:YearData;file:RemoteFile|null;yearFile:string|null}>{
  asPersonId(id);if(!validYear(year))throw new Error('暦年が不正です。');
  let proof=await this.activeProfile(a,id),{profile,activeIndex}=proof;
  let name=profile.value.yearFiles[String(year)];
  if(!name){if(!create)return {profile,activeIndex,data:emptyYear(id,year),file:null,yearFile:null};
   name=crypto.randomUUID() as typeof name;
   const blank=emptyYear(id,year);await this.writeJson(a,'year',[...this.personPath(a,id),'years'],name+'.enc',blank,null,MAX_YEAR);
   const next:PersonProfile={...profile.value,yearFiles:{...profile.value.yearFiles,[String(year)]:name},updatedAt:new Date().toISOString()};
   try{await this.writeJson(a,'profile',this.personPath(a,id),'profile.enc',next,profile.file,MAX_PROFILE);}
   catch(error){throw new Error('年度の登録確認に失敗しました。再読み込みしてください。未参照の暗号化ファイルが残った可能性があります。',{cause:error});}
   proof=await this.activeProfile(a,id);profile=proof.profile;activeIndex=proof.activeIndex;
  }
  if(!isUuid(name))throw new Error('年度ファイルIDが不正です。');
  const file=await this.readJson<YearData>(a,'year',[...this.personPath(a,id),'years'],name+'.enc',MAX_YEAR);
  if(!file)throw new Error('年度ファイルが見つかりません。');
  return {profile,activeIndex,data:validateYear(file.value,id,year),file:file.file,yearFile:name};
 }
 private async verifiedDisplayYear(a:Access,id:PersonId,year:number,profile:PersonProfile):Promise<YearData>{
  const name=profile.yearFiles[String(year)];
  if(!name)return emptyYear(id,year);
  if(!isUuid(name))throw new Error('年度ファイルIDが不正です。');
  const data=await this.readOnlyJson<YearData>(a,'year',
   [...this.personPath(a,id),'years'],name+'.enc',MAX_YEAR,value=>validateYear(value,id,year));
  if(!data)throw new Error('年度ファイルが見つかりません。');
  return data;
 }
 /** Return the year immediately, with a deferred read-only name comparison.
  * The deferred job shares the initial validated profile, but probes its live
  * ETag before and after comparing names so recently added years are included.
  */
 async yearWithOtherYearNames(id:PersonId,year:number):Promise<{data:YearData;otherYearNames:()=>Promise<string[]>}>{
  asPersonId(id);if(!validYear(year))throw new Error('暦年が不正です。');
  const perf=yearEndPerf('yearend-year');let success=false;
  let a:Access,profile:PersonProfile,data:YearData;
  let verified:VerifiedRead|undefined;
  try{
   a=await perf.measure('yearend-access',()=>this.access());
   profile=await perf.measure('yearend-profile',()=>this.readOnlyProfile(a,id,entry=>{verified=entry;}));
   data=await perf.measure('yearend-context',()=>this.verifiedDisplayYear(a,id,year,profile));
   success=true;
  }finally{perf.finish(success);}
  // The profile/version pair is captured atomically by the validated read.
  // Another read may replace the shared Map while year JSON is being fetched.
  const profilePath=this.personPath(a,id);
  const stillUnlocked=async()=>{
   const vault=await cloudVault();
   if(!vault.isUnlocked()||(vault.graph&&vault.graph!==a.graph)||
      vault.sessionKey().key!==a.key||vault.sessionKey().salt!==a.salt)
    throw new Error('保管庫がロックまたは変更されました。他年度の氏名照合を中止しました。');
  };
  const matches=(meta:{id:string;etag:string;size?:number}|null,entry:VerifiedRead|undefined)=>
   Boolean(meta&&entry&&meta.id===entry.id&&meta.etag===entry.etag&&meta.size===entry.size);
  return {data,otherYearNames:async()=>{
   let currentProfile=profile;
   for(let attempt=0;attempt<3;attempt++){
    await stillUnlocked();
    const before=await a.graph.metadata(profilePath,'profile.enc');
    await stillUnlocked();
    if(!before)throw new Error('従業員プロフィールが見つかりません。');
    if(!matches(before,verified)){
     // Changed ETag/identity: validate active employee and decrypt the latest
     // profile before deciding which years to compare. No stale year list.
     currentProfile=await this.readOnlyProfile(a,id,entry=>{verified=entry;});
     if(!matches(before,verified))continue; // changed during the reload
    }
    const names=await this.otherYearNamesFromProfile(a,id,year,currentProfile);
    await stillUnlocked();
    const after=await a.graph.metadata(profilePath,'profile.enc');
    await stillUnlocked();
    if(matches(after,verified))return names;
    // Another tab added/removed a year during the background comparison.
    // Repeat with the new profile, or fail closed if it keeps changing.
   }
   throw new Error('他年度の氏名照合中に従業員プロフィールが変更されました。再読み込みしてください。');
  }};
 }
 async year(id:PersonId,year:number):Promise<YearData>{
  const perf=yearEndPerf('yearend-year');let success=false;
  try{
   asPersonId(id);if(!validYear(year))throw new Error('暦年が不正です。');
   const a=await perf.measure('yearend-access',()=>this.access());
   const profile=await perf.measure('yearend-profile',()=>this.readOnlyProfile(a,id));
   const data=await perf.measure('yearend-context',()=>this.verifiedDisplayYear(a,id,year,profile));
   success=true;return data;
  }finally{perf.finish(success);}
 }
 /** Read-only comparison across other years; names remain in encrypted annual files. */
 async otherYearDetectedNames(id:PersonId,exceptYear:number):Promise<string[]>{
  const a=await this.access(),profile=await this.readOnlyProfile(a,id);
  return this.otherYearNamesFromProfile(a,id,exceptYear,profile);
 }
 private async otherYearNamesFromProfile(a:Access,id:PersonId,exceptYear:number,profile:PersonProfile):Promise<string[]>{
  const names:string[]=[];
  const years=Object.entries(profile.yearFiles).filter(([y])=>Number(y)!==exceptYear);
  // A single decrypted year JSON per year; do not repeat index/profile network reads.
  for(let i=0;i<years.length;i+=2){
   const results=await Promise.all(years.slice(i,i+2).map(async([year,fileId])=>{
    const remote=await this.readOnlyJson<YearData>(a,'year',[...this.personPath(a,id),'years'],fileId+'.enc',MAX_YEAR,
     value=>validateYear(value,id,Number(year)));
    if(!remote)throw new Error('他年度のファイルが見つかりません。');
    return remote.documents;
   }));
   for(const docs of results)for(const record of docs)if(record.detectedName)names.push(record.detectedName);
  }
  return names;
 }

 private async saveYear(a:Access,id:PersonId,year:number,prior:RemoteFile|null,data:YearData,name:string|null,proof?:ActiveWriteProof):Promise<void>{
  validateYear(data,id,year);if(!name)throw new Error('年度ファイルが未登録です。');
  // Earlier versions stored deleted salary amounts in history. Never write them again.
  const live=new Set(data.documents.map(d=>d.id));
  data={...data,history:data.history.flatMap(event=>{
   if(!event.documentId||live.has(event.documentId))return [event];
   return event.kind==='document-deleted'?[{at:event.at,kind:event.kind,month:event.month,documentId:event.documentId}]:[];
  })};
  // Two independent metadata checks can run together. If both versions match
  // this operation's validated snapshot, no second ciphertext GET is needed.
  // A changed/missing item must be fully fetched and validated, never trusted.
  if(proof?.activeIndex.file?.id&&proof.profile.file?.id&&typeof a.graph.metadata==='function'){
   const [liveIndex,liveProfile]=await Promise.all([
    a.graph.metadata(a.path,'index.enc'),
    a.graph.metadata(this.personPath(a,id),'profile.enc'),
   ]);
   const matched=(live:{id:string;etag:string;size?:number}|null,file:RemoteFile)=>
    Boolean(live&&live.id===file.id&&live.etag===file.etag&&live.size===file.size);
   let confirmedProfile=liveProfile;
   if(!matched(liveIndex,proof.activeIndex.file)){
    await this.assertActive(a,id);
    // Keep the previous index-then-profile check order if the index changed
    // while the two initial metadata requests were in flight.
    confirmedProfile=await a.graph.metadata(this.personPath(a,id),'profile.enc');
   }else if(!proof.activeIndex.value.persons.some(p=>p.id===id&&p.state==='active'))
    throw new Error('対象の従業員は未登録または削除処理中です。');
   if(!matched(confirmedProfile,proof.profile.file)){
    const remote=await this.readJson<PersonProfile>(a,'profile',this.personPath(a,id),'profile.enc',MAX_PROFILE);
    if(!remote)throw new Error('従業員プロフィールが見つかりません。');
    if(validateProfile(remote.value,id).yearFiles[String(year)]!==name)
     throw new Error('年度ファイルの参照先が更新されました。再読み込みしてください。');
   }else if(proof.profile.value.yearFiles[String(year)]!==name)
    throw new Error('年度ファイルの参照先が更新されました。再読み込みしてください。');
  }else{
   // Synthetic Graph fixtures and legacy adapters without metadata use the
   // original fresh index/profile validation, never a metadata-only shortcut.
   const current=await this.profile(a,id);
   if(current.value.yearFiles[String(year)]!==name)throw new Error('年度ファイルの参照先が更新されました。再読み込みしてください。');
  }
  // writeJson() performs a fresh vault generation/rotation/key check just before
  // its conditional ETag write and still reads back the encrypted result.
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
   fileName:base64Name(yearEndPdfName(draft.kind,draft.paymentDate,file.name)),pdfSize:bytes.byteLength,fileHash:digest,detectedName:draft.detectedName??null,confirmedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'pdf-reviewed',revision:1};
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
  try{await this.saveYear(a,id,year,current.file,next,current.yearFile,current);}
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
   additions:Array<{file:File;draft:DraftDocument}>,acknowledgedAmountWarning=false,onProgress?:(done:number,total:number)=>void,
   deletions:Array<{documentId:string;expectedRevision:number}>=[]):Promise<{data:YearData;yearFiles:PersonProfile['yearFiles'];cleanupPending:number}>{
  asPersonId(id);if(!validYear(year))throw new Error('保存先の暦年が不正です。');
  if(!updates.length&&!additions.length&&!deletions.length)throw new Error('保存する明細がありません。');
  if(updates.length+additions.length+deletions.length>50)throw new Error('一度に保存できる明細が多すぎます。');
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
  const perf=yearEndPerf('yearend-pdf-batch');let perfSuccess=false;
  try{
  const a=await this.access(),context=await this.yearContext(a,id,year,Boolean(additions.length));
  const now=new Date().toISOString();
  let working:YearData={...context.data,documents:[...context.data.documents],estimates:[...context.data.estimates],
   bonusEstimates:[...context.data.bonusEstimates],noPaymentMonths:[...context.data.noPaymentMonths],history:[...context.data.history]};
  const changes=new Set<string>();
  const removed:DocumentRecord[]=[];
  for(const deletion of deletions){
   asDocumentId(deletion.documentId);
   if(changes.has(deletion.documentId))throw new Error('同じ明細が重複指定されています。');
   changes.add(deletion.documentId);
   const prior=working.documents.find(r=>r.id===deletion.documentId);
   if(!prior||prior.revision!==deletion.expectedRevision)throw new Error('他の画面で削除対象の明細が更新されています。年度を読み直してください。');
   removed.push(prior);
   working={...working,documents:working.documents.filter(r=>r.id!==prior.id),
    estimates:working.estimates.filter(e=>!e.references.includes(prior.id)),
    confirmedAt:null,
    history:[...working.history.filter(event=>event.documentId!==prior.id),
     {at:now,kind:'document-deleted',month:monthOf(prior.paymentDate),documentId:prior.id}]};
  }
  for(const update of updates){
   asDocumentId(update.documentId);
   if(changes.has(update.documentId))throw new Error('同じ明細が重複編集されています。');
   changes.add(update.documentId);
   const prior=working.documents.find(r=>r.id===update.documentId);
   if(!prior||prior.revision!==update.expectedRevision)throw new Error('他の画面で明細が更新されています。年度を読み直してください。');
   const d=update.draft;
   const record:DocumentRecord={...prior,fileName:yearEndUpdatedPdfName(prior.kind,prior.paymentDate,prior.fileName,d.kind,d.paymentDate),kind:d.kind,paymentDate:d.paymentDate,targetMonth:d.targetMonth,
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
  const prepared:Array<{file:File;bytes:ArrayBuffer;digest:string;draft:DraftDocument}|undefined>=new Array(additions.length);
  let prepareCursor=0;
  const prepareWorker=async():Promise<void>=>{
   while(prepareCursor<additions.length){
    const position=prepareCursor++,x=additions[position];
    const bytes=await x.file.arrayBuffer();
    if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('PDF原本のヘッダーが不正です。');
    prepared[position]={file:x.file,bytes,digest:await hash(bytes),draft:x.draft};
   }
  };
  // Parallelize read/hash only; duplicate/model checks still finish before cloud writes.
  await Promise.all(Array.from({length:Math.min(3,additions.length)},()=>prepareWorker()));
  for(const entry of prepared){
   if(!entry)throw new Error('PDF原本の準備が完了しませんでした。');
   const x=entry,bytes=x.bytes,digest=x.digest;
   if(working.documents.some(r=>r.fileHash===digest)||pending.some(p=>p.digest===digest))
    throw new Error('同一内容のPDFが保存済みまたは保存対象にあります。');
   const d=x.draft;
   const record:DocumentRecord={id:randomDocumentId(),personId:id,kind:d.kind,paymentDate:d.paymentDate,targetMonth:d.targetMonth,
    taxable:checkedMoney(d.taxable),gross:d.gross,transportation:d.transportation,nonTaxable:d.nonTaxable,
    healthInsurance:d.healthInsurance,pension:d.pension,employmentInsurance:d.employmentInsurance,
    incomeTax:d.incomeTax,residentTax:d.residentTax,fileName:base64Name(yearEndPdfName(d.kind,d.paymentDate,x.file.name)),pdfSize:bytes.byteLength,
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
   const otherYears=Object.entries(context.profile.value.yearFiles).filter(([y])=>Number(y)!==year);
   const otherRecords=await Promise.all(otherYears.map(async ([y,fileId])=>{
    const remote=await this.readJson<YearData>(a,'year',[...this.personPath(a,id),'years'],fileId+'.enc',MAX_YEAR);
    if(!remote)throw new Error('同じ従業員の別年度ファイルが見つかりません。');
    return validateYear(remote.value,id,Number(y)).documents;
   }));
   const otherHashes=new Set(otherRecords.flat().map(r=>r.fileHash));
   if(pending.some(x=>otherHashes.has(x.digest)))throw new Error('同じ従業員の別年度に登録済みのPDFがあります。');
  }
  // Three concurrent, independently verified originals; all writes must settle
  // before returning a failure so no upload keeps running after the error UI appears.
  const originalPath=[...this.personPath(a,id),'originals'];
  let completedOriginals=0;
  const uploadAndCheck=async (entry:typeof pending[number])=>{
   const encrypted=await encryptBytes(kinds.original,new Uint8Array(entry.bytes),a.key);
   await a.graph.write(originalPath,entry.record.id+'.enc',encrypted,null,MAX_PDF);
   const stored=await a.graph.read(originalPath,entry.record.id+'.enc',MAX_PDF);
   if(!stored)throw new Error('原本PDFの暗号化保存照合に失敗しました。');
   const restored=await decryptBytes(kinds.original,stored.text,a.key);
   if(restored.byteLength!==entry.bytes.byteLength||await hash(restored.buffer as ArrayBuffer)!==entry.digest)
    throw new Error('暗号化PDF原本のSHA-256照合に失敗しました。');
   onProgress?.(++completedOriginals,pending.length);
  };
  for(let i=0;i<pending.length;i+=3){
   const outcomes=await Promise.allSettled(pending.slice(i,i+3).map(uploadAndCheck));
   const failed=outcomes.find((result):result is PromiseRejectedResult=>result.status==='rejected');
   if(failed)throw new Error('PDFの暗号化保存中に問題が発生しました。未参照の暗号化PDFが残った可能性があります。再読み込みして状況を確認してください。',{cause:failed.reason});
  }
  try{await this.saveYear(a,id,year,context.file,working,context.yearFile,context);}
  catch(error){throw new Error(pending.length?'暗号化PDF原本は保存されましたが、年度データの確定に失敗しました。二重登録せず再読み込みしてください。':'年度データの保存に失敗しました。再読み込みしてください。',{cause:error});}
  // The annual ETag commit is authoritative. Original PDFs are moved to the
  // OneDrive recycle bin only AFTER that successful commit. Cleanup failures
  // cannot turn a committed save into an ambiguous retryable failure.
  let cleanupPending=0;
  if(removed.length){
   const path=[...this.personPath(a,id),'originals'];
   try{
    const listed=await a.graph.listFolder(path);
    if(!listed)throw new Error('原本フォルダを確認できません。');
    const byName=new Map(listed.map(file=>[file.name,file]));
    for(const record of removed){
     const file=byName.get(record.id+'.enc');
     if(!file||file.folder){cleanupPending++;continue;}
     try{await a.graph.trashFile(path,file);}catch{cleanupPending++;}
    }
   }catch{cleanupPending=removed.length;}
  }
  perfSuccess=true;
  return {data:working,yearFiles:context.profile.value.yearFiles,cleanupPending};
  }finally{perf.finish(perfSuccess);}
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
   const foreign=Object.entries(context.profile.value.yearFiles).filter(([y])=>Number(y)!==year);
   // yearContext() already verified the active index and current profile.
   // Only the referenced annual JSON needs to be decrypted and validated; no
   // extra employee-index/profile round trip per year. Limit concurrent GETs.
   for(let offset=0;offset<foreign.length;offset+=3){
    const found=await Promise.all(foreign.slice(offset,offset+3).map(async([y,fileId])=>{
     const remote=await this.readJson<YearData>(a,'year',
      [...this.personPath(a,id),'years'],fileId+'.enc',MAX_YEAR);
     if(!remote)throw new Error('同じ従業員の別年度ファイルが見つかりません。');
     return validateYear(remote.value,id,Number(y)).documents.some(r=>r.fileHash===nextHash);
    }));
    if(found.some(Boolean))throw new Error('この従業員の別年度に同じPDFが登録されています。');
   }
   nextId=randomDocumentId();nextName=base64Name(yearEndPdfName(draft.kind,draft.paymentDate,replacement.name));nextSize=bytes.byteLength;
  }
  const now=new Date().toISOString();
  if(!replacement)nextName=yearEndUpdatedPdfName(prior.kind,prior.paymentDate,prior.fileName,draft.kind,draft.paymentDate);
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
  try{await this.saveYear(a,id,year,context.file,next,context.yearFile,context);}
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
  await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
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
  await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
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
  await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
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
  await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
 }
 /** Commit salary and bonus draft in a single encrypted annual-file update.
  * Protect against changed salary references, old estimates and other-tab edits. */
 async replaceIncomeForecasts(id:PersonId,year:number,method:EstimateMethod,months:string[],overrides:Record<string,number>,
  previousEstimates:Estimate[],previousNoPaymentMonths:string[],expectedReferences:ForecastPreview['references'],
   previousBonusEstimates:Estimate[],bonusDraft?:{month:string;amount:number}|{month:string;remove:true},
   salaryUpdate=true):Promise<void>{
  asPersonId(id);
  const perf=yearEndPerf('yearend-forecast');let perfSuccess=false;
  try{
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  if(JSON.stringify(context.data.estimates)!==JSON.stringify(previousEstimates)||
   JSON.stringify(context.data.noPaymentMonths)!==JSON.stringify(previousNoPaymentMonths)||
   JSON.stringify(context.data.bonusEstimates)!==JSON.stringify(previousBonusEstimates))
   throw new Error('別の画面で見込みが変更されました。再読み込みしてから保存してください。');
  const compatible={...context.data,noPaymentMonths:[]};
   const fresh=salaryUpdate&&months.length?forecastPreview(compatible,method,months,overrides):null;
   if(salaryUpdate&&JSON.stringify(fresh?.references??[])!==JSON.stringify(expectedReferences))
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
   const updatedSalaryEstimates=salaryUpdate?(fresh?.estimated??[]).map(nextEstimate=>{
    const old=context.data.estimates.find(e=>e.month===nextEstimate.month);
    // Selecting manual in order to correct December must not silently
    // rewrite November's original estimate method, references, or timestamp.
    return method==='manual'&&old&&old.amount===nextEstimate.amount?old:nextEstimate;
   }):context.data.estimates;
   const next:YearData={...context.data,
    estimates:updatedSalaryEstimates,
    noPaymentMonths:salaryUpdate?[]:context.data.noPaymentMonths,bonusEstimates,confirmedAt:null};
   if((!salaryUpdate||(!context.data.noPaymentMonths.length&&
     JSON.stringify(next.estimates.map(e=>[e.month,e.amount,e.method,e.references]))===JSON.stringify(context.data.estimates.map(e=>[e.month,e.amount,e.method,e.references]))))&&
    bonusEstimates===context.data.bonusEstimates){perfSuccess=true;return;}
  await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
  perfSuccess=true;
  }finally{perf.finish(perfSuccess);}
 }
 async commitBonusEstimate(id:PersonId,year:number,month:string,amount:number):Promise<void>{
  asPersonId(id);checkedMoney(amount);
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  bonusEstimatePreview(context.data,month,amount);
  const forecast={month,amount,method:'manual' as const,references:[],updatedAt:new Date().toISOString()};
  const next:YearData={...context.data,bonusEstimates:[...context.data.bonusEstimates.filter(e=>e.month!==month),forecast],confirmedAt:null};
  await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
 }
 async setNoPay(id:PersonId,year:number,month:string,noPay:boolean):Promise<void>{
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||Number(month.slice(0,4))!==year)throw new Error('対象月が不正です。');
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  if(noPay&&(context.data.documents.some(d=>d.kind==='salary'&&monthOf(d.paymentDate)===month)||context.data.estimates.some(e=>e.month===month)))throw new Error('実績または見込みが存在する月は支給なしにできません。');
  const next={...context.data,noPaymentMonths:noPay?[...new Set([...context.data.noPaymentMonths,month])]:context.data.noPaymentMonths.filter(m=>m!==month),confirmedAt:null};
  await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
 }
 /** No silent autosave: encrypted year JSON, checked with ETag and the existing write verification. */
 async saveYearMemo(id:PersonId,year:number,memo:string):Promise<void>{
  asPersonId(id);
  if(!validYearMemo(memo))throw new Error('年度メモは16,000文字以内で入力してください。');
  const perf=yearEndPerf('yearend-memo');let success=false;
  try{
   const a=await this.access(),context=await this.yearContext(a,id,year,true);
   if((context.data.memo??'')===memo){success=true;return;}
   const next:YearData={...context.data,memo};
   await this.saveYear(a,id,year,context.file,next,context.yearFile,context);
   success=true;
  }finally{perf.finish(success);}
 }
 async recordConfirmation(id:PersonId,year:number):Promise<void>{
  const a=await this.access(),context=await this.yearContext(a,id,year,true);
  await this.saveYear(a,id,year,context.file,{...context.data,confirmedAt:new Date().toISOString()},context.yearFile,context);
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
 /** Read-only preview of the encrypted index, active employee profiles and folder metadata. Never writes. */
 async previewBackupRestore(data:YearEndBackupData):Promise<YearEndRestorePreview>{
  const a=await this.access();
  // Do not call readIndex: the first interrupted restore may have folders without an index.
  const stored=await this.readJson<PersonIndex>(a,'index',a.path,'index.enc',MAX_INDEX);
  const indexed=new Map((stored?validateIndex(stored.value):emptyIndex()).persons.map(p=>[p.id,p]));
  const folders=await a.graph.listFolder([...a.path,'persons'])??[];
  const found=new Map(folders.map(folder=>[folder.name,folder]));
  const unindexed=folders.filter(folder=>!folder.folder||!isUuid(folder.name)||indexed.get(folder.name as PersonId)?.state!=='active');
  // A backup ID and a newly created employee ID can differ while their visible names match.
  // Look up active profiles only for the names that may actually be restored; read-only.
  const restorableNames=new Set(data.persons.filter(person=>indexed.get(asPersonId(person.profile.id))?.state!=='active')
   .map(person=>person.profile.displayName.normalize('NFKC').trim()));
  const activeNames=new Map<string,Set<PersonId>>();
  if(restorableNames.size){
   const activeRows=[...indexed.values()].filter(row=>row.state==='active');
   for(let i=0;i<activeRows.length;i+=6){
    const profiles=await Promise.all(activeRows.slice(i,i+6).map(async row=>{
     const file=await this.readJson<PersonProfile>(a,'profile',this.personPath(a,row.id),'profile.enc',MAX_PROFILE);
     if(!file)throw new Error('登録済み従業員の情報が見つかりません。復元前に保存状態を確認してください。');
     return validateProfile(file.value,row.id);
    }));
    for(const profile of profiles){
     const name=profile.displayName.normalize('NFKC').trim();
     if(!restorableNames.has(name))continue;
     const matches=activeNames.get(name)??new Set<PersonId>();matches.add(profile.id);activeNames.set(name,matches);
    }
   }
  }
  let restorable=0,skipped=0,blocked=0,sameNameCollisions=0;
  const ids=new Set<string>();
  const items=data.persons.map(person=>{
   const id=asPersonId(person.profile.id);
   if(ids.has(id))throw new Error('バックアップ内で従業員IDが重複しています。');ids.add(id);
   const label=person.profile.alias?`${person.profile.displayName}（${person.profile.alias}）`:person.profile.displayName;
   const prior=indexed.get(id),folder=found.get(id);
   let status:'restore'|'skip'|'blocked'='restore',reason='未登録・復元対象';
   if(prior?.state==='active'){
    if(folder?.folder){status='skip';reason='登録済み・スキップ';}
    else {status='blocked';reason='登録済みですが保存フォルダーが見つかりません';}
   }else if(prior?.state==='deleting'){status='blocked';reason='削除途中のため復元できません';}
   else if(folder){status='blocked';reason='索引未登録・削除済みのフォルダーがあります。復元再開の確認が必要です';}
   else if(prior?.state==='deleted'){reason='削除済み・復元対象';}
   const sameNameCollision=status==='restore'&&[...(activeNames.get(person.profile.displayName.normalize('NFKC').trim())??[])].some(otherId=>otherId!==id);
   if(sameNameCollision){reason+='（同名の別データが追加されます）';sameNameCollisions++;}
   if(status==='restore')restorable++;
   else if(status==='skip')skipped++;
   else blocked++;
   return {id,label,status,reason,sameNameCollision};
  });
  const warnings:string[]=[];
  if(unindexed.length)warnings.push('保存途中または索引未登録の従業員フォルダーがあります。復元前に保存状態を確認してください。');
  if(sameNameCollisions)warnings.push(`同名の別データが${sameNameCollisions}名追加されます。従業員別の復元内容を確認してください。`);
  return {items,restorable,skipped,blocked,sameNameCollisions,warning:warnings.join(' '),canRestore:blocked===0&&unindexed.length===0};
 }
 /** After a failed batch, inspect all PDF references before allowing the user to retry.
  * Never delete, overwrite, or automatically claim unreferenced originals. */
 async inspectUnreferencedOriginals(id:PersonId):Promise<{unreferenced:number;missing:number;referenced:number}>{
  const a=await this.access(),before=await this.readIndex(a),profile=await this.profile(a,id);
  const expected=new Set<string>();
  for(const [year,fileId] of Object.entries(profile.value.yearFiles)){
   const remote=await this.readJson<YearData>(a,'year',[...this.personPath(a,id),'years'],fileId+'.enc',MAX_YEAR);
   if(!remote)throw new Error('参照先の年度ファイルが見つかりません。');
   const yearData=validateYear(remote.value,id,Number(year));
   for(const record of yearData.documents)expected.add(record.id+'.enc');
  }
  const files=await a.graph.listFolder([...this.personPath(a,id),'originals'])??[];
  const found=new Set(files.filter(f=>!f.folder).map(f=>f.name));
  const unreferenced=files.filter(file=>file.folder||!expected.has(file.name)).length;
  const missing=[...expected].filter(name=>!found.has(name)).length;
  const after=await this.readIndex(a);
  const profileNow=await a.graph.metadata(this.personPath(a,id),'profile.enc');
  if((before.file?.etag??null)!==(after.file?.etag??null)||!profileNow||profileNow.etag!==profile.file?.etag)
   throw new Error('確認中に別タブでデータが変更されました。もう一度確認してください。');
  return {unreferenced,missing,referenced:expected.size};
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
 /** 一括ZIP用。年度JSONは一度だけ取得し、各原本は最大3件並列で取得・復号・SHA-256照合。書込みなし。 */
 async originalsForYear(id:PersonId,year:number):Promise<VerifiedYearEndPdf[]> {
  const a=await this.access(),before=await this.yearContext(a,id,year,false);
  const records=before.data.documents;
  if(!records.length)throw new Error('対象年度に保存済みPDFがありません。');
  const total=records.reduce((sum,record)=>sum+record.pdfSize,0);
  if(total>MAX_TOTAL_PDF_BYTES)throw new Error('PDFの合計が480MiBを超えています。年度を分けて取得してください。');
  if(!before.file||!before.yearFile)throw new Error('年度の保存情報が見つかりません。');
  const result:Array<VerifiedYearEndPdf|undefined>=new Array(records.length);
  const path=[...this.personPath(a,id),'originals'];
  let cursor=0;
  const worker=async()=>{
   while(cursor<records.length){
    const i=cursor++,record=records[i];
    const file=await a.graph.read(path,record.id+'.enc',MAX_PDF);
    if(!file)throw new Error('ZIP作成を中止しました。PDF原本が欠落しています。');
    const bytes=await decryptBytes(kinds.original,file.text,a.key);
    if(bytes.length!==record.pdfSize||await hash(bytes.buffer as ArrayBuffer)!==record.fileHash)
     throw new Error('ZIP作成を中止しました。PDF原本の完全性が一致しません。');
    result[i]={record,bytes};
   }
  };
  await Promise.all(Array.from({length:Math.min(3,records.length)},()=>worker()));
  const after=await this.yearContext(a,id,year,false);
  if((after.file?.etag??null)!==before.file.etag||after.yearFile!==before.yearFile||
     (await this.access()).path.join('/')!==a.path.join('/'))
   throw new Error('取得中に年度の保存状態が変わりました。再度ダウンロードしてください。');
  return result.map(item=>{if(!item)throw new Error('PDF原本をすべて取得できませんでした。');return item;});
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
 async deletePerson(id:PersonId,expected?:{state:'active'|'deleting';displayName:string;alias:string}):Promise<{trashed:number;otherVersions:number}> {
  asPersonId(id);const a=await this.access();let index=await this.readIndex(a);
  let person=index.value.persons.find(p=>p.id===id);if(!person||person.state==='deleted')throw new Error('対象の従業員は登録されていません。');
  if(expected&&person.state!==expected.state)throw new Error('従業員の削除状態が更新されました。最新の一覧を確認してください。');
  if(person.state==='active'){
   if(expected){
    const live=await this.readJson<PersonProfile>(a,'profile',this.personPath(a,id),'profile.enc',MAX_PROFILE);
    if(!live)throw new Error('従業員プロフィールが見つかりません。');
    const p=validateProfile(live.value,id);
    if(p.displayName!==expected.displayName||p.alias!==expected.alias)throw new Error('従業員名が更新されました。最新の一覧を確認してください。');
   }
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
