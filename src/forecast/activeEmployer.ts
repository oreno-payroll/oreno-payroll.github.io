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
