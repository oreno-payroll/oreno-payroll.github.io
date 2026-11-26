import type {EmployerEntry} from '../storage/employerDirectory.ts';
/** Keep historical actuals intact, but never mix independent employer IDs in forecast samples.
 * Legacy records without an ID remain their own unidentified cohort.
 */
export interface EmployerForecastSource {form:Record<string,string>;employerId?:string}
export function activeEmployerSalaries<T extends EmployerForecastSource>(
 salaries:readonly T[],todayIso:string,
):T[]{
 const paid=salaries.filter(item=>item.form.paymentDate<=todayIso);
 const latest=[...paid].sort((a,b)=>b.form.paymentDate.localeCompare(a.form.paymentDate))[0];
 if(!latest)return [];
 return paid.filter(item=>item.employerId===latest.employerId);
}

export type ForecastEmployerSetting=EmployerEntry;
/** A registered current employer takes precedence over the last paid statement.
 * Old role-only data remains readable. An explicitly retired role is not projected.
 */
export function forecastEmployerScope<T extends EmployerForecastSource>(
 records:readonly T[],role:'main'|'side',todayIso:string,directory:readonly ForecastEmployerSetting[]=[],
):{samples:T[];registered:T[];current?:ForecastEmployerSetting;inactive:boolean}{
 const entries=directory.filter(e=>e.role===role),current=entries.find(e=>e.current);
 if(current)return {current,inactive:false,samples:records.filter(r=>r.employerId===current.id&&r.form.paymentDate<=todayIso),
  // Unassigned legacy actuals may be from the current employer: do not estimate over them.
  registered:records.filter(r=>r.employerId===current.id||r.employerId===undefined)};
 if(entries.length)return {inactive:true,samples:[],registered:[...records]};
 return {inactive:false,samples:activeEmployerSalaries(records,todayIso),registered:[...records]};
}
