/** Per-invocation observer, no access policy or global registry. A failed sink
 * cannot turn an observed provider execution into a retryable provider failure.
 */
import { randomUUID, createHash } from 'node:crypto';
function retrievalPort(port) {
  try {const fn=port?.retrieveTrace;return {recover:typeof fn==='function'?fn.bind(port):null,failed:false};}
  catch {return {recover:null,failed:true};}
}
export function createTraceExposure(options, sourceRef, layer='provider-interface') {
  const sourceId=`${sourceRef}:${randomUUID()}`;
  let sequence=0;const representations=new Set();
  const enabled=typeof options?.onTraceEvent==='function';
  async function record(payload, representation='native-json-event', evidenceKind='provider-event', transformations=[]) {
    if(!enabled)return;
    representations.add(representation);
    const event={sourceId,sourceRef,layer,sequence:sequence++,representation,evidenceKind,transformations,payload};
    try {await options.onTraceEvent(event);} catch {try{await options.onTraceFailure?.({sourceId,sourceRef,stage:'observer-failed'});}catch{}}
  }
  return Object.freeze({enabled,record,sourceId,sourceRef,layer,
    async failure(stage) {try{await options?.onTraceFailure?.({sourceId,sourceRef,stage});}catch{}},
    async source(port) {
      if(!enabled||typeof options.onTraceSource!=='function')return;
      const found=retrievalPort(port);
      try{await options.onTraceSource({id:sourceId,sourceRef,layer,
        interfaceInspectionFailed:found.failed,...(found.recover?{recover:found.recover}:{})});}
      catch{try{await options.onTraceFailure?.({sourceId,sourceRef,stage:'source-discovery-failed'});}catch{}}
    },
    async bytes(bytes) {
      if(!enabled)return;
      const raw=Buffer.from(bytes);
      await record({encoding:'base64',bytes:raw.toString('base64'),byteLength:raw.length,
        sha256:createHash('sha256').update(raw).digest('hex'),boundary:'fetch-response-body'},'original-response-body-bytes','transport-body-chunk');
    },
    async text(response) {
      if(enabled&&typeof response.arrayBuffer==='function') {
        const bytes=Buffer.from(await response.arrayBuffer());await this.bytes(bytes);
        await this.finish();
        return new TextDecoder().decode(bytes);
      }
      const raw=await response.text();
      await record(raw,'original-response-text','transport-response',['HTTP-text-decoding']);await this.finish();return raw;
    },
    async json(response) {
      if(enabled&&(typeof response.arrayBuffer==='function'||typeof response.text==='function')) {
        const raw=await this.text(response);await this.finish();
        try{return JSON.parse(raw);}catch(error){await this.failure('provider-response-parse-failed');throw error;}
      }
      const value=await response.json();
      await record(value,'native-json-event','provider-response',['HTTP-json-parsing']);return value;
    },
    async *lines(body) {
      const decoder=new TextDecoder();let pending='',exhausted=false;
      const chunks=body?.[Symbol.asyncIterator]?body:(async function*(){
        const reader=body.getReader();try{while(true){const next=await reader.read();if(next.done)break;yield next.value;}}
        finally{reader.releaseLock?.();}
      })();
      try {
        for await(const chunk of chunks) {
          await this.bytes(chunk);pending+=decoder.decode(chunk,{stream:true});
          let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);yield line;}
        }
        pending+=decoder.decode();
        if(pending)yield pending; // EOF is a line boundary too; do not drop the tail.
        exhausted=true;
      } finally {await this.finish(exhausted);}
    },
    async *sse(body) {
      let block=[];
      for await(const line of this.lines(body)){
        if(!line.trim()){if(block.length){yield block.join('\n');block=[];}}
        else block.push(line);
      }
      if(block.length)yield block.join('\n');
    },
    async finish(exhausted=true) {
      if(!enabled)return;
      try{await options.onTraceManifest?.({sourceId,sourceRef,layer,firstSequence:0,count:sequence,representations:[...representations].sort(),scope:'source-declared-window',exhausted});}catch{}
    },
  });
}

/** Bind an observed source instance to the actual port's retrieval interface.
 * The source ID remains the captured stream's ID, so recovered ranges can fill
 * that stream. Neither provider labels nor model identities select capability.
 */
export function bindTraceSources(options,port) {
  if(typeof options?.onTraceEvent!=='function')return options;
  const seen=new Set(),found=retrievalPort(port),retrieve=found.recover;
  const register=async source=>{if(seen.has(source.id))return;
    await options.onTraceSource?.({...source,interfaceInspectionFailed:found.failed,...(retrieve?{recover:request=>retrieve(request)}:{})});seen.add(source.id);};
  const observe=async source=>{try{await register(source);}catch{try{await options.onTraceFailure?.({sourceId:source.id,stage:'source-discovery-failed'});}catch{}}};
  return {...options,
    onTraceSource:register,
    async onTraceEvent(event){await observe({id:event.sourceId,sourceRef:event.sourceRef,layer:event.layer});return options.onTraceEvent(event);},
    async onTraceManifest(manifest){await observe({id:manifest.sourceId,sourceRef:manifest.sourceRef,layer:manifest.layer});return options.onTraceManifest?.(manifest);},
  };
}
