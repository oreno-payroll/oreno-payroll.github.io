/** Private employer labels belong only in the encrypted Payroll index and backup. */
import {validEmployerId} from './employerIdentity.ts';
import {validateEmployerForecast,type EmployerForecastPreferences} from './employerForecast.ts';
export type EmployerRole='main'|'side';
export interface EmployerEntry {id:string;name:string;role:EmployerRole;current:boolean;forecast?:EmployerForecastPreferences}
const MAX_EMPLOYERS=200;
/** No arbitrary fields, invisible control characters, or duplicate identities/defaults. */
export function validateEmployerDirectory(value:unknown):EmployerEntry[] {
 if(!Array.isArray(value)||value.length>MAX_EMPLOYERS)throw new Error('勤務先一覧の形式または件数が不正です。');
 const ids=new Set<string>(),defaults=new Set<EmployerRole>();
 return Array.from(value,raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==(Object.hasOwn(raw,'forecast')?5:4)||
     !['id','name','role','current'].every(key=>Object.hasOwn(raw,key))||
     typeof raw.id!=='string'||!validEmployerId(raw.id)||ids.has(raw.id)||
     typeof raw.name!=='string'||raw.name!==raw.name.trim()||!raw.name||[...raw.name].length>100||/[\p{Cc}\p{Cf}]/u.test(raw.name)||
     (raw.role!=='main'&&raw.role!=='side')||typeof raw.current!=='boolean'||(raw.current&&defaults.has(raw.role)))
   throw new Error('勤務先一覧に不正または重複した情報があります。');
  ids.add(raw.id);if(raw.current)defaults.add(raw.role);
  return {id:raw.id,name:raw.name,role:raw.role,current:raw.current,...(Object.hasOwn(raw,'forecast')?{forecast:validateEmployerForecast(raw.forecast)}:{})};
 }).sort((a,b)=>a.id.localeCompare(b.id));
}
export function employerDirectorySignature(value:readonly EmployerEntry[]):string {
 return JSON.stringify(validateEmployerDirectory(value));
}
/** Bulk assignment consent concerns the chosen identity, role and displayed name only. */
export function employerAssignmentSignature(directory:readonly EmployerEntry[],id:string):string {
 const entry=validateEmployerDirectory(directory).find(e=>e.id===id);
 return entry?JSON.stringify([entry.id,entry.role,entry.name]):'';
}
/** Restore missing identities without overwriting live labels or current defaults. */
export function mergeEmployerDirectories(live:readonly EmployerEntry[],backup:readonly EmployerEntry[]):EmployerEntry[] {
 const result=validateEmployerDirectory(live),incoming=validateEmployerDirectory(backup);
 const ids=new Set(result.map(v=>v.id)),defaults=new Set(result.filter(v=>v.current).map(v=>v.role));
 for(const entry of incoming){
  if(ids.has(entry.id))continue;
  const current=entry.current&&!defaults.has(entry.role);
  result.push({...entry,current});ids.add(entry.id);if(current)defaults.add(entry.role);
 }
 return validateEmployerDirectory(result);
}

/** Editing a current default demotes its predecessor without deleting any identity. */
export function upsertEmployer(directory:readonly EmployerEntry[],entry:EmployerEntry):EmployerEntry[] {
 const live=validateEmployerDirectory(directory);
 const existing=live.find(x=>x.id===entry.id);
 if(existing&&existing.role!==entry.role)throw new Error('登録済み勤務先の勤務区分は変更できません。');
 const updated=existing?.forecast&&!Object.hasOwn(entry,'forecast')?{...entry,forecast:existing.forecast}:entry;
 return validateEmployerDirectory([...live.filter(x=>x.id!==entry.id).map(x=>entry.current&&x.role===entry.role?{...x,current:false}:x),updated]);
}
