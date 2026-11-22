/** 従業員PDF一括ZIPと年間課税額の出典表示・純数字コピーの回帰確認。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const html=read('public/year-end-assist/index.html'),ui=read('src/year-end-assist.ts');
const repo=read('src/yearEnd/repository.ts'),css=read('public/styles/year-end-assist.css');
assert.match(html,/id="yea-download-pdfs"/);
assert.doesNotMatch(html,/id="yea-copy-total"/);
assert.match(html,/id="yea-taxable-breakdown"/);
assert.match(ui,/await repo\.originalsForYear\(id,year\)/);
assert.doesNotMatch(ui,/navigator\.clipboard\.writeText/);
assert.match(css,/#yea-total\{user-select:all/);
assert.match(repo,/async originalsForYear\(/);
assert.match(repo,/await hash\(bytes\.buffer as ArrayBuffer\)!==record\.fileHash/);
assert.match(repo,/after\.file\?\.etag/);
assert.match(repo,/Math\.min\(3,records\.length\)/);
assert.match(css,/\.yea-taxable-table/);
const common={TextEncoder,TextDecoder,DataView,Uint8Array,Blob,Set,Map,crypto:{randomUUID},Date};
function code(file){return stripTypeScriptTypes(read(file).replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,''),{mode:'strip'});}
const ctx={...common,globalThis:null};ctx.globalThis=ctx;
vm.runInNewContext('const MAX_ARCHIVE_BYTES=512*1024*1024;\n'+code('src/storage/zipArchive.ts')+'\nglobalThis.pack=writeYearEndPdfZip;',ctx);
vm.runInNewContext(code('src/storage/fileNaming.ts')+'\nglobalThis.safePdfFileName=safePdfFileName;globalThis.yearEndVisiblePdfName=yearEndVisiblePdfName;',ctx);
vm.runInNewContext(code('src/yearEnd/pdfExport.ts')+'\nglobalThis.makeZip=createYearEndPdfZip;',ctx);
const sample=(id,date,kind,name)=>({id,paymentDate:date,kind,fileName:name,pdfSize:12});
const bytes=new TextEncoder().encode('%PDF-1.7\nXYZ');
assert.equal(bytes.length,12);
const records=[
 {record:sample('a','2026-11-25','salary','11111111-2222-3333-8444-555555555555.pdf'),bytes},
 {record:sample('b','2026-12-10','bonus','../../another.pdf'),bytes},
 {record:sample('c','2026-12-20','bonus','../../another.pdf'),bytes},
];
const zip=ctx.makeZip(records);
assert.equal(zip.type,'application/zip');
const raw=new Uint8Array(await zip.arrayBuffer()),view=new DataView(raw.buffer);
let offset=0;const entries=[];
while(offset+4<=raw.length&&view.getUint32(offset,true)===0x04034b50){
 const size=view.getUint32(offset+18,true),length=view.getUint16(offset+26,true),name=new TextDecoder().decode(raw.slice(offset+30,offset+30+length));
 const pdf=raw.slice(offset+30+length,offset+30+length+size);
 entries.push({name,pdf});offset+=30+length+size;
}
assert.deepEqual(entries.map(x=>x.name),[
 '202611_給与明細.pdf','_.._another.pdf','_.._another_2.pdf',
]);
assert.ok(entries.every(x=>new TextDecoder().decode(x.pdf)==='%PDF-1.7\nXYZ'));
assert.ok(!entries.some(x=>x.name.includes('.enc')||x.name.includes('manifest')));
assert.throws(()=>ctx.makeZip([{record:{...sample('d','2026-12-20','salary','bad.pdf'),pdfSize:1},bytes}]),/サイズ/);
// Use the actual year calculator and monthly audit structure on a synthetic employee.
const modelCtx={...common,globalThis:null};modelCtx.globalThis=modelCtx;
vm.runInNewContext(code('src/yearEnd/model.ts')+'\nglobalThis.emptyYear=emptyYear;globalThis.calculateYear=calculateYear;globalThis.yearMonth=yearMonth;',modelCtx);
const person=randomUUID(),year=modelCtx.emptyYear(person,2026);
const doc=(date,kind,taxable)=>{const id=randomUUID();return {id,personId:person,kind,paymentDate:date,targetMonth:date.slice(0,7),taxable,gross:null,transportation:null,nonTaxable:null,healthInsurance:null,pension:null,employmentInsurance:null,incomeTax:null,residentTax:null,fileName:'saved.pdf',pdfSize:12,fileHash:id.replaceAll('-','').repeat(2),confirmedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'pdf-reviewed',revision:1};};
year.documents.push(doc('2026-01-25','salary',300000),doc('2026-02-25','salary',258389),doc('2026-12-10','bonus',200000));
year.estimates.push({month:'2026-11',amount:100000,method:'manual',references:[],updatedAt:new Date().toISOString()});
assert.equal(modelCtx.calculateYear(year).total,858389);
assert.equal(modelCtx.calculateYear(year).salary,558389);
console.log('PASS: year-end PDF ZIP plaintext with named PDFs/duplicates, archived SHA-256 guard, breakdown source, native text selection');
