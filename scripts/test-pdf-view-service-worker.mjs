/** Cloud移行後は旧Service WorkerがIndexedDBへアクセスしないことを確認。 */
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/view/pdf-sw.js',import.meta.url),'utf8');
assert.ok(!source.includes('indexedDB'),'閲覧SWが旧IndexedDBを参照してはいけない');
assert.ok(!source.includes('respondWith'),'旧PDF URLを提供してはいけない');
let callback;let unregistered=false;
vm.runInNewContext(source,{
 self:{addEventListener(name,fn){if(name==='activate')callback=fn;},registration:{async unregister(){unregistered=true;}}},
});
assert.equal(typeof callback,'function');
let wait;callback({waitUntil(value){wait=value;}});await wait;
assert.equal(unregistered,true);
console.log('OK: 旧PDF Service Workerの自動解除・IndexedDBアクセス廃止');
