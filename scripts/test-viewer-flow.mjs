/** OneDrive原本を復号したBlobがPDF iframeに渡されることをDOMモックで確認。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../src/view.ts',import.meta.url),'utf8');
const runnable=stripTypeScriptTypes(source.replace(/^import .*?;\s*$/gm,''),{mode:'strip'});
const pdf=new Blob(['%PDF-1.4\ncloud-test\n'],{type:'application/pdf'});
const reader={hidden:true,src:'',title:''};const status={hidden:false,textContent:'',setAttribute(){}};
let unregistered=false;
const ctx={
 window:{addEventListener(){},isSecureContext:true},
 document:{title:'',getElementById(id){return id==='pdf-status'?status:id==='pdf-reader'?reader:null;}},
 location:{href:'https://payroll.example/view/index.html?id=7',search:'?id=7'},
 navigator:{serviceWorker:{async getRegistration(){return {active:{scriptURL:'https://payroll.example/view/pdf-sw.js'},async unregister(){unregistered=true;}};}}},
 URL:class extends URL{static createObjectURL(blob){assert.equal(blob,pdf);return 'blob:cloud-payroll-pdf';}static revokeObjectURL(){}},
 URLSearchParams,Blob,console,
 getRecord:async(id)=>{assert.equal(id,7);return {id:7,fileName:'給与明細.pdf',pdf};},
};
vm.runInNewContext(runnable,ctx,{filename:'view.ts'});
for(let n=0;n<20&&!reader.src;n++)await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(unregistered,true);
assert.equal(reader.src,'blob:cloud-payroll-pdf');
assert.equal(ctx.document.title,'給与明細.pdf');
assert.equal(reader.hidden,false);assert.equal(status.hidden,true);
console.log('OK: OneDrive復号PDFをBlob URLで閲覧・旧Workerを解除');
