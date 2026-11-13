import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditBoundary, auditWrap, AuditWriteError, drainAuditBuffer, auditBufferStats } from './audit-wrapper.js';
import { readDecisions } from '../decisions/logger.js';
let dir, file, previous;
beforeEach(() => {
  previous = process.env.ILLUCI_DECISIONS_FILE;
  dir = mkdtempSync(join(tmpdir(), 'illuci-boundary-audit-')); file = join(dir,'decisions.jsonl');
  process.env.ILLUCI_DECISIONS_FILE = file; drainAuditBuffer();
});
afterEach(() => {
  if (previous === undefined) delete process.env.ILLUCI_DECISIONS_FILE; else process.env.ILLUCI_DECISIONS_FILE = previous;
  if (!dir.startsWith(join(tmpdir(),'illuci-boundary-audit-'))) throw Error('Unexpected cleanup target');
  rmSync(dir, { recursive:true, force:true });
});
const records = () => readDecisions({source:'runtime',type:'boundary-audit'});

test('existing logger confirms attempt before handler and correlates observed return', async () => {
  const result = {ok:false, downstream:'not completed'};
  const wrapped = auditBoundary('tools/call', () => {
    const [attempt] = records(); assert.equal(attempt.decision,'attempt');
    assert.equal(attempt.metadata.handlerOutcome,'not-yet-invoked'); return result;
  });
  assert.equal(await wrapped({params:{name:'fixture'}}), result);
  const [attempt,done] = records(); assert.equal(done.metadata.attemptId,attempt.id);
  assert.equal(done.metadata.operationId,attempt.metadata.operationId);
  assert.equal(done.outputs.handlerOutcome,'returned'); assert.equal('ok' in done.outputs,false);
  assert.equal(done.metadata.authorizationAssessed,false); assert.equal(done.humanStatus,'operator-absent');
});

test('handler throws retain original identity and append a thrown outcome', async () => {
  const original = new Error('fixture failure');
  await assert.rejects(auditBoundary('tools/call',() => {throw original;})({}), error => error === original);
  assert.equal(records()[1].outputs.handlerOutcome,'threw');
});

test('attempt-write failure prevents invocation and reports recording uncertainty', async () => {
  process.env.ILLUCI_DECISIONS_FILE = dir; let calls=0;
  await assert.rejects(auditBoundary('tools/call',() => {calls++;})({}), error => {
    assert.ok(error instanceof AuditWriteError); assert.equal(error.stage,'attempt');
    assert.equal(error.executionObserved,false); assert.equal(error.handlerOutcome,'not-invoked');
    assert.equal(error.auditOutcome,'unconfirmed'); return true;
  });
  assert.equal(calls,0);
});

for (const throws of [false,true]) test('completion-write failure preserves observed '+(throws?'throw':'return')+' without replay', async () => {
  let calls=0; const original = new Error('private fixture failure');
  const wrapped=auditBoundary('tools/call',() => {calls++;process.env.ILLUCI_DECISIONS_FILE=dir;if(throws)throw original;return {ok:true};});
  await assert.rejects(wrapped({}),error => {
    assert.equal(error.stage,'completion'); assert.equal(error.executionObserved,true);
    assert.equal(error.handlerOutcome,throws?'threw':'returned'); assert.equal(error.retrySafe,false);
    assert.equal(error.cause,throws?original:undefined); assert.ok(error.attemptId); return true;
  });
  process.env.ILLUCI_DECISIONS_FILE=file;
  assert.equal(calls,1); assert.equal(records().length,1); assert.equal(drainAuditBuffer()[0].audit_outcome,'unconfirmed');
});

test('concurrent invocations retain distinct operation and attempt correlation', async () => {
  const pending=[];
  const wrapped=auditBoundary('resources/read',() => new Promise(resolve=>pending.push(resolve)));
  const a=wrapped({}),b=wrapped({}); assert.equal(records().length,2);
  pending[1]('second'); await b; pending[0]('first'); await a;
  const all=records();
  for(const attempt of all.filter(r=>r.decision==='attempt')) {
    const done=all.filter(r=>r.decision==='completion'&&r.metadata.operationId===attempt.metadata.operationId);
    assert.equal(done.length,1); assert.equal(done[0].metadata.attemptId,attempt.id);
  }
  assert.equal(new Set(all.map(r=>r.metadata.operationId)).size,2);
});

test('durable evidence is structural and never recursively copies arbitrary payload or identities', async () => {
  const unknown='unlabelled private free text';
  await auditBoundary('resources/read',()=>({contents:[{text:unknown}]}))({params:{name:unknown,custom:unknown}},{host:unknown,tenant_id:unknown});
  const raw=readFileSync(file,'utf8'); assert.doesNotMatch(raw,/unlabelled private free text|contents|tenant_id/);
  assert.ok(records().every(r=>r.metadata.payloadCapture==='structural-only' && r.metadata.identityAuthenticated===false));
});

test('preview omits getters, cycles and record overflow while durable receipts survive eviction', async () => {
  let reads=0; const payload={};payload.self=payload;
  Object.defineProperty(payload,'value',{enumerable:true,get(){reads++;throw Error('must not read');}});
  await auditBoundary('tools/call',()=>payload)({params:payload},{host:Object.fromEntries(Array.from({length:32},(_,i)=>['field'+i,'x'.repeat(5000)]))});
  assert.equal(reads,0); assert.ok(Buffer.byteLength(JSON.stringify(drainAuditBuffer()[0]))<=auditBufferStats().maxRecordBytes);
  assert.equal(records().length,2);
});

test('in-process opt-in wrapper uses same durable correlation and keeps original result', async () => {
  const value={outcome:'fixture'};
  assert.equal(await auditWrap({caller:'fixture',callee:'observed',args:{private:'input'}},()=>value),value);
  assert.equal(records()[0].metadata.path,'in_process');assert.equal(records()[1].metadata.attemptId,records()[0].id);
});

const uninspectable = () => new Proxy({}, { getPrototypeOf() { throw Error('private preview trap'); } });
test('failed result preview cannot replace an acknowledged handler return', async () => {
  const value=uninspectable();
  assert.equal(await auditBoundary('tools/call',()=>value)({}),value);
  assert.equal(records()[1].outputs.handlerOutcome,'returned');
  assert.equal(drainAuditBuffer()[0].preview.unavailable,true);
});
test('failed request preview cannot replace the original handler throw', async () => {
  const original=new Error('original handler error');
  await assert.rejects(auditBoundary('tools/call',()=>{throw original;})({params:uninspectable()}),error=>error===original);
  assert.equal(records()[1].outputs.handlerOutcome,'threw');
  assert.equal(drainAuditBuffer()[0].preview.unavailable,true);
});
test('failed preview cannot replace executed-but-unconfirmed audit error', async () => {
  await assert.rejects(auditBoundary('tools/call',()=>{process.env.ILLUCI_DECISIONS_FILE=dir;return uninspectable();})({}),error=>{
    assert.ok(error instanceof AuditWriteError);assert.equal(error.stage,'completion');
    assert.equal(error.executionObserved,true);assert.equal(error.retrySafe,false);return true;
  });
  assert.equal(drainAuditBuffer()[0].audit_outcome,'unconfirmed');
});
