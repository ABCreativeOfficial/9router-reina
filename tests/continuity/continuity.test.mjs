import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { continuitySettings } from '../../open-sse/continuity/config.js';
import { consumeTaggedThinking, flushTaggedThinking } from '../../open-sse/continuity/thinking.js';
import { estimateClaudeTokens, estimateKiroTokens, estimateTextTokens } from '../../open-sse/continuity/estimator.js';
import { prepareHandoff, handoffPrefix } from '../../open-sse/continuity/memory.js';
import { clearContinuityStateForTests, readContinuityState, writeContinuityState } from '../../open-sse/continuity/stateStore.js';
import { inspectContinuityRequest, recentContinuityTelemetry, resetContinuityTelemetryForTests, recordKiroContinuityResponse } from '../../open-sse/continuity/monitor.js';
import { applyKiroSessionReplay, clearKiroSessionReplayStore } from '../../open-sse/utils/kiroSessionReplay.js';
import { resolveSessionIdentity, resolveContinuationId, clearSessionStore } from '../../open-sse/utils/sessionManager.js';
import { estimateAnthropicInputTokens, POST as countTokensPost } from '../../src/app/api/v1/messages/count_tokens/route.js';
import { normalizeKiroToolSpecs, canonicalizeKiroConversation, validateKiroConversation } from '../../open-sse/translator/concerns/kiroConversation.js';

process.env.KIRO_CONTINUITY_MODE = 'off';
process.env.KIRO_CONTINUITY_PERSIST = '0';

function parse(...chunks) {
  const state = { inThinking: false, thinkingCapture: '', thinkingRemainder: '' };
  const visible = chunks.map(chunk => consumeTaggedThinking(state, chunk, 1200)).join('') + flushTaggedThinking(state);
  return { visible, thinking: state.thinkingCapture, inThinking: state.inThinking };
}

for (const [label, input, expected, captured] of [
  ['no tags', ['hello world'], 'hello world', ''],
  ['whole tag', ['hello <thinking>reason</thinking> world'], 'hello  world', 'reason'],
  ['fragmented opening tag', ['hello <th', 'inking>reason</thinking> world'], 'hello  world', 'reason'],
  ['fragmented closing tag', ['hello <thinking>rea', 'son</thin', 'king> world'], 'hello  world', 'reason'],
  ['multiple blocks', ['a<thinking>1</thinking>b<thinking>2</thinking>c'], 'abc', '12'],
  ['literal prefix left unfinished', ['abc<thi'], 'abc<thi', ''],
  ['unclosed reasoning hidden', ['answer<thinking>secret'], 'answer', 'secret'],
  ['split close followed by prose', ['<thinking>x</thi', 'nking>Final'], 'Final', 'x'],
]) test(`tag parser: ${label}`, () => {
  const actual = parse(...input);
  assert.equal(actual.visible, expected);
  assert.equal(actual.thinking, captured);
});

test('bounded thought capture keeps only suffix', () => {
  const state = {inThinking:false};
  consumeTaggedThinking(state, '<thinking>abcdefghij</thinking>final', 4);
  assert.equal(state.thinkingCapture, 'ghij');
  assert.equal(flushTaggedThinking(state), '');
});

test('off parser strips but does not retain private thinking', () => {
  const state = {};
  const content = consumeTaggedThinking(state, '<thinking>PRIVATE</thinking>Final', 0);
  assert.equal(content, 'Final');
  assert.equal(state.thinkingCapture || '', '');
});

test('token counter matches trivial legacy estimate', () => assert.equal(estimateAnthropicInputTokens({ messages:[{role:'user',content:'hello world'}]}),3));
test('token counter handles unicode/code safely', () => {
  assert.ok(estimateTextTokens('😀😀😀😀') > 2);
  assert.ok(estimateTextTokens('function foo(){return Array(10)};') > 8);
});
test('token counter structured tool use contributes', () => {
  const bare = estimateClaudeTokens({messages:[{role:'user',content:'hello'}]});
  const tool = estimateClaudeTokens({tools:[{name:'read',input_schema:{properties:{path:{type:'string'}}}}],messages:[{role:'assistant',content:[{type:'tool_use',name:'read', input:{path:'/tmp/file'}}]}]});
  assert.ok(tool>bare);
});
test('token counter ignores opaque redacted signature bytes', () => {
  const before = estimateClaudeTokens({messages:[{role:'assistant',content:[{type:'redacted_thinking',data:'abcd'}]}]});
  const after = estimateClaudeTokens({messages:[{role:'assistant',content:[{type:'redacted_thinking',data:'a'.repeat(2000)}]}]});
  assert.equal(before,after);
});
test('kiro estimate counts tool results and longer messages', () => {
  const body = {conversationState:{history:[],currentMessage:{userInputMessage:{content:'a',modelId:'claude-sonnet-4.5'}}}};
  const first=estimateKiroTokens(body);
  body.conversationState.history.push({userInputMessage:{content:'a'.repeat(5000)}});
  assert.ok(estimateKiroTokens(body)>first+1000);
});

