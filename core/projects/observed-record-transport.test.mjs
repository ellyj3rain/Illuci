import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,lstatSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import * as nativeFs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {selectExistingRecordAppend} from './record-file-port.mjs';
import {recordProjectData,listProjectData,transactProjectData} from './substrate.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,project=false){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'illuci-observed-record-composition-')));
  const temporaryParent=realpathSync(tmpdir());
  t.after(()=>{const selected=realpathSync(root),r=relative(temporaryParent,selected);assert.equal(selected,root);assert.ok(r&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep)&&r.startsWith('illuci-observed-record-composition-'));assert.equal(lstatSync(root).isSymbolicLink(),false);rmSync(root,{recursive:true,force:true});});
  if(project){execFileSync('git',['-C',root,'init'],{stdio:'ignore',windowsHide:true});writeFileSync(join(root,'VERSION'),'1.0.0\n');}
  return root;
}
function port(root,bytes=Buffer.from('{"synthetic":"new"}\n'),current=()=>true){
  const path=join(root,'records.jsonl');writeFileSync(path,'{"synthetic":"seed"}\n');
  const before=readFileSync(path),s=lstatSync(path,{bigint:true});
  return {path,before,selected:selectExistingRecordAppend({path,fileIdentity:{dev:s.dev.toString(),ino:s.ino.toString()},expectedPrefixSha256:hash(before),expectedSize:before.length,operationRef:'fixture:original-operation',bytes,assertWriterCurrent:current})};
}
function project(t){const root=fixture(t,true);recordProjectData(root,'artifacts',{id:'fixture-seed',type:'fixture',payload:{synthetic:true}});return root;}
const rows=root=>listProjectData(root,{lane:'artifacts'}).records;
test('port observes exact copied UTF-8 bytes and consumes selection once',t=>{
  const root=fixture(t),input=Buffer.from('{"unicode":"\u03bb"}\n'),f=port(root,input);input.fill(120);
  const r=f.selected.appendOnce();assert.equal(r.io.fileSync,'completed');assert.equal(r.io.sameHandleReadback,true);
  assert.equal(r.readbackBytes.toString(),'{"unicode":"\u03bb"}\n');assert.equal(r.authorityGranted,false);assert.equal(r.custodyAuthenticated,false);
  const after=readFileSync(f.path);assert.ok(after.subarray(0,f.before.length).equals(f.before));
  assert.throws(()=>f.selected.appendOnce(),{code:'ILLUCI_RECORD_APPEND_UNCONFIRMED',retrySafe:false});assert.deepEqual(readFileSync(f.path),after);
});
test('port refuses stale prefix before writing and never grants retry',t=>{
  const root=fixture(t),f=port(root);writeFileSync(f.path,Buffer.alloc(f.before.length,120));const altered=readFileSync(f.path);
  assert.throws(()=>f.selected.appendOnce(),e=>e.code==='ILLUCI_RECORD_APPEND_UNCONFIRMED'&&e.io.writtenBytes===0&&e.retrySafe===false);
  assert.deepEqual(readFileSync(f.path),altered);
});
test('port refuses missing writer currentness before an effect',t=>{
  const f=port(fixture(t),undefined,()=>false);assert.throws(()=>f.selected.appendOnce(),e=>e.io.writtenBytes===0&&e.retrySafe===false);
  assert.deepEqual(readFileSync(f.path),f.before);
});
test('post-write currentness loss preserves measured original I/O without replay',t=>{
  let n=0;const f=port(fixture(t),undefined,()=>++n<3);
  assert.throws(()=>f.selected.appendOnce(),e=>e.io.writtenBytes>0&&e.io.fileSync==='completed'&&e.io.sameHandleReadback===true&&e.retrySafe===false);
  const after=readFileSync(f.path);assert.throws(()=>f.selected.appendOnce(),{code:'ILLUCI_RECORD_APPEND_UNCONFIRMED'});assert.deepEqual(readFileSync(f.path),after);
});
test('actual substrate returns observed original row and expires transaction ports',t=>{
  const root=project(t);let retained;
  const r=transactProjectData(root,'artifacts',tx=>{retained=tx;return tx.appendObserved({id:'fixture-observed',type:'fixture',payload:{synthetic:true},metadata:{goalFeedbackOperationRef:'fixture-original-operation'}});});
  assert.equal(r.record.id,'fixture-observed');assert.equal(r.io.fileSync,'completed');assert.equal(r.io.sameHandleReadback,true);
  assert.equal(rows(root).filter(x=>x.id==='fixture-observed').length,1);assert.throws(()=>retained.read(),/transaction has ended/);
  assert.equal(existsSync(join(root,'.illuci/data/artifacts/illuci-authority-gate.lock')),false);
});
test('ordinary artifacts writer shares the selected transaction exclusion',t=>{
  const root=project(t),count=rows(root).length;
  transactProjectData(root,'artifacts',()=>{assert.throws(()=>recordProjectData(root,'artifacts',{id:'must-not-append'}),{code:'ILLUCI_AUTHORITY_GATE_UNCONFIRMED'});});
  assert.equal(rows(root).length,count);
});
test('Promise transaction is refused and retains its original fixture gate',t=>{
  const root=project(t);assert.throws(()=>transactProjectData(root,'artifacts',()=>Promise.resolve('fixture-no-effect')),{code:'ILLUCI_AUTHORITY_GATE_UNCONFIRMED',retrySafe:false});
  assert.equal(existsSync(join(root,'.illuci/data/artifacts/illuci-authority-gate.lock')),true);
});
test('strong append cannot create a missing records lane or silently fall back',t=>{
  const root=fixture(t,true);assert.throws(()=>transactProjectData(root,'artifacts',tx=>tx.appendObserved({metadata:{goalFeedbackOperationRef:'fixture-original-operation'}})));
  assert.equal(existsSync(join(root,'.illuci/data/artifacts/records.jsonl')),false);
  assert.equal(existsSync(join(root,'.illuci/data/artifacts/illuci-authority-gate.lock')),true);
});
// Descriptor probe is test-local: real filesystem calls and unchanged port body,
// with only the exact builtin import redirected. No global fs monkeypatch.
const FIXED_PORT_SHA='a92cbbe43df917cdb651a3afc7dafbe2d73108ad74805e0964ae913704868a52';
const ORIGINAL_PORT_SHA='398b69f2208dca2d74edfbb3c5a78f8118ab54a13ed41a0589741c4e10e821ff';
const OWNED_CLOSE_HELPER=" function closeOwned(){if(fd===null)return;const owned=fd;fd=null;closeSync(owned);}\n";
function fixedPortSource(){const source=readFileSync(new URL('./record-file-port.mjs',import.meta.url),'utf8');assert.equal(hash(Buffer.from(source)),FIXED_PORT_SHA);return source;}
function originalPortSource(fixed){
  let source=fixed;
  const changes=[
    [OWNED_CLOSE_HELPER,''],
    ["pathCurrent();io.sameHandleReadback=true;closeOwned();check();standing='observed';","pathCurrent();io.sameHandleReadback=true;closeSync(fd);fd=null;check();standing='observed';"],
    ["   finally{try{closeOwned();}catch{}}\n",''],
  ];
  for(const [from,to]of changes){assert.equal(source.split(from).length,2);source=source.replace(from,to);}
  assert.equal(hash(Buffer.from(source)),ORIGINAL_PORT_SHA);return source;
}
async function withDescriptorProbe(t,source,closeMode,use){
  const root=fixture(t),path=join(root,'records.jsonl');writeFileSync(path,'{"synthetic":"descriptor-seed"}\n');
  const before=readFileSync(path),s=lstatSync(path,{bigint:true}),opened=[],owned=new Map();let closeCalls=0;
  const cleanupFailure=Object.assign(Error('synthetic owned-close failure'),{code:'FIXTURE_CLOSE_FAILURE'});
  const probe={...nativeFs,
    openSync(...args){const fd=nativeFs.openSync(...args);if(args[0]===path&&args[1]==='r+'){const current=nativeFs.fstatSync(fd,{bigint:true});opened.push(fd);owned.set(fd,{dev:current.dev,ino:current.ino});}return fd;},
    closeSync(fd){if(!owned.has(fd))return nativeFs.closeSync(fd);closeCalls++;if(closeMode==='throw-before-close')throw cleanupFailure;nativeFs.closeSync(fd);owned.delete(fd);if(closeMode==='close-then-throw')throw cleanupFailure;},
  };
  const key='__illuci_owned_fd_probe_'+randomUUID();assert.equal(Object.hasOwn(globalThis,key),false);
  const importLine="import {openSync,readSync,writeSync,fsyncSync,closeSync,fstatSync,lstatSync,realpathSync} from 'node:fs';";
  assert.equal(source.split(importLine).length,2);
  const instrumented=source.replace(importLine,`const {openSync,readSync,writeSync,fsyncSync,closeSync,fstatSync,lstatSync,realpathSync}=globalThis[${JSON.stringify(key)}];`);
  Object.defineProperty(globalThis,key,{value:Object.freeze(probe),configurable:true});
  try{
    const module=await import('data:text/javascript;base64,'+Buffer.from(instrumented).toString('base64'));
    delete globalThis[key];
    const selected=module.selectExistingRecordAppend({path,fileIdentity:{dev:s.dev.toString(),ino:s.ino.toString()},expectedPrefixSha256:hash(before),expectedSize:before.length,operationRef:'fixture-owned-fd-operation',bytes:Buffer.from('{"synthetic":"descriptor-append"}\n'),assertWriterCurrent:()=>true});
    const assertClosed=()=>{assert.equal(opened.length,1);assert.throws(()=>nativeFs.fstatSync(opened[0]),{code:'EBADF'});};
    const failBeforeAppend=()=>{writeFileSync(path,Buffer.alloc(before.length,120));let caught;try{selected.appendOnce();}catch(error){caught=error;}assert.equal(caught?.code,'ILLUCI_RECORD_APPEND_UNCONFIRMED');assert.equal(caught.retrySafe,false);assert.equal(caught.io.writtenBytes,0);assert.equal(selected.standing,'held');return caught;};
    return await use({selected,path,before,opened,assertClosed,failBeforeAppend,cleanupFailure,get closeCalls(){return closeCalls;}});
  }finally{
    delete globalThis[key];
    // Fixture repair only: close a tracked descriptor only while its exact
    // device/inode is still ours. Never close a reused descriptor number.
    for(const [fd,id]of owned){let current;try{current=nativeFs.fstatSync(fd,{bigint:true});}catch(error){if(error.code==='EBADF'){owned.delete(fd);continue;}throw error;}assert.equal(current.dev,id.dev);assert.equal(current.ino,id.ino);nativeFs.closeSync(fd);owned.delete(fd);}
  }
}
test('descriptor regression: exact original fails closure invariant and corrected source closes after prefix refusal',async t=>{
  const fixed=fixedPortSource(),original=originalPortSource(fixed);
  await withDescriptorProbe(t,original,'normal',p=>{p.failBeforeAppend();assert.equal(p.closeCalls,0);assert.throws(p.assertClosed,{code:'ERR_ASSERTION'});assert.doesNotThrow(()=>nativeFs.fstatSync(p.opened[0]));});
  await withDescriptorProbe(t,fixed,'normal',p=>{p.failBeforeAppend();assert.equal(p.closeCalls,1);p.assertClosed();const after=readFileSync(p.path);assert.throws(()=>p.selected.appendOnce(),{code:'ILLUCI_RECORD_APPEND_UNCONFIRMED',retrySafe:false});assert.deepEqual(readFileSync(p.path),after);assert.equal(p.closeCalls,1);});
});
test('descriptor cleanup failure cannot mask the primary pre-append failure or change measured I/O',async t=>{
  await withDescriptorProbe(t,fixedPortSource(),'throw-before-close',p=>{const failure=p.failBeforeAppend();assert.equal(failure.cause.message,'Original record file changed');assert.notEqual(failure.cause,p.cleanupFailure);assert.equal(failure.io.fileSync,'not-performed');assert.equal(failure.io.sameHandleReadback,false);assert.equal(p.closeCalls,1);assert.doesNotThrow(()=>nativeFs.fstatSync(p.opened[0]));});
});
test('owned descriptor closes once on success and is not double-closed after a throwing close',async t=>{
  await withDescriptorProbe(t,fixedPortSource(),'normal',p=>{const r=p.selected.appendOnce();assert.equal(r.io.fileSync,'completed');assert.equal(p.closeCalls,1);p.assertClosed();assert.equal(p.selected.standing,'observed');});
  await withDescriptorProbe(t,fixedPortSource(),'close-then-throw',p=>{let caught;try{p.selected.appendOnce();}catch(error){caught=error;}assert.equal(caught.cause,p.cleanupFailure);assert.equal(caught.code,'ILLUCI_RECORD_APPEND_UNCONFIRMED');assert.equal(caught.retrySafe,false);assert.equal(caught.io.fileSync,'completed');assert.equal(caught.io.sameHandleReadback,true);assert.equal(p.selected.standing,'held');assert.equal(p.closeCalls,1);p.assertClosed();});
});
test('failure before open attempts no descriptor cleanup',async t=>{
  await withDescriptorProbe(t,fixedPortSource(),'normal',p=>{writeFileSync(p.path,'short');assert.throws(()=>p.selected.appendOnce(),error=>error.code==='ILLUCI_RECORD_APPEND_UNCONFIRMED'&&error.io.writtenBytes===0);assert.equal(p.opened.length,0);assert.equal(p.closeCalls,0);});
});
