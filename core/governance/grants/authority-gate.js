// Cross-process authority gate. An abandoned gate requires reconciliation.
import {openSync,writeFileSync,fsyncSync,closeSync,readFileSync,lstatSync,unlinkSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const failure=message=>Object.assign(new Error(message),{code:'ILLUCI_AUTHORITY_GATE_UNCONFIRMED',retrySafe:false});
export function acquireAuthorityGate(directory){
 const root=realpathSync(directory),path=join(root,'illuci-authority-gate.lock'),recoveryPath=join(root,'illuci-authority-recovery.lock');
 const bytes=JSON.stringify({schema:'illuci.authority-gate/1',nonce:randomUUID(),pid:process.pid});let fd,identity;
 try{fd=openSync(path,'wx');writeFileSync(fd,bytes);fsyncSync(fd);identity=lstatSync(path);closeSync(fd);fd=undefined;if(!identity.isFile()||identity.isSymbolicLink()||!identity.ino)throw failure('Authority gate identity unavailable');
  // A recovery owner creates this while the predecessor gate is still held.
  // If the predecessor is later retired, a competing writer may create the
  // ordinary filename during the transfer interval; it must discard only its
  // own exact file and refuse until recovery custody ends.
  if(existsSync(recoveryPath)){const current=lstatSync(path);if(current.dev===identity.dev&&current.ino===identity.ino&&readFileSync(path,'utf8')===bytes)unlinkSync(path);throw failure('Authority recovery is active');}}
 catch{if(fd!==undefined)try{closeSync(fd);}catch{}throw failure('Authority gate unavailable; reconciliation may be required');}
 let held=true;
 function assertCurrent(){try{const s=lstatSync(path);if(!held||!s.isFile()||s.isSymbolicLink()||s.dev!==identity.dev||s.ino!==identity.ino||readFileSync(path,'utf8')!==bytes)throw failure('Authority gate changed');return true;}catch{throw failure('Authority gate changed');}}
 return Object.freeze({assertCurrent,release(){assertCurrent();unlinkSync(path);held=false;}});
}
export function underAuthorityGate(directory,action){
 if(typeof action!=='function')throw TypeError('Synchronous authority action required');
 const gate=acquireAuthorityGate(directory);let safe=false;
 try{gate.assertCurrent();const result=action(gate);if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw failure('Asynchronous action is not an authority decision');}gate.assertCurrent();safe=true;return result;}
 finally{if(safe)gate.release();}
}