test('count_tokens route accepts structured request', async () => {
  const body={messages:[{role:'assistant',content:[{type:'tool_use', name:'Read', input:{file_path:'/tmp/x'}}]}]};
  const resp=await countTokensPost(new Request('http://localhost/v1/messages/count_tokens',{method:'POST',body:JSON.stringify(body)}));
  assert.equal(resp.status,200);
  assert.ok((await resp.json()).input_tokens>0);
});
test('count_tokens route rejects malformed JSON', async () => {
  const resp=await countTokensPost(new Request('http://localhost/v1/messages/count_tokens',{method:'POST',body:'{' }));
  assert.equal(resp.status,400);
});

test('default continuity mode off for unrecognized value', () => {
  process.env.KIRO_CONTINUITY_MODE='invalid';
  assert.equal(continuitySettings().mode,'off');
  process.env.KIRO_CONTINUITY_MODE='off';
});
test('settings clamp unsafe limits', () => {
  process.env.KIRO_CONTINUITY_STOP_TOKENS='999999';
  assert.equal(continuitySettings().stopTokens,190000);
  delete process.env.KIRO_CONTINUITY_STOP_TOKENS;
});

test('memory extracts only explicit labeled facts and preserves task goal', () => {
  clearContinuityStateForTests();
  const notes=prepareHandoff({sessionKey:'unit:one',messages:[
    {role:'user',content:'Refactor the authentication module but keep old routes'},
    {role:'assistant',content:[{type:'text',text:'Decision: Preserve backwards compatibility\nConstraint: do not change database schema\nThe weather looks nice'}]}
  ]});
  assert.match(notes,/Decision: Preserve/);
  assert.match(notes,/Constraint: do not change/);
  assert.match(notes,/Historical task goal/);
  assert.doesNotMatch(notes,/weather/);
});
test('memory detects file edit tool path without copying patches', () => {
  clearContinuityStateForTests();
  const notes=prepareHandoff({sessionKey:'unit:edit', messages:[
    {role:'assistant',content:[{type:'tool_use',name:'Edit',input:{file_path:'src/auth.js', new_string:'SECRET STRING'}}]}
  ]});
  assert.match(notes,/src\/auth.js/);
  assert.doesNotMatch(notes,/SECRET STRING/);
});
test('memory rejects obvious secrets', () => {
  clearContinuityStateForTests();
  const notes=prepareHandoff({sessionKey:'unit:secret',messages:[{role:'assistant',content:[{type:'text',text:'Decision: password=super-secret\nPending: update tests'}]}]});
  assert.doesNotMatch(notes,/super-secret/);
  assert.match(notes,/update tests/);
});
test('memory deduplicates repeats', () => {
  clearContinuityStateForTests();
  const messages=[{role:'assistant',content:[{type:'text',text:'Decision: use PostgreSQL migration'}]}];
  prepareHandoff({sessionKey:'unit:dedupe',messages});
  const notes=prepareHandoff({sessionKey:'unit:dedupe',messages});
  assert.equal(notes.match(/Decision: use PostgreSQL/g).length,1);
});
test('memory enforces size cap', () => {
  clearContinuityStateForTests();
  const messages=[{role:'assistant',content:[{type:'text',text:Array.from({length:25},(_,i)=>`Decision: ${i} ${'X'.repeat(90)}`).join('\n')}]}];
  const notes=prepareHandoff({sessionKey:'unit:cap',messages,memoryChars:280});
  assert.ok(notes.length<=280);
});
test('handoff marks memory as historical not higher-priority instruction', () => {
  const note=handoffPrefix('Decision: keep API');
  assert.match(note,/historical notes/);
  assert.match(note,/not new instructions/);
});

