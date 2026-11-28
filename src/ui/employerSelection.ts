import type {EmployerEntry,EmployerRole} from '../storage/employerDirectory';

export function currentEmployer(directory:readonly EmployerEntry[],role:string):string|undefined {
 return directory.find(entry=>entry.role===role&&entry.current)?.id;
}
/** Same-name ordinals use the full directory, independently of display order. */
export function employerNumber(directory:readonly EmployerEntry[],entry:EmployerEntry):string {
 const same=directory.filter(e=>e.name===entry.name).sort((a,b)=>a.id.localeCompare(b.id));
 return same.length>1?String(same.findIndex(e=>e.id===entry.id)+1):'';
}
export function employerChoices(directory:readonly EmployerEntry[],role:string,selected?:string):{id:string;label:string}[] {
 const items=directory.filter(entry=>entry.role===role).sort((a,b)=>Number(b.current)-Number(a.current)||a.name.localeCompare(b.name,'ja')||a.id.localeCompare(b.id));
 const result=items.map(entry=>{const n=employerNumber(directory,entry);return {id:entry.id,label:`${entry.name}（${entry.current?'現在':'過去'}${n?`・${n}`:''}）`};});
 // Never discard an old statement's ID just because a directory is absent or its role differs.
 if(selected&&!result.some(x=>x.id===selected)){
  const known=directory.find(x=>x.id===selected);
  result.push({id:selected,label:known?`${employerDisplayName(directory,known.id)}（既存明細・別勤務区分）`:'未登録の勤務先（既存明細）'});
 }
 return [{id:'',label:'未設定'},...result];
}
export function renderEmployerSelect(select:HTMLSelectElement,directory:readonly EmployerEntry[],role:string,selected?:string):void {
 const options=employerChoices(directory,role,selected).map(item=>{
  const option=select.ownerDocument.createElement('option');option.value=item.id;option.textContent=item.label;return option;
 });
 select.replaceChildren(...options);select.value=selected??'';
}
export interface EmployerReference {employerId?:string;form:Record<string,string>}
export interface LegacyEmployer {id:string;roles:EmployerRole[];count:number;first:string;last:string}
/** Existing IDs can be named without changing any statement. Do not infer an ID for unassigned statements. */
export function legacyEmployers(records:readonly EmployerReference[],directory:readonly EmployerEntry[]):LegacyEmployer[] {
 const known=new Set(directory.map(v=>v.id)),groups=new Map<string,LegacyEmployer>();
 for(const record of records){
  const id=record.employerId,role=record.form.job,month=record.form.targetMonth;
  if(!id||known.has(id)||(role!=='main'&&role!=='side'))continue;
  const entry=groups.get(id)??{id,roles:[],count:0,first:month,last:month};
  if(!entry.roles.includes(role))entry.roles.push(role);entry.count++;
  if(month<entry.first)entry.first=month;if(month>entry.last)entry.last=month;
  groups.set(id,entry);
 }
 return [...groups.values()].sort((a,b)=>a.first.localeCompare(b.first)||a.id.localeCompare(b.id));
}

/** Only unchanged legacy assignments can retain an unknown or mismatched ID. */
export function employerAssignmentAllowed(directory:readonly EmployerEntry[],role:string,id:string|undefined,previous?:EmployerReference):boolean {
 if(id===undefined)return true;
 if(previous?.employerId===id&&previous.form.job===role)return true;
 return directory.some(e=>e.id===id&&e.role===role);
}
export function employerDisplayName(directory:readonly EmployerEntry[],id:string|undefined,role?:string,legacy?:readonly LegacyEmployer[]):string {
 if(!id)return '勤務先未設定';
 const entry=directory.find(e=>e.id===id);
 if(!entry){const n=legacy?.findIndex(e=>e.id===id)??-1;return n>=0?`未登録の勤務先 ${n+1}`:'未登録の勤務先';}
 const number=employerNumber(directory,entry);
 return entry.name+(number?`（${entry.role==='main'?'本業':'副業'}・${number}）`:'')+(role&&role!==entry.role?'（勤務区分不一致）':'');
}
