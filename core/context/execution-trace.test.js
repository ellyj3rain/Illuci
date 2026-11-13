import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionTrace,reassembleTraceEvent} from './execution-trace.js';
import {memoryValueDigest,createProtectedMemoryAdmission} from './protected-memory-admission.js';
const binding={operationId:'dispatch-1',executionId:'execution-1',owningRecordId:'work-1'};
const custody={sourceRef:'host:operator-approved',ownerAgentId:'worker',ownerContextId:'context',projectId:'illuci',assignmentId:'work'};
const makeEvent=(sequence,payload='original\n  text',extra={})=>({sourceId:'source',sourceRef:'host:source',layer:'controlled-runtime',
  representation:'runtime-exposed-event',evidenceKind:'emitted-reasoning',sequence,payload,...extra});
const manifest=(count,extra={})=>({sourceId:'source',sourceRef:'host:source',layer:'controlled-runtime',firstSequence:0,count,
  representations:['runtime-exposed-event'],scope:'source-declared-window',exhausted:true,...extra});
function fixture(options={}) {
  const lane=new Map(),evidence=[];
  const control=createExecutionTrace({binding,custody,chunkBytes:256,
    appendItem:item=>{lane.set(item.id,structuredClone(item));return item.id;},
    recordEvidence:(phase,payload)=>{const id='receipt-'+evidence.length;evidence.push({id,phase,payload:structuredClone(payload)});return id;},...options});
  return {lane,evidence,control};
}
test('lossless multi-chunk originals retain ordering, protected custody and whole-event/byte digests',async()=>{
  const f=fixture(),value={text:' \n漢字🙂\r\n'.repeat(2000),providerType:'thinking',opaque:'keep exact'};
  assert.equal(f.control.capture(makeEvent(0,value)),true);f.control.declareManifest(manifest(1));
  const before=f.control.snapshot(),event=before.events[0];assert.ok(event.chunkCount>1);
  const restored=await reassembleTraceEvent(event,id=>f.lane.get(id));assert.deepEqual(restored.payload,value);
  for(const item of f.lane.values()){assert.equal(item.custody.classification,'protected');assert.equal(item.digest,memoryValueDigest(item.value));}
  assert.equal(before.coverage[0].completeness,'source-window-complete');
  assert.doesNotMatch(JSON.stringify(before),/keep exact|漢字/);assert.equal(event.observedOrder,0);assert.ok(event.receivedAt);
});
test('same text at distinct positions is retained; conflicting same identity never selects newest',()=>{
  const f=fixture();f.control.capture(makeEvent(0));f.control.capture(makeEvent(1));f.control.capture(makeEvent(1,'conflict'));
  f.control.declareManifest(manifest(2));const c=f.control.snapshot();assert.equal(c.events.length,3);
  assert.equal(c.coverage[0].completeness,'conflicted');assert.deepEqual(c.coverage[0].conflictingSequences,[1]);
});
test('same-run retrieval repairs an observed middle gap and verifies declared source coverage',async()=>{
  let calls=0,input;
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:async args=>{
    calls++;input=args;return {operationId:args.operationId,sourceInstanceRef:'runtime-execution:1',events:[makeEvent(1,'middle')],manifest:manifest(3)};
  }}]});
  f.control.capture(makeEvent(0,'first'));f.control.capture(makeEvent(2,'last'));f.control.declareManifest(manifest(3));
  assert.deepEqual(f.control.snapshot().coverage[0].missingRanges,[[1,1]]);
  const result=await f.control.recover();assert.equal(calls,1);assert.deepEqual(input.missingRanges,[[1,1]]);
  assert.equal(result.coverage[0].completeness,'source-window-complete');assert.equal(result.recovery[0].invoked,true);
  const recovered=result.events.find(e=>e.recoveryRef);assert.equal((await reassembleTraceEvent(recovered,id=>f.lane.get(id))).payload,'middle');
  assert.deepEqual(result.events.map(e=>e.sequence),[0,2,1]); // observation order remains intact
});
test('unsupported interface is evaluated without fabricating an invocation',async()=>{
  const f=fixture();const result=await f.control.recover();assert.equal(result.recovery[0].status,'unsupported-interface');
  assert.equal(result.recovery[0].invoked,false);assert.equal(f.evidence.length,2);
});
test('interfaces determine capability regardless of identity labels',async()=>{
  for(const id of ['unknown-model','closed-looking-provider','local-looking-provider']){
    let calls=0;const f=fixture({sources:[{id,sourceRef:'host:'+id,layer:'instrumented-port',recover:args=>{calls++;return {operationId:args.operationId,sourceInstanceRef:'runtime:'+id,events:[]};}}]});
    const result=await f.control.recover();assert.equal(calls,1);assert.equal(result.recovery[0].status,'retrieved');
    assert.equal(result.recovery[0].completeness,'unverified');
  }
});
test('unknown source count remains unverified, even with successful retrieval and complete:true',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,sourceInstanceRef:'runtime:1',events:[makeEvent(5)],complete:true})}]});
  const result=await f.control.recover();assert.equal(result.coverage[0].completeness,'unverified');
});
test('derived summary and tensors cannot replace missing original source events',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,sourceInstanceRef:'runtime:1',events:[
    makeEvent(0,{summary:'derived'}, {sourceId:'derived',representation:'derived-analysis'}),
  ]})}]});f.control.declareManifest(manifest(1));
  const result=await f.control.recover();assert.equal(result.events.length,0);assert.equal(result.coverage[0].completeness,'partial');
  assert.equal(result.failures[0].stage,'recovery-source-mismatch');
});
test('tensor measurements and opaque continuity retain distinct provenance and do not claim inner thought',async()=>{
  const f=fixture();
  f.control.capture(makeEvent(0,{dtype:'float32',shape:[2],layout:'C',endianness:'little',bytesBase64:'AACAPwAAAEA=',tokenIds:[1,2],runtimeRevision:'fixture'},
    {representation:'tensor-observation',evidenceKind:'logits'}));
  f.control.capture(makeEvent(1,{providerType:'encrypted-continuity',bytesBase64:'AAEC'},
    {representation:'opaque-continuity',evidenceKind:'continuity'}));
  const receipt=f.control.snapshot();assert.equal(receipt.hiddenComputationRecovered,false);
  assert.deepEqual(receipt.events.map(e=>e.representation),['tensor-observation','opaque-continuity']);
  assert.equal((await reassembleTraceEvent(receipt.events[0],id=>f.lane.get(id))).payload.dtype,'float32');
});
test('write uncertainty retains intended chunk IDs and does not call it complete',async()=>{
  let calls=0;const f=fixture({appendItem:item=>{calls++;if(calls===2)throw Error('private sink detail');return item.id;}});
  assert.equal(f.control.capture(makeEvent(0,'x'.repeat(2000))),false);f.control.declareManifest(manifest(1));
  const r=f.control.snapshot();assert.equal(r.events[0].status,'partial');assert.equal(r.coverage[0].completeness,'partial');
  assert.ok(r.failures[0].recordId);assert.doesNotMatch(JSON.stringify(r),/private sink detail/);
  assert.equal(await reassembleTraceEvent(r.events[0],()=>null),null);
});
test('changed, missing or reordered chunks cannot become recovered original',async()=>{
  const f=fixture();f.control.capture(makeEvent(0,'long'.repeat(400)));const event=f.control.snapshot().events[0];
  assert.equal(await reassembleTraceEvent({...event,chunks:[...event.chunks].reverse()},id=>f.lane.get(id)),null);
  const item=f.lane.get(event.chunks[0].id);item.value.dataBase64='AAAA';item.digest=memoryValueDigest(item.value);
  assert.equal(await reassembleTraceEvent(event,id=>f.lane.get(id)),null);
});
test('protected traces do not become ordinary work merely because they were captured',async()=>{
  const f=fixture();f.control.capture(makeEvent(0));const id=[...f.lane.keys()][0];
  const reader={contextId:'context',agentId:'worker',runId:'run',sessionId:'session',projectId:'illuci',assignmentId:'work',purpose:'execution-audit',lineage:['run']};
  const port=createProtectedMemoryAdmission({resolveReader:()=>reader,resolveItem:key=>f.lane.get(key),resolveAuthorization:()=>null}).openContext('host');
  assert.equal((await port.select([id])).admitted.length,0);
  assert.equal(await reassembleTraceEvent(f.control.snapshot().events[0],async key=>(await port.select([key])).admitted[0]),null);
});
for(const [name,recover,status] of [
  ['synchronous failure',()=>{throw Error('private');},'failed'],['rejection',()=>Promise.reject(Error('private')),'failed'],
  ['unavailable',()=>({status:'unavailable'}),'unavailable'],['malformed',()=>({complete:true}),'invalid-result'],
])test('recovery '+name+' is explicit without private diagnostics',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover}]});
  const result=await f.control.recover();assert.equal(result.recovery[0].status,status);assert.equal(result.recovery[0].invoked,true);
  assert.doesNotMatch(JSON.stringify(result),/private/);
});
test('timeout preserves sealed receipt and appends late-settlement evidence without replay',async()=>{
  let resolve;const f=fixture({recoveryTimeoutMs:5,sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:()=>new Promise(r=>{resolve=r;})}]});
  const result=await f.control.recover(),before=JSON.stringify(result);assert.equal(result.recovery[0].status,'timed-out');
  resolve({events:[makeEvent(0)]});await new Promise(r=>setImmediate(r));assert.equal(JSON.stringify(result),before);
  assert.equal(f.evidence.at(-1).phase,'trace-recovery-late-settlement');assert.equal(f.evidence.at(-1).payload.lateContentNotRetained,true);
});
test('cancelled recovery invokes no source and cannot be mistaken for missing permission',async()=>{
  let calls=0;const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:()=>{calls++;}}]});
  const c=new AbortController();c.abort();const result=await f.control.recover({signal:c.signal});
  assert.equal(result.recovery[0].status,'cancelled');assert.equal(calls,0);
});
test('unconfirmed recovery attempt prevents invocation; result uncertainty is separate',async()=>{
  let calls=0;const f=fixture({recordEvidence:()=>null,sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:()=>{calls++;}}]});
  const result=await f.control.recover();assert.equal(result.recovery[0].status,'attempt-unconfirmed');assert.equal(calls,0);
});
test('unsupported non-JSON data fails explicitly without evaluating accessors',()=>{
  let reads=0;const value={};Object.defineProperty(value,'x',{enumerable:true,get(){reads++;return 'private';}});
  const cycle={};cycle.self=cycle;
  const f=fixture();for(const payload of [value,new Date(),cycle,new Array(2)])assert.equal(f.control.capture(makeEvent(0,payload)),false);
  assert.equal(reads,0);assert.equal(f.control.snapshot().failures.length,4);
});

