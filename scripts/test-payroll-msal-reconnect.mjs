/** Synthetic-only regression for explicit Microsoft reconnect. No Graph/MSAL/network. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {
 MicrosoftSignInRequiredError,MicrosoftTemporaryError,microsoftSilentTemporaryError,
 selectPayrollAccountAfterRedirect,
} from '../src/cloud/msalPolicy.ts';

const a={homeAccountId:'same-payroll-account',username:'synthetic-account-a'};
const b={homeAccountId:'another-account',username:'synthetic-account-b'};
assert.equal(selectPayrollAccountAfterRedirect([a,b],a.homeAccountId,b,b,null),a,
 'a stray redirect must not override the pinned account');
assert.equal(selectPayrollAccountAfterRedirect([a,b],a.homeAccountId,b,a,{mode:'reconnect',expectedAccountId:a.homeAccountId}),a);
assert.throws(()=>selectPayrollAccountAfterRedirect([a,b],a.homeAccountId,a,b,{mode:'reconnect',expectedAccountId:a.homeAccountId}),MicrosoftSignInRequiredError,
 'cross-account reconnect must fail before pinning new account');
assert.equal(selectPayrollAccountAfterRedirect([a,b],a.homeAccountId,a,b,{mode:'switch'}),b,
 'only an explicit account switch can replace the pinned account');
assert.equal(selectPayrollAccountAfterRedirect([a,b],'',null,b,{mode:'signin'}),b);
assert.equal(selectPayrollAccountAfterRedirect([a,b],a.homeAccountId,null,b,{mode:'signin'}),a,
 'ordinary sign-in intent must not override existing pinned identity');
assert.equal(selectPayrollAccountAfterRedirect([a,b],'',null,b,null),undefined,
 'without intent, ambiguous result must not select another cached account');
assert.equal(microsoftSilentTemporaryError({errorCode:'monitor_window_timeout'}).reason,'timeout');
assert.equal(microsoftSilentTemporaryError({errorCode:'timed_out'}).reason,'timeout');
assert.equal(microsoftSilentTemporaryError({errorCode:'network_error'}).reason,'network');
assert.equal(microsoftSilentTemporaryError({errorCode:'temporarily_unavailable'}).reason,'service');
assert.equal(microsoftSilentTemporaryError(new TypeError('transport failure')).reason,'network');
assert.equal(microsoftSilentTemporaryError({errorCode:'monitor_window_timeout'},true).reason,'network');
assert.equal(microsoftSilentTemporaryError({errorCode:'something_unrecognized'}).reason,'other');
console.log('PASS: pinned identity, explicit switch, silent timeout vs genuine network outage');

const source=readFileSync(new URL('../src/cloud/auth.ts',import.meta.url),'utf8');
const start=source.indexOf('export async function reconnectMicrosoftAccount():Promise<void>{');
const end=source.indexOf('\ntype GateUI =',start);
assert.ok(start>0&&end>start,'real reconnect entrypoint exists');
const js=stripTypeScriptTypes(source.slice(start,end).replace(/^export /,''),{mode:'strip'});
assert.match(source,/const intent=consumeRedirectIntent\(id\)/,'MSAL callback must consume single-use intent');
assert.match(source,/selectPayrollAccountAfterRedirect\(app\.getAllAccounts\(\)/,'redirect identity must be checked before pinning');
assert.match(source,/throw microsoftSilentTemporaryError\(error,offline\(\)\)/,'raw MSAL error must be typed');
assert.match(source,/stageRedirectIntent\(clientId\(\),\{mode:'switch'\}\)/,'explicit switch must be distinguishable');
assert.match(source,/sessionStorage\.setItem\(REDIRECT_INTENT_PREFIX\+id/,'intent must be per tab and client ID');
assert.doesNotMatch(source,/localStorage\.setItem\(REDIRECT_INTENT_PREFIX/,'redirect intent must not persist across browser restarts');

// Execute the actual one-use redirect intent storage helpers with synthetic storage.
const markerStart=source.indexOf("const REDIRECT_INTENT_PREFIX='payroll-msal-redirect-intent-v1:';");
const markerEnd=source.indexOf('\nfunction account(app:Msal):Account|undefined {',markerStart);
assert.ok(markerStart>=0&&markerEnd>markerStart,'redirect-intent helpers are present');
const markerSource=stripTypeScriptTypes(source.slice(markerStart,markerEnd),{mode:'strip'});
const storage=new Map();
const sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
const state={sessionStorage,Date,JSON,navigator:{onLine:true},MicrosoftTemporaryError};
vm.runInNewContext(`${markerSource}\nglobalThis.stage=stageRedirectIntent;globalThis.take=consumeRedirectIntent;globalThis.clear=clearRedirectIntent;`,state);
state.stage('client-A',{mode:'reconnect',expectedAccountId:a.homeAccountId});
assert.equal(state.take('client-B'),null,'other client ID must not inherit the intent');
assert.equal(state.take('client-A').expectedAccountId,a.homeAccountId);
assert.equal(state.take('client-A'),null,'intent must be consumed once');
state.stage('client-A',{mode:'switch'});
state.clear('client-A');assert.equal(state.take('client-A'),null);
const key='payroll-msal-redirect-intent-v1:client-A';
storage.set(key,JSON.stringify({mode:'reconnect',expectedAccountId:a.homeAccountId,at:Date.now()-16*60_000}));
assert.equal(state.take('client-A'),null,'an abandoned redirect must expire');
assert.equal(storage.has(key),false);
storage.set(key,JSON.stringify({mode:'reconnect',expectedAccountId:123,at:Date.now()}));
assert.equal(state.take('client-A'),null,'malformed account ID must be rejected');
console.log('PASS: one-time, session-only, client-scoped, expiring Microsoft redirect intents');

async function run({failure=null,offline=false,user=a,pinned=a.homeAccountId,accounts=[a],mutateEpoch=false,redirectFailure=false}={}){
 const calls=[];
 let currentUser=user,epoch=20;
 const app={
  getAllAccounts:()=>accounts,
  async loginRedirect(options){calls.push(['login',structuredClone(options)]);if(redirectFailure)throw Error('redirect rejected');},
  async acquireTokenRedirect(options){calls.push(['redirect',structuredClone(options)]);if(redirectFailure)throw Error('redirect rejected');},
 };
 const ctx={
  Error,MicrosoftSignInRequiredError,MicrosoftTemporaryError,
  clientId:()=> 'test-client',authEpoch:()=>epoch,getMsal:async()=>app,
  account:()=>currentUser,offline:()=>offline,previousAccountId:()=>pinned,
  SCOPES:['Files.ReadWrite.AppFolder'],
  stageRedirectIntent:(_id,intent)=>calls.push(['intent',structuredClone(intent)]),
  clearRedirectIntent:()=>calls.push(['clear']),
  token:async()=>{calls.push(['token']);if(mutateEpoch)epoch++;if(failure)throw failure;return 'synthetic-token';},
 };
 vm.runInNewContext(`${js}\nglobalThis.testReconnect=reconnectMicrosoftAccount;`,ctx,{filename:'auth-reconnect-test.js'});
 let thrown;
 try{await ctx.testReconnect();}catch(e){thrown=e;}
 return {calls,thrown};
}
{
 const v=await run();assert.equal(v.thrown,undefined);assert.deepEqual(v.calls,[['token']]);
}
for(const failure of [new MicrosoftSignInRequiredError(),new MicrosoftTemporaryError('iframe timeout','timeout'),new MicrosoftTemporaryError()]){
 const v=await run({failure});
 assert.equal(v.thrown,undefined);
 assert.deepEqual(v.calls.map(x=>x[0]),['token','intent','redirect']);
 assert.deepEqual(v.calls[1][1],{mode:'reconnect',expectedAccountId:a.homeAccountId});
 assert.equal(v.calls[2][1].account.homeAccountId,a.homeAccountId);
}
for(const failure of [new MicrosoftTemporaryError('failed fetch','network'),new Error('unrecognized crash')]){
 const v=await run({failure});
 assert.equal(v.thrown,failure);
 assert.deepEqual(v.calls,[['token']]);
}
{
 const v=await run({offline:true});assert.equal(v.thrown instanceof MicrosoftTemporaryError,true);
 assert.equal(v.thrown.reason,'network');assert.deepEqual(v.calls,[]);
}
{
 const v=await run({mutateEpoch:true,failure:new MicrosoftSignInRequiredError()});
 assert.equal(v.thrown instanceof MicrosoftSignInRequiredError,true);
 assert.deepEqual(v.calls,[['token']]);
}
{
 const v=await run({user:null,pinned:a.homeAccountId,accounts:[b]});
 assert.equal(v.thrown,undefined);
 assert.deepEqual(v.calls.map(x=>x[0]),['intent','login']);
 assert.equal(v.calls[1][1].prompt,'select_account');
 assert.deepEqual(v.calls[0][1],{mode:'reconnect',expectedAccountId:a.homeAccountId});
}
{
 const v=await run({user:null,pinned:'',accounts:[a,b]});
 assert.equal(v.thrown,undefined);
 assert.deepEqual(v.calls.map(x=>x[0]),['intent','login']);
 assert.deepEqual(v.calls[0][1],{mode:'signin'});
 assert.equal(v.calls[1][1].prompt,'select_account');
}
{
 const v=await run({failure:new MicrosoftTemporaryError('iframe timeout','timeout'),redirectFailure:true});
 assert.match(v.thrown.message,/redirect rejected/);
 assert.deepEqual(v.calls.map(x=>x[0]),['token','intent','redirect','clear'],
  'failed interactive initiation must remove one-shot intent');
}
console.log('PASS: real reconnect entrypoint, user click only, old account preserved, timeout fallback, offline safety, abort and recovery');
