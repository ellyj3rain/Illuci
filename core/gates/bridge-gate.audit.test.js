import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

for (const approved of [false, true]) test('existing stdio bridge retains '+(approved?'approval':'refusal')+' and remembered outcome without tool execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illuci-gate-audit-'));
  const url = name => new URL(name, import.meta.url).href;
  const source = [
    'import { requestApproval } from '+JSON.stringify(url('./gate-controller.js'))+';',
    'import { GATE_LEVELS } from '+JSON.stringify(url('./gate-types.js'))+';',
    'import { setApprovalContext, clearApprovalContext } from '+JSON.stringify(url('./approval-context.js'))+';',
    'import { closeBridge } from '+JSON.stringify(url('./bridge-gate.js'))+';',
    'import { readDecisions } from '+JSON.stringify(url('../decisions/logger.js'))+';',
    'import { existsSync } from "node:fs";',
    'const path='+JSON.stringify(join(root,'must-not-exist.txt'))+';',
    'setApprovalContext({task:"Synthetic bridge decision",allowedPaths:[],deniedPaths:[],allowedActions:["file_write"]});',
    'try { const params={tool:"file_write",args:{path,content:"never executed"},level:GATE_LEVELS.FULL,source:{model:"fixture",seat:"test"}};',
    'const first=await requestApproval(params); const second=await requestApproval(params);',
    'process.stdout.write(JSON.stringify({type:"fixture_result",first,second,rows:readDecisions({type:"tool-gate",source:"runtime"}),targetExists:existsSync(path)})+String.fromCharCode(10));',
    '} catch(error) { process.stdout.write(JSON.stringify({type:"fixture_error",error:error.message})+String.fromCharCode(10));process.exitCode=1;} finally{closeBridge();clearApprovalContext();}',
  ].join(String.fromCharCode(10));
  let child, timer, closed;
  try {
    let buffer='', stderr='', requests=0; const messages=[], stdoutChunksBase64=[];
    child=spawn(process.execPath,['--input-type=module','--eval',source],{cwd:root,env:{...process.env,ILLUCI_GATE_MODE:'bridge',ILLUCI_CLASSIFIER_ENABLED:'0',ILLUCI_DATA_HOME:join(root,'data'),ILLUCI_DECISIONS_FILE:join(root,'decisions.jsonl')},stdio:['pipe','pipe','pipe']});
    closed=new Promise(resolve=>child.once('close',resolve));
    child.stderr.on('data',d=>{stderr+=d;});
    child.stdout.on('data',data=>{
      stdoutChunksBase64.push(Buffer.from(data).toString('base64'));
      buffer+=data;let end;while((end=buffer.indexOf(String.fromCharCode(10)))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;try{message=JSON.parse(line);}catch{continue;}messages.push(message);
        if(message.type==='gate_request'){requests++;child.stdin.write(JSON.stringify({type:'gate_decision',id:message.id,approved,reason:'synthetic fixture answer'})+String.fromCharCode(10));}
        if(message.type==='fixture_result'||message.type==='fixture_error')child.stdin.end();
      }
    });
    const outcome=await new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('Bridge fixture timeout'));},15000);child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    assert.equal(outcome.code,0,JSON.stringify({messages,stderr}));
    const result=messages.find(m=>m.type==='fixture_result');assert.ok(result);assert.equal(requests,1);
    assert.equal(result.first.approved,approved);assert.equal(result.second.approved,approved);assert.equal(result.targetExists,false);
    assert.equal(result.rows.length,2);assert.equal(result.rows[0].metadata.transport,'bridge');
    assert.ok(result.rows.every(row=>row.humanStatus===(approved?'operator-approved':'operator-denied')));
    assert.equal(result.rows[1].metadata[approved?'autoApproved':'autoDenied'],true);
    if(process.env.ILLUCI_GATE_DENIAL_EVIDENCE_PATH) writeFileSync(process.env.ILLUCI_GATE_DENIAL_EVIDENCE_PATH+'.'+approved+'.json',JSON.stringify({
      scope:'Real stdio child and decision logger; synthetic operator fixture, no tool execution or provider',
      approved,requests,messages,stdoutChunksBase64,stderr,outcome,targetExists:result.targetExists,
      humanActAuthenticated:false,permissionGrantedOutsideFixture:false,
    },null,2)+String.fromCharCode(10));
  } finally {
    clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
    if(closed){
      let closeTimer;
      const settled=await Promise.race([closed.then(()=>true),new Promise(resolve=>{closeTimer=setTimeout(()=>resolve(false),3000);})]);
      clearTimeout(closeTimer);
      if(!settled)throw Error('Fixture closure unconfirmed; retained '+root);
    }
    if(!root.startsWith(join(tmpdir(),'illuci-gate-audit-')))throw Error('Unexpected fixture cleanup target');
    rmSync(root,{recursive:true,force:true});
  }
});
