/**
 * Read-only PDF handoff between two same-origin tabs. The opener keeps OAuth and
 * the AES key; the recipient receives only the verified PDF Blob. Never use
 * persistent browser storage for PDF bytes, tokens, passphrases or keys.
 *
 * A cryptographically random, short-lived fragment is a per-click channel name.
 * Fragments never go to the server, and `noopener noreferrer` stays on the link.
 */
export interface HandoffPdf {fileName:string;pdf:Blob}
type HandoffMessage =
 | {action:'ready'|'loading';id:number;ticket:string}
 | {action:'pdf';id:number;ticket:string;fileName:string;pdf:Blob}
 | {action:'error';id:number;ticket:string;message:string};
const PREFIX='payroll-pdf-handoff-v1-';
const TICKET=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_BYTES=50*1024*1024;

/** Called synchronously from a real anchor click/auxclick, before native navigation. */
export function preparePdfHandoff(link:HTMLAnchorElement,id:number,load:()=>Promise<HandoffPdf>,mayTransfer:()=>boolean):void {
 if(!mayTransfer()||typeof BroadcastChannel==='undefined'||!globalThis.crypto?.randomUUID)return;
 const ticket=crypto.randomUUID();
 let channel:BroadcastChannel;
 try {channel=new BroadcastChannel(PREFIX+ticket);}catch{return;}
 const original=link.href;
 const target=new URL(original);
 const params=new URLSearchParams(target.hash.slice(1));
 params.set('handoff',ticket);
 target.hash=params.toString();
 link.href=target.href;
 // The browser follows the updated href after the click listener; restore the
 // stable direct URL in a later task (also keeps the context-menu fallback).
 setTimeout(()=>{if(link.href===target.href)link.href=original;},0);
 let started=false;
 let timer:ReturnType<typeof setTimeout>;
 const close=()=>{clearTimeout(timer);channel.close();};
 timer=setTimeout(close,30_000); // Opened tab never signalled readiness.
 channel.onmessage=event=>{
  const message=event.data as Partial<HandoffMessage>;
  if(message?.action!=='ready'||message.id!==id||message.ticket!==ticket||started)return;
  started=true;clearTimeout(timer);
  if(!mayTransfer()){
   channel.postMessage({action:'error',ticket,id,message:'保管庫がロックまたは切り替えられました。PDFを開き直してください。'} satisfies HandoffMessage);
   close();return;
  }
  channel.postMessage({action:'loading',ticket,id} satisfies HandoffMessage);
  void (async()=>{
   try {
    const payload=await load();
    if(!(payload.pdf instanceof Blob)||payload.pdf.size<1||payload.pdf.size>MAX_BYTES||
       !payload.fileName||payload.fileName.length>500)throw new Error('PDF原本の形式が正しくありません。');
    // A different tab may have locked or switched accounts during load().
    // Never transfer plaintext even when the original passed integrity checks.
    if(!mayTransfer())throw new Error('保管庫がロックまたは切り替えられました。PDFを開き直してください。');
    channel.postMessage({action:'pdf',ticket,id,...payload} satisfies HandoffMessage);
   }catch(error){
    const message=error instanceof Error?error.message:'PDF原本を取得できませんでした。';
    channel.postMessage({action:'error',ticket,id,message} satisfies HandoffMessage);
   }finally{close();}
  })();
 };
}

/** New viewer tab receives a Blob from the already authenticated dashboard. */
export function receivePdfHandoff(id:number,ticket:string,onProgress?:()=>void):Promise<HandoffPdf>|null {
 if(!TICKET.test(ticket)||typeof BroadcastChannel==='undefined')return null;
 let channel:BroadcastChannel;
 try {channel=new BroadcastChannel(PREFIX+ticket);}catch{return null;}
 return new Promise((resolve,reject)=>{
  let timer:ReturnType<typeof setTimeout>;
  const close=()=>{clearTimeout(timer);channel.close();};
  timer=setTimeout(()=>{
   close();reject(new Error('元のPayrollタブからPDFを受信できませんでした。元の画面から開き直してください。'));
  },120_000);
  channel.onmessage=event=>{
   const message=event.data as Partial<HandoffMessage>;
   if(message?.ticket!==ticket||message.id!==id)return;
   if(message.action==='loading'){onProgress?.();return;}
   if(message.action==='error'){
    close();reject(new Error(message.message||'PDF原本の取得に失敗しました。'));return;
   }
   if(message.action!=='pdf')return;
   close();
   if(!(message.pdf instanceof Blob)||message.pdf.size<1||message.pdf.size>MAX_BYTES||
       typeof message.fileName!=='string'||!message.fileName||message.fileName.length>500){
    reject(new Error('受信したPDF原本の形式が正しくありません。'));return;
   }
   resolve({pdf:message.pdf,fileName:message.fileName});
  };
  try{channel.postMessage({action:'ready',ticket,id} satisfies HandoffMessage);}
  catch(error){close();reject(error);}
 });
}
