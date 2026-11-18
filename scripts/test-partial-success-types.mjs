/** Partial operations are classified by stable types, never UI substring checks. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const root=new URL('../',import.meta.url).pathname;
const built=await build({
 stdin:{contents:"export {PayrollPartialSuccessError} from './src/storage/operationError.ts';",resolveDir:root,sourcefile:'test-partial.ts',loader:'ts'},
 bundle:true,platform:'node',format:'esm',target:'es2022',write:false,logLevel:'silent',
});
const {PayrollPartialSuccessError}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const rootError=new Error('offline');
for(const kind of ['income-sync','duplicate-cleanup']) {
 const err=new PayrollPartialSuccessError(kind,'明細の保存後に後続処理が失敗',{cause:rootError});
 assert.ok(err instanceof Error);
 assert.equal(err.stage,kind);
 assert.equal(err.cause,rootError);
 assert.equal(err.name,'PayrollPartialSuccessError');
}
const code=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const vault=code('src/cloud/vault.ts'),store=code('src/storage/payrollStore.ts'),edit=code('src/edit.ts'),home=code('src/main.ts');
assert.match(vault,/new PayrollPartialSuccessError\('income-sync'/);
assert.match(store,/new PayrollPartialSuccessError\('duplicate-cleanup'/);
assert.match(edit,/error instanceof PayrollPartialSuccessError/);
assert.match(edit,/error\.stage==='duplicate-cleanup'/);
assert.doesNotMatch(edit,/detail\.includes\('保存済みですが'\)|detail\.includes\('削除済みですが'\)/);
assert.match(home,/error instanceof PayrollPartialSuccessError/);
console.log('PASS: typed partial operation errors distinguish income sync from duplicate cleanup in edit and home');
