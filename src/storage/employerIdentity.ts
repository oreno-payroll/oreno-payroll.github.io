/** Stable, non-identifying employer identifier. Separate from the main/side role. */
export const EMPLOYER_ID_PATTERN = /^emp_[0-9a-f]{32}$/;
/** Old statements have no employerId. Do not backfill one from their role. */
export function validEmployerId(value:unknown):value is string|undefined {
 return value===undefined||(typeof value==='string'&&EMPLOYER_ID_PATTERN.test(value));
}
export function createEmployerId():string {
 // A random ID prevents company names/employee IDs entering the Finance export.
 if(typeof crypto.randomUUID!=='function')throw new Error('勤務先IDの発行には安全な乱数機能が必要です。');
 return `emp_${crypto.randomUUID().replaceAll('-','')}`;
}
