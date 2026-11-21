/** One-use, same-origin PDF transport for the year-end view page.
 * The receiving tab owns the iframe so it can discard plaintext on global vault lock.
 * Never navigate a tab directly to a bare blob: URL. */
import type {HandoffPdf} from './handoff';
const PREFIX='payroll-yearend-view-v1-';
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const LIMIT=50_000_000;
type Message={type:'ready'|'pdf'|'error';id:string;ticket:string;pdf?:Blob;fileName?:string;error?:string};

export function openYearEndPdf(id:string,load:()=>Promise<HandoffPdf>):void{
 if(!UUID.test(id)||typeof BroadcastChannel==='undefined'||!crypto.randomUUID)
  throw new Error('安全なPDF閲覧機能を利用できません。最新のブラウザを使用してください。');
 const ticket=crypto.randomUUID();
 const channel=new BroadcastChannel(PREFIX+ticket);
 const epoch=localStorage.getItem('payroll-global-vault-lock-epoch-v1');
 let started=false,closed=false;
 const close=()=>{if(closed)return;closed=true;clearTimeout(timer);channel.close();};
 const timer=setTimeout(close,120_000);
 channel.onmessage=event=>{
  const message=event.data as Partial<Message>;
  if(message?.type!=='ready'||message.ticket!==ticket||message.id!==id||started)return;
  started=true;
  void (async()=>{
   try{
    const payload=await load();
    if(epoch!==localStorage.getItem('payroll-global-vault-lock-epoch-v1'))throw new Error('保管庫がロックされました。');
    if(!(payload.pdf instanceof Blob)||payload.pdf.size<1||payload.pdf.size>LIMIT||
      !payload.fileName||payload.fileName.length>500)throw new Error('PDF原本の形式が正しくありません。');
    channel.postMessage({type:'pdf',id,ticket,pdf:payload.pdf,fileName:payload.fileName} satisfies Message);
   }catch(error){channel.postMessage({type:'error',id,ticket,error:error instanceof Error?error.message:'原本を開けませんでした。'} satisfies Message);}
   finally{close();}
  })();
 };
 const link=document.createElement('a');
 link.href=`../view/index.html?yearend=${encodeURIComponent(id)}#handoff=${encodeURIComponent(ticket)}`;
 link.target='_blank';link.rel='noopener noreferrer';
 document.body.append(link);link.click();link.remove();
}

export function receiveYearEndPdf(id:string,ticket:string):Promise<HandoffPdf>{
 if(!UUID.test(id)||!UUID.test(ticket)||typeof BroadcastChannel==='undefined')
  throw new Error('PDF閲覧チケットが不正です。年末調整画面から開き直してください。');
 const channel=new BroadcastChannel(PREFIX+ticket);
 return new Promise((resolve,reject)=>{
  const close=()=>{clearTimeout(timer);channel.close();};
  const timer=setTimeout(()=>{close();reject(new Error('元のタブと通信できませんでした。年末調整画面から開き直してください。'));},120_000);
  channel.onmessage=event=>{
   const message=event.data as Partial<Message>;
   if(message?.ticket!==ticket||message.id!==id)return;
   if(message.type==='error'){close();reject(new Error(message.error||'PDF原本の取得に失敗しました。'));return;}
   if(message.type!=='pdf')return;
   close();
   if(!(message.pdf instanceof Blob)||message.pdf.size<1||message.pdf.size>LIMIT||
      typeof message.fileName!=='string'||!message.fileName||message.fileName.length>500){
    reject(new Error('PDF原本の形式が不正です。'));return;
   }
   resolve({pdf:message.pdf,fileName:message.fileName});
  };
  channel.postMessage({type:'ready',id,ticket} satisfies Message);
 });
}
