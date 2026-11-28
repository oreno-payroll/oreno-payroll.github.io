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
 | {action:'ready'|'loading'|'start'|'cancel';id:number;ticket:string}
 | {action:'pdf';id:number;ticket:string;fileName:string;pdf:Blob}
 | {action:'error';id:number;ticket:string;message:string};
const PREFIX='payroll-pdf-handoff-v1-';
const TICKET=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_BYTES=50*1024*1024;
export type PdfSenderStatus='not-authorized'|'unsupported'|'channel-failed'|'ticket-issued'|'receiver-ready'|'transferred'|'expired'|'transfer-failed'|'navigation-failed'|'cancelled';

/** Called synchronously from a real anchor click/auxclick, before native navigation. */
export function preparePdfHandoff(link:HTMLAnchorElement,id:number,load:()=>Promise<HandoffPdf>,mayTransfer:()=>boolean,event?:MouseEvent,observe?:(status:PdfSenderStatus)=>void):void {
 const report=(status:PdfSenderStatus)=>{try{observe?.(status);}catch{/* diagnostic only */}};
 if(!mayTransfer()){report('not-authorized');return;}
 if(typeof BroadcastChannel==='undefined'||!globalThis.crypto?.randomUUID){report('unsupported');return;}
 const ticket=crypto.randomUUID();
 let channel:BroadcastChannel;
 try {channel=new BroadcastChannel(PREFIX+ticket);}catch{report('channel-failed');return;}
 report('ticket-issued');
 const original=link.href;
 const target=new URL(original);
 const params=new URLSearchParams(target.hash.slice(1));
 params.set('handoff',ticket);
 target.hash=params.toString();

 let offered=false,started=false,closed=false;
 let timer:ReturnType<typeof setTimeout>;
 const close=()=>{if(closed)return;closed=true;clearTimeout(timer);channel.close();};
 timer=setTimeout(()=>{report('expired');close();},30_000); // Opened tab never signalled readiness.
 channel.onmessage=event=>{
  const message=event.data as Partial<HandoffMessage>;
  if(closed||message?.id!==id||message.ticket!==ticket)return;
  if(message.action==='cancel'){report('cancelled');close();return;}
  if(message.action==='ready'&&!offered){
   offered=true;report('receiver-ready');
   if(!mayTransfer()){
    report('transfer-failed');
    channel.postMessage({action:'error',ticket,id,message:'保管庫がロックまたは切り替えられました。PDFを開き直してください。'} satisfies HandoffMessage);
    close();return;
   }
   // Wait for acknowledgement before starting the expensive read. If the
   // viewer already timed out, a late loading message cannot start a download.
   channel.postMessage({action:'loading',ticket,id} satisfies HandoffMessage);
   return;
  }
  if(message.action!=='start'||!offered||started)return;
  started=true;clearTimeout(timer);
  if(!mayTransfer()){
   report('transfer-failed');
   channel.postMessage({action:'error',ticket,id,message:'保管庫がロックまたは切り替えられました。PDFを開き直してください。'} satisfies HandoffMessage);
   close();return;
  }
  void (async()=>{
   try {
    const payload=await load();
    if(closed)return;
    if(!(payload.pdf instanceof Blob)||payload.pdf.size<1||payload.pdf.size>MAX_BYTES||
       !payload.fileName||payload.fileName.length>500)throw new Error('PDF原本の形式が正しくありません。');
    // A different tab may have locked or switched accounts during load().
    // Never transfer plaintext even when the original passed integrity checks.
    if(!mayTransfer())throw new Error('保管庫がロックまたは切り替えられました。PDFを開き直してください。');
    channel.postMessage({action:'pdf',ticket,id,...payload} satisfies HandoffMessage);report('transferred');
   }catch(error){
    if(closed)return;
    report('transfer-failed');
    const message=error instanceof Error?error.message:'PDF原本を取得できませんでした。';
    channel.postMessage({action:'error',ticket,id,message} satisfies HandoffMessage);
   }finally{close();}
  })();
 };
 // Ordinary activation uses a separate anchor with the final fragment, not a
 // transient mutation of the clicked anchor. Keep native modifier/middle-click
 // behaviour and the direct/context-menu link. No opener reference is granted.
 if(event&&event.type==='click'&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){
  const anchor=link.ownerDocument.createElement('a');
  anchor.href=target.href;anchor.target='_blank';anchor.rel='noopener noreferrer';
  try{link.ownerDocument.body.append(anchor);anchor.click();event.preventDefault();}
  catch{report('navigation-failed');close();}finally{anchor.remove();}
 }else{
  link.href=target.href;
  setTimeout(()=>{if(link.href===target.href)link.href=original;},0);
 }
}

/** New viewer tab receives a Blob from the already authenticated dashboard. */
export function receivePdfHandoff(id:number,ticket:string,onProgress?:()=>void):Promise<HandoffPdf|null>|null {
 if(!TICKET.test(ticket)||typeof BroadcastChannel==='undefined')return null;
 let channel:BroadcastChannel;
 try {channel=new BroadcastChannel(PREFIX+ticket);}catch{return null;}
 return new Promise((resolve,reject)=>{
  let timer:ReturnType<typeof setTimeout>;
  let acknowledged=false,closed=false;
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);channel.close();};
  const cancel=()=>{try{channel.postMessage({action:'cancel',ticket,id} satisfies HandoffMessage);}catch{/* channel unavailable */}finally{close();}};
  // No sender response: use the normal authenticated direct-read path. Do not
  // use this short deadline once the sender has acknowledged the request.
  timer=setTimeout(()=>{cancel();resolve(null);},2_000);
  channel.onmessage=event=>{
   const message=event.data as Partial<HandoffMessage>;
   if(closed||message?.ticket!==ticket||message.id!==id)return;
   if(message.action==='loading'){
    if(acknowledged)return;
    acknowledged=true;clearTimeout(timer);
    timer=setTimeout(()=>{cancel();reject(new Error('元のPayrollタブからPDFを受信できませんでした。元の画面から開き直してください。'));},120_000);
    try{channel.postMessage({action:'start',ticket,id} satisfies HandoffMessage);onProgress?.();}
    catch(error){cancel();reject(error);}
    return;
   }
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
  catch{close();resolve(null);}
 });
}