test('SDK-exposed undefined and numeric sentinels are preserved explicitly rather than silently dropped',async()=>{
  const f=fixture(),payload={toolCalls:undefined,negativeZero:-0,nan:NaN,infinite:Infinity,big:2n};
  assert.equal(f.control.capture(makeEvent(0,payload)),true);
  const out=await reassembleTraceEvent(f.control.snapshot().events[0],id=>f.lane.get(id));assert.deepEqual(out.payload,payload);
});

test('same-run recovery can monotonically finalize an interrupted window while preserving both declarations',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,
    sourceInstanceRef:'runtime:1',events:[],manifest:manifest(1)})}]});
  f.control.capture(makeEvent(0));f.control.declareManifest(manifest(1,{exhausted:false}));
  assert.equal(f.control.snapshot().coverage[0].completeness,'unverified');
  const result=await f.control.recover();assert.equal(result.coverage[0].completeness,'source-window-complete');
  assert.deepEqual(result.manifestHistory.map(m=>m.exhausted),[false,true]);assert.ok(result.manifestHistory[1].recoveryRef);
});

test('completed window or mismatched source provenance cannot be rewritten into apparent completeness',()=>{
  const f=fixture();f.control.capture(makeEvent(0));f.control.declareManifest(manifest(2));
  assert.equal(f.control.declareManifest(manifest(1)),false);
  assert.equal(f.control.declareManifest(manifest(1,{sourceRef:'another-source'})),false);
  assert.equal(f.control.snapshot().coverage[0].completeness,'partial');
});

