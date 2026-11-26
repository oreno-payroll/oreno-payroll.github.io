/** Synthetic browser fixture: run the production employer handlers with an in-memory vault.
 * Only tests import this module. Never load the real auth code or contact Graph. */
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const backup=read('src/backup.ts');
function section(start,end){const a=backup.indexOf(start),b=backup.indexOf(end,a+1);if(a<0||b<=a)throw new Error('Employer fixture source boundary changed');return backup.slice(a,b);}
const modules=['src/storage/employerIdentity.ts','src/storage/employerForecast.ts','src/storage/employerDirectory.ts','src/ui/employerSelection.ts','src/ui/operationDialog.ts','src/ui/operationOutcome.ts','src/ui/notificationHistory.ts','src/ui/appStatus.ts'].map(path=>read(path).replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'')).join('\n');
export function employerFixtureScript(){return stripTypeScriptTypes(modules+`
const $=id=>document.getElementById(id);
let busy=false;
const filePicker=$('restore-file'),yearEndFile=$('ye-restore-file');
const A='emp_'+'a'.repeat(32),B='emp_'+'b'.repeat(32),C='emp_'+'c'.repeat(32),D='emp_'+'d'.repeat(32);
const makeRecord=(id,job,employerId)=>({id,employerId,fileName:'synthetic.pdf',form:{job,targetMonth:'2026-0'+id,kind:'salary',paymentDate:'2026-0'+id+'-25',gross:'1000'}});
let fixtureList=[{id:A,name:'架空本業',role:'main',current:true},{id:B,name:'架空旧勤務先',role:'main',current:false},{id:C,name:'架空副業',role:'side',current:true}];
let fixtureRecords=[makeRecord(1,'main'),makeRecord(2,'side'),makeRecord(3,'main',D)];
let writes=0,failRead=false,failWrite=false,authorized=true,pauseWrite=false,releaseWrite;
const vault={async refresh(options){if(failRead)throw Error('fixture read failure');options.onEmployerDirectory?.(fixtureList);return fixtureRecords;},async readEmployerDirectory(){return fixtureList;},async writeEmployerDirectory(expected,next){writes++;if(pauseWrite)await new Promise(resolve=>{releaseWrite=resolve;});if(failWrite)throw Error('fixture write failure');if(employerDirectorySignature(expected)!==employerDirectorySignature(fixtureList))throw Error('fixture conflict');fixtureList=next;return fixtureList;}};
const captureOperationAuthorization=()=>()=>authorized;
const tryResumeCloudVault=async()=>vault,cloudVault=async()=>vault;
const recordSignature=r=>JSON.stringify(r);
const inspectEmployerAssignment=async(targets,id,directory,guard)=>{if(!guard())throw Error('fixture guard');return {count:targets.length,signature:'fixture'};};
const assignEmployers=async(targets,id,directory,signature,guard)=>{if(!guard())throw Error('fixture guard');writes++;fixtureRecords=fixtureRecords.map(r=>targets.some(t=>t.id===r.id)?{...r,employerId:id}:r);return fixtureRecords;};
class PayrollPartialSuccessError extends Error{}
function updateButtons(){
`+section('  updateEmployerButtons();\n  updateBulkControls();','  reportStatusTransition();')+`
 reportStatusTransition();
}
`+section('let employers:','let loadedDb = false;')+section('const appStatus=createAppStatus','\nconst sizes =')+section('// Employer names stay','// Activate navigation')+`
window.fixture={get writes(){return writes;},get list(){return fixtureList;},get records(){return fixtureRecords;},get busy(){return busy;},set failRead(v){failRead=v;},set failWrite(v){failWrite=v;},set pauseWrite(v){pauseWrite=v;},release(){releaseWrite?.();},set authorized(v){authorized=v;},async load(){await loadEmployerDirectory(false);}};
document.getElementById('settings-employers-panel').hidden=false;void loadEmployerDirectory(false);
`,{mode:'strip'});}
