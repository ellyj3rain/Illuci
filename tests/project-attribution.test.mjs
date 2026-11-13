import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {execFileSync} from 'node:child_process';
vi.mock('../core/events/emitter.js',()=>({emit:()=>{}}));
vi.mock('../core/sandbox/git.js',()=>({appendEvent:()=>{}}));
import {createSandbox,cleanupSandbox,getSandbox} from '../core/sandbox/workspace.js';
import {createPR,formatPRsForReview,getPR} from '../core/sandbox/pr-manager.js';

test('actual sandbox branch, commit and PR presentation do not add provider authorship',()=>{
  const root=mkdtempSync(join(tmpdir(),'illuci-attribution-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    git('init','-q');git('config','user.name','Fixture Maintainer');git('config','user.email','fixture@example.test');
    writeFileSync(join(root,'README.md'),'synthetic source\n');git('add','README.md');git('commit','-qm','Initial synthetic fixture');
    const sandbox=createSandbox('implementation','provider-fixture-model',undefined,root);
    assert.doesNotMatch(sandbox.branch,/provider-fixture-model/);
    writeFileSync(join(sandbox.workdir,'change.txt'),'bounded fixture result\n');
    const made=createPR('implementation','provider-fixture-model',sandbox.branch,'Add the bounded fixture result');
    const subject=execFileSync('git',['-C',sandbox.workdir,'log','-1','--format=%s'],{encoding:'utf8'}).trim();
    assert.equal(subject,'Add the bounded fixture result');
    const presented=formatPRsForReview([made.prId]);
    assert.doesNotMatch(presented,/provider-fixture-model|\*\*Author:/);
    assert.match(presented,/Add the bounded fixture result/);
    assert.equal(getPR(made.prId).modelId,'provider-fixture-model'); // private operational provenance is distinct
  } finally {
    if(getSandbox('implementation'))cleanupSandbox('implementation');
    rmSync(root,{recursive:true,force:true});
  }
});