test('a retained exact replacement repairs current storage coverage while failure history remains',async()=>{
  let failing=true;const event=makeEvent(0);
  const f=fixture({appendItem:item=>{if(failing)throw Error('sink');return item.id;},sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>{
    failing=false;return {operationId:args.operationId,sourceInstanceRef:'runtime:1',events:[event],manifest:manifest(1)};
  }}]});f.control.capture(event);f.control.declareManifest(manifest(1));
  const result=await f.control.recover();assert.ok(result.failures.length);assert.equal(result.coverage[0].completeness,'source-window-complete');
});

test('a previous execution or unbound recovered source cannot be relabeled as the current dispatch',async()=>{
  for(const change of [{operationId:'previous-operation'}, {sourceInstanceRef:undefined}]){
    const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,
      sourceInstanceRef:'runtime:1',events:[makeEvent(0)],manifest:manifest(1),...change})}]});
    const result=await f.control.recover();assert.equal(result.recovery[0].status,'unverified-execution-binding');assert.equal(result.events.length,0);
  }
});

test('recovery cannot supply a manifest for an unrelated source even with a valid current operation',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,
    sourceInstanceRef:'runtime:1',events:[],manifest:manifest(0,{sourceRef:'unrelated'})})}]});
  const result=await f.control.recover();assert.equal(result.failures[0].stage,'recovery-manifest-mismatch');
  assert.equal(result.coverage[0].completeness,'partial');
});

