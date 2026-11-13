// Isolated ACP v1 stdio candidate. Ports are supplied by the owning host.
// No process, authentication, filesystem, terminal, or permission grant is created here.
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { randomUUID } from 'node:crypto';

const unknown = (message, cause) => Object.assign(new Error(message, cause ? {cause} : undefined),
  {code:'ILLUCI_GROK_ACP_UNCONFIRMED',outcome:'unknown',retrySafe:false});
const stops = new Set(['end_turn','max_tokens','max_turn_requests','refusal','cancelled']);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
// Only recognize session-scoped metadata whose required outer fields are shaped.
// Keep the original payload as untrusted evidence; this does not certify capabilities.
function sessionMetadataShape(u) {
  if(!plain(u))return false;
  switch(u.sessionUpdate){
    case 'available_commands_update': return Array.isArray(u.availableCommands)&&u.availableCommands.every(x=>plain(x)&&nonempty(x.name)&&typeof x.description==='string'&&(x.input==null||plain(x.input)&&typeof x.input.hint==='string'));
    case 'current_mode_update': return nonempty(u.currentModeId);
    case 'config_option_update': return Array.isArray(u.configOptions)&&u.configOptions.every(x=>plain(x)&&nonempty(x.id)&&nonempty(x.name)&&nonempty(x.type));
    case 'session_info_update': return (u.title==null||typeof u.title==='string')&&(u.updatedAt==null||typeof u.updatedAt==='string')&&(u._meta==null||plain(u._meta));
    case 'usage_update': return Number.isSafeInteger(u.used)&&u.used>=0&&Number.isSafeInteger(u.size)&&u.size>=0&&(u.cost==null||plain(u.cost)&&typeof u.cost.amount==='number'&&Number.isFinite(u.cost.amount)&&u.cost.amount>=0&&nonempty(u.cost.currency));
    default: return false;
  }
}

