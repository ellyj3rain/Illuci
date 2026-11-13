import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for(const mode of ['attempt','completion'])test('real MCP stdio retains '+mode+' audit reconciliation and execution standing',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'illuci-audit-stdio-')),home=join(dir,'home');mkdirSync(home);
  const file=join(dir,'decisions.jsonl');
  const child=spawn(process.execPath,['--experimental-test-module-mocks',fileURLToPath(new URL('./audit-stdio.fixture.mjs',import.meta.url))],{
    stdio:['pipe','pipe','pipe'],env:{...process.env,ILLUCI_HOME:home,ILLUCI_DATA_HOME:join(dir,'data'),ILLUCI_DECISIONS_FILE:file,
      ILLUCI_AUDIT_FIXTURE_DIR:dir,ILLUCI_AUDIT_FIXTURE_MODE:mode,ILLUCI_HEADLESS:'1',ILLUCI_VERIFY_SOFT:'0'},
  });
  let buffer='',stderr='',parseError;const messages=[];
  child.stderr.on('data',b=>{stderr+=b;});child.stdout.on('data',b=>{buffer+=b;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{messages.push(JSON.parse(line));}catch(e){parseError=e;}}});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,1000);});}
    if(!dir.startsWith(join(tmpdir(),'illuci-audit-stdio-')))throw Error('Unexpected cleanup target');rmSync(dir,{recursive:true,force:true});});
  const send=v=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
  async function response(id){const end=Date.now()+10000;while(Date.now()<end){if(parseError)throw parseError;const found=messages.find(m=>m.id===id);if(found)return found;if(child.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,10));}throw Error('Missing response: '+stderr);}
  send({id:1,method:'initialize',params:{capabilities:{}}});assert.ok((await response(1)).result);
  send({id:2,method:'tools/call',params:{name:'audit_fixture_v1',arguments:{}}});
  const reply=await response(2),data=reply.error?.data;assert.ok(data,JSON.stringify(reply));
  assert.equal(data.code,'ILLUCI_AUDIT_WRITE_UNCONFIRMED');assert.equal(data.stage,mode);
  assert.equal(data.executionObserved,mode==='completion');assert.equal(data.auditOutcome,'unconfirmed');assert.equal(data.retrySafe,false);
  assert.match(data.operationId,/^[0-9a-f-]{36}$/);
  const actions=messages.filter(m=>m.method==='fixture/action-observed');assert.equal(actions.length,mode==='completion'?1:0);
  if(mode==='completion'){
    const records=readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(records.length,1);assert.equal(records[0].id,data.attemptId);assert.equal(records[0].metadata.operationId,data.operationId);
    assert.equal(data.handlerOutcome,'returned');assert.equal(actions[0].params.calls,1);
  }else{assert.equal(data.attemptId,null);assert.equal(data.handlerOutcome,'not-invoked');}
  assert.doesNotMatch(JSON.stringify(reply),/fixtureResult|stack|cause|private/);
  if(process.env.ILLUCI_AUDIT_STDIO_EVIDENCE_DIR)writeFileSync(join(process.env.ILLUCI_AUDIT_STDIO_EVIDENCE_DIR,'stdio-'+mode+'-evidence.json'),JSON.stringify({
    scope:'Disposable actual MCP stdio fixture; no live provider',mode,reply,actions,
    records:mode==='completion'?readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],
  },null,2)+'\n');
});
