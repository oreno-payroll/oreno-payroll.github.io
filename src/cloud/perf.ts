/** Opt-in, transfer timing and aggregate diagnostics. No payroll values, IDs, paths, tokens or URLs. */
export type SavePerfPhase = 'save-prepare'|'save-connection'|'save-lock'|'save-records'|'save-duplicates'|'save-inventory'|'save-detached'|'save-original'|'save-annual'|'save-finance'|'save-finish';
type Operation = 'payroll-pdf-verified'|'payroll-pdf-direct'|'payroll-edit-load'|'payroll-edit-preview'|'payroll-upload'|'payroll-edit'|'finance-income-sync'|'yearend-people'|'yearend-year'|'yearend-memo'|'yearend-forecast'|'yearend-pdf-batch';
type Phase = SavePerfPhase|'pdf-access'|'pdf-before'|'pdf-original'|'pdf-after'|'edit-access'|'edit-inventory'|'edit-preview'|'source-refresh'|'income-read'|'income-prewrite-refresh'|'income-write'|'income-verify'|'income-postwrite-refresh'|'income-register'|'yearend-access'|'yearend-index'|'yearend-profile'|'yearend-context';
export type TransferCategory = 'folder'|'inventory'|'index'|'profile'|'annual'|'original'|'lock'|'other';
type Transport = 'graph-api'|'encrypted-download'|'encrypted-upload';
const counters:Record<Transport,number>={'graph-api':0,'encrypted-download':0,'encrypted-upload':0};
const wait:Record<Transport,number>={'graph-api':0,'encrypted-download':0,'encrypted-upload':0};
let retries=0;
const now=()=>performance.now();
const enabled=():boolean=>{
  try{return typeof sessionStorage!=='undefined'&&sessionStorage.getItem('payroll-perf-diagnostics')==='1';}
  catch{return false;}
};
// Serialize immediately: DevTools can retain this text even after the page is destroyed.
// Diagnostics must never change the outcome of a cloud operation.
function emit(label:string,data:object):void {
  try{console.info(label,JSON.stringify(data));}catch{/* optional diagnostic only */}
}
export function observeGraphTransfer(transport:Transport,elapsedMs:number,method:string,httpStatus:number|null,completed:boolean,category:TransferCategory='other'):void {
  if(!enabled())return;
  const duration=Number.isFinite(elapsedMs)?Math.max(0,elapsedMs):0;
  counters[transport]++;
  wait[transport]+=duration;
  emit('[Payroll transfer]',{
    transport,category:['folder','inventory','index','profile','annual','original','lock','other'].includes(category)?category:'other',method:['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method)?method:'OTHER',
    httpStatus:Number.isInteger(httpStatus)&&httpStatus!==null&&httpStatus>=100&&httpStatus<=599?httpStatus:null,
    outcome:completed?'response':'transport-error',elapsedMs:Math.round(duration*10)/10,
  });
}
export function observePdfRoute(route:'handoff'|'direct-no-ticket'|'direct-unavailable',elapsedMs?:number):void {
  if(enabled())emit('[Payroll PDF route]',{route,...(elapsedMs!==undefined&&Number.isFinite(elapsedMs)?{elapsedMs:Math.max(0,Math.round(elapsedMs))}:{})});
}
export function observePdfSender(status:import('../pdf/handoff').PdfSenderStatus):void {
  if(enabled())emit('[Payroll PDF sender]',{status});
}
export function observeGraphRetry():void {
  if(!enabled())return;
  retries++;
  emit('[Payroll retry]',{count:retries});
}
/** A lightweight operation-local summary. Concurrent operations may share transport counters. */
export function beginPerfOperation(operation:Operation):{
  measure<T>(phase:Phase,work:()=>Promise<T>):Promise<T>;
  mark(phase:SavePerfPhase):void;
  finish(succeeded:boolean):void;
} {
  const active=enabled();
  const started=now();
  const initial={api:counters['graph-api'],download:counters['encrypted-download'],upload:counters['encrypted-upload'],apiWait:wait['graph-api'],downloadWait:wait['encrypted-download'],uploadWait:wait['encrypted-upload'],retries};
  const phases:Partial<Record<Phase,{calls:number;ms:number}>>={};
  let finished=false,marked:SavePerfPhase|undefined,markedAt=started;
  const flushMark=()=>{
    if(!marked)return;
    const previous=phases[marked]??{calls:0,ms:0};
    phases[marked]={calls:previous.calls+1,ms:Math.round((previous.ms+now()-markedAt)*10)/10};
  };
  return {
    async measure<T>(phase:Phase,work:()=>Promise<T>):Promise<T>{
      if(!active)return work();
      const begin=now();
      try{return await work();}
      finally {
        const prev=phases[phase]??{calls:0,ms:0};
        phases[phase]={calls:prev.calls+1,ms:Math.round((prev.ms+now()-begin)*10)/10};
      }
    },
    mark(phase:SavePerfPhase):void {
      if(!active||finished||phase===marked)return;
      flushMark();marked=phase;markedAt=now();
    },
    finish(succeeded:boolean):void {
      if(!active||finished)return;
      flushMark();finished=true;
      if(!enabled())return;
      // Log only controlled categories and numbers. Never log exception objects or raw responses.
      emit('[Payroll performance]',{
        operation, status:succeeded?'success':'failure',totalMs:Math.round((now()-started)*10)/10,
        graphRequests:counters['graph-api']-initial.api,
        encryptedDownloads:counters['encrypted-download']-initial.download,
        encryptedUploads:counters['encrypted-upload']-initial.upload,
        networkWaitMs:Math.round((wait['graph-api']+wait['encrypted-download']+wait['encrypted-upload']-initial.apiWait-initial.downloadWait-initial.uploadWait)*10)/10,
        retries:retries-initial.retries,phases,
      });
    },
  };
}
