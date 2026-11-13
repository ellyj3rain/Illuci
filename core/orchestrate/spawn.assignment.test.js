import {test} from 'node:test';
import assert from 'node:assert/strict';
// Use the repository's ordinary Node test lane; execution stays behind injected deps.
import {TopologyTree,makeSpawnTool} from './spawn.js';
import {DetachedRunRegistry} from './detached-registry.js';
const assignment={projectId:'illuci',workId:'memory',revision:'r1',workspaceId:'cloud'};
async function exercise(extra,detached=false){
 const calls=[];const tree=new TopologyTree('s');tree.registerRoot('root','parent');
 const registry=detached?new DetachedRunRegistry('s'):null;
 const tool=makeSpawnTool({sessionId:'s',parentRunId:'root',tree,detached,registry,busScope:'stage:1',...extra},{enforceDispatch:()=>({allowed:true}),requestApproval:async()=>({approved:true}),runTopology:async(...args)=>{calls.push(args);return {runId:'child',halted:false};}});
 const result=await tool.handler({topologyId:'child',prompt:'do selected work'});
 await new Promise(r=>setImmediate(r));assert.equal(result.ok,true);assert.equal(calls.length,1);
 return calls[0][3];
}
for(const detached of [false,true]){
 test(`assignment survives ${detached?'detached':'awaited'} child option composition`,async()=>{
 const opts=await exercise({awarenessAssignment:assignment},detached);assert.deepEqual(opts.awarenessAssignment,assignment);assert.equal(opts.busScope,'stage:1');assert.equal(opts.awareness,true);
 });
 test(`explicit invalid assignment stays explicit in ${detached?'detached':'awaited'} child`,async()=>{
 for(const value of [null,undefined]){const opts=await exercise({awarenessAssignment:value},detached);assert.equal(Object.hasOwn(opts,'awarenessAssignment'),true);assert.equal(opts.awarenessAssignment,value);}
 });
}
test('legacy child options omit selection and persona carry cannot override explicit selection',async()=>{
 assert.equal(Object.hasOwn(await exercise({}),'awarenessAssignment'),false);
 const opts=await exercise({awarenessAssignment:assignment,childCarry:{awarenessAssignment:{...assignment,workId:'wrong'}}});assert.deepEqual(opts.awarenessAssignment,assignment);
});
