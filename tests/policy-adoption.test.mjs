import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { injectGovernance } from '../core/governance/injector.js';
import { checkCreationDecision } from '../core/governance/compiler/runtime/dispatch-bridge.js';
import { checkVersionTransition } from '../core/governance/authortime/version-gate.js';

test('selected verification and continuous-evaluation adapters reach actual governed input', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../core/governance/compiled/carried-manifest.json',import.meta.url)));
  const ids = ['std-06.verification-gate.operate-verify-first','std-10.continuous-governance.operate-continuous','std-13.odometer.scope-credit','std-14.modularity.operate-one-concern','std-01.scope-delegation.is-carried','std-11.pcmi.reconstruct-context','art-I.sovereignty.operator-mediated','art-IX.secret-isolation.by-reference'];
  const input = injectGovernance('selected task',{modelId:'fixture'});
  for(const id of ids){
    const row=manifest.find(x=>x.id===id),mod=await import(`../core/governance/compiled/carried/${id}.js`);
    assert.equal(mod.PREAMBLE,row.preamble);assert.ok(input.includes(row.preamble));
  }
  assert.equal(injectGovernance('selected task',{raw:true}),'selected task');
});

test('creation requires grounded inadequacy; ordinary version rules have no private-history jump',()=>{
  assert.equal(checkCreationDecision(null).ok,false);
  const surface={surface:'existing',revision:'r1',owner:'team',responsibilities:'parse',contracts:'v1',demonstratedBehavior:'observed',reason:'separate boundary',adequate:false};
  const input={action:'create',record:'work:1',requirement:'new input',existingSystem:{surfaces:[surface]},gap:'new source',boundary:'input parser',owner:'team'};
  assert.equal(checkCreationDecision(input).ok,true);
  assert.equal(checkCreationDecision({...input,existingSystem:{surfaces:[{...surface,adequate:true}]}}).ok,false);
  assert.equal(checkVersionTransition('1.0.0.0-alpha','1.0.0.1-alpha').ok,true);
  assert.equal(checkVersionTransition('5.8.0.0','5.10.0.0').ok,false);
});


test('version credit follows evidenced delivery scope rather than location or syntax',async()=>{
  const {elevate,versionAction}=await import('../core/governance/authortime/ceiling/elevation.js');
  for(const band of ['LEAF','INTERMEDIATE','HUB','SUBSTRATE']) assert.equal(elevate('PATCH',band),'PATCH');
  for(const cls of ['PATCH','KOHAI','MINOR','CONTRACT','DOCTRINE']) {
    assert.equal(versionAction(cls),'scope-assessment-required');
    assert.equal(versionAction(cls,{kind:'correction',evidence:['fixture:correction']}),'patch');
    assert.equal(versionAction(cls,{kind:'increment',evidence:['fixture:progress']}),'kohai');
    assert.equal(versionAction(cls,{kind:'completed-feature',evidence:['fixture:integration']}),'minor');
  }
  assert.equal(versionAction('CONTRACT',{kind:'completed-group',evidence:['fixture:release']}),'operator-selection-required');
  assert.equal(versionAction('CONTRACT',{kind:'completed-group',operatorSelection:'fixture:operator-selection',evidence:['fixture:release']}),'major');
});


test('the real ceiling consumer preserves review reach without inventing version credit',async()=>{
  const {runCeiling}=await import('../core/governance/authortime/ceiling-check.js');
  const change={path:'illuci/core/example.js',oldContent:'export function value(){return 1;}',newContent:'export function value(){return 2;}'};
  const graph={nodes:['illuci','claude'],edges:[{from:'claude',to:'illuci'}]};
  const undecided=runCeiling({changes:[change]},{graph});
  assert.equal(undecided.proposedClass,'PATCH');
  assert.equal(undecided.versionAction,'scope-assessment-required');
  const corrected=runCeiling({changes:[change],versionScope:{kind:'correction',evidence:['fixture:corrected-contract']}},{graph});
  assert.equal(corrected.changes[0].band,'SUBSTRATE');
  assert.equal(corrected.versionAction,'patch');
});