test('continuity state in-process roundtrip', () => {
  clearContinuityStateForTests();
  assert.equal(readContinuityState('unit:missing'),null);
  assert.equal(writeContinuityState('unit:state',{notes:['hello']}),true);
  assert.deepEqual(readContinuityState('unit:state'),{notes:['hello']});
});
test('state returns defensive copy', () => {
  clearContinuityStateForTests(); writeContinuityState('unit:copy',{values:[1]});
  const received=readContinuityState('unit:copy');received.values.push(2);
  assert.deepEqual(readContinuityState('unit:copy').values,[1]);
});
test('state rejects oversize payload', () => {
  assert.equal(writeContinuityState('unit:huge',{blob:'a'.repeat(60000)}),false);
});
test('state persist opt-in with restrictive permissions', () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'9router-continuity-unit-'));
  try {
    const previous=process.env.DATA_DIR;
    process.env.DATA_DIR=tmp;process.env.KIRO_CONTINUITY_PERSIST='true';
    clearContinuityStateForTests();
    assert.equal(writeContinuityState('unit:disk',{notes:['checkpoint']}),true);
    clearContinuityStateForTests();
    assert.deepEqual(readContinuityState('unit:disk'),{notes:['checkpoint']});
    const dir=path.join(tmp,'continuity-v1');
    if(process.platform!=='win32') {
      assert.equal(fs.statSync(dir).mode&0o077,0);
      assert.equal(fs.statSync(path.join(dir,fs.readdirSync(dir)[0])).mode&0o077,0);
    }
    if(previous===undefined) delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;
    process.env.KIRO_CONTINUITY_PERSIST='0';
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});

test('monitor never records actual message content', () => {
  process.env.KIRO_CONTINUITY_MODE='observe';resetContinuityTelemetryForTests();
  const payload={conversationState:{currentMessage:{userInputMessage:{content:'SECRET TASK CONTENT'}}}};
  inspectContinuityRequest(payload,{sessionId:'private-session-uuid'});
  recordKiroContinuityResponse({contextUsagePercentage:8, stopReason:'END_TURN', eventCounts:{assistantResponseEvent:1}});
  const data=JSON.stringify(recentContinuityTelemetry());
  assert.doesNotMatch(data,/SECRET TASK CONTENT|private-session-uuid/);
  assert.match(data,/contextUsagePercentage/);
  process.env.KIRO_CONTINUITY_MODE='off';
});
test('monitor recognizes warning and critical thresholds', () => {
  process.env.KIRO_CONTINUITY_MODE='observe';
  process.env.KIRO_CONTINUITY_WARN_TOKENS='50000';
  process.env.KIRO_CONTINUITY_STOP_TOKENS='100000';
  const payload={conversationState:{currentMessage:{userInputMessage:{content:'a'.repeat(405000)}}}};
  const inspection=inspectContinuityRequest(payload);
  assert.equal(inspection.status,'critical');
  delete process.env.KIRO_CONTINUITY_WARN_TOKENS; delete process.env.KIRO_CONTINUITY_STOP_TOKENS;
  process.env.KIRO_CONTINUITY_MODE='off';
});

test('session replay keeps first turn stable', () => {
  clearKiroSessionReplayStore();
  const first=applyKiroSessionReplay({conversationId:'unit-session',connectionId:'c',modelId:'m',systemPrompt:'system', contentPrefix:'system\nclock1',currentMessage:{userInputMessage:{content:'hello',modelId:'m'}}});
  assert.match(first.currentMessage.userInputMessage.content,/clock1/);
  const second=applyKiroSessionReplay({conversationId:'unit-session',connectionId:'c',modelId:'m',systemPrompt:'system',contentPrefix:'system\nclock2',currentContentPrefix:'clock2',history:[{userInputMessage:{content:'hello',modelId:'m'}},{assistantResponseMessage:{content:'done'}}],currentMessage:{userInputMessage:{content:'next',modelId:'m'}}});
  assert.equal(second.replayed,true);
  assert.equal(second.history[0].userInputMessage.content,first.currentMessage.userInputMessage.content);
  assert.match(second.currentMessage.userInputMessage.content,/clock2/);
});
test('session replay model mismatch does not restore old cache', () => {
  clearKiroSessionReplayStore();
  const make=modelId=>applyKiroSessionReplay({conversationId:'unit-change',connectionId:'c',modelId,systemPrompt:'s',contentPrefix:'prefix',currentMessage:{userInputMessage:{content:'question',modelId}}});
  make('model-a');
  assert.equal(make('model-b').replayed,false);
});
test('session resolver stable when client id is explicit', () => {
  const args={headers:{'x-claude-code-session-id':'11111111-2222-3333-4444-555555555555'},scope:'kiro',body:{messages:[]}};
  const a=resolveSessionIdentity(args);
  assert.equal(a.ephemeral,false);
  assert.equal(a.sessionId,resolveSessionIdentity(args).sessionId);
});
test('session resolver ephemeral without an explicit id on Kiro', () => {
  const a=resolveSessionIdentity({scope:'kiro',body:{messages:[]}});
  assert.equal(a.ephemeral,true);
});
test('continuation ID stable for same session', () => {
  const args={sessionId:'unit-cont',connectionId:'conn',scope:'kiro'};
  assert.equal(resolveContinuationId(args),resolveContinuationId(args));
});

