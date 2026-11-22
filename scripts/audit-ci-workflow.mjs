/** Fail-closed structural audit of the supported workflow YAML subset.
 * Unlike substring checks, this inspects *executable steps* and their order.
 * actionlint is recommended as an additional full YAML syntax validator.
 */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const repo=fileURLToPath(new URL('../',import.meta.url));
const allowedUses=new Map([
 ['Checkout complete Git history for secret audits','actions/checkout@11d5960a326750d5838078e36cf38b85af677262'],
 ['Setup Node.js','actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'],
 ['Configure Pages','actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b'],
 ['Upload Pages artifact','actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa'],
 ['Deploy to Pages','actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e'],
]);
const requiredRun=new Map([
 ['Audit published source and check PDF viewer files','node scripts/audit-publish.mjs'],
 ['Supplemental private-data audit (tracked files and Git author history)','node scripts/audit-private-data.mjs --strict-gitleaks --skip-current-author --require-private-terms'],
 ['Full Git history Gitleaks audit (deployment gate)','gitleaks git --log-opts=--all --redact --no-banner .'],
 ['Verify audited MSAL npm lockfile and redirect bridge source','node scripts/audit-msal.mjs'],
 ['Audit workflow security shape','node scripts/audit-ci-workflow.mjs'],
 ['Install dependencies','npm ci'],
 ['Dependency vulnerability audit','npm audit --audit-level=high'],
 ['Build Payroll','npm run build'],
 ['Verify generated MSAL bundle and redirect bridge','node scripts/audit-msal.mjs --built'],
 ['Audit complete Pages distribution','node scripts/audit-dist.mjs --require-private-terms'],
 ['Regression tests','npm test'],
]);
const order=[
 'Checkout complete Git history for secret audits','Setup Node.js',
 'Audit published source and check PDF viewer files','Install verified Gitleaks 8.30.1',
 'Supplemental private-data audit (tracked files and Git author history)',
 'Full Git history Gitleaks audit (deployment gate)',
 'Verify audited MSAL npm lockfile and redirect bridge source',
 'Audit workflow security shape','Install dependencies','Dependency vulnerability audit',
 'Build Payroll','Verify generated MSAL bundle and redirect bridge',
 'Audit complete Pages distribution','Regression tests',
 'Configure Pages','Upload Pages artifact','Deploy to Pages',
];
function sections(s){
  const lines=s.split(/\r?\n/);
  // Reject advanced YAML constructs not modeled by this strict subset parser.
  if(/(^|\s)[&*][A-Za-z_][\w-]*|\t/.test(s))throw Error('YAML anchors, aliases and tabs are not permitted in the security workflow');
  const jobsAt=lines.indexOf('jobs:');
  const jobHeaders=lines.slice(jobsAt+1).filter(line=>/^  [A-Za-z][\w-]*:\s*$/.test(line));
  if(jobHeaders.length!==1||jobHeaders[0]!=='  deploy:')throw Error('only the reviewed deploy job is allowed');
  if((s.match(/^jobs:\s*$/gm)||[]).length!==1)throw Error('jobs must appear exactly once');
  const start=lines.findIndex(line=>line==='    steps:');
  if(start<0)throw Error('steps are missing');
  const items=[];
  let current;
  for(let i=start+1;i<lines.length;i++){
    const line=lines[i];
    if(line.trim()&& !line.startsWith('      '))throw Error(`unexpected job-level content after steps at line ${i+1}`);
    const m=/^      - name:\s*(.+?)\s*$/.exec(line);
    if(m){current={name:m[1],raw:[],fields:new Map()};items.push(current);continue;}
    if(!current){if(line.trim())throw Error('steps content without a step name');continue;}
    current.raw.push(line);
    const prop=/^        ([A-Za-z-]+):(?:\s*(.*))?$/.exec(line);
    if(prop){if(current.fields.has(prop[1]))throw Error(`duplicate field ${current.name}.${prop[1]}`);current.fields.set(prop[1],(prop[2]||'').split(/\s+#/)[0]);}
  }
  return items;
}
export function auditWorkflow(s){
  const errors=[];
  function demand(value,message){if(!value)errors.push(message);}
  demand(/^on:\s*$/m.test(s),'on: must be present');
  demand(/^  push:\s*$/m.test(s)&&/^    branches:\s*\[main\]\s*$/m.test(s),'main push trigger must exist');
  demand(/^  workflow_dispatch:\s*$/m.test(s),'manual dispatch trigger must exist');
  demand(/^  schedule:\s*$/m.test(s)&&/^    - cron:\s*['"]\d+\s+\d+\s+\*\s+\*\s+\d+['"]\s*$/m.test(s),'weekly schedule must exist');
  demand(/^permissions:\s*$/m.test(s)&&/^  contents:\s*read\s*$/m.test(s),'read-only checkout permission missing');
  demand(!/^\s*continue-on-error:\s*true\s*$/m.test(s),'continue-on-error true is forbidden');
  demand(!/^    if:\s*/m.test(s),'job-level if may disable security checks');
  let steps=[];
  try{steps=sections(s);}catch(e){errors.push(e.message);return errors;}
  const names=steps.map(x=>x.name);
  demand(JSON.stringify(names)===JSON.stringify(order),'unexpected/missing/reordered steps (must gate deployment)');
  for(const step of steps){
    const fields=step.fields;
    demand(!fields.has('continue-on-error'),`continue-on-error forbidden: ${step.name}`);
    if(allowedUses.has(step.name)){
      demand(fields.get('uses')===allowedUses.get(step.name),`unapproved Action reference: ${step.name}`);
      demand(!fields.has('run'),`Action step mixes run: ${step.name}`);
    }else if(step.name==='Install verified Gitleaks 8.30.1'){
      demand(fields.get('run')==='|', 'Gitleaks setup must be a reviewed bash block');
      const body=step.raw.join('\n');
      demand(/sha256sum --check --status/.test(body)&&/gitleaks_8\.30\.1_linux_x64\.tar\.gz/.test(body)&&/set -euo pipefail/.test(body), 'Gitleaks setup integrity checks missing');
    }else{
      demand(fields.get('run')===requiredRun.get(step.name),`expected executable run command changed: ${step.name}`);
      demand(!fields.has('uses'),`run step has action reference: ${step.name}`);
    }
    if(step.name==='Supplemental private-data audit (tracked files and Git author history)'||step.name==='Audit complete Pages distribution'){
      demand(step.raw.some(line=>/^          PAYROLL_PRIVATE_TERMS_B64:\s*\$\{\{\s*secrets\.PAYROLL_PRIVATE_TERMS_B64\s*\}\}/.test(line)),`private dictionary CI secret missing: ${step.name}`);
    }
    if(['Configure Pages','Upload Pages artifact','Deploy to Pages'].includes(step.name)){
      demand(fields.get('if')==="github.event_name != 'schedule'",`schedule must not publish Pages: ${step.name}`);
    }else demand(!fields.has('if'),`security step must be unconditional: ${step.name}`);
    if(step.name==='Checkout complete Git history for secret audits'){
      demand(/fetch-depth:\s*0/.test(step.raw.join('\n')),'full Git history checkout missing');
      demand(/persist-credentials:\s*false/.test(step.raw.join('\n')),'checkout credentials must not persist');
    }
  }
  return errors;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const yaml=process.argv.includes('--staged')?execFileSync('git',['show',':.github/workflows/deploy.yml'],{cwd:repo,encoding:'utf8'}):readFileSync(path.join(repo,'.github/workflows/deploy.yml'),'utf8');
  const problems=auditWorkflow(yaml);
  for(const p of problems)console.error('NG: '+p);
  if(problems.length)process.exitCode=1;
  else console.log('[CI構造監査] PASS: executable commands, SHA actions, ordered security gates, weekly schedule');
}
