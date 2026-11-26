import {confirmNotificationHistory,notificationHistory,noticeSummary,subscribeNotificationHistory} from './notificationHistory.ts';
const labels={success:'成功',warning:'警告',partial:'部分成功',error:'エラー'};
export function mountNotificationHistory(root:Document=document):void{
 const list=root.getElementById('notification-list'),empty=root.getElementById('notification-empty'),omitted=root.getElementById('notification-omitted'),unread=root.getElementById('notification-unread'),confirm=root.getElementById('notification-confirm-all') as HTMLButtonElement|null;
 if(!list||!empty||!omitted||!unread||!confirm)return;
 const format=new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 function render(){
  const history=notificationHistory();const count=history.entries.filter(x=>!x.seen).length;
  unread!.hidden=!count;unread!.textContent=count?`未確認 ${count}件`:'';confirm!.disabled=!count;
  empty!.hidden=history.entries.length>0;omitted!.hidden=!history.omitted;omitted!.textContent=history.omitted?`上限を超えた通知 ${history.omitted}件を省略しています。`:'';
  const nodes=history.entries.map(entry=>{
   const li=root.createElement('li'),head=root.createElement('div'),kind=root.createElement('strong'),time=root.createElement('time'),text=root.createElement('p');
   li.dataset.kind=entry.kind;li.dataset.unread=String(!entry.seen);head.className='notification-history__meta';kind.textContent=labels[entry.kind]+(entry.seen?'':'・未確認');time.dateTime=new Date(entry.at).toISOString();time.textContent=format.format(entry.at);text.textContent=noticeSummary(entry);head.append(kind,time);li.append(head,text);return li;
  });list!.replaceChildren(...nodes);
 }
 confirm.addEventListener('click',confirmNotificationHistory);subscribeNotificationHistory(render);render();
}
