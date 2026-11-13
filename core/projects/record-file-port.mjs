// Mechanical existing-file transport for the owning artifacts transaction.
// It neither chooses records nor establishes work/append authority.
import {openSync,readSync,writeSync,fsyncSync,closeSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,basename,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex'),SHA=/^[a-f0-9]{64}$/;
const identity=s=>({dev:s.dev.toString(),ino:s.ino.toString()}),same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const error=(phase,cause,io)=>Object.assign(Error('Original record-file operation requires reconciliation',{cause}),{code:'ILLUCI_RECORD_APPEND_UNCONFIRMED',phase,retrySafe:false,io:structuredClone(io),authorityGranted:false,custodyAuthenticated:false});

/** Internal dependency of the EXISTING synchronous lane transaction only.
 * The original owner supplies the fixed file, original operation and bytes.
 * New file creation/directory durability are deliberately not selected here.
 */
export function selectExistingRecordAppend({path,fileIdentity,expectedPrefixSha256,expectedSize,operationRef,bytes,assertWriterCurrent,maxFileBytes=16777216,maxAppendBytes=1048576}){
 if(!isAbsolute(path??'')||basename(path)!=='records.jsonl'||realpathSync(dirname(path))!==dirname(path)||!SHA.test(expectedPrefixSha256??'')||
   !/^[0-9]+$/.test(fileIdentity?.dev??'')||!/^[0-9]+$/.test(fileIdentity?.ino??'')||!Number.isSafeInteger(expectedSize)||expectedSize<0||
   !Number.isSafeInteger(maxFileBytes)||maxFileBytes<=0||maxFileBytes>16777216||!Number.isSafeInteger(maxAppendBytes)||maxAppendBytes<=0||maxAppendBytes>1048576||
   typeof operationRef!=='string'||!operationRef||typeof assertWriterCurrent!=='function'||!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>maxAppendBytes||expectedSize+bytes.length>maxFileBytes)throw TypeError('Fixed bounded existing record file and original writer required');
 const data=Buffer.from(bytes),selected=Object.freeze({...fileIdentity}),parent=dirname(path),parentIdentity=lstatSync(parent,{bigint:true});
 if(!parentIdentity.isDirectory()||parentIdentity.isSymbolicLink())throw TypeError('Ordinary canonical record directory required');
 let entered=false,standing='selected',fd=null;
 const io={fileIdentityBefore:null,fileIdentityAfter:null,requestedBytes:data.length,writtenBytes:0,fileSync:'not-performed',sameHandleReadback:false,originalSize:expectedSize,finalSize:null,requestedSha256:sha(data),readbackSha256:null,operationRef};
 function closeOwned(){if(fd===null)return;const owned=fd;fd=null;closeSync(owned);}
 function check(){const r=assertWriterCurrent();if(r!==true)throw Error('Exact synchronous writer currentness required');}
 function pathCurrent(){const d=lstatSync(parent,{bigint:true}),p=lstatSync(path,{bigint:true});if(!same(identity(d),identity(parentIdentity))||!d.isDirectory()||d.isSymbolicLink()||realpathSync(parent)!==parent||!p.isFile()||p.isSymbolicLink()||!same(identity(p),selected))throw Error('Selected record namespace changed');return p;}
 function prefix(){const h=createHash('sha256'),chunk=Buffer.alloc(Math.min(65536,Math.max(1,expectedSize)));let position=0;while(position<expectedSize){const n=readSync(fd,chunk,0,Math.min(chunk.length,expectedSize-position),position);if(n<=0)throw Error('Short original file read');h.update(chunk.subarray(0,n));position+=n;}return h.digest('hex');}
 return Object.freeze({get standing(){return standing;},get observation(){return structuredClone(io);},
  appendOnce(){
   if(entered)throw error('original-operation-already-entered',null,io);entered=true;
   try{
    check();const before=pathCurrent();if(before.size!==BigInt(expectedSize))throw Error('Original record size changed');
    fd=openSync(path,'r+');const retained=fstatSync(fd,{bigint:true});if(!same(identity(retained),selected)||!retained.isFile()||retained.size!==BigInt(expectedSize)||prefix()!==expectedPrefixSha256)throw Error('Original record file changed');
    io.fileIdentityBefore=selected.dev+':'+selected.ino;pathCurrent();check();standing='entered';
    while(io.writtenBytes<data.length){const n=writeSync(fd,data,io.writtenBytes,data.length-io.writtenBytes,expectedSize+io.writtenBytes);if(!Number.isInteger(n)||n<=0)throw Error('Record write did not progress');io.writtenBytes+=n;}
    // Once entered, sync/readback settles the original write even if authority
    // later changes. It does not authorize a new status or a second append.
    fsyncSync(fd);io.fileSync='completed';const raw=Buffer.alloc(data.length);let got=0;while(got<raw.length){const n=readSync(fd,raw,got,raw.length-got,expectedSize+got);if(n<=0)throw Error('Short same-handle append readback');got+=n;}
    const after=fstatSync(fd,{bigint:true});io.fileIdentityAfter=identity(after).dev+':'+identity(after).ino;io.finalSize=Number(after.size);io.readbackSha256=sha(raw);
    if(!same(identity(after),selected)||after.size!==BigInt(expectedSize+data.length)||!raw.equals(data)||prefix()!==expectedPrefixSha256)throw Error('Original append/readback correspondence changed');
    pathCurrent();io.sameHandleReadback=true;closeOwned();check();standing='observed';
    return Object.freeze({operationRef,io:Object.freeze(structuredClone(io)),readbackBytes:Buffer.from(raw),authorityGranted:false,custodyAuthenticated:false,directorySync:'not-performed',hardwareDurability:'not-proved'});
   }catch(cause){standing='held';throw error('original-append-unconfirmed',cause,io);}
   finally{try{closeOwned();}catch{}}
  }
 });
}
