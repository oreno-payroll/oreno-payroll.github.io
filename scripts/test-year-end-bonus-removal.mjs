/** Bonus estimate deletion regression. Synthetic encrypted annual-file Graph stand-in only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=src=>stripTypeScriptTypes(src.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/\bexport\s+/g,''),{mode:'strip'});
const store=new Map();let seq=0,writes=0;
const key=(p,n)=>[...p,n].join('/');
const graph={
 async read(p,n){const v=store.get(key(p,n));return v?{...v}:null;},
 async write(p,n,text,prior){const k=key(p,n),old=store.get(k);
  if(prior?old?.etag!==prior.etag:!!old)throw new Error('ETag collision');
  store.set(k,{text,etag:`e${++seq}`});if(p.includes('years'))writes++;
 },
 async listFolder(){return [];}
};
const root=['payroll','versions','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','year-end-assist'];
const access={path:root,key:{},salt:'test',graph};
const sandbox={crypto:webcrypto,Blob,TextDecoder,Uint8Array,Number,Set,Map,Date,Error,JSON,Buffer,Promise,
 cloudVault:async()=>({yearEndAccess:async()=>access}),
 encryptJson:async(_,data)=>JSON.stringify(data),decryptJson:async(_,data)=>JSON.parse(data),
 encryptBytes:async()=>'',decryptBytes:async()=>new Uint8Array(),
 isCollision:e=>/collision/.test(e.message)};
const api=runInNewContext(strip(read('src/yearEnd/model.ts'))+'\n'+strip(read('src/yearEnd/repository.ts'))+
 '\n({YearEndRepository,randomPersonId,randomDocumentId,emptyYear,calculateYear})',sandbox);
const id=api.randomPersonId(),yearId=api.randomDocumentId(),at='2026-11-01T00:00:00Z';
const bonus=(month,amount)=>({month,amount,method:'manual',references:[],updatedAt:at});
const actual={id:api.randomDocumentId(),personId:id,kind:'bonus',paymentDate:'2026-05-20',targetMonth:'2026-05',
 taxable:70000,gross:70000,transportation:0,nonTaxable:0,healthInsurance:0,pension:0,employmentInsurance:0,
 incomeTax:0,residentTax:0,fileName:'synthetic.pdf',pdfSize:12,fileHash:'a'.repeat(64),
 confirmedAt:at,updatedAt:at,source:'pdf-reviewed',revision:1};
const annual={...api.emptyYear(id,2026),documents:[actual],estimates:[bonus('2026-10',123456)],
 bonusEstimates:[bonus('2026-11',100000),bonus('2026-12',200000)]};
const profile={format:'payroll-year-end-person-v1',id,displayName:'検証用',alias:'',createdAt:at,updatedAt:at,yearFiles:{'2026':yearId}};
store.set(key(root,'index.enc'),{text:JSON.stringify({format:'payroll-year-end-index-v1',persons:[{id,state:'active',createdAt:at,updatedAt:at}]}),etag:`e${++seq}`});
store.set(key([...root,'persons',id],'profile.enc'),{text:JSON.stringify(profile),etag:`e${++seq}`});
store.set(key([...root,'persons',id,'years'],yearId+'.enc'),{text:JSON.stringify(annual),etag:`e${++seq}`});
const repo=new api.YearEndRepository();
const replace=(from,change)=>repo.replaceIncomeForecasts(id,2026,'manual',['2026-10'],{'2026-10':123456},
 from.estimates,from.noPaymentMonths,[],from.bonusEstimates,change);
const before=await repo.year(id,2026);
const base=api.calculateYear(before).total;
assert.equal(base,493456);
await replace(before,{month:'2026-11',remove:true});
let next=await repo.year(id,2026);
assert.equal(next.bonusEstimates.length,1,'deletes only selected bonus month');
assert.equal(next.bonusEstimates[0].month,'2026-12');
assert.equal(api.calculateYear(next).total,393456,'annual taxable forecast is recalculated');
assert.equal(next.documents[0].taxable,70000,'confirmed bonus is never deleted');
assert.equal(next.estimates[0].amount,123456,'salary forecast survives bonus deletion');
assert.equal(writes,1,'one encrypted annual file update');
await assert.rejects(replace(before,{month:'2026-12',remove:true}),/別の画面で見込みが変更/,'stale snapshot may not delete another month');
assert.equal(writes,1);
await replace(next,{month:'2026-12',amount:0});
next=await repo.year(id,2026);
assert.equal(next.bonusEstimates.length,1,'zero yen remains an explicit estimate, not deletion');
assert.equal(next.bonusEstimates[0].amount,0);
assert.equal(api.calculateYear(next).total,193456);
await assert.rejects(replace(next,{month:'2027-01',remove:true}),/支給月が不正/,'other year cannot be removed');
await assert.rejects(replace(next,{month:'2026-00',remove:true}),/支給月が不正/,'invalid month cannot be removed');
assert.equal(writes,2);
await replace(next,{month:'2026-12',remove:true});
next=await repo.year(id,2026);
assert.equal(next.bonusEstimates.length,0);
assert.equal(next.estimates[0].amount,123456,'salary forecast still exists');
assert.equal(writes,3);
await replace(next,{month:'2026-12',remove:true});
assert.equal(writes,3,'deleting nonexistent month is an idempotent no-op');
await replace(next,{month:'2026-11',amount:50000});
next=await repo.year(id,2026);
assert.equal(next.bonusEstimates[0].amount,50000,'new bonus entry can be saved after removal');
await replace(next,undefined);
assert.equal(writes,4,'salary-only/no bonus change never clears existing bonus');
const ui=read('src/year-end-assist.ts');
assert.match(ui, /if\(data\?\.bonusEstimates\.some\(e=>e\.month===month\)\)return \{month,remove:true\}/);
assert.match(ui, /bonusClearedMonth\?\{month:bonusClearedMonth,remove:true\}/);
assert.match(ui, /bonusDirty\?requestedBonusChange\(\):undefined/);
assert.match(ui, /bonusChange&&'amount' in bonusChange/,'deletion must not invoke amount preview');
assert.match(ui, /bonusClearedMonth=!month&&bonusLastMonth/,'clearing month retains a precise saved deletion target');
// Bonus-only write must not rewrite old salary estimate metadata or migrate legacy no-pay months.
const annualPath=key([...root,'persons',id,'years'],yearId+'.enc');
const oldAnnual=await repo.year(id,2026);
const legacy={...oldAnnual,
 estimates:[...oldAnnual.estimates,{month:'2026-07',amount:90000,method:'latest',references:[],updatedAt:'2026-08-01T00:00:00Z'}],
 noPaymentMonths:['2026-02'],confirmedAt:at};
store.set(annualPath,{text:JSON.stringify(legacy),etag:`e${++seq}`});
const prior=await repo.year(id,2026),beforeBonusOnly=writes;
await repo.replaceIncomeForecasts(id,2026,'manual',[],{},prior.estimates,prior.noPaymentMonths,
 [],prior.bonusEstimates,{month:'2026-11',amount:85000},false);
const preserved=await repo.year(id,2026);
assert.deepEqual(JSON.parse(JSON.stringify(preserved.estimates)),JSON.parse(JSON.stringify(prior.estimates)),
 'mixed salary methods, references, timestamps and amounts remain identical');
assert.deepEqual(JSON.parse(JSON.stringify(preserved.noPaymentMonths)),['2026-02'],
 'legacy no-payment markers must not silently migrate during bonus-only edit');
assert.equal(preserved.bonusEstimates[0].amount,85000);
assert.equal(writes,beforeBonusOnly+1,'bonus-only edit commits exactly one annual file');
await assert.rejects(repo.replaceIncomeForecasts(id,2026,'manual',[],{},prior.estimates,prior.noPaymentMonths,
 [],prior.bonusEstimates,{month:'2026-11',amount:95000},false),/別の画面/,
 'stale bonus-only edit must not overwrite a concurrent change');
console.log('PASS: bonus-only preservation of mixed salary methods, references, timestamps, and no-pay markers');
console.log('PASS: bonus forecast removal, 0 yen, independent months, no-op, stale-tab collision, year bounds, UI intent');
