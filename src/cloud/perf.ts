/** Opt-in, aggregate-only diagnostics. No payroll values, IDs, paths, tokens or URLs. */
export type SavePerfPhase = 'save-prepare'|'save-connection'|'save-lock'|'save-records'|'save-duplicates'|'save-inventory'|'save-detached'|'save-original'|'save-annual'|'save-finance'|'save-finish';
type Operation = 'payroll-upload'|'payroll-edit'|'finance-income-sync'|'yearend-people'|'yearend-year'|'yearend-memo'|'yearend-forecast'|'yearend-pdf-batch';
type Phase = SavePerfPhase|'source-refresh'|'income-read'|'income-prewrite-refresh'|'income-write'|'income-verify'|'income-postwrite-refresh'|'income-register'|'yearend-access'|'yearend-index'|'yearend-profile'|'yearend-context';
type Transport = 'graph-api'|'encrypted-download';
const counters:Record<Transport,number>={'graph-api':0,'encrypted-download':0};
const wait:Record<Transport,number>={'graph-api':0,'encrypted-download':0};
let retries=0;
const now=()=>performance.now();
const enabled=():boolean=>{
  try{return typeof sessionStorage!=='undefined'&&sessionStorage.getItem('payroll-perf-diagnostics')==='1';}
  catch{return false;}
};
export function observeGraphTransfer(transport:Transport,elapsedMs:number):void {
  if(!enabled())return;
  counters[transport]++;
  wait[transport]+=Math.max(0,elapsedMs);
}
export function observeGraphRetry():void {if(enabled())retries++;}
/** A lightweight operation-local summary. Concurrent operations may share transport counters. */
export function beginPerfOperation(operation:Operation):{
  measure<T>(phase:Phase,work:()=>Promise<T>):Promise<T>;
  mark(phase:SavePerfPhase):void;
  finish(succeeded:boolean):void;
} {
  const active=enabled();
  const started=now();
  const initial={api:counters['graph-api'],download:counters['encrypted-download'],apiWait:wait['graph-api'],downloadWait:wait['encrypted-download'],retries};
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
      // Log only controlled categories and numbers. Never log exception objects or raw responses.
      console.info('[Payroll performance]',{
        operation, status:succeeded?'success':'failure',totalMs:Math.round((now()-started)*10)/10,
        graphRequests:counters['graph-api']-initial.api,
        encryptedDownloads:counters['encrypted-download']-initial.download,
        networkWaitMs:Math.round((wait['graph-api']+wait['encrypted-download']-initial.apiWait-initial.downloadWait)*10)/10,
        retries:retries-initial.retries,phases,
      });
    },
  };
}
