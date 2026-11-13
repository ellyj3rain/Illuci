import {test} from 'node:test';import assert from 'node:assert/strict';
import {createTraceExposure,bindTraceSources} from './trace-exposure.js';
import {createExecutionTrace,reassembleTraceEvent} from '../context/execution-trace.js';
const collect=async stream=>{const out=[];for await(const e of stream)out.push(e);return out;};
test('raw chunks survive split UTF8 and EOF line flushing before parsed projection',async()=>{
  const events=[],manifests=[],raw=Buffer.from('data: {"thinking":"漢🙂"}\nlast event with no newline');
  const trace=createTraceExposure({onTraceEvent:e=>events.push(e),onTraceManifest:m=>manifests.push(m)},'fixture');
  const lines=await collect(trace.lines((async function*(){yield raw.subarray(0,22);yield raw.subarray(22,23);yield raw.subarray(23);})()));
  assert.deepEqual(lines,['data: {"thinking":"漢🙂"}','last event with no newline']);
  assert.deepEqual(Buffer.concat(events.map(e=>Buffer.from(e.payload.bytes,'base64'))),raw);
  assert.equal(manifests[0].exhausted,true);assert.equal(events[0].representation,'original-response-body-bytes');
});
test('observer failure cannot cause provider retry or replace provider output',async()=>{
  let calls=0,failures=0;const trace=createTraceExposure({onTraceEvent:()=>{calls++;throw Error('sink');},onTraceFailure:()=>{failures++;}},'fixture');
  assert.deepEqual(await trace.json({text:async()=>'{"answer":"one"}'}),{answer:'one'});assert.equal(calls,1);assert.equal(failures,1);
});
test('JSON fallback is labeled parsed while raw response text is preserved exactly',async()=>{
  const events=[],trace=createTraceExposure({onTraceEvent:e=>events.push(e)},'fixture');
  await trace.json({text:async()=>'{ "thinking" : "  original  " }'});
  await trace.json({json:async()=>({thinking:'parsed'})});
  assert.equal(events[0].payload,'{ "thinking" : "  original  " }');assert.equal(events[0].representation,'original-response-text');
  assert.deepEqual(events[1].transformations,['HTTP-json-parsing']);
});
test('interrupted observation window is not declared exhausted',async()=>{
  const manifests=[],trace=createTraceExposure({onTraceEvent:()=>true,onTraceManifest:m=>manifests.push(m)},'fixture');
  for await(const line of trace.lines((async function*(){yield Buffer.from('first\nsecond\n');})())){assert.equal(line,'first');break;}
  assert.equal(manifests[0].exhausted,false);
});
test('observed retrieval method, not source label, determines supported interface',async()=>{
  for(const label of ['opaque-provider','local-server']){
    const ports=[],trace=createTraceExposure({onTraceEvent:()=>true,onTraceSource:s=>ports.push(s)},label);
    await trace.source({});await trace.source({retrieveTrace:async()=>({events:[]})});
    assert.equal(ports[0].recover,undefined);assert.equal(typeof ports[1].recover,'function');
  }
});
test('native bytes compose with protected retention and verified later reconstruction',async()=>{
  const lane=new Map(),control=createExecutionTrace({binding:{operationId:'op',executionId:'run'},
    custody:{sourceRef:'approved',ownerAgentId:'a',ownerContextId:'c',projectId:'p',assignmentId:'w'},
    appendItem:item=>{lane.set(item.id,item);return item.id;},recordEvidence:()=> 'receipt'});
  const trace=createTraceExposure({onTraceEvent:control.capture,onTraceManifest:control.declareManifest},'fixture');
  const raw=Buffer.from([0,255,10,195,40]);await trace.bytes(raw);await trace.finish();
  const receipt=control.snapshot().events[0],value=await reassembleTraceEvent(receipt,id=>lane.get(id));
  assert.deepEqual(Buffer.from(value.payload.bytes,'base64'),raw);
});

test('a throwing optional-interface probe records discovery failure without blocking ordinary query capture',async()=>{
  const sources=[],events=[],port={};Object.defineProperty(port,'retrieveTrace',{get(){throw Error('unsupported proxy lookup');}});
  const options={onTraceEvent:e=>events.push(e),onTraceSource:s=>sources.push(s)};
  const bound=bindTraceSources(options,port),trace=createTraceExposure(options,'fixture');
  await trace.source(port);await bound.onTraceEvent({sourceId:'native',sourceRef:'fixture:native',layer:'native',sequence:0});
  assert.equal(sources.length,2);assert.ok(sources.every(s=>s.interfaceInspectionFailed===true));assert.equal(events.length,1);
});
