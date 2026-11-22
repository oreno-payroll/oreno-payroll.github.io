/** Payroll v29: Microsoft identity selection, typed errors, bounded Graph 401 recovery. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GraphError,PayrollGraph} from '../src/cloud/graph.ts';
import {pickPayrollAccount,needsMicrosoftInteraction,rememberedAccountKey} from '../src/cloud/msalPolicy.ts';
const fake=(id)=>({homeAccountId:id,username:id+'@example.test'});
const a=fake('alpha'),b=fake('bravo');
assert.equal(pickPayrollAccount([a,b],'alpha',b,null),a,'pinned ID must beat MSAL active account');
assert.equal(pickPayrollAccount([a,b],'missing',b,null),undefined,'missing pinned account must not fall through');
assert.equal(pickPayrollAccount([a,b],'',b,null),undefined,'ambiguous account cannot use arbitrary active identity');
assert.equal(pickPayrollAccount([a],'',null,null),a);
assert.equal(pickPayrollAccount([a,b],'alpha',a,b),b,'explicit redirect result selects requested new account');
assert.notEqual(rememberedAccountKey('CLIENT-1'),rememberedAccountKey('CLIENT-2'));
console.log('PASS: previous homeAccountId preferred; missing/multiple accounts cannot access another vault');
assert(needsMicrosoftInteraction({name:'InteractionRequiredAuthError'}));
for(const code of ['login_required','interaction_required','consent_required'])assert(needsMicrosoftInteraction({errorCode:code}));
for(const error of [{errorCode:'network_error'},{errorCode:'no_network_connectivity'},new TypeError('fetch failed'),{errorCode:'temporarily_unavailable'}])
 assert.equal(needsMicrosoftInteraction(error),false);
console.log('PASS: only formal MSAL interaction signals require login; transport failures do not');
const endpoint='/me/drive/special/approot';
function testGraph(method,statuses){
 let sent=0,refreshes=0,invalidated=0,reads=[];
 const graph=new PayrollGraph(async()=> 'cached-token',async (url,init)=>{
  sent++;reads.push({url,init});const status=statuses.shift()??200;
  return new Response(JSON.stringify(status===200?{id:'folder1'}:{error:{code:'invalidAuthenticationToken'}}),{status,headers:{'content-type':'application/json'}});
 },()=>{}, {invalidate(){invalidated++;},async refresh(){refreshes++;return 'fresh-token';}});
 return {graph,records:()=>({sent,refreshes,invalidated,reads}),method};
}
{
 const x=testGraph('GET',[401,200]);
 const response=await x.graph['request'](endpoint,{method:'GET'});
 assert.equal(response.status,200);
 const c=x.records();assert.equal(c.sent,2);assert.equal(c.refreshes,1);assert.equal(c.invalidated,1);
 assert.equal(c.reads[0].init.headers.Authorization,'Bearer cached-token');
 assert.equal(c.reads[1].init.headers.Authorization,'Bearer fresh-token');
}
{
 const x=testGraph('HEAD',[401,200]);await x.graph['request'](endpoint,{method:'HEAD'});
 assert.equal(x.records().sent,2);
}
console.log('PASS: Graph GET/HEAD 401 refreshes token and retries at most one time');
for(const method of ['POST','PUT','PATCH','DELETE']){
 const x=testGraph(method,[401,200]);
 await assert.rejects(x.graph['request'](endpoint,{method,body:method==='DELETE'?undefined:'x'}),e=>e instanceof GraphError&&e.status===401);
 assert.equal(x.records().sent,1,method+' must never retry');assert.equal(x.records().refreshes,0);assert.equal(x.records().invalidated,1);
}
console.log('PASS: Graph mutations never retry or force token refresh on 401');
{
 const x=testGraph('GET',[401,401,200]);
 await assert.rejects(x.graph['request'](endpoint,{method:'GET'}),e=>e instanceof GraphError&&e.status===401);
 assert.equal(x.records().sent,2);
}
{
 const x=testGraph('GET',[403,200]);
 await assert.rejects(x.graph['request'](endpoint,{method:'GET'}),e=>e instanceof GraphError&&e.status===403);
 assert.equal(x.records().sent,1);assert.equal(x.records().refreshes,0);
}
console.log('PASS: 401 retry is bounded; 403 does not trigger refresh');
const auth=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
const graph=readFileSync(new URL('../src/cloud/graph.ts',import.meta.url),'utf8');
const backup=readFileSync(new URL('../src/backup.ts',import.meta.url),'utf8');
assert.match(auth,/cacheLocation:'localStorage'/);
assert.match(auth,/forceRefresh:true/);
assert.doesNotMatch(auth,/window\.confirm\('Microsoftの再認証が必要です/);
assert.match(auth,/await token\(\);\s+const scope=sessionScope/,'automatic unlock must first check current MSAL token');
assert.match(auth,/app\.loginRedirect\(\{scopes:SCOPES,prompt:'select_account'\}\)/,'explicit switch still prompts');
assert.match(auth,/await reconnectMicrosoftAccount\(\)/);
assert.match(backup,/state\.status==='connected'/);
assert.match(graph,/credentials:'omit'/,'signed URL must not receive bearer token');
console.log('PASS: localStorage MSAL, explicit reauth UX, remembered key integration and signed URL isolation');
