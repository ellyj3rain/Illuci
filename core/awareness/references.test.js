import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { publish, reset, recallReferences, setAdapter, recall } from './store.js';
import { createAdmittedMemoryContext } from '../context/admitted-memory-context.js';
import { createProtectedMemoryAdmission, memoryValueDigest } from '../context/protected-memory-admission.js';
const assignment = { projectId:'illuci', workId:'memory', revision:'a1', workspaceId:'host' };
const query = { company:'company', assignment, tags:['memory'], budget:{maxEvents:8,maxTokens:1000,perEventTokenCeiling:100} };
const event = extra => publish({ company:'company', assignment, summary:'data', tags:[], ...extra });
beforeEach(reset);

test('reference exclusions free the bounded output slot without changing relevance or legacy recall', () => {
  const a=event({tags:['memory']}),b=event({tags:['other']});
  assert.deepEqual(recallReferences({...query,budget:{maxEvents:1},excludeReferences:[a.id]}),[b.id]);
  assert.deepEqual(recallReferences({...query,excludeReferences:[b.id]}),[a.id]);
  assert.deepEqual(recallReferences({...query,excludeReferences:[]}),[a.id,b.id]);
  assert.deepEqual(recall(query).map(e=>e.id),[a.id,b.id]);
});

test('invalid explicit reference exclusions fail closed and cannot replace assignment or company', () => {
  const a=event();
  for(const excludeReferences of [null,undefined,'all',{},[null],[''],Array(257).fill(a.id)])
    assert.deepEqual(recallReferences({...query,excludeReferences}),[]);
  assert.deepEqual(recallReferences({...query,assignment:null,excludeReferences:[]}),[]);
  assert.deepEqual(recallReferences({...query,company:'elsewhere',excludeReferences:[]}),[]);
});

test('reference exclusions do not inspect payloads and retain the recent-window discovery bound', () => {
  let reads=0,limit;
  const make=id=>{const e={id,company:'company',assignment,tags:[]};Object.defineProperty(e,'summary',{get(){reads++;throw Error('payload read');}});return e;};
  setAdapter({recent:n=>{limit=n;return [make('held'),make('eligible')];}});
  assert.deepEqual(recallReferences({...query,budget:{maxEvents:1},excludeReferences:['held']}),['eligible']);
  assert.equal(limit,64);assert.equal(reads,0);
});

test('reference exclusions snapshot dense IDs without invoking custom iteration', () => {
  const selected=event();let iterations=0;
  const sparse=new Array(1),decorated=[selected.id];
  decorated[Symbol.iterator]=function*(){iterations++;};
  decorated.every=()=>{iterations++;return true;};
  assert.deepEqual(recallReferences({...query,excludeReferences:sparse}),[]);
  assert.deepEqual(recallReferences({...query,excludeReferences:decorated}),[]);
  assert.equal(iterations,0);
});

test('reference discovery shares tagged-recency policy while preserving legacy recall', () => {
  const a=event({tags:['memory']}); const b=event({tags:['other']});
  assert.deepEqual(recallReferences(query),[a.id,b.id]);
  assert.deepEqual(recall(query).map(e=>e.id),[a.id,b.id]);
  assert.deepEqual(recallReferences({...query,order:'recency'}),[b.id,a.id]);
});

test('work policy changes selection without moving or rewriting records', () => {
  const a=event({tags:['memory']}); const b=event({tags:['engine']});
  const limited={...query,budget:{maxEvents:1}};
  assert.deepEqual(recallReferences(limited),[a.id]);
  assert.deepEqual(recallReferences({...limited,tags:['engine']}),[b.id]);
  assert.deepEqual(recallReferences(limited),[a.id]);
});

test('scope filters precede relevance and recency', () => {
  const valid=event({tags:['memory']});
  event({assignment:{...assignment,workId:'pml'},tags:['memory']});
  event({company:'foreign',tags:['memory']});
  publish({company:'company',summary:'unbound',tags:['memory']});
  assert.deepEqual(recallReferences(query),[valid.id]);
  assert.deepEqual(recallReferences({...query,assignment:null}),[]);
  const {assignment:_,...unbound}=query; assert.deepEqual(recallReferences(unbound),[]);
});

test('self topology exclusion remains independent of assignment', () => {
  const own=event({topologyId:'own'}); const other=event({topologyId:'other'});
  assert.deepEqual(recallReferences({...query,excludeTopologyId:'own'}),[other.id]);
  assert.deepEqual(recallReferences({...query,excludeTopologyId:'own',includeSelf:true}),[other.id,own.id]);
});

