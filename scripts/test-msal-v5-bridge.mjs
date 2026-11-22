/** Source-level v5 bridge and npm supply-chain guard, independent of npm registry. */
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const pkg=JSON.parse(read('package.json'));
assert.equal(pkg.dependencies?.['@azure/msal-browser'],'5.30.0');
assert.match(read('scripts/msal-entry.mjs'),/from '@azure\/msal-browser'/);
assert.match(read('scripts/msal-redirect-bridge.mjs'),/broadcastResponseToMainFrame/);
assert.match(read('scripts/msal-redirect-bridge.mjs'),/from '@azure\/msal-browser\/redirect-bridge'/);
assert.match(read('public/auth/redirect.html'),/type="module" src="\.\/redirect-bridge\.js"/);
assert.match(read('src/cloud/auth.ts'),/new URL\('\.\/auth\/redirect\.html',import\.meta\.url\)/);
assert.match(read('scripts/build.mjs'),/scripts\/msal-redirect-bridge\.mjs/);
assert.match(read('scripts/build.mjs'),/scripts\/msal-entry\.mjs/);
assert.match(read('.github/workflows/deploy.yml'),/node scripts\/audit-msal\.mjs --built/);
assert.match(read('scripts/run-tests.mjs'),/--experimental-transform-types/);
assert.doesNotMatch(read('scripts/run-tests.mjs'),/--experimental-strip-types/);
assert.equal(existsSync(new URL('../public/vendor/msal/msal-browser.bundle.js',import.meta.url)),false);
console.log('PASS: MSAL v5 redirect bridge, audited npm dependency, build and CI TypeScript configuration');
