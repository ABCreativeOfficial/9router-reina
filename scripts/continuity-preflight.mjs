/** Credential-free offline diagnostics for 9Router Continuity Edition. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { continuitySettings } from '../open-sse/continuity/config.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const require=createRequire(import.meta.url);
const results=[];
function check(name,ok,detail='') { results.push({name,status:ok?'PASS':'BLOCKED',detail}); }
const major=Number(process.versions.node.split('.')[0]);
check('Node.js >=20.18.1', major>20 || (major===20&&Number(process.versions.node.split('.')[1])>=18),process.version);
check('Next.js installed', Boolean((()=>{try{return require.resolve('next/package.json')}catch{return null}})()),'Missing? run npm install on a networked host');
check('Source: Claude -> Kiro',fs.existsSync(path.join(root,'open-sse/translator/request/claude-to-kiro.js')));
check('Source: Kiro executor',fs.existsSync(path.join(root,'open-sse/executors/kiro.js')));
check('Source: continuity modules',fs.existsSync(path.join(root,'open-sse/continuity/memory.js')));
check('Kiro model entry',fs.readFileSync(path.join(root,'open-sse/config/kiroConstants.js'),'utf8').includes('claude-sonnet-4.5'));
const settings=continuitySettings();
const dataDir=process.env.DATA_DIR||path.join(os.homedir(),'.9router');
check('Continuity flags',true,`mode=${settings.mode}, persistence=${settings.persist}, warn=${settings.warnTokens}, hard=${settings.stopTokens}, strict=${settings.strictGuard}`);
check('Data directory configuration',Boolean(dataDir),'Will be created when persistence is enabled');
console.log(`9Router Reina Continuity preflight | app ${pkg.version} | no network requests`);
for(const r of results) console.log(`[${r.status}] ${r.name}${r.detail?` — ${r.detail}`:''}`);
if(results.some(r=>r.status==='BLOCKED')) {
  console.log('A BLOCKED dependency prevents production startup in this environment; run npm install and npm run build on your machine.');
  process.exitCode=1;
}
