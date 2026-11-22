import test from 'node:test';
import assert from 'node:assert/strict';
import { KiroExecutor } from '../../open-sse/executors/kiro.js';
import { encodeEventFrame } from '../../open-sse/utils/awsEventStream.js';
import { recentContinuityTelemetry, resetContinuityTelemetryForTests } from '../../open-sse/continuity/monitor.js';

async function execute(frames, options={}) {
  const raw=new ReadableStream({start(controller){for(const f of frames)controller.enqueue(f);controller.close();}});
  const response=new KiroExecutor().transformEventStreamToSSE(new Response(raw), 'claude-sonnet-4.5', options);
  return (await response.text()).split('\n').filter(line=>line.startsWith('data: ')&&!line.includes('[DONE]')).map(line=>JSON.parse(line.slice(6)));
}
const frame=(eventType,payload)=>encodeEventFrame({':event-type':eventType,':message-type':'event'},payload);
const end=()=>frame('metadataEvent',{metadataEvent:{stopReason:'END_TURN'}});

for(const [label,chunks,want,thinking] of [
  ['whole',['Hello <thinking>secret reasoning</thinking> final'],'Hello  final','secret reasoning'],
  ['split open',['Hello <th','inking>secret reasoning</thinking> final'],'Hello  final','secret reasoning'],
  ['split close',['<thinking>secret',' reasoning</thin','king>Final'],'Final','secret reasoning'],
  ['multiple',['A<thinking>one</thinking>B<thinking>two</thinking>C'],'ABC','onetwo'],
]) test(`executor SSE tag framing ${label}`,async()=>{
  process.env.KIRO_CONTINUITY_MODE='replay';
  let captured='not-called';
  const data=await execute([...chunks.map(c=>frame('assistantResponseEvent',{content:c})),end()],{onTaggedThinkingComplete:v=>{captured=v}});
  const content=data.map(item=>item?.choices?.[0]?.delta?.content||'').join('');
  assert.equal(content,want);
  assert.equal(captured,thinking);
  assert.ok(data.some(d=>d?.choices?.[0]?.finish_reason==='stop'));
  process.env.KIRO_CONTINUITY_MODE='off';
});

test('executor never persists thinking capture for truncated response',async()=>{
  process.env.KIRO_CONTINUITY_MODE='replay';
  let called=false;
  const data=await execute([frame('assistantResponseEvent',{content:'<thinking>secret</thinking>Partial'}),frame('metadataEvent',{stopReason:'MAX_TOKENS'})],{onTaggedThinkingComplete:()=>{called=true}});
  assert.equal(called,false);
  assert.ok(data.some(d=>d?.choices?.[0]?.finish_reason==='length'));
  process.env.KIRO_CONTINUITY_MODE='off';
});

test('executor records real provider usage separately from context proxy estimate',async()=>{
  process.env.KIRO_CONTINUITY_MODE='observe';resetContinuityTelemetryForTests();
  await execute([frame('assistantResponseEvent',{content:'done'}),frame('contextUsageEvent',{contextUsagePercentage:16}),frame('meteringEvent',{usage:0.1}),end()]);
  const responses=recentContinuityTelemetry().filter(r=>r.phase==='response');
  assert.equal(responses.length,1);
  assert.equal(responses[0].providerReportedTokens,null);
  assert.equal(responses[0].contextUsagePercentage,16);
  process.env.KIRO_CONTINUITY_MODE='off';
});

test('executor records actual metricsEvent input tokens as provider reported',async()=>{
  process.env.KIRO_CONTINUITY_MODE='observe';resetContinuityTelemetryForTests();
  await execute([frame('assistantResponseEvent',{content:'done'}),frame('metricsEvent',{metricsEvent:{inputTokens:123,outputTokens:4}}),end()]);
  const record=recentContinuityTelemetry().find(r=>r.phase==='response');
  assert.equal(record.providerReportedTokens,123);
  process.env.KIRO_CONTINUITY_MODE='off';
});
