/** Offline synthetic context pressure + pairing / handoff regression smoke. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { estimateKiroTokens } from '../open-sse/continuity/estimator.js';
import { normalizeKiroToolSpecs, canonicalizeKiroConversation } from '../open-sse/translator/concerns/kiroConversation.js';
import { prepareHandoff } from '../open-sse/continuity/memory.js';
const targets=[50_000,100_000,150_000,180_000];
const results=[];
for(const target of targets){
  const content='x'.repeat(target*4);
  const payload={conversationState:{history:[],currentMessage:{userInputMessage:{content,modelId:'claude-sonnet-4.5'}}}};
  const estimated=estimateKiroTokens(payload);
  const diff=Math.abs(estimated-target);
  assert.ok(diff<=10,`target ${target} estimate ${estimated}`);
  results.push({scenario:`synthetic-${target}`,targetTokens:target,estimatedTokens:estimated,contextPercent:Number((estimated/200000*100).toFixed(2)),passed:true,mode:'OFFLINE-SYNTHETIC'});
}
const {specs,nameMap}=normalizeKiroToolSpecs([{name:'Edit',input_schema:{type:'object',properties:{file_path:{type:'string'}}}}]);
const result=canonicalizeKiroConversation({modelId:'claude-sonnet-4.5',toolSpecs:specs,nameMap,history:[
  {userInputMessage:{content:'Fix source'}},
  {assistantResponseMessage:{content:'Will edit',toolUses:[{toolUseId:'a',name:'Edit',input:{file_path:'src/a.js'}}]}}
],currentMessage:{userInputMessage:{content:'Tool results provided.',userInputMessageContext:{toolResults:[{toolUseId:'a',status:'success',content:[{text:'updated'}]}]}}}});
assert.equal(result.valid,true);
results.push({scenario:'paired-tool-after-handoff',passed:true,mode:'OFFLINE-SYNTHETIC'});
const memory=prepareHandoff({messages:[{role:'user',content:'Refactor files without breaking API'},{role:'assistant',content:[{type:'text',text:'Decision: keep backward compatibility'}]}],persist:false});
assert.match(memory,/backward compatibility/);
results.push({scenario:'explicit-decision-memory',passed:true,mode:'OFFLINE-SYNTHETIC'});
const output={mode:'OFFLINE-SYNTHETIC',timestamp:new Date().toISOString(),providerRequests:0,results,limitations:['Not a real tokenizer','No LIVE 9Router or Kiro request','No actual model quality measurement']};
if(process.argv.includes('--write')){
  const dir=path.join(process.cwd(),'output','continuity');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'offline-results.json'),JSON.stringify(output,null,2));
}
console.log(JSON.stringify(output,null,2));