test('canonicalizer preserves paired tool result and tool use', () => {
  const {specs,nameMap}=normalizeKiroToolSpecs([{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}}}}]);
  const canonical=canonicalizeKiroConversation({
    modelId:'claude-sonnet-4.5',toolSpecs:specs,nameMap,
    history:[{userInputMessage:{content:'check files'}},{assistantResponseMessage:{content:'',toolUses:[{toolUseId:'t1',name:'Read',input:{file_path:'a.js'}}]}}],
    currentMessage:{userInputMessage:{content:'Tool results provided.',userInputMessageContext:{toolResults:[{toolUseId:'t1',status:'success',content:[{text:'done'}]}]}}}
  });
  assert.equal(canonical.valid,true);
  assert.equal(canonical.history[1].assistantResponseMessage.toolUses.length,1);
  assert.equal(canonical.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].toolUseId,'t1');
  assert.equal(validateKiroConversation(canonical.history,canonical.currentMessage,specs).valid,true);
});
test('canonicalizer does not ship orphan results', () => {
  const canonical=canonicalizeKiroConversation({modelId:'m',history:[{userInputMessage:{content:'start'}}],currentMessage:{userInputMessage:{content:'Tool results provided.',userInputMessageContext:{toolResults:[{toolUseId:'nonexistent',content:[{text:'x'}]}]}}}});
  assert.equal(canonical.valid,true);
  assert.ok(canonical.repairs.orphanResults>0);
});

test('persistent first-turn replay can be restored in a fresh Node process', () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'9router-restart-'));
  const env={...process.env,DATA_DIR:temp,KIRO_CONTINUITY_PERSIST:'1'};
  const moduleUrl=new URL('../../open-sse/utils/kiroSessionReplay.js',import.meta.url).href;
  const writer=`import { applyKiroSessionReplay } from ${JSON.stringify(moduleUrl)}; applyKiroSessionReplay({conversationId:'restart-a',connectionId:'conn-a',modelId:'claude-sonnet-4.5',systemPrompt:'system',contentPrefix:'system\\nclock1',currentMessage:{userInputMessage:{content:'first question',modelId:'claude-sonnet-4.5'}}});`;
  const reader=`import { applyKiroSessionReplay } from ${JSON.stringify(moduleUrl)}; let result=applyKiroSessionReplay({conversationId:'restart-a',connectionId:'conn-a',modelId:'claude-sonnet-4.5',systemPrompt:'system',contentPrefix:'system\\nclock2',currentContentPrefix:'clock2',history:[{userInputMessage:{content:'first question'}},{assistantResponseMessage:{content:'completed'}}],currentMessage:{userInputMessage:{content:'next question'}}}); console.log(JSON.stringify({replayed:result.replayed,start:result.history[0].userInputMessage.content}));`;
  try {
    const a=spawnSync(process.execPath,['--input-type=module','-e',writer],{env,encoding:'utf8'});
    assert.equal(a.status,0,a.stderr);
    const b=spawnSync(process.execPath,['--input-type=module','-e',reader],{env,encoding:'utf8'});
    assert.equal(b.status,0,b.stderr);
    const output=JSON.parse(b.stdout.trim());
    assert.equal(output.replayed,true);
    assert.match(output.start,/clock1/);
    assert.doesNotMatch(output.start,/clock2/);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});

test('no persistent state when persistence is off', () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'9router-no-persist-'));
  const before=process.env.DATA_DIR;process.env.DATA_DIR=temp;
  process.env.KIRO_CONTINUITY_PERSIST='0';
  clearContinuityStateForTests();
  try {
    assert.equal(writeContinuityState('unit:no-disk',{foo:1}),true);
    assert.equal(fs.existsSync(path.join(temp,'continuity-v1')),false);
  } finally {
    if(before===undefined) delete process.env.DATA_DIR;else process.env.DATA_DIR=before;
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('context guard reserves bounded output headroom without mutating history', () => {
  process.env.KIRO_CONTINUITY_MODE='observe';
  const payload={conversationState:{history:[{userInputMessage:{content:'a'}}],currentMessage:{userInputMessage:{content:'b'}}},inferenceConfig:{maxTokens:200000}};
  const original=JSON.stringify(payload);
  const outcome=inspectContinuityRequest(payload);
  assert.equal(outcome.record.reservedOutputTokens,16000);
  assert.equal(JSON.stringify(payload),original);
  process.env.KIRO_CONTINUITY_MODE='off';
});
