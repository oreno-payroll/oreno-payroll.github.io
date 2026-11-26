/** Optional, encrypted employer-specific forecast preferences. An empty bonus schedule disables bonus estimates. */
export type SalaryForecastMethod='latest'|'median'|'average'|'none';
export interface EmployerForecastPreferences {salaryMethod:SalaryForecastMethod;bonusMonths:number[]}
export const SALARY_FORECAST_LABELS:Readonly<Record<SalaryForecastMethod,string>>={latest:'最新の通常給与',median:'直近最大3件の中央値',average:'直近最大3件の平均値',none:'算出しない'};
export function defaultEmployerForecast(role:'main'|'side'):EmployerForecastPreferences {
 return {salaryMethod:'median',bonusMonths:role==='main'?[2,8]:[]};
}
export function validateEmployerForecast(value:unknown):EmployerForecastPreferences {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('勤務先の見込み設定が不正です。');
 const raw=value as Record<string,unknown>;
 if(Object.keys(raw).length!==2||!Object.hasOwn(raw,'salaryMethod')||!Object.hasOwn(raw,'bonusMonths')||
    typeof raw.salaryMethod!=='string'||!Object.hasOwn(SALARY_FORECAST_LABELS,raw.salaryMethod)||
    !Array.isArray(raw.bonusMonths)||raw.bonusMonths.length>12||
    !Array.from(raw.bonusMonths).every(m=>Number.isInteger(m)&&m>=1&&m<=12)||new Set(raw.bonusMonths).size!==raw.bonusMonths.length)
  throw new Error('勤務先の見込み設定が不正です。');
 return {salaryMethod:raw.salaryMethod as SalaryForecastMethod,bonusMonths:[...raw.bonusMonths].sort((a,b)=>a-b)};
}
