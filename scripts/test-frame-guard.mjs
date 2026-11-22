import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const guard=readFileSync(path.join(root,'public/frame-guard.js'),'utf8');
const normal={style:{},setAttribute(){throw Error('not framed');}};
const parent={};let stopped=false;
runInNewContext(guard,{window:{self:parent,top:parent,stop(){stopped=true;}},document:{documentElement:normal}});
assert.equal(stopped,false,'top-level application remains visible');
const child={},top={};let blocked=0,attrs={};
runInNewContext(guard,{window:{self:child,top,stop(){blocked++;}},document:{documentElement:{style:{},setAttribute:(k,v)=>attrs[k]=v}}});
assert.equal(blocked,1);assert.equal(attrs['data-payroll-framed'],'blocked');
for(const page of ['public/index.html','public/upload/index.html','public/edit/index.html',
 'public/backup/index.html','public/view/index.html','public/year-end-assist/index.html']){
 const html=readFileSync(path.join(root,page),'utf8');
 assert.match(html,/src="(?:\.\.\/|\.\/)frame-guard\.js"/);
 assert.ok(html.indexOf('frame-guard.js')<html.lastIndexOf('</head>'),page);
}
const bridge=readFileSync(path.join(root,'public/auth/redirect.html'),'utf8');
assert.doesNotMatch(bridge,/frame-guard|frame-ancestors|X-Frame-Options|Cross-Origin-Opener-Policy/,
 'hidden iframe bridge must not be blocked');
const auth=readFileSync(path.join(root,'src/cloud/auth.ts'),'utf8');
assert.match(auth,/window\.top!==window\.self/,'the vault has an independent frame guard');
console.log('PASS: best-effort clickjacking gate protects all app pages without blocking MSAL iframe bridge');
