import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createAcpStdioClient} from './grok-acp-client.mjs';

function fixture(opts={}){
 const fromAgent=new PassThrough(),toAgent=new PassThrough(),messages=[];let pending='';
 toAgent.on('data',chunk=>{pending+=chunk.toString('utf8');let n;while((n=pending.indexOf('\n'))>=0){const m=JSON.parse(pending.slice(0,n));pending=pending.slice(n+1);messages.push(m);
  if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
  if(m.method==='session/new')send({id:m.id,result:{sessionId:'fixture-session'}});
 }});
 const send=m=>fromAgent.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',...m})+'\n'));
 const sendBatch=(...m)=>fromAgent.write(Buffer.from(m.map(x=>JSON.stringify({jsonrpc:'2.0',...x})+'\n').join('')));
 const wait=async fn=>{for(let i=0;i<100;i++){const x=messages.find(fn);if(x)return x;await new Promise(r=>setTimeout(r,2));}throw Error('fixture message missing');};
 const client=createAcpStdioClient({readable:fromAgent,writable:toAgent,timeoutMs:500,cancelTimeoutMs:60,...opts});
 return {client,messages,send,sendBatch,wait,fromAgent,toAgent};
}
async function ready(t,opts){const f=fixture(opts);t.after(()=>f.client.close());await f.client.initialize();await f.client.createSession({cwd:process.cwd()});return f;}
const update=text=>({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});

