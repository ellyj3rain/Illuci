import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const temp = mkdtempSync(join(tmpdir(), 'illuci-scope-candidate-'));
process.env.ILLUCI_DECISIONS_FILE = join(temp, 'decisions.jsonl');
process.env.ILLUCI_GATE_MODE = 'headless';
delete process.env.ILLUCI_CLASSIFIER_ENABLED;
const load = p => import(pathToFileURL(resolve(p)).href);
const ctx = await load('core/gates/approval-context.js');
const { requestApproval } = await load('core/gates/gate-controller.js');
const { auditClassifierDecision } = await load('core/gates/classifier/audit.js');
const { isClassifierEnabled } = await load('core/gates/classifier/config.js');
const { GATE_LEVELS } = await load('core/gates/gate-types.js');
const context = paths => ctx.setApprovalContext({ task:'synthetic', allowedPaths:paths, deniedPaths:[], allowedActions:['file_write','file_edit'] });
after(() => { ctx.clearApprovalContext(); rmSync(temp, { recursive:true, force:true }); });

test('exact action/path approval does not authorize a parent, sibling, child or other action', () => {
  context([]);
  ctx.recordApproval('file_write', { path:'scope/a.txt' });
  for (const path of ['scope/b.txt','scope','scope/a.txt/child']) assert.equal(ctx.evaluate('file_write',{path}).decision,'gate',path);
  assert.equal(ctx.evaluate('file_edit',{path:'scope/a.txt'}).decision,'gate');
  const selected=ctx.evaluate('file_write',{path:'scope\\a.txt'});
  assert.equal(selected.decision,'approved');
  assert.equal(selected.approvalOrigin,'operator');
  assert.deepEqual(ctx.getApprovalContext().allowedPaths,[]);
});

test('explicit directory scope continues to cover its descendants', () => {
  context(['approved/dir']);
  assert.equal(ctx.evaluate('file_write',{path:'approved/dir/child.txt'}).decision,'approved');
  assert.equal(ctx.evaluate('file_write',{path:'approved/dir/nested/../child.txt'}).decision,'approved');
  assert.equal(ctx.evaluate('file_write',{path:'approved/other.txt'}).decision,'gate');
  assert.equal(ctx.evaluate('file_write',{path:'approved/dir/../outside.txt'}).decision,'gate');
  assert.equal(ctx.evaluate('file_write',{path:'approved\\dir\\..\\outside.txt'}).decision,'gate');
  assert.equal(ctx.evaluate('file_write',{path:'approved/directory/child.txt'}).decision,'gate');
  context(['approved/dir/']);
  assert.equal(ctx.evaluate('file_write',{path:'approved/dir'}).decision,'approved');
  assert.equal(ctx.evaluate('file_write',{path:'approved/dir/child.txt'}).decision,'approved');
  context(['.']);
  assert.equal(ctx.evaluate('file_write',{path:'./child.txt'}).decision,'approved');
  assert.equal(ctx.evaluate('file_write',{path:'../outside.txt'}).decision,'gate');
  context(['C:\\approved\\dir']);
  assert.equal(ctx.evaluate('file_write',{path:'C:\\approved\\dir\\child.txt'}).decision,'approved');
  assert.equal(ctx.evaluate('file_write',{path:'C:\\approved\\dir\\..\\outside.txt'}).decision,'gate');
  context(['C:\\approved\\dir\\']);
  assert.equal(ctx.evaluate('file_write',{path:'C:\\approved\\dir'}).decision,'approved');
});

test('classifier and legacy provenance survive remembered decisions without inventing a human action', async () => {
  context([]);
  assert.equal(isClassifierEnabled(),false);
  ctx.recordApproval('file_write',{path:'synthetic/classifier.txt'},{origin:'classifier'});
  const decision=await requestApproval({tool:'file_write',args:{path:'synthetic/classifier.txt'},level:GATE_LEVELS.FULL});
  assert.equal(decision.approved,true);
  let rows=readFileSync(process.env.ILLUCI_DECISIONS_FILE,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).humanStatus,'operator-absent');
  assert.equal(rows.at(-1).metadata.approvalOrigin,'classifier');
  ctx.getApprovalContext().approvals.push({tool:'file_write',path:'synthetic/legacy.txt'});
  assert.equal((await requestApproval({tool:'file_write',args:{path:'synthetic/legacy.txt'},level:GATE_LEVELS.FULL})).approved,true);
  rows=readFileSync(process.env.ILLUCI_DECISIONS_FILE,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).humanStatus,'operator-absent');
  assert.equal(rows.at(-1).metadata.approvalOrigin,'unknown');
  for (const [origin,path] of [['unknown','synthetic/unknown.txt'],['unrecognized','synthetic/unrecognized.txt']]) {
    ctx.recordApproval('file_write',{path},{origin});
    assert.equal(ctx.evaluate('file_write',{path}).approvalOrigin,'unknown');
    assert.equal((await requestApproval({tool:'file_write',args:{path},level:GATE_LEVELS.FULL})).approved,true);
    rows=readFileSync(process.env.ILLUCI_DECISIONS_FILE,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).humanStatus,'operator-absent');
    assert.equal(rows.at(-1).metadata.approvalOrigin,'unknown');
  }
});

test('classifier audit calls preserve automated allow, deny and undecided provenance', () => {
  assert.equal(isClassifierEnabled(),false);
  for(const decision of ['allow','deny','undecided']) {
    const row=auditClassifierDecision({decision,tier:0,reason:'synthetic'}, {tool:'fixture'});
    assert.equal(row.humanStatus,'operator-absent');
    assert.equal(row.metadata.classifierDecision,decision);
  }
  const source=readFileSync(resolve('core/gates/gate-controller.js'),'utf8');
  assert.match(source,/recordApproval\(params\.tool, params\.args, \{ origin: "classifier" \}\)/);
  assert.match(source,/humanStatus: "operator-absent",[\s\S]*?type: "classifier-gate"/);
  assert.equal(isClassifierEnabled(),false);
});
