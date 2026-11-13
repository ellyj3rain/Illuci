import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.js';
import { readDecisions } from '../decisions/logger.js';
let dir, previous;
before(()=>{previous=process.env.ILLUCI_DECISIONS_FILE;dir=mkdtempSync(join(tmpdir(),'illuci-boundary-readback-'));process.env.ILLUCI_DECISIONS_FILE=join(dir,'decisions.jsonl');});
after(()=>{if(previous===undefined)delete process.env.ILLUCI_DECISIONS_FILE;else process.env.ILLUCI_DECISIONS_FILE=previous;
  if(!dir.startsWith(join(tmpdir(),'illuci-boundary-readback-')))throw Error('Unexpected cleanup target');rmSync(dir,{recursive:true,force:true});});

test('actual MCP list and decision-log resource expose correlated audit receipts without recursive persistence',async()=>{
  const {handlers}=await startServer({tenantId:'audit-fixture'});
  const list=await handlers['resources/list']({});assert.ok(list.resources.some(r=>r.name==='decision_log_v1'));
  const read=await handlers['resources/read']({params:{name:'decision_log_v1',arguments:{type:'boundary-audit'}}});
  const document=JSON.parse(read.contents[0].text);
  assert.ok(document.decisions.some(r=>r.type==='boundary-audit'&&r.decision==='completion'));
  const current=readDecisions({source:'runtime',type:'boundary-audit'});
  const completed=current.at(-1),attempt=current.find(r=>r.id===completed.metadata.attemptId);
  assert.equal(completed.metadata.operation,'resources/read');assert.equal(completed.outputs.handlerOutcome,'returned');
  assert.ok(document.decisions.some(r=>r.id===attempt.id));
  assert.equal(document.decisions.some(r=>r.id===completed.id),false); // Read snapshot precedes its own completion.
  assert.ok(JSON.stringify(completed).length<1800);assert.equal('contents' in completed.outputs,false);
});
