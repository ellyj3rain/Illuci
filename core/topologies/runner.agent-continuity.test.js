/** Public runner proof for M5 continuity routing. The real runner, frame, awareness
 * store and spawn-tool construction run; provider/seat-loop execution is stubbed.
 * Default tests use portable publication callbacks. Explicit native qualification
 * imports the adopted publication constructor and permits its pinned fixture-only
 * helper. No lifecycle run, provider, tool handler or grant writer is invoked.
 */
import { test, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { resolveIlluciHomeDir } from '../agents/home-dir.js';

const probe = vi.hoisted(() => ({ dispatches: [], loops: [], spawns: [], failOpening: false, unexpected: [], throwAgentId: null, thrownValue: null, gitReads: 0,
  publication: null, publicationError: null, publicationResolutions: 0, allowedPublication: null }));
function publicationSpawn(spawn, args) {
  const allowed = probe.allowedPublication;
  assert.ok(allowed, 'explicit native publication fixture required');
  assert.equal(args[0], allowed.executablePath);
  assert.deepEqual(args[1], ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', allowed.helperPath]);
  assert.equal(args[2].windowsHide, true); assert.equal(args[2].shell, false);
  const request = JSON.parse(args[2].input);
  assert.ok(request.destination.startsWith(allowed.projectDir));
  assert.ok(request.source.startsWith(allowed.projectDir));
  allowed.calls++;
  return spawn(...args);
}
vi.mock('child_process', async importOriginal => {
  const real=await importOriginal(),nativeSpawn=real.spawnSync;const deny=name=>(...args)=>{
    if(name==='spawnSync'&&probe.allowedPublication)return publicationSpawn(nativeSpawn,args);
    if(name==='execFileSync'&&args[0]==='git'&&Array.isArray(args[1])&&
      !args[1].some(a=>['reset','checkout','commit','config','add','fetch','pull','push'].includes(a))) {probe.gitReads++;return real.execFileSync(...args);}
    probe.unexpected.push(name);const error=Error('Unexpected child process at isolated runner boundary');console.error(error.stack);throw error;};
  return {...real,spawn:deny('spawn'),spawnSync:deny('spawnSync'),exec:deny('exec'),execSync:deny('execSync'),execFile:deny('execFile'),execFileSync:deny('execFileSync')};
});
vi.mock('../tools/burp.js',()=>({getTools:async()=>({})}));
vi.mock('../tools/unreal-mcp.js',()=>({getTools:async()=>({})}));
vi.mock('../events/emitter.js', async importOriginal => ({...await importOriginal(),
  // Local structural events and run IDs remain real; omit remote discovery.
  emitTopologyStart: async()=>{},
}));
const scratch = mkdtempSync(join(tmpdir(), 'illuci-continuity-run-'));
const isolatedEnv = {
  ILLUCI_HOME: join(scratch, 'home'),
  ILLUCI_DATA_HOME: join(scratch, 'data'),
  ILLUCI_CONTEXT_DB: join(scratch, 'context.db'),
  ILLUCI_GATE_MODE: 'headless', ILLUCI_DRL_ENABLED: '0', ILLUCI_PREFLIGHT_ENABLED: '0',
};
const savedEnv = Object.fromEntries(Object.keys(isolatedEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);
const answer = model => ({ model, response: 'assignment runner answer',
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, latency: 1 });

vi.mock('../dispatch/dispatch.js', async importOriginal => ({
  ...await importOriginal(),
  queryModel: async (model, message, options) => {
    probe.dispatches.push({ model, message, options });
    if (probe.throwAgentId === options?.agentId) { probe.throwAgentId = null; throw probe.thrownValue; }
    if (probe.failOpening && probe.dispatches.length <= 2) return { model, response: null, error: 'fixture failure' };
    return answer(model);
  },
}));
vi.mock('../orchestrate/seat-loop.js', async importOriginal => ({
  ...await importOriginal(),
  runSeatLoop: async options => { probe.loops.push(options); return answer(options.model); },
}));
vi.mock('../orchestrate/spawn.js', async importOriginal => {
  const real = await importOriginal();
  return { ...real, makeSpawnTool: (context, deps) => {
    probe.spawns.push(context);
    return real.makeSpawnTool(context, deps);
  } };
});

let runTopology, topologies, store, lineup;
let sequence = 0;
const assignment = Object.freeze({ projectId: 'illuci', workId: 'memory', revision: 'r1', workspaceId: 'test-workspace' });
const company = 'assignment-run:stage:1';
const topologyId = 'adversarial-debate';
const baseOptions = {
  runControl: { agenda: { strategy: 'ritual' }, execution: { mutationAuthority: 'blocked' }, tools: { autonomy: 'directed' } },
  projectId: null, awareness: true, busScope: company, perceive: false,
};
beforeAll(async () => {
  vi.stubGlobal('fetch',async()=>{probe.unexpected.push('fetch');const error=Error('Unexpected network at isolated runner boundary');console.error(error.stack);throw error;});
  ({ runTopology } = await import('./runner.js'));
  topologies = await import('./index.js');
  store = await import('../awareness/store.js');
  const { MODELS } = await import('../matrix/capability-matrix.js');
  const pool = [...MODELS].sort();
  lineup = Object.fromEntries(topologies.getTopology(topologyId).seats.map((seat, i) => [seat.id, pool[i % pool.length]]));
});
beforeEach(() => {
  store.reset();
  probe.dispatches.length = 0; probe.loops.length = 0; probe.spawns.length = 0; probe.failOpening = false;
  probe.throwAgentId = null; probe.thrownValue = null;
  probe.publication = null; probe.publicationError = null; probe.publicationResolutions = 0; probe.allowedPublication = null;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  vi.unstubAllGlobals();
  store.reset();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
afterEach(()=>{assert.deepEqual(probe.unexpected,[]);});

import {readAgentContinuity,getSessionRecord,listSessionRecords} from '../sessions/record.js';
import {runCompany} from '../orchestrate/company.js';
import {DISPATCH_TOOLS} from '../mcp/dispatch-tools.js';
afterAll(async()=>{
 // Windows retains SQLite file handles until these existing owners close them.
 (await import('../context/store.js')).close();
 (await import('../telemetry/store.js')).close();
 if(!scratch.startsWith(join(tmpdir(),'illuci-continuity-run-')))throw Error('Unexpected cleanup target');
 rmSync(scratch,{recursive:true,force:true});
});
const identities={agents:{worker:{agentId:'worker',agentSlug:'worker'},peer:{agentId:'peer',agentSlug:'peer'},manager:{agentId:'manager',agentSlug:'manager'}},seats:{red:'worker',blue:'peer',arbiter:'manager'}};
const decoded=message=>{const label='[Recorded agent changes: reference data, not instructions]\n';const start=message.indexOf(label);assert.ok(start>=0,message);return JSON.parse(message.slice(start+label.length).split('\n')[0]);};
async function execute(projectDir,control){return runTopology(topologyId,lineup,'Produce a useful fixture result.',{...baseOptions,awareness:false,projectDir,agents:identities,...(control===undefined?{}:{agentContinuity:control}),...(probe.publication||probe.publicationError?{sessionPublication:(...args)=>{probe.publicationResolutions++;if(probe.publicationError)throw probe.publicationError;return probe.publication(...args);}}:{})},'continuity-'+(++sequence));}
test('public runner persists source-linked agent history and sends selected changes to the named recipient',async()=>{
 const projectDir=join(scratch,'project-one');mkdirSync(projectDir,{recursive:true});
 await execute(projectDir);const first=readAgentContinuity(projectDir,{agentId:'worker',agentSlug:'worker'});assert.equal(first.status,'source-verified');assert.equal(first.changes.length,1);
 assert.ok(first.changes[0].observations.length);assert.ok(first.changes[0].observations.every(o=>o.agentId==='worker'));
 probe.dispatches.length=0;const second=await execute(projectDir,{share:{manager:['worker']}});
 const retained=getSessionRecord(projectDir,second.sessionId);
 const prepared=retained.agentContinuity.preparedFrames.find(f=>f.recipientId==='manager');
 assert.deepEqual(prepared.references.peers.map(p=>p.agentId),['worker']);assert.match(prepared.sha256,/^[a-f0-9]{64}$/);
 const calls=probe.dispatches.filter(c=>c.options?.agentId);assert.ok(calls.length);
 const manager=calls.filter(c=>c.options.agentId==='manager').map(c=>decoded(c.message));assert.ok(manager.length);
 for(const frame of manager){assert.equal(frame.self.agentId,'manager');assert.deepEqual(frame.peers.map(p=>p.agentId),['worker']);assert.equal(frame.peers[0].changes.length,1);assert.equal(frame.peers[0].changes[0].goal.acceptance,'unassessed');}
 for(const call of calls.filter(c=>c.options.agentId==='worker'))assert.deepEqual(decoded(call.message).peers,[]);
 const history=readAgentContinuity(projectDir,{agentId:'worker',agentSlug:'worker'});assert.equal(history.changes.length,2);assert.notEqual(history.changes[0].source.runId,history.changes[1].source.runId);
 probe.dispatches.length=0;await execute(projectDir,{share:{manager:['worker']},after:{manager:{worker:first.cursor}}});
 for(const call of probe.dispatches.filter(c=>c.options?.agentId==='manager')){const frame=decoded(call.message);assert.deepEqual(frame.peers[0].changes.map(c=>c.source.sessionId),[history.changes[1].source.sessionId]);}
});
test('unknown continuity recipient/source is rejected before any seat dispatch',async()=>{
 const projectDir=join(scratch,'project-invalid');mkdirSync(projectDir,{recursive:true});
 await assert.rejects(execute(projectDir,{share:{manager:['unselected-agent']}}),/continuity recipient/);assert.equal(probe.dispatches.filter(c=>c.options?.agentId).length,0);
});

test('selected publication reaches normal close and source-verified distillation', async () => {
  const projectDir = join(scratch, 'selected-publication'); mkdirSync(projectDir, { recursive: true });
  let calls = 0, restore = () => {};
  try {
      // Portable callback-contract fixture; not native publication evidence.
      probe.publication = (path, value) => {
        calls++; const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
        writeFileSync(path, bytes, { flag: 'wx' });
        return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
      };
    const trace = await execute(projectDir, {});
    assert.equal(probe.publicationResolutions, 1); assert.equal(calls, 1);
    assert.ok(getSessionRecord(projectDir, trace.sessionId, { runId: trace.runId }));
    assert.equal(readAgentContinuity(projectDir, { agentId: 'worker', agentSlug: 'worker' }).status, 'source-verified');
    if (probe.allowedPublication) assert.equal(probe.allowedPublication.calls, 1);
  } finally { restore(); }
}, 20000);

test('selected publication failure leaves ordinary work running without direct-write or distillation fallback', async () => {
  const projectDir = join(scratch, 'failed-publication'); mkdirSync(projectDir, { recursive: true });
  let calls = 0;
  probe.publication = () => { calls++; throw Error('fixture stage failure'); };
  const trace = await execute(projectDir, {});
  assert.equal(calls, 1); assert.notEqual(trace.halted, true);
  assert.ok(Object.values(trace.phases).some(phase => phase.responses?.some(r => typeof r.response === 'string')));
  assert.deepEqual(listSessionRecords(projectDir), []);
  assert.equal(readAgentContinuity(projectDir, { agentId: 'worker', agentSlug: 'worker' }).status, 'no-recorded-state');
});

test('acknowledged substituted seal preserves work output and final evidence without distillation', async () => {
  const projectDir = join(scratch, 'substituted-publication'); mkdirSync(projectDir, { recursive: true });
  let final, calls = 0;
  probe.publication = (path, value) => {
    final = path; calls++;
    const changed = { ...value, sessionId: 'foreign-session', agentAssignments: { foreign: 'foreign-agent' } };
    const bytes = Buffer.from(JSON.stringify(changed));
    writeFileSync(path, bytes, { flag: 'wx' });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const trace = await execute(projectDir, {});
  assert.equal(calls, 1); assert.notEqual(trace.halted, true);
  assert.ok(Object.values(trace.phases).some(phase => phase.responses?.some(r => typeof r.response === 'string')));
  assert.equal(JSON.parse(readFileSync(final, 'utf8')).sessionId, 'foreign-session');
  assert.equal(existsSync(join(projectDir, '.illuci', 'data', 'memory', 'project.jsonl')), false);
  for (const id of ['worker', 'peer', 'manager']) {
    assert.equal(existsSync(join(projectDir, '.illuci', 'data', 'memory', 'agents', id + '.jsonl')), false);
    assert.equal(readAgentContinuity(projectDir, { agentId: id, agentSlug: id }).status, 'no-recorded-state');
  }
});

test('publisher-added hidden array behavior cannot become derived project memory', async () => {
  const projectDir = join(scratch, 'hidden-publication-behavior'); mkdirSync(projectDir, { recursive: true });
  let final;
  probe.publication = (path, value) => {
    final = path; const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(path, bytes, { flag: 'wx' });
    Object.defineProperty(value.arrangement, 'filter', { enumerable: false, value: () => [{ type: 'mandate_revised' }] });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const trace = await execute(projectDir, {});
  assert.notEqual(trace.halted, true); assert.ok(existsSync(final));
  assert.equal(existsSync(join(projectDir, '.illuci', 'data', 'memory', 'project.jsonl')), false);
});

test('invalid configured publication resolver leaves no direct compatibility record', async () => {
  const projectDir = join(scratch, 'invalid-publication'); mkdirSync(projectDir, { recursive: true });
  probe.publicationError = Error('fixture invalid adopted binding');
  const trace = await execute(projectDir, {});
  assert.equal(probe.publicationResolutions, 1); assert.notEqual(trace.halted, true);
  assert.ok(Object.values(trace.phases).some(phase => phase.responses?.some(r => typeof r.response === 'string')));
  assert.deepEqual(listSessionRecords(projectDir), []);
});

test('records M5 frame presence separately from preparation at actual query calls',async()=>{
 const projectDir=join(scratch,'dispatch-observation-project');mkdirSync(projectDir,{recursive:true});
 const trace=await execute(projectDir,{});
 const audit=trace.agentContinuity.dispatch;
 assert.equal(audit?.schema,'illuci.agent-continuity-dispatch/1');
 const calls=probe.dispatches.filter(c=>c.options?.agentId);
 assert.equal(audit.observations.length,calls.length);
 for(const call of calls){
  const inputSha256=createHash('sha256').update(call.message).digest('hex');
  const observation=audit.observations.find(o=>o.recipientId===call.options.agentId&&o.inputSha256===inputSha256);
  assert.ok(observation);assert.equal(observation.route,'query-model');assert.equal(observation.model,call.model);
  assert.equal(observation.inputBytes,Buffer.byteLength(call.message));assert.equal(observation.presence,'exact-frame-present');
  assert.equal(observation.outcome,'returned');assert.ok(observation.phaseId);
  assert.equal(Object.getOwnPropertySymbols(call.options).length,0);
  assert.equal(observation.frameSha256,trace.agentContinuity.preparedFrames.find(f=>f.recipientId===observation.recipientId).sha256);
 }
 assert.deepEqual(getSessionRecord(projectDir,trace.sessionId).agentContinuity.dispatch,audit);
 const topology=topologies.getTopology(topologyId),phase=topology.phases.find(p=>p.type==='parallel');
 const hadRaw=Object.hasOwn(phase,'raw'),originalRaw=phase.raw;
 try{
  phase.raw=true;probe.dispatches.length=0;
  const raw=await execute(projectDir,{});
  assert.ok(raw.agentContinuity.preparedFrames.length);
  assert.ok(raw.agentContinuity.dispatch.observations.some(o=>o.phaseId===phase.id&&o.presence==='absent'));
  assert.ok(probe.dispatches.some(c=>c.options?.agentId&&!c.message.includes('[Recorded agent changes:')));
 }finally{if(hadRaw)phase.raw=originalRaw;else delete phase.raw;}
});

test('seat-loop observation covers the initial entry and preserves absent-control behavior',async()=>{
 const projectDir=join(scratch,'seat-loop-observation-project');mkdirSync(projectDir,{recursive:true});
 const trace=await runTopology(topologyId,lineup,'Observe the initial seat-loop input.',{
  ...baseOptions,awareness:false,projectDir,agents:identities,agentContinuity:{},seatLoop:true,adaptive:false,
 },'loop-observation-'+(++sequence));
 assert.ok(probe.loops.length);
 const observed=trace.agentContinuity.dispatch.observations.filter(o=>o.route==='seat-loop-entry');
 assert.equal(observed.length,probe.loops.length);
 for(const call of probe.loops){
  const inputSha256=createHash('sha256').update(call.message).digest('hex');
  const entry=observed.find(o=>o.recipientId===call.agentId&&o.inputSha256===inputSha256);
  assert.ok(entry);assert.equal(entry.presence,'exact-frame-present');assert.equal(entry.outcome,'returned');
 }
 assert.deepEqual(getSessionRecord(projectDir,trace.sessionId).agentContinuity.dispatch,trace.agentContinuity.dispatch);
 const legacy=await execute(projectDir,undefined);assert.equal(legacy.agentContinuity,null);
});

test('seat-loop option preparation failure creates no observation of an uncalled loop',async()=>{
 const projectDir=join(scratch,'seat-loop-preparation-failure');mkdirSync(projectDir,{recursive:true});
 let reads=0;
 const workPermits=Object.defineProperty({},'worker',{enumerable:true,get(){reads++;throw Error('fixture preparation failed');}});
 const trace=await runTopology(topologyId,lineup,'Retain the preparation failure without a false entry.',{
  ...baseOptions,awareness:false,projectDir,agents:identities,agentContinuity:{},seatLoop:true,workPermits,adaptive:false,
 },'preparation-failure-'+(++sequence));
 assert.ok(reads>0);assert.equal(probe.loops.filter(c=>c.agentId==='worker').length,0);
 assert.deepEqual(trace.agentContinuity.dispatch.observations.filter(o=>o.recipientId==='worker'),[]);
 const state=readAgentContinuity(projectDir,{agentId:'worker',agentSlug:'worker'});
 assert.ok(state.changes.flatMap(c=>c.observations).some(o=>o.status==='error-observed'));
});

test('real company members retain distinct agent histories under their shared parent session',async()=>{
 const projectDir=join(scratch,'company-project');mkdirSync(projectDir,{recursive:true});
 const other={agents:{otherWorker:{agentId:'otherWorker',agentSlug:'otherWorker'},otherPeer:{agentId:'otherPeer',agentSlug:'otherPeer'},otherManager:{agentId:'otherManager',agentSlug:'otherManager'}},seats:{red:'otherWorker',blue:'otherPeer',arbiter:'otherManager'}};
 const members=[identities,other].map(agents=>({topologyId,lineup,options:{...baseOptions,awareness:false,projectDir,agents,agentContinuity:{}}}));
 const company=await runCompany({topologies:members,prompt:'Deliver the bounded company fixture.',concurrency:2,awareness:false},{runTopology});
 const records=listSessionRecords(projectDir);assert.equal(records.length,2);assert.equal(records[0].sessionId,records[1].sessionId);assert.notEqual(records[0].runId,records[1].runId);
 for(const summary of records){
  const record=getSessionRecord(projectDir,summary.sessionId,{runId:summary.runId});
  const assigned=new Set(Object.values(record.agentAssignments).flat().map(a=>a.agentId));
  assert.ok(record.agentContinuity.dispatch.observations.length);
  assert.ok(record.agentContinuity.dispatch.observations.every(o=>assigned.has(o.recipientId)));
  assert.equal(record.agentContinuity.dispatch.observations[0].ordinal,1);
 }
 for(const agentId of ['worker','otherWorker']){const state=readAgentContinuity(projectDir,{agentId,agentSlug:agentId});assert.equal(state.status,'source-verified');assert.equal(state.changes.length,1);assert.ok(state.changes[0].observations.every(o=>o.agentId===agentId));}
 assert.ok(company);
});

test('opaque __proto__ recipient receives its own prepared continuity frame through the public runner',async()=>{
 const projectDir=join(scratch,'opaque-project');mkdirSync(projectDir,{recursive:true});
 const options={...baseOptions,awareness:false,projectDir,agents:identities,
  seatAgents:{red:{agentId:'__proto__',agentSlug:'opaque-memory'}},agentContinuity:{},adaptive:false};
 for(let i=0;i<2;i++)await runTopology(topologyId,lineup,'Continue the opaque agent fixture.',options,'opaque-'+(++sequence));
 const calls=probe.dispatches.filter(c=>c.options?.agentId==='__proto__');assert.ok(calls.length);
 for(const c of calls){assert.equal(decoded(c.message).self.agentId,'__proto__');assert.doesNotMatch(c.message,/\[object Object\]/);}
 const state=readAgentContinuity(projectDir,{agentId:'__proto__',agentSlug:'opaque-memory'});assert.equal(state.status,'source-verified');assert.equal(state.changes.length,2);
});

for(const [label,thrownValue] of [['Error',new Error('fixture rejected call')],['falsy',0]]){
 test(`rejected parallel ${label} retains the known agent identity and an observed error`,async()=>{
  const projectDir=join(scratch,'rejected-'+label);mkdirSync(projectDir,{recursive:true});
  probe.throwAgentId='worker';probe.thrownValue=thrownValue;
  const trace=await runTopology(topologyId,lineup,'Observe the rejected call fixture.',{...baseOptions,awareness:false,projectDir,agents:identities,agentContinuity:{},adaptive:false},'rejected-'+(++sequence));
  assert.ok(trace.agentContinuity.dispatch.observations.some(o=>o.recipientId==='worker'&&o.outcome==='threw'));
  const state=readAgentContinuity(projectDir,{agentId:'worker',agentSlug:'worker'});assert.equal(state.status,'source-verified');
  const errors=state.changes.flatMap(c=>c.observations).filter(o=>o.status==='error-observed');assert.ok(errors.length);
  assert.ok(errors.every(o=>o.agentId==='worker'));assert.equal(probe.throwAgentId,null);
 });
}

test('actual MCP topology handler forwards host-bound M5 through real runner and returns minimal caller receipt',async()=>{
 const projectDir=join(scratch,'mcp-bound-project');mkdirSync(projectDir,{recursive:true});
 await execute(projectDir);
 const tool=DISPATCH_TOOLS.find(t=>t.name==='run_topology_v1');
 const args={topology:topologyId,task:'Continue the assigned fixture.',assignments:lineup,agents:identities,
  runControl:baseOptions.runControl,perceive:false,agentContinuity:{share:{manager:['worker']}},adaptive:false};
 const ctx={principalContext:{snapshot:()=>({binding:{workspaceId:projectDir}})}};
 probe.dispatches.length=0;
 const result=await tool.handler(args,ctx);
 const manager=probe.dispatches.filter(c=>c.options?.agentId==='manager');assert.ok(manager.length);
 for(const c of manager){assert.deepEqual(decoded(c.message).peers.map(p=>p.agentId),['worker']);assert.equal(decoded(c.message).peers[0].changes.length,1);}
 for(const c of probe.dispatches.filter(c=>c.options?.agentId==='peer'))assert.deepEqual(decoded(c.message).peers,[]);
 const receipt=result.agentContinuity;assert.ok(receipt.recipients.length);
 assert.match(receipt.recipients.find(r=>r.recipientId==='manager').sha256,/^[a-f0-9]{64}$/);
 assert.ok(receipt.recipients.find(r=>r.recipientId==='manager').sources.some(s=>s.agentId==='worker'&&s.cursor?.runId));
 assert.doesNotMatch(JSON.stringify(receipt),/changes|observed|goal|PRIVATE/);
 assert.equal(readAgentContinuity(projectDir,{agentId:'worker',agentSlug:'worker'}).changes.length,2);
});

// Private work-authority/REST host integration is outside this source selection.
