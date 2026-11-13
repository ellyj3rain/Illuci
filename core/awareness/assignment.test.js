import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from './store.js';
import { composeSeatFrame } from '../topologies/frame.js';
const assignment={projectId:'illuci',workId:'memory',revision:'r1',workspaceId:'cloud'};
const budget={maxEvents:2,maxTokens:1000,perEventTokenCeiling:384};
const query=(extra={})=>({company:'run:stage:1',excludeTopologyId:'principal',assignment,budget,...extra});
const publish=(extra={})=>store.publish({company:'run:stage:1',topologyId:'worker',summary:'eligible',assignment,...extra});
beforeEach(()=>store.reset());
test('publication preserves a detached identity and no claimed authorization',()=>{
 const supplied={...assignment,taskId:'t1',allowed:true}; const result=publish({assignment:supplied}); supplied.workId='other';
 assert.deepEqual(result.assignment,{...assignment,taskId:'t1'});
 assert.equal('allowed' in result.assignment,false);
});
test('high relevance cannot admit a different assignment',()=>{
 publish(); publish({summary:'wrong',tags:['critical'],assignment:{...assignment,workId:'other-work'}});
 assert.deepEqual(store.recall(query({tags:['critical']})).map(e=>e.summary),['eligible']);
});
test('every selected identity dimension is exact and independent',()=>{
 for(const key of Object.keys(assignment))publish({summary:key,assignment:{...assignment,[key]:'different'}});
 publish(); assert.deepEqual(store.recall(query()).map(e=>e.summary),['eligible']);
});
test('assignment cannot widen company or stage isolation',()=>{
 publish({company:'other'});publish({company:'run:stage:2'});
 assert.deepEqual(store.recall(query()),[]);
});
test('strict selection rejects unbound events and malformed identities',()=>{
 publish({assignment:undefined});publish({assignment:null});publish({assignment:{...assignment,revision:''}});
 store.publish({company:'run:stage:1',topologyId:'worker',summary:'legacy'});
 assert.deepEqual(store.recall(query()),[]);
});
test('explicit invalid selection never becomes unrestricted recall',()=>{
 publish();
 for(const value of [null,undefined,{},[],{...assignment,workId:5},{...assignment,taskId:''}]) assert.deepEqual(store.recall(query({assignment:value})),[]);
 for(const company of [null,undefined,'',5])assert.deepEqual(store.recall(query({company})),[]);
});
test('task identity is required only when selected, never guessed',()=>{
 publish({assignment:{...assignment,taskId:'old'}});publish({assignment});
 assert.deepEqual(store.recall(query({assignment:{...assignment,taskId:'new'}})),[]);
 publish({summary:'new',assignment:{...assignment,taskId:'new'}});
 assert.deepEqual(store.recall(query({assignment:{...assignment,taskId:'new'}})).map(e=>e.summary),['new']);
 assert.equal(store.recall(query()).length,2);
});
test('self topology isolation remains independent of assignment',()=>{
 publish({topologyId:'principal'});
 assert.deepEqual(store.recall(query()),[]);
 assert.equal(store.recall(query({includeSelf:true})).length,1);
});
test('rendered omission count excludes rejected assignments',()=>{
 publish({summary:'eligible1'}); publish({summary:'eligible2'});
 for(let i=0;i<8;i++)publish({assignment:{...assignment,workId:'other'},summary:'reject'});
 const block=store.recallBlock(query({budget:{...budget,maxEvents:1}}));
 assert.match(block,/eligible2/);assert.match(block,/\(\+1 more/);assert.doesNotMatch(block,/reject/);
});
test('legacy unselected recall retains tag ordering and company scope',()=>{
 store.publish({company:'c',topologyId:'t',summary:'first',tags:['selected']});
 store.publish({company:'c',topologyId:'t',summary:'second'});
 store.publish({company:'elsewhere',topologyId:'t',summary:'outside'});
 assert.deepEqual(store.recall({company:'c',tags:['selected'],budget}).map(e=>e.summary),['first','second']);
});
test('bounded candidate window is not exhaustive memory retrieval',()=>{
 publish();for(let i=0;i<64;i++)publish({assignment:{...assignment,workId:'other'}});
 assert.deepEqual(store.recall(query()),[]);
 assert.equal(store.getAdapter().size,65);
});
test('filtered awareness is consumed by the real seat frame',()=>{
 publish({summary:'selected evidence'});publish({summary:'unrelated correction',assignment:{...assignment,workId:'other'}});
 const frame=composeSeatFrame({task:'continue selected work',awarenessBlock:store.recallBlock(query())});
 assert.equal(typeof frame,'string');assert.match(frame,/selected evidence/);assert.doesNotMatch(frame,/unrelated correction/);
});
test('published and recalled references cannot rewrite stored assignment',()=>{
 const result=publish();
 assert.throws(()=>{result.assignment.workId='other-work';},TypeError);
 assert.throws(()=>{result.assignment={...assignment,workId:'other-work'};},TypeError);
 const recalled=store.recall(query())[0];
 assert.throws(()=>{recalled.assignment.workId='other-work';},TypeError);
 recalled.assignment={...assignment,workId:'other-work'};
 assert.equal(store.recall(query()).length,1);
 assert.equal(store.recall(query({assignment:{...assignment,workId:'other-work'}})).length,0);
});
test('federation cannot mutate retained scoped assignment',()=>{
 store.registerFederation(e=>{e.assignment={...assignment,workId:'other-work'};});
 assert.ok(publish()); assert.equal(store.recall(query()).length,1);
});
test('unselected readers do not consume newly assignment-scoped events',()=>{
 publish();publish({assignment:null});
 store.publish({company:'run:stage:1',topologyId:'worker',summary:'legacy'});
 assert.deepEqual(store.recall({company:'run:stage:1',budget}).map(e=>e.summary),['legacy']);
});