test('reference discovery never reads summary or token payload fields', () => {
  let reads=0;
  const e={id:'ref',company:'company',assignment,tags:['memory']};
  Object.defineProperty(e,'summary',{get(){reads++;throw Error('payload read');}});
  Object.defineProperty(e,'tokens',{get(){reads++;throw Error('payload read');}});
  setAdapter({recent:()=>[e]});
  assert.deepEqual(recallReferences(query),['ref']); assert.equal(reads,0);
});

test('invalid policy and reference budgets fail closed', () => {
  event();
  for(const maxEvents of [0,-1,257,1.5,Infinity,'2',NaN]) assert.deepEqual(recallReferences({...query,budget:{maxEvents}}),[]);
  assert.deepEqual(recallReferences({...query,order:'unrecognized'}),[]);
  assert.deepEqual(recallReferences({...query,tags:[null]}),[]);
});

test('adapter failure and duplicate reference IDs cannot produce unbounded output', () => {
  const e={id:'ref',company:'company',assignment,tags:[]};
  setAdapter({recent:()=>[e,e,{...e,id:'second'}]});
  assert.deepEqual(recallReferences({...query,budget:{maxEvents:2}}),['ref','second']);
  setAdapter({recent:()=>{throw Error('failed');}}); assert.deepEqual(recallReferences(query),[]);
});

test('selected references still pass custody admission before rendering', async () => {
  const protectedEvent=event({summary:'PRIVATE_FEEDBACK',tags:['memory']});
  const workEvent=event({summary:'WORK_BRIEFING'});
  const reader={contextId:'c',agentId:'a',runId:'r',sessionId:'s',projectId:'illuci',assignmentId:'memory',purpose:'execution',lineage:['r']};
  const records=Object.fromEntries([protectedEvent,workEvent].map(e=>{
    const value={content:e.summary};
    return [e.id,{id:e.id,value,digest:memoryValueDigest(value),custody:{classification:e===protectedEvent?'protected':'work',
      sourceRef:'host',ownerAgentId:'a',ownerContextId:'c',projectId:'illuci',assignmentId:'memory',permittedPurposes:['execution']}}];
  }));
  const admissionPort=createProtectedMemoryAdmission({resolveReader:()=>reader,resolveItem:id=>records[id],resolveAuthorization:()=>null}).openContext('host');
  const build=createAdmittedMemoryContext({selectReferences:()=>recallReferences(query),admissionPort});
  const text=await build({modelId:'fixture',maxTokens:100});
  assert.match(text,/WORK_BRIEFING/); assert.doesNotMatch(text,/PRIVATE_FEEDBACK/);
});

test('bounded recent-window discovery can omit an older eligible reference', () => {
  const older=event({tags:['memory']});
  for(let i=0;i<64;i++)event({assignment:{...assignment,workId:'other'},tags:['memory']});
  assert.deepEqual(recallReferences({...query,budget:{maxEvents:1}}),[]);
  assert.ok(older.id);
});

test('candidate-window enforcement belongs to the adapter while reference output stays capped', () => {
  const limits=[];
  const records=Array.from({length:1600},(_,i)=>({id:'ref-'+i,company:'company',assignment,tags:[]}));
  setAdapter({recent:limit=>{limits.push(limit);return records.slice(0,limit);}});
  assert.equal(recallReferences({...query,budget:{maxEvents:1}}).length,1);
  assert.equal(recallReferences({...query,budget:{maxEvents:256}}).length,256);
  assert.deepEqual(limits,[64,1536]);
  const unrelated=records.slice(0,64).map(e=>({...e,company:'other'}));
  setAdapter({recent:limit=>{assert.equal(limit,64);return [...unrelated,{...records[0],id:'outside-requested-window'}];}});
  assert.deepEqual(recallReferences({...query,budget:{maxEvents:1}}),['outside-requested-window']);
});

test('returned references cannot mutate records or queries, while existing mutable tags affect later priority', () => {
  const oldTags=['memory'],newTags=[];
  const older=event({tags:oldTags}),newer=event({tags:newTags});
  const q={...query,budget:{maxEvents:1}},before=structuredClone(q);
  const refs=recallReferences(q);refs[0]='forged';refs.push('extra');
  assert.deepEqual(q,before);
  assert.deepEqual(recallReferences(q),[older.id]);
  oldTags.pop();newTags.push('memory');
  assert.deepEqual(recallReferences(q),[newer.id]);
  assert.deepEqual(q,before);
});

test('malformed outer queries and company identities do not reach the adapter', () => {
  let calls=0;setAdapter({recent:()=>{calls++;return [];}});
  for(const q of [null,0,'name',[],{},...['',null,5].map(company=>({...query,company}))])assert.deepEqual(recallReferences(q),[]);
  assert.equal(calls,0);
});
