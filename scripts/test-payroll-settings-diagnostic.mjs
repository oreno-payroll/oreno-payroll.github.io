import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openRecordDiagnostic,dismissRecordDiagnostic} from '../src/ui/recordDiagnostic.ts';
import {dismissOperationDialog} from '../src/ui/operationDialog.ts';
import {mountSettingsNavigation} from '../src/ui/settingsNavigation.ts';
let focused;
class Element extends EventTarget{
 constructor(tag='div'){super();this.tag=tag;this.children=[];this.dataset={};this.style={};this.textContent='';this.hidden=false;this.open=false;this.disabled=false;this.type='';this.parent=null;this.queries=new Map();}
 setAttribute(){} append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}} remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
 replaceChildren(){for(const n of this.children)n.parent=null;this.children=[];} get isConnected(){return this===body||!!this.parent?.isConnected;}
 focus(){focused=this;} showModal(){this.open=true;} close(){this.open=false;this.dispatchEvent(new Event('close'));}
 click(){if(!this.disabled)this.dispatchEvent(new Event('click'));} querySelector(s){return this.queries.get(s)??null;} querySelectorAll(s){return this.queries.get(s)??[];} contains(n){return n===password;}
}
const body=new Element('body'),trigger=new Element('button');body.append(trigger);trigger.focus();
globalThis.HTMLElement=Element;globalThis.HTMLInputElement=Element;globalThis.document={body,documentElement:new Element('html'),get activeElement(){return focused;},createElement:tag=>new Element(tag),querySelector:s=>s==='dialog[open]'?body.children.find(n=>n.tag==='dialog'&&n.open)??null:null};
const win=new EventTarget();globalThis.window=win;
let copied=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(s){copied.push(s);}}}});
const dialogs=()=>body.children.filter(n=>n.tag==='dialog');const outer=()=>dialogs()[0];const find=(node,label)=>node.children.flatMap(c=>[c,...c.children]).find(n=>n.tag==='button'&&n.textContent===label);
const settle=async()=>{await Promise.resolve();await Promise.resolve();};
let reads=0,authorized=true;const raw=()=>{reads++;return '{"synthetic":"<private>"}';};const guard=()=>authorized;
openRecordDiagnostic(raw,guard);assert.equal(reads,0);const first=outer(),output=first.children.flatMap(n=>[n,...n.children]).find(n=>n.tag==='pre');assert.equal(output.textContent,'');assert.equal(output.hidden,true);
assert.equal(dialogs().length,1);assert.equal(find(first,'診断データをコピー'),undefined);assert.equal(focused,find(first,'×'));
openRecordDiagnostic(raw,guard);assert.equal(dialogs().length,1);
find(first,'診断データを表示').click();await settle();assert.equal(dialogs().length,1);assert.equal(reads,1);assert.equal(output.textContent,'{"synthetic":"<private>"}');assert.equal(output.hidden,false);assert.equal(copied.length,0);
find(first,'診断データをコピー').click();await settle();assert.deepEqual(copied,['{"synthetic":"<private>"}']);assert.equal(reads,1);assert.equal(dialogs().length,1);
find(first,'×').click();assert.equal(dialogs().length,0);assert.equal(output.textContent,'');assert.equal(focused,trigger);
openRecordDiagnostic(raw,guard);const second=outer(),out2=second.children.flatMap(n=>[n,...n.children]).find(n=>n.tag==='pre');authorized=false;const before=reads;find(second,'診断データを表示').click();await settle();assert.equal(reads,before);assert.equal(dialogs().length,0);assert.equal(out2.textContent,'');
authorized=true;openRecordDiagnostic(raw,guard);const third=outer(),out3=third.children.flatMap(n=>[n,...n.children]).find(n=>n.tag==='pre');find(third,'診断データを表示').click();authorized=false;find(third,'診断データをコピー').click();await settle();assert.equal(copied.length,1);assert.equal(dialogs().length,0);assert.equal(out3.textContent,'');
authorized=true;openRecordDiagnostic(raw,guard);const fourth=outer(),out4=fourth.children.flatMap(n=>[n,...n.children]).find(n=>n.tag==='pre');find(fourth,'診断データを表示').click();assert.equal(out4.hidden,false);win.dispatchEvent(new Event('pagehide'));assert.equal(out4.textContent,'');assert.equal(dialogs().length,0);
openRecordDiagnostic(raw,guard);const fifth=outer(),out5=fifth.children.flatMap(n=>[n,...n.children]).find(n=>n.tag==='pre');find(fifth,'診断データを表示').click();dismissOperationDialog();dismissRecordDiagnostic();assert.equal(out5.textContent,'');assert.equal(dialogs().length,0);
const existing=new Element('dialog');body.append(existing);existing.showModal();openRecordDiagnostic(raw,guard);assert.deepEqual(dialogs(),[existing]);existing.close();existing.remove();
openRecordDiagnostic(()=>{throw Error('synthetic');},guard);const failed=outer();find(failed,'診断データを表示').click();await settle();assert.equal(failed.children.flatMap(n=>[n,...n.children]).find(n=>n.tag==='pre').hidden,true);assert.ok(find(failed,'診断データを表示'));dismissRecordDiagnostic();
const originalClipboard=navigator.clipboard.writeText;navigator.clipboard.writeText=async()=>{throw Error('synthetic');};openRecordDiagnostic(raw,guard);const retry=outer();find(retry,'診断データを表示').click();find(retry,'診断データをコピー').click();await settle();assert.equal(find(retry,'診断データをコピー').disabled,false);assert.ok(retry.children.flatMap(n=>[n,...n.children]).some(n=>n.textContent==='コピーできませんでした。もう一度お試しください。'));navigator.clipboard.writeText=originalClipboard;find(retry,'診断データをコピー').click();await settle();assert.equal(copied.length,2);dismissRecordDiagnostic();
// Exercise real persistent navigation, authorization and secret remasking.
const root=new Element(),menu=new Element(),password=new Element('input'),toggle=new Element('button');password.type='password';toggle.dataset.togglePassword='pw';root.ownerDocument={getElementById:()=>password};
const keys=['employers','auth','backup','maintenance','notifications'];const buttons=keys.map(key=>{const b=new Element('button');b.dataset.settingsOpen=key;return b;});menu.queries.set('button[data-settings-open]',buttons);root.queries.set('[data-toggle-password]',[toggle]);
root.queries.set('#settings-menu',menu);
for(const key of ['employers','auth','backup','details','notifications'])root.queries.set(`#settings-${key}-panel`,new Element());
const finance=new Element(),maintenance=new Element();root.queries.set('.settings-finance-income',finance);root.queries.set('#settings-details-title',new Element('h2'));root.querySelector('#settings-details-panel').queries.set('.settings-details-column:not(.settings-finance-income)',[maintenance]);
win.history={pushState(){assert.fail('category must not push history')},replaceState(){assert.fail('category must not change history')},back(){assert.fail('category must not navigate back')}};
let canNavigate=true;const opened=[];const navigation=mountSettingsNavigation(root,()=>canNavigate,view=>opened.push(view));assert.equal(menu.hidden,false);assert.equal(root.querySelector('#settings-auth-panel').hidden,false);
buttons[2].click();assert.equal(menu.hidden,false);assert.equal(root.querySelector('#settings-backup-panel').hidden,false);assert.equal(root.querySelector('#settings-auth-panel').hidden,true);
password.type='text';password.value='synthetic';navigation.setBusy(true);buttons[3].click();assert.equal(root.querySelector('#settings-backup-panel').hidden,false);assert.ok(buttons.every(b=>b.disabled));navigation.setBusy(false);
canNavigate=false;buttons[3].click();assert.equal(root.querySelector('#settings-backup-panel').hidden,false);canNavigate=true;buttons[3].click();assert.equal(password.type,'password');assert.equal(password.value,'synthetic');assert.equal(finance.hidden,false);assert.equal(maintenance.hidden,false);assert.equal(root.querySelector('#settings-backup-panel').hidden,true);
buttons[1].click();assert.equal(root.querySelector('#settings-details-panel').hidden,true);assert.equal(root.querySelector('#settings-auth-panel').hidden,false);password.type='text';win.dispatchEvent(new Event('pagehide'));assert.equal(password.type,'password');
buttons[0].click();buttons[0].click();assert.deepEqual(opened,['backup','maintenance','auth','employers']);buttons[4].click();assert.equal(root.querySelector('#settings-notifications-panel').hidden,false);assert.equal(root.querySelector('#settings-employers-panel').hidden,true);assert.equal(opened.at(-1),'notifications');
win.location={hash:'#employers'};const initial=[];mountSettingsNavigation(root,()=>true,view=>initial.push(view));assert.equal(root.querySelector('#settings-employers-panel').hidden,false);assert.deepEqual(initial,['employers']);
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');assert.doesNotMatch(read('public/edit/index.html'),/id="raw-state"/);assert.doesNotMatch(read('src/edit.ts'),/`ID \$\{record.id\}/);assert.match(read('src/cloud/snapshot.ts'),/dismissOperationDialog\(\);\s*dismissRecordDiagnostic\(\);/);
console.log('PASS settings persistent navigation, transient diagnostic consent and cleanup');
