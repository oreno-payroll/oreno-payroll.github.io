/** OneDrive原本を復号したBlobがPDF iframeに渡されることをDOMモックで確認。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../src/view.ts',import.meta.url),'utf8');
const history=fs.readFileSync(new URL('../src/ui/notificationHistory.ts',import.meta.url),'utf8');
const sharedStatus=fs.readFileSync(new URL('../src/ui/appStatus.ts',import.meta.url),'utf8').replace(/^import .*?;\s*$/gm,'');
const safePdf=fs.readFileSync(new URL('../src/pdf/safePdf.ts',import.meta.url),'utf8');
const navigation=fs.readFileSync(new URL('../src/ui/navigationParams.ts',import.meta.url),'utf8');
const runnable=stripTypeScriptTypes(navigation.replace(/^export /gm,'')+'\n'+history.replace(/^export /gm,'')+'\n'+sharedStatus.replace(/^export /gm,'')+'\n'+safePdf.replace(/^export /gm,'')+'\n'+source.replace(/^import .*?;\s*$/gm,''),{mode:'strip'});
const pdf=new Blob(['%PDF-1.4\ncloud-test\n'],{type:'application/pdf'});
const reader={hidden:true,src:'',title:''};const status={hidden:false,dataset:{},children:[],classList:{add(){}},setAttribute(){},removeAttribute(){},replaceChildren(...children){this.children=children;}};
const createElement=()=>({textContent:'',hidden:false,setAttribute(){},addEventListener(){}});
let unregistered=false;
const location=new URL('https://payroll.example/view/index.html?id=7');
const ctx={
 window:{addEventListener(){},isSecureContext:true,location,history:{state:null,replaceState(_state,_unused,url){location.href=url;}}},
 document:{title:'',createElement,getElementById(id){return id==='pdf-status'?status:id==='pdf-reader'?reader:null;}},
 location,
 navigator:{serviceWorker:{async getRegistration(){return {active:{scriptURL:'https://payroll.example/view/pdf-sw.js'},async unregister(){unregistered=true;}};}}},
 URL:class extends URL{static createObjectURL(blob){assert.equal(blob.type,'application/pdf');assert.notEqual(blob,pdf);return 'blob:cloud-payroll-pdf';}static revokeObjectURL(){}},
 URLSearchParams,Blob,console,setTimeout:()=>1,clearTimeout:()=>{},
 createTabLockCoordinator:()=>({epoch:()=>'',check:()=>true}),
 receiveYearEndPdf:async()=>{throw new Error('not expected in personal viewer test');},
 getRecord:async(id)=>{assert.equal(id,7);return {id:7,fileName:'給与明細.pdf',pdf};},
};
vm.runInNewContext(runnable,ctx,{filename:'view.ts'});
for(let n=0;n<20&&!reader.src;n++)await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(unregistered,true);
assert.equal(reader.src,'blob:cloud-payroll-pdf');
assert.equal(ctx.document.title,'Payroll | PDF原本');
assert.equal(reader.title,'PDF原本');
assert.equal(location.search,'');assert.equal(location.hash,'#id=7');
assert.equal(reader.hidden,false);assert.equal(status.hidden,false);
assert.equal(status.dataset.state,'success');
assert.match(status.children[0].textContent,/PDFを表示しました/);
console.log('OK: OneDrive復号PDFをBlob URLで閲覧・旧Workerを解除');