test('initialization and session use ACP v1 with no advertised tool capabilities',async t=>{
 const f=await ready(t);assert.equal(f.messages[0].method,'initialize');assert.deepEqual(f.messages[0].params.clientCapabilities,{});assert.equal(f.messages[1].method,'session/new');assert.deepEqual(f.messages[1].params.mcpServers,[]);assert.equal(f.client.status().state,'ready');
});
test('fragmented UTF-8 and coalesced frames preserve updates; observer cannot mutate retained output',async t=>{
 const f=await ready(t,{onUpdate:u=>{u.content.text='changed';}});const p=f.client.prompt('fixture');const q=await f.wait(m=>m.method==='session/prompt');
 const raw=Buffer.from(JSON.stringify({jsonrpc:'2.0',...update('漢🙂')})+'\n'+JSON.stringify({jsonrpc:'2.0',id:q.id,result:{stopReason:'end_turn'}})+'\n');const at=raw.indexOf(Buffer.from('漢'))+2;f.fromAgent.write(raw.subarray(0,at));f.fromAgent.write(raw.subarray(at));
 const r=await p;assert.equal(r.updates[0].content.text,'漢🙂');assert.equal(r.stopReason,'end_turn');assert.equal(r.processCessation,'unknown');assert.equal(r.taskValidation,'not-performed');
});
test('permission requests are declined and unsupported client requests receive method-not-found',async t=>{
 const f=await ready(t),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');f.send({id:'permission',method:'session/request_permission',params:{sessionId:'fixture-session'}});f.send({id:'terminal',method:'terminal/create',params:{}});
 assert.deepEqual((await f.wait(m=>m.id==='permission')).result,{outcome:{outcome:'cancelled'}});assert.equal((await f.wait(m=>m.id==='terminal')).error.code,-32601);f.send({id:q.id,result:{stopReason:'end_turn'}});await p;
});
test('cancellation is id-less, retains late updates and is confirmed only by prompt response',async t=>{
 const f=await ready(t),controller=new AbortController(),p=f.client.prompt('q',{signal:controller.signal}),q=await f.wait(m=>m.method==='session/prompt');controller.abort();const c=await f.wait(m=>m.method==='session/cancel');assert.equal(Object.hasOwn(c,'id'),false);f.send(update('late'));f.send({id:'p',method:'session/request_permission',params:{sessionId:'fixture-session'}});assert.equal((await f.wait(m=>m.id==='p')).result.outcome.outcome,'cancelled');f.send({id:q.id,result:{stopReason:'cancelled'}});
 const result=await p;assert.equal(result.cancelRequested,true);assert.equal(result.cancellationConfirmed,true);assert.equal(result.updates[0].content.text,'late');assert.equal(result.processCessation,'unknown');
});
test('an end_turn response after a cancel request is not a cancellation confirmation',async t=>{
 const f=await ready(t),controller=new AbortController(),p=f.client.prompt('q',{signal:controller.signal}),q=await f.wait(m=>m.method==='session/prompt');controller.abort();await f.wait(m=>m.method==='session/cancel');f.send({id:q.id,result:{stopReason:'end_turn'}});const r=await p;assert.equal(r.cancelRequested,true);assert.equal(r.cancellationConfirmed,false);assert.equal(r.stopReason,'end_turn');
});
test('unconfirmed cancellation holds the session and retains observed partial output',async t=>{
 const f=await ready(t),controller=new AbortController(),p=f.client.prompt('q',{signal:controller.signal});await f.wait(m=>m.method==='session/prompt');f.send(update('partial'));controller.abort();await assert.rejects(p,e=>e.code==='ILLUCI_GROK_ACP_UNCONFIRMED'&&e.retrySafe===false&&e.cancelRequested&&e.updates[0].content.text==='partial'&&e.processCessation==='unknown');assert.equal(f.client.status().state,'unconfirmed');await assert.rejects(f.client.prompt('again'),/not ready/);
});
test('EOF after partial output never implies completion and preserves the update',async t=>{
 const f=await ready(t),p=f.client.prompt('q');await f.wait(m=>m.method==='session/prompt');f.send(update('partial'));f.fromAgent.end();await assert.rejects(p,e=>e.outcome==='unknown'&&e.retrySafe===false&&e.updates[0].content.text==='partial');
});
test('RPC error, unknown stop reason, malformed frames and post-terminal update fail closed',async t=>{
 for(const kind of ['rpc','stop','bad','late']){const f=await ready(t),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');
  if(kind==='rpc')f.send({id:q.id,error:{code:-32603,message:'fixture'}});if(kind==='stop')f.send({id:q.id,result:{stopReason:'invented'}});if(kind==='bad')f.fromAgent.write(Buffer.from('{bad}\n'));if(kind==='late')f.sendBatch({id:q.id,result:{stopReason:'end_turn'}},update('late'));
  await assert.rejects(p,e=>e.retrySafe===false&&e.outcome==='unknown');assert.equal(f.client.status().state,'unconfirmed');}
});
test('oversized input and invalid UTF-8 refuse without retry',async t=>{
 for(const bytes of [Buffer.from('x'.repeat(300)+'\n'),Buffer.from([0xff,10])]){const f=await ready(t,{maxFrameBytes:256}),p=f.client.prompt('q');await f.wait(m=>m.method==='session/prompt');f.fromAgent.write(bytes);await assert.rejects(p,e=>e.outcome==='unknown'&&e.retrySafe===false);}
});
test('pre-aborted request never sends a prompt and nonterminal stops are preserved',async t=>{
 const f=await ready(t),controller=new AbortController();controller.abort();await assert.rejects(f.client.prompt('q',{signal:controller.signal}),{code:'ILLUCI_NOT_STARTED',retrySafe:true});assert.equal(f.messages.some(m=>m.method==='session/prompt'),false);
 for(const reason of ['max_tokens','max_turn_requests','refusal']){const p=f.client.prompt('q'),q=f.messages.filter(m=>m.method==='session/prompt').at(-1);f.send({id:q.id,result:{stopReason:reason}});assert.equal((await p).stopReason,reason);}
});
test('RPC errors retain original request correlation and malformed errors do not strand the turn',async t=>{
 for(const valid of [true,false]){const f=await ready(t),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');f.send({id:q.id,error:valid?{code:-32603,message:'fixture error',data:{source:'fixture'}}:{message:'missing code'}});await assert.rejects(p,e=>e.outcome==='unknown'&&e.retrySafe===false&&(!valid||e.requestId===q.id&&e.rpcError.code===-32603&&e.rpcError.data.source==='fixture'));}
});
test('retained update bytes are bounded separately from individual frames',async t=>{
 const f=await ready(t,{maxUpdateBytes:128}),p=f.client.prompt('q');await f.wait(m=>m.method==='session/prompt');f.send(update('x'.repeat(200)));await assert.rejects(p,e=>e.outcome==='unknown'&&e.retrySafe===false);
});
test('abort after terminal frame does not send a stale cancellation',async t=>{
 const f=await ready(t),controller=new AbortController(),p=f.client.prompt('q',{signal:controller.signal}),q=await f.wait(m=>m.method==='session/prompt');f.send({id:q.id,result:{stopReason:'end_turn'}});controller.abort();const r=await p;assert.equal(r.cancelRequested,false);assert.equal(f.messages.some(m=>m.method==='session/cancel'),false);
});
test('the original prompt request ID survives terminal and uncertain outcomes',async t=>{
 for(const confirm of [true,false]){const f=await ready(t),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');if(confirm){f.send({id:q.id,result:{stopReason:'end_turn'}});assert.equal((await p).requestId,q.id);}else{f.fromAgent.end();await assert.rejects(p,e=>e.requestId===q.id&&e.outcome==='unknown');}}
});
test('foreign-session update during a prompt holds the original without attributing the foreign text',async t=>{
 const f=await ready(t),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');f.send(update('own'));const foreign=update('foreign');foreign.params.sessionId='other-session';f.send(foreign);
 await assert.rejects(p,e=>e.outcome==='unknown'&&e.retrySafe===false&&e.requestId===q.id&&e.updates.length===1&&e.updates[0].content.text==='own'&&e.unmatchedUpdate.kind==='foreign-session'&&e.unmatchedUpdate.event.params.sessionId==='other-session');
 assert.equal(f.client.status().state,'unconfirmed');await assert.rejects(f.client.prompt('again'),/not ready/);
});
test('same-session post-return update is retained separately and prevents a subsequent prompt',async t=>{
 const f=await ready(t),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');f.send({id:q.id,result:{stopReason:'end_turn'}});const completed=await p;assert.equal(completed.stopReason,'end_turn');f.send(update('late'));
 const s=f.client.status();assert.equal(s.state,'unconfirmed');assert.equal(s.anomaly.kind,'out-of-turn');assert.equal(s.anomaly.event.params.update.content.text,'late');await assert.rejects(f.client.prompt('again'),/not ready/);
});
test('rejected asynchronous observer does not crash and later observations retain delivery order',async t=>{
 const delivered=[];const f=await ready(t,{onUpdate:async u=>{delivered.push(u.content.text);await Promise.resolve();if(u.content.text==='first')throw Error('synthetic observer failure');}}),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');f.sendBatch(update('first'),update('second'),{id:q.id,result:{stopReason:'end_turn'}});const r=await p;assert.deepEqual(r.updates.map(u=>u.content.text),['first','second']);for(let i=0;i<20&&f.client.status().observerDelivery.pending;i++)await new Promise(r=>setTimeout(r,1));assert.deepEqual(delivered,['first','second']);assert.equal(f.client.status().observerDelivery.pending,0);assert.equal(f.client.status().observerDelivery.dropped,0);
});
test('a stalled observer has a bounded queue while the turn retains later updates',async t=>{
 let release;const blocker=new Promise(r=>{release=r;}),delivered=[];const f=await ready(t,{maxUpdates:1,onUpdate:async u=>{delivered.push(u.content.text);await blocker;}});
 const first=f.client.prompt('q1'),q1=await f.wait(m=>m.method==='session/prompt');f.sendBatch(update('first'),{id:q1.id,result:{stopReason:'end_turn'}});assert.equal((await first).updates[0].content.text,'first');
 const second=f.client.prompt('q2'),q2=f.messages.filter(m=>m.method==='session/prompt').at(-1);f.sendBatch(update('second'),{id:q2.id,result:{stopReason:'end_turn'}});const r=await second;assert.equal(r.updates[0].content.text,'second');assert.equal(r.observerDelivery.dropped,1);release();for(let i=0;i<20&&f.client.status().observerDelivery.pending;i++)await new Promise(r=>setTimeout(r,1));assert.deepEqual(delivered,['first']);
});
function coalescedFixture(stage){
 const fromAgent=new PassThrough(),toAgent=new PassThrough(),messages=[];let input='';
 const frame=m=>JSON.stringify({jsonrpc:'2.0',...m})+'\n';
 toAgent.on('data',chunk=>{input+=chunk.toString('utf8');let i;while((i=input.indexOf('\n'))>=0){const m=JSON.parse(input.slice(0,i));input=input.slice(i+1);messages.push(m);
  if(m.method==='initialize'){const result={id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}};fromAgent.write(frame(result)+(stage==='initialize'?frame(update('premature')):''));}
  if(m.method==='session/new'){const result={id:m.id,result:{sessionId:'fixture-session'}};const next=stage==='session-fatal'?update('late'):stage==='session-metadata'?{method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}}:null;fromAgent.write(frame(result)+(next?frame(next):''));}
 }});
 return {client:createAcpStdioClient({readable:fromAgent,writable:toAgent,timeoutMs:500}),messages};
}
test('coalesced fatal after initialization response cannot revive the client',async t=>{
 const f=coalescedFixture('initialize');t.after(()=>f.client.close());await assert.rejects(f.client.initialize(),{code:'ILLUCI_GROK_ACP_UNCONFIRMED'});assert.equal(f.client.status().state,'unconfirmed');await assert.rejects(f.client.createSession({cwd:process.cwd()}));assert.equal(f.messages.some(m=>m.method==='session/new'),false);
});
test('coalesced late turn update after session response cannot become ready',async t=>{
 const f=coalescedFixture('session-fatal');t.after(()=>f.client.close());await f.client.initialize();await assert.rejects(f.client.createSession({cwd:process.cwd()}),{code:'ILLUCI_GROK_ACP_UNCONFIRMED'});assert.equal(f.client.status().state,'unconfirmed');assert.equal(f.client.status().anomaly.event.params.update.content.text,'late');await assert.rejects(f.client.prompt('q'),/not ready/);assert.equal(f.messages.some(m=>m.method==='session/prompt'),false);
});
test('valid metadata coalesced after session/new is attributed and retained',async t=>{
 const f=coalescedFixture('session-metadata');t.after(()=>f.client.close());await f.client.initialize();assert.equal((await f.client.createSession({cwd:process.cwd()})).sessionId,'fixture-session');assert.equal(f.client.status().state,'ready');assert.equal(f.client.status().sessionMetadata[0].sessionUpdate,'available_commands_update');
});
test('validated same-session idle metadata is retained without holding the session',async t=>{
 const f=await ready(t);const metadata=[{sessionUpdate:'available_commands_update',availableCommands:[{name:'help',description:'Help'}]},{sessionUpdate:'current_mode_update',currentModeId:'ask'},{sessionUpdate:'config_option_update',configOptions:[{id:'model',name:'Model',type:'select'}]},{sessionUpdate:'session_info_update',title:'Fixture',updatedAt:null},{sessionUpdate:'usage_update',used:3,size:20,cost:{amount:0,currency:'USD'}}];for(const update of metadata)f.send({method:'session/update',params:{sessionId:'fixture-session',update}});const status=f.client.status();assert.equal(status.state,'ready');assert.deepEqual(status.sessionMetadata,metadata);status.sessionMetadata[0].availableCommands[0].name='mutated';assert.equal(f.client.status().sessionMetadata[0].availableCommands[0].name,'help');
});
test('malformed idle metadata and foreign-session metadata remain unconfirmed',async t=>{
 for(const foreign of [false,true]){const f=await ready(t);f.send({method:'session/update',params:{sessionId:foreign?'foreign':'fixture-session',update:foreign?{sessionUpdate:'usage_update',used:1,size:2}:{sessionUpdate:'usage_update',used:'invalid',size:2}}});assert.equal(f.client.status().state,'unconfirmed');assert.ok(f.client.status().anomaly);}
});
test('async observer failure is counted separately from pending and dropped deliveries',async t=>{
 const f=await ready(t,{onUpdate:async()=>{throw Error('fixture observer failure');}}),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');f.sendBatch(update('observed'),{id:q.id,result:{stopReason:'end_turn'}});assert.equal((await p).updates[0].content.text,'observed');for(let i=0;i<20&&f.client.status().observerDelivery.pending;i++)await new Promise(r=>setTimeout(r,1));assert.deepEqual(f.client.status().observerDelivery,{pending:0,dropped:0,failed:1});
});
test('observer backlog has a cross-turn byte bound as well as a count bound',async t=>{
 let release;const blocker=new Promise(r=>{release=r;});const f=await ready(t,{maxUpdates:10,maxUpdateBytes:128,onUpdate:async()=>blocker});
 const p1=f.client.prompt('first'),q1=await f.wait(m=>m.method==='session/prompt');f.sendBatch(update('x'.repeat(30)),{id:q1.id,result:{stopReason:'end_turn'}});await p1;
 const p2=f.client.prompt('second'),q2=f.messages.filter(m=>m.method==='session/prompt').at(-1);f.sendBatch(update('x'.repeat(30)),{id:q2.id,result:{stopReason:'end_turn'}});const r=await p2;assert.equal(r.observerDelivery.dropped,1);assert.equal(r.updates.length,1);release();
});
test('host acknowledgment drains bounded metadata over a healthy long session',async t=>{
 const f=await ready(t,{maxUpdates:2});let expected=0;
 for(let cycle=0;cycle<8;cycle++){
  for(let i=0;i<2;i++)f.send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'usage_update',used:++expected,size:100}}});
  const batch=f.client.readSessionMetadata();assert.equal(batch.entries.length,2);assert.deepEqual(batch.entries.map(x=>x.sequence),[expected-1,expected]);assert.ok(batch.entries.every(x=>x.sessionId==='fixture-session'));
  const ack=f.client.acknowledgeSessionMetadata({ackToken:batch.ackToken,retentionRef:`fixture:retained:${cycle}`});assert.equal(ack.throughSequence,expected);assert.equal(f.client.status().sessionMetadata.length,0);assert.equal(f.client.status().state,'ready');
 }
});
test('only the exact offered prefix can be acknowledged; later metadata survives',async t=>{
 const f=await ready(t,{maxUpdates:3});const meta=n=>({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'usage_update',used:n,size:10}}});f.send(meta(1));
 assert.throws(()=>f.client.acknowledgeSessionMetadata({ackToken:'fabricated',retentionRef:'fixture:stored'}));const batch=f.client.readSessionMetadata();const again=f.client.readSessionMetadata();assert.deepEqual(again,batch);batch.entries[0].update.used=999;
 assert.throws(()=>f.client.acknowledgeSessionMetadata({ackToken:batch.ackToken,retentionRef:'  '}));f.send(meta(2));assert.throws(()=>f.client.acknowledgeSessionMetadata({ackToken:'wrong',retentionRef:'fixture:stored'}));
 const ack=f.client.acknowledgeSessionMetadata({ackToken:batch.ackToken,retentionRef:'fixture:stored'});assert.equal(ack.throughSequence,1);assert.equal(ack.count,1);assert.equal(f.client.status().sessionMetadata[0].used,2);assert.throws(()=>f.client.acknowledgeSessionMetadata({ackToken:batch.ackToken,retentionRef:'fixture:stored'}));const next=f.client.readSessionMetadata();assert.equal(next.entries[0].sequence,2);assert.equal(next.entries[0].update.used,2);
});
test('actual metadata retention overflow is distinct and preserves the unaccepted event',async t=>{
 const f=await ready(t,{maxUpdates:1});const meta=n=>({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'usage_update',used:n,size:10}}});f.send(meta(1));f.send(meta(2));const s=f.client.status();assert.equal(s.state,'unconfirmed');assert.equal(s.anomaly.kind,'metadata-overflow');assert.equal(s.anomaly.event.params.update.used,2);assert.equal(s.sessionMetadata[0].used,1);assert.equal(f.client.readSessionMetadata().entries[0].update.used,1);await assert.rejects(f.client.prompt('q'),/not ready/);
});
test('metadata during a prompt is independently retained and still appears in turn order',async t=>{
 const f=await ready(t),p=f.client.prompt('q'),q=await f.wait(m=>m.method==='session/prompt');const metadata={sessionUpdate:'current_mode_update',currentModeId:'ask'};f.send({method:'session/update',params:{sessionId:'fixture-session',update:metadata}});const batch=f.client.readSessionMetadata();assert.deepEqual(batch.entries[0].update,metadata);f.client.acknowledgeSessionMetadata({ackToken:batch.ackToken,retentionRef:'fixture:stored'});f.send({id:q.id,result:{stopReason:'end_turn'}});assert.deepEqual((await p).updates,[metadata]);assert.equal(f.client.status().sessionMetadata.length,0);
});
test('metadata byte overflow is reported without silently discarding the arrival',async t=>{
 const f=await ready(t,{maxUpdateBytes:128});const m={method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'session_info_update',title:'x'.repeat(200)}}};f.send(m);const s=f.client.status();assert.equal(s.state,'unconfirmed');assert.equal(s.anomaly.kind,'metadata-overflow');assert.equal(s.anomaly.event.params.update.title.length,200);
});