export function createAcpStdioClient({readable,writable,timeoutMs=30000,cancelTimeoutMs=5000,maxFrameBytes=1048576,maxUpdates=4096,maxUpdateBytes=8388608,onUpdate}={}) {
  if(!readable || typeof readable.on !== 'function' || !writable || typeof writable.write !== 'function' ||
     !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || !Number.isSafeInteger(cancelTimeoutMs) || cancelTimeoutMs<1 ||
     !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes<128 || !Number.isSafeInteger(maxUpdates) || maxUpdates<1 ||
     !Number.isSafeInteger(maxUpdateBytes) || maxUpdateBytes<128 ||
     (onUpdate !== undefined && typeof onUpdate !== 'function')) throw new TypeError('Bounded stream ports required');
  let nextId=1,buffer=Buffer.alloc(0),state='new',sessionId=null,provisionalSessionId=null,active=null,fatal=null,anomaly=null,observerQueue=Promise.resolve(),observerPending=0,observerDropped=0,observerFailed=0,observerBytes=0,metadataBytes=0,metadataSequence=0,metadataOffer=null,lastMetadataAck=null;
  const sessionMetadata=[];
  const pending=new Map(),decoder=new TextDecoder('utf-8',{fatal:true});
  function fail(message,cause) {
    if(fatal){state='unconfirmed';return;}fatal=unknown(message,cause);state='unconfirmed';
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(fatal);}pending.clear();
  }
  function send(message) {
    if(fatal)throw fatal;
    const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
    if(bytes.length>maxFrameBytes)throw new TypeError('ACP outbound frame too large');
    try {writable.write(bytes,error=>{if(error)fail('ACP write outcome unconfirmed',error);});}
    catch(e){fail('ACP write outcome unconfirmed',e);throw fatal;}
  }
  function request(method,params,wait=timeoutMs,onId) {
    if(fatal)return Promise.reject(fatal);
    const id=nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>fail('ACP request outcome unconfirmed'),wait);
      pending.set(id,{resolve,reject,timer,method});onId?.(id);
      try{send({id,method,params});}catch(e){clearTimeout(timer);pending.delete(id);reject(e);}
    });
  }
  function onMessage(message) {
    if(!plain(message)||message.jsonrpc!=='2.0')throw Error('Invalid ACP message');
    if(typeof message.method==='string') {
      if(Object.hasOwn(message,'id')) {
        if(message.id===null || !['string','number'].includes(typeof message.id))throw Error('Invalid ACP request id');
        if(message.method==='session/request_permission') send({id:message.id,result:{outcome:{outcome:'cancelled'}}});
        else send({id:message.id,error:{code:-32601,message:'Method not supported'}});
      } else if(message.method==='session/update') {
        const update=message.params?.update,expectedSession=sessionId??provisionalSessionId;
        if(expectedSession&&message.params?.sessionId===expectedSession&&sessionMetadataShape(update)){
          const size=Buffer.byteLength(JSON.stringify(update));
          if(sessionMetadata.length>=maxUpdates||metadataBytes+size>maxUpdateBytes){
            anomaly={kind:'metadata-overflow',event:structuredClone(message)};
            fail('ACP session metadata retention overflow');fatal.metadataOverflow=structuredClone(anomaly);return;
          }
          metadataBytes+=size;sessionMetadata.push({sequence:++metadataSequence,sessionId:expectedSession,update:structuredClone(update),size});
          if(!active||active.terminal)return;
        }
        if(!active||active.terminal||message.params?.sessionId!==sessionId){
          anomaly={kind:!active?'out-of-turn':active.terminal?'post-terminal':'foreign-session',event:structuredClone(message)};
          fail('ACP session update correlation unconfirmed');fatal.unmatchedUpdate=structuredClone(anomaly);return;
        }
        if(!plain(update)||typeof update.sessionUpdate!=='string')throw Error('Invalid session update');
        if(active.updates.length>=maxUpdates)throw Error('ACP update limit exceeded');
        const retained=structuredClone(update),size=Buffer.byteLength(JSON.stringify(retained));
        if(active.updateBytes+size>maxUpdateBytes)throw Error('ACP update byte limit exceeded');
        active.updateBytes+=size;active.updates.push(retained);
        if(onUpdate){
          if(observerPending>=maxUpdates||observerBytes+size>maxUpdateBytes)observerDropped++;
          else {const event=structuredClone(retained);observerPending++;observerBytes+=size;
            observerQueue=observerQueue.then(()=>onUpdate(event)).catch(()=>{observerFailed++;}).finally(()=>{observerPending--;observerBytes-=size;});}
        }
      }
      return;
    }
    if(!Object.hasOwn(message,'id') || !pending.has(message.id) ||
       Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw Error('Uncorrelated ACP response');
    if(Object.hasOwn(message,'error')&&(!plain(message.error)||!Number.isInteger(message.error.code)||typeof message.error.message!=='string'))throw Error('Invalid ACP error');
    const p=pending.get(message.id);pending.delete(message.id);clearTimeout(p.timer);
    if(p.method==='session/prompt' && active)active.terminal=true;
    // Capture identity synchronously so coalesced, valid session metadata can
    // be attributed before createSession's awaiting continuation resumes.
    if(p.method==='session/new' && plain(message.result) && nonempty(message.result.sessionId))provisionalSessionId=message.result.sessionId;
    if(Object.hasOwn(message,'error')){
      p.reject(Object.assign(unknown('ACP request returned an error'),{requestId:message.id,rpcError:structuredClone(message.error)}));
    }
    else p.resolve(message.result);
  }
  function onData(chunk) {
    if(fatal)return;
    try {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      if(bytes.length>maxFrameBytes*64)throw Error('ACP input batch too large');
      buffer=Buffer.concat([buffer,bytes]);let index;
      while((index=buffer.indexOf(10))!==-1){
        if(index>maxFrameBytes)throw Error('ACP input frame too large');
        const line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);
        if(!line.length)throw Error('Empty ACP frame');
        onMessage(JSON.parse(decoder.decode(line)));
        if(fatal)return;
      }
      if(buffer.length>maxFrameBytes)throw Error('ACP input frame too large');
    }catch(e){fail('ACP protocol outcome unconfirmed',e);}
  }
  const onEnd=()=>fail(buffer.length?'ACP stream ended with partial frame':'ACP stream ended');
  const onError=e=>fail('ACP transport outcome unconfirmed',e);
  readable.on('data',onData);readable.on('end',onEnd);readable.on('error',onError);writable.on('error',onError);
  return Object.freeze({
    async initialize(){
      if(fatal||state!=='new')throw Error('ACP initialization already attempted');state='initializing';
      try{const r=await request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'illuci-acp-fixture',version:'0'}});
        if(fatal)throw fatal;
        if(!plain(r)||r.protocolVersion!==1||!plain(r.agentCapabilities))throw unknown('Unsupported ACP initialization');
        state='initialized';return structuredClone(r);
      }catch(e){fail('ACP initialization unconfirmed',e);throw e;}
    },
    async createSession({cwd,mcpServers=[]}={}){
      if(fatal||state!=='initialized'||typeof cwd!=='string'||!isAbsolute(cwd)||!Array.isArray(mcpServers)||mcpServers.length)throw Error('Initialized ACP session with absolute cwd and no MCP servers required');
      state='opening';try{const r=await request('session/new',{cwd,mcpServers:[]});
        if(fatal)throw fatal;
        if(!plain(r)||typeof r.sessionId!=='string'||!r.sessionId.trim())throw unknown('ACP session unconfirmed');
        sessionId=r.sessionId;provisionalSessionId=null;state='ready';return structuredClone(r);
      }catch(e){fail('ACP session unconfirmed',e);throw e;}
    },
    async prompt(text,{signal}={}){
      if(fatal||state!=='ready'||active)throw Error('ACP session is not ready');
      if(typeof text!=='string'||!text.length||signal!=null&&!(signal instanceof AbortSignal))throw TypeError('Prompt text and AbortSignal required');
      if(signal?.aborted)throw Object.assign(Error('Prompt cancelled before send'),{code:'ILLUCI_NOT_STARTED',retrySafe:true});
      const turn={updates:[],updateBytes:0,cancelRequested:false,timer:null};active=turn;state='prompting';
      const cancel=()=>{if(turn.cancelRequested||turn.terminal||fatal)return;turn.cancelRequested=true;
        try{send({method:'session/cancel',params:{sessionId}});turn.timer=setTimeout(()=>fail('ACP cancellation unconfirmed'),cancelTimeoutMs);}
        catch(e){fail('ACP cancellation unconfirmed',e);}};
      signal?.addEventListener('abort',cancel,{once:true});
      try{
        const pendingPrompt=request('session/prompt',{sessionId,prompt:[{type:'text',text}]},timeoutMs,id=>{turn.requestId=id;});
        if(signal?.aborted)cancel();
        const result=await pendingPrompt;
        if(fatal)throw fatal;
        if(!plain(result)||!stops.has(result.stopReason))throw unknown('ACP terminal outcome unconfirmed');
        state='ready';return {sessionId,requestId:turn.requestId,stopReason:result.stopReason,cancelRequested:turn.cancelRequested,
          cancellationConfirmed:turn.cancelRequested&&result.stopReason==='cancelled',updates:structuredClone(turn.updates),
          processCessation:'unknown',taskValidation:'not-performed',observerDelivery:{pending:observerPending,dropped:observerDropped,failed:observerFailed}};
      }catch(e){fail('ACP prompt outcome unconfirmed',e);const issue=e?.retrySafe===false?e:fatal;
        issue.sessionId=sessionId;issue.requestId??=turn.requestId;issue.cancelRequested=turn.cancelRequested;issue.updates=structuredClone(turn.updates);issue.processCessation='unknown';throw issue;}
      finally{clearTimeout(turn.timer);signal?.removeEventListener('abort',cancel);active=null;}
    },
    close(){fail('ACP client closed');readable.off('data',onData);readable.off('end',onEnd);readable.off('error',onError);writable.off('error',onError);},
    readSessionMetadata(){
      if(!sessionMetadata.length)return {ackToken:null,entries:[]};
      if(!metadataOffer)metadataOffer={ackToken:randomUUID(),entries:sessionMetadata.map(({sequence,sessionId,update})=>({sequence,sessionId,update:structuredClone(update)}))};
      return structuredClone(metadataOffer);
    },
    acknowledgeSessionMetadata({ackToken,retentionRef}={}){
      if(!metadataOffer||typeof ackToken!=='string'||ackToken!==metadataOffer.ackToken||typeof retentionRef!=='string'||!retentionRef.trim()||retentionRef.length>8192||/[\r\n\0]/.test(retentionRef))throw Error('Exact offered metadata and host retention reference required');
      const offered=metadataOffer.entries;
      if(offered.some((entry,i)=>sessionMetadata[i]?.sequence!==entry.sequence))throw Error('Offered metadata prefix changed');
      const removed=sessionMetadata.splice(0,offered.length);metadataBytes-=removed.reduce((sum,x)=>sum+x.size,0);
      lastMetadataAck={throughSequence:offered.at(-1).sequence,count:offered.length,retentionRef};metadataOffer=null;
      return structuredClone(lastMetadataAck);
    },
    status(){return {state,sessionId,active:!!active,anomaly:anomaly?structuredClone(anomaly):null,sessionMetadata:sessionMetadata.map(x=>structuredClone(x.update)),lastMetadataAcknowledgement:lastMetadataAck?structuredClone(lastMetadataAck):null,observerDelivery:{pending:observerPending,dropped:observerDropped,failed:observerFailed}};},
  });
}