test('a same-source summary cannot fill an original-event gap',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,
    sourceInstanceRef:'runtime:1',events:[makeEvent(1,{summary:'derived'},{representation:'derived-analysis'})],manifest:manifest(2)})}]});
  f.control.capture(makeEvent(0));f.control.declareManifest(manifest(2));
  const result=await f.control.recover();assert.equal(result.coverage[0].completeness,'partial');
  assert.equal(result.failures[0].stage,'recovery-representation-mismatch');assert.deepEqual(result.coverage[0].missingRanges,[[1,1]]);
});

test('original body bytes require a verified raw-byte length, encoding and digest',()=>{
  const f=fixture();assert.equal(f.control.capture(makeEvent(0,{encoding:'base64',bytes:'AAAA',byteLength:3,sha256:'wrong'},
    {representation:'original-response-body-bytes'})),false);assert.equal(f.control.snapshot().events.length,0);
});

test('trusted mixed-format expectation permits a missing opaque event beside a surviving tensor observation',async()=>{
  const selected=manifest(2,{representations:['tensor-observation','opaque-continuity']});
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,
    sourceInstanceRef:'runtime:1',events:[makeEvent(1,{bytes:'opaque'},{representation:'opaque-continuity'})],manifest:selected})}]});
  f.control.capture(makeEvent(0,{shape:[1],dtype:'float32'},{representation:'tensor-observation'}));f.control.declareManifest(selected);
  const result=await f.control.recover();assert.equal(result.coverage[0].completeness,'source-window-complete');
  assert.deepEqual(result.events.map(e=>e.representation),['tensor-observation','opaque-continuity']);
});

test('all-originals-lost recovery remains unverified without a trusted format expectation',async()=>{
  const unknown=manifest(1,{representations:undefined});
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,
    sourceInstanceRef:'runtime:1',events:[makeEvent(0,{summary:'only a provider summary'},{representation:'provider-summary'})],manifest:unknown})}]});
  f.control.declareManifest(unknown);const result=await f.control.recover();assert.equal(result.coverage[0].completeness,'unverified');
  assert.equal(result.recovery[0].formatExpectation,'unverified');
});

test('all-originals-lost known event format cannot be satisfied by a replacement summary',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',recover:args=>({operationId:args.operationId,
    sourceInstanceRef:'runtime:1',events:[makeEvent(0,{summary:'replacement'},{representation:'provider-summary'})],manifest:manifest(1)})}]});
  f.control.declareManifest(manifest(1));const result=await f.control.recover();assert.equal(result.coverage[0].completeness,'partial');assert.equal(result.events.length,0);
});

test('recovery cannot replace a registered source format contract when no live window survived',async()=>{
  const f=fixture({sources:[{id:'source',sourceRef:'host:source',layer:'controlled-runtime',representations:['original-response-body-bytes'],
    recover:args=>({operationId:args.operationId,sourceInstanceRef:'runtime:1',events:[makeEvent(0,{summary:'replacement'},{representation:'provider-summary'})],
      manifest:manifest(1,{representations:['provider-summary']})})}]});
  const result=await f.control.recover();assert.equal(result.coverage[0].completeness,'partial');assert.equal(result.events.length,0);
  assert.deepEqual(result.coverage[0].expectedRepresentations,['original-response-body-bytes']);
  assert.equal(result.failures[0].stage,'source-format-contract-conflict');
});
