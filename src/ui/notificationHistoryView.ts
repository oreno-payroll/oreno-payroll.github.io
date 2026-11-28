import {notificationHistory,noticeSummary,subscribeNotificationHistory,type ResultKind} from './notificationHistory.ts';
const labels:Record<ResultKind,string>={success:'成功',warning:'警告',partial:'一部完了',error:'エラー'};
export function mountNotificationHistory(root:Document=document):void{
 const list=root.getElementById('notification-list'),empty=root.getElementById('notification-empty'),omitted=root.getElementById('notification-omitted'),filter=root.getElementById('notification-filter') as HTMLSelectElement|null;
 if(!list||!empty||!omitted||!filter)return;
 const format=new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 function render(){
  const history=notificationHistory();const selected=filter!.value;
  const visible=history.entries.filter(entry=>selected==='all'||entry.kind===selected);
  empty!.hidden=visible.length>0;empty!.textContent=history.entries.length?'該当する通知はありません':'通知はありません';
  omitted!.hidden=!history.omitted;omitted!.textContent=history.omitted?`上限を超えた通知 ${history.omitted}件を省略しています。`:'';
  const nodes=visible.map(entry=>{
   const li=root.createElement('li'),head=root.createElement('div'),kind=root.createElement('strong'),time=root.createElement('time'),text=root.createElement('p');
   li.dataset.kind=entry.kind;head.className='notification-history__meta';kind.textContent=labels[entry.kind];time.dateTime=new Date(entry.at).toISOString();time.textContent=format.format(entry.at);text.textContent=noticeSummary(entry);head.append(kind,time);li.append(head,text);return li;
  });list!.replaceChildren(...nodes);
 }
 filter.addEventListener('change',render);subscribeNotificationHistory(render);render();
}
