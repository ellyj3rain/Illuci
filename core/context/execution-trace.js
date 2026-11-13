/** Host-owned execution evidence over existing protected memory envelopes.
 * Capture is not disclosure, model training, promotion, or proof of inner thought.
 * Sources/recovery closures are trusted host dependencies, never model selectors.
 */
import { createHash, randomUUID } from 'node:crypto';
import { memoryValueDigest } from './protected-memory-admission.js';

const text = v => typeof v === 'string' && v.trim().length > 0;
const hash = v => createHash('sha256').update(v).digest('hex');
const clone = v => structuredClone(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;

// A tagged value tree preserves SDK-exposed undefined/NaN/-0/BigInt without
// invoking getters/toJSON or pretending JSON serialization preserved them.
function json(value, seen = new Set()) {
  if (value === null) return ['null'];
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value,value];
  if (typeof value === 'undefined') return ['undefined'];
  if (typeof value === 'number') return ['number',Object.is(value,-0)?'-0':String(value)];
  if (typeof value === 'bigint') return ['bigint',String(value)];
  if (!value || typeof value !== 'object' || seen.has(value)) throw TypeError('Acyclic exposed trace data required');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== null && proto !== Object.prototype) throw TypeError('Plain trace data required');
  seen.add(value);
  try {
    const out = [], descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(k => typeof k !== 'string')) throw TypeError('Symbol data unsupported');
    for (const [key, d] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!d.enumerable || !Object.hasOwn(d, 'value')) throw TypeError('Own data fields required');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw TypeError('Dense arrays required');
      out.push([key,json(d.value, seen)]);
    }
    if (array && out.length !== value.length) throw TypeError('Dense arrays required');
    return [array?'array':'object',out];
  } finally { seen.delete(value); }
}
function fromJson([kind,data]) {
  if(kind==='null')return null;
  if(kind==='undefined')return undefined;
  if(kind==='string'||kind==='boolean')return data;
  if(kind==='number')return data==='-0'?-0:Number(data);
  if(kind==='bigint')return BigInt(data);
  if(kind==='array')return data.map(([,v])=>fromJson(v));
  if(kind==='object')return Object.fromEntries(data.map(([k,v])=>[k,fromJson(v)]));
  throw TypeError('Unknown exposed value encoding');
}
function validBody(payload) {
  if(payload?.encoding!=='base64'||typeof payload.bytes!=='string'||!integer(payload.byteLength)||!text(payload.sha256))return false;
  const bytes=Buffer.from(payload.bytes,'base64');
  return bytes.toString('base64')===payload.bytes&&bytes.length===payload.byteLength&&hash(bytes)===payload.sha256;
}

function missingRanges(manifest, sequences) {
  if (!manifest || !manifest.count) return [];
  let next = manifest.firstSequence;
  const end = next + manifest.count, missing = [];
  for (const n of [...new Set(sequences)].sort((a,b) => a-b)) {
    if (n < next || n >= end) continue;
    if (n > next) missing.push([next,n-1]);
    next = n+1;
  }
  if (next < end) missing.push([next,end-1]);
  return missing;
}

export function createExecutionTrace({ binding, custody, appendItem, recordEvidence,
  sources = [], recoveryTimeoutMs = 5000, chunkBytes = 49152 } = {}) {
  if (!text(binding?.operationId) || !text(binding?.executionId) || typeof appendItem !== 'function' ||
      typeof recordEvidence !== 'function' || !Array.isArray(sources) ||
      !['ownerAgentId','ownerContextId','projectId','assignmentId','sourceRef'].every(k => text(custody?.[k])) ||
      !Number.isInteger(chunkBytes) || chunkBytes < 256 || chunkBytes > 1048576 ||
      !Number.isFinite(recoveryTimeoutMs) || recoveryTimeoutMs <= 0) throw TypeError('Trusted trace custody and storage ports required');
  binding = clone(binding); custody = clone(custody);
  const events = [], failures = [], recovery = [], manifests = new Map(), manifestHistory = [], configured = new Map(), identities = new Map();
  let finished = false;
  const remember = (id,sourceRef,layer) => {
    const identity=identities.get(id);
    if(identity&&(identity.sourceRef!==sourceRef||identity.layer!==layer))throw TypeError('Source provenance conflict');
    if(!identity)identities.set(id,{sourceRef,layer});
  };
  const registerSource = source => {
    if (finished || !source || !['id','sourceRef','layer'].every(k => text(source[k])) || configured.has(source.id)) throw TypeError('Distinct trusted trace source required');
    remember(source.id,source.sourceRef,source.layer);
    if(source.representations!==undefined&&(!Array.isArray(source.representations)||!source.representations.length||!source.representations.every(text)))throw TypeError('Explicit source representations required');
    configured.set(source.id, { ...source,...(source.representations?{representations:Object.freeze([...source.representations])}:{}) });
  };
  for (const source of sources) registerSource(source);
  function capture(event, recoveryRef = null) {
    if (finished) return false;
    try {
      if (!event || !['sourceId','sourceRef','layer','representation','evidenceKind'].every(k => text(event[k])) || !integer(event.sequence)) throw TypeError('Trace provenance required');
      remember(event.sourceId,event.sourceRef,event.layer);
      const payload = json(event.payload);
      if(event.representation==='original-response-body-bytes'&&!validBody(fromJson(payload)))throw TypeError('Invalid body-byte evidence');
      const value = { schema:'illuci.execution-trace-event/1', ...binding, sourceId:event.sourceId, sourceRef:event.sourceRef,
        layer:event.layer, representation:event.representation, evidenceKind:event.evidenceKind, sequence:event.sequence,
        transformations:json(event.transformations ?? []), payloadEncoding:'illuci.exposed-value/1', payload };
      const bytes = Buffer.from(JSON.stringify(value)), digest = hash(bytes), eventId = `trace-event-${randomUUID()}`;
      const count = Math.max(1,Math.ceil(bytes.length/chunkBytes));
      const receipt = { eventId, observedOrder:events.length, receivedAt:new Date().toISOString(), sourceId:event.sourceId, sourceRef:event.sourceRef, layer:event.layer,
        representation:event.representation, evidenceKind:event.evidenceKind, sequence:event.sequence,
        sha256:digest, bytes:bytes.length, chunkCount:count, chunks:[], recoveryRef, status:'partial' };
      events.push(receipt);
      for (let index=0; index<count; index++) {
        const part = bytes.subarray(index*chunkBytes,(index+1)*chunkBytes), id = `trace-chunk-${randomUUID()}`;
        const value = { schema:'illuci.execution-trace-chunk/1', ...binding, eventId, eventSha256:digest,
          chunkIndex:index, chunkCount:count, totalBytes:bytes.length, encoding:'utf8-json/base64',
          chunkSha256:hash(part), dataBase64:part.toString('base64') };
        const chunk = { id, index, sha256:hash(part), acknowledged:false };
        receipt.chunks.push(chunk);
        const item = { id,value,digest:memoryValueDigest(value),custody:{...custody,classification:'protected',
          permittedPurposes:['execution-audit','architecture-research']} };
        try {
          if (appendItem(item) !== id) throw Error('Trace append unconfirmed');
          chunk.acknowledged = true;
        } catch { failures.push({stage:'storage',eventId,recordId:id}); }
      }
      receipt.status = receipt.chunks.every(c=>c.acknowledged) ? 'retained' : 'partial';
      return receipt.status === 'retained';
    } catch { failures.push({stage:'unsupported-event-data',sourceId:text(event?.sourceId)?event.sourceId:null}); return false; }
  }
  function declareManifest(manifest,recoveryRef=null) {
    if (finished) return false;
    if (!manifest || !text(manifest.sourceId) || !text(manifest.sourceRef) || !text(manifest.layer) || !integer(manifest.firstSequence) ||
        !integer(manifest.count) || !Number.isSafeInteger(manifest.firstSequence+manifest.count) ||
        manifest.scope !== 'source-declared-window') { failures.push({stage:'invalid-window-manifest'}); return false; }
    try{remember(manifest.sourceId,manifest.sourceRef,manifest.layer);}catch{failures.push({stage:'manifest-provenance-conflict',sourceId:manifest.sourceId});return false;}
    if(manifest.representations!==undefined&&(!Array.isArray(manifest.representations)||!manifest.representations.every(text)||
      (manifest.count>0&&!manifest.representations.length))){failures.push({stage:'invalid-format-manifest',sourceId:manifest.sourceId});return false;}
    const selected = {sourceId:manifest.sourceId,sourceRef:manifest.sourceRef,layer:manifest.layer,firstSequence:manifest.firstSequence,
      count:manifest.count,scope:manifest.scope,exhausted:manifest.exhausted === true,
      representations:manifest.representations===undefined?null:[...new Set(manifest.representations)].sort()};
    const sourceFormats=configured.get(manifest.sourceId)?.representations;
    if(sourceFormats&&selected.representations?.some(r=>!sourceFormats.includes(r))) {
      failures.push({stage:'source-format-contract-conflict',sourceId:manifest.sourceId});return false;
    }
    const previous = manifests.get(manifest.sourceId);
    if (previous && JSON.stringify(previous)!==JSON.stringify(selected)) {
      // An interrupted window can be extended/finalized by the same trusted
      // source. Completed windows cannot be rewritten or silently shrunk.
      if(previous.exhausted || previous.firstSequence!==selected.firstSequence || selected.count<previous.count ||
          previous.representations?.some(r=>!selected.representations?.includes(r))) {
        failures.push({stage:'conflicting-window-manifest',sourceId:manifest.sourceId}); return false;
      }
    }
    if(!previous||JSON.stringify(previous)!==JSON.stringify(selected))manifestHistory.push({...selected,recoveryRef});
    manifests.set(manifest.sourceId,selected); return true;
  }
  function coverage() {
    const ids = new Set([...configured.keys(),...manifests.keys(),...events.map(e=>e.sourceId)]);
    return [...ids].map(sourceId=>{
      const all = events.filter(e=>e.sourceId===sourceId), retained = all.filter(e=>e.status==='retained');
      const bySequence = new Map();
      for (const event of retained) { if(!bySequence.has(event.sequence))bySequence.set(event.sequence,new Set());bySequence.get(event.sequence).add(event.sha256); }
      const conflicts = [...bySequence].filter(([,digests])=>digests.size>1).map(([sequence])=>sequence);
      const manifest = manifests.get(sourceId), gaps = missingRanges(manifest,[...bySequence.keys()]);
      const expectedFormats=manifest?.representations??configured.get(sourceId)?.representations??null;
      const outsideWindow = manifest ? [...bySequence.keys()].filter(n=>n<manifest.firstSequence||n>=manifest.firstSequence+manifest.count) : [];
      const sourceFailure = failures.some(f=>f.sourceId===sourceId || (f.eventId && all.some(e=>e.eventId===f.eventId && !retained.some(r=>r.sequence===e.sequence&&r.sha256===e.sha256))));
      const formatMismatch=expectedFormats?retained.some(e=>!expectedFormats.includes(e.representation)):false;
      return {sourceId,retainedObservations:retained.length,manifest:manifest?clone(manifest):null,expectedRepresentations:expectedFormats,
        missingRanges:gaps,conflictingSequences:conflicts,outsideWindow,
        completeness:conflicts.length||outsideWindow.length?'conflicted':sourceFailure||gaps.length?'partial'
          :formatMismatch?'conflicted':manifest?.exhausted&&(manifest.count===0||expectedFormats)?'source-window-complete':'unverified',
        scope:'only the declared observation window; never all internal computation'};
    });
  }
  const snapshot = () => clone({schema:'illuci.execution-trace-receipt/1',...binding,events,failures,recovery,manifestHistory,coverage:coverage(),
    originalContentInStructuralReceipt:false,hiddenComputationRecovered:false});
  async function recover({ signal } = {}) {
    if (finished) return snapshot();
    // An absent interface is evaluated on every execution, never a fictitious query.
    const candidates = configured.size ? [...configured.values()] : [{id:'runtime-retrieval',sourceRef:'illuci:serving-module',layer:'runtime-interface'}];
    for (const source of candidates) {
      const id = `trace-recovery-${randomUUID()}`, attempt = {id,sourceId:source.id,sourceRef:source.sourceRef,layer:source.layer,
        supportedInterface:typeof source.recover==='function',invoked:false,status:'pending'};
      recovery.push(attempt);
      try {
        attempt.attemptRecordId=recordEvidence('trace-recovery-attempt',{...binding,...attempt});
        if (!text(attempt.attemptRecordId)) throw Error('Attempt unconfirmed');
      } catch { attempt.status='attempt-unconfirmed';continue; }
      if(source.interfaceInspectionFailed)attempt.status='interface-inspection-failed';
      else if (!attempt.supportedInterface) attempt.status='unsupported-interface';
      else if (signal?.aborted) attempt.status='cancelled';
      else {
        const controller = new AbortController(), abort=()=>controller.abort();
        signal?.addEventListener('abort',abort,{once:true});
        let timer;
        try {
          const stopped = new Promise(resolve=>{controller.signal.addEventListener('abort',()=>resolve(null),{once:true});timer=setTimeout(abort,recoveryTimeoutMs);});
          const pending=Promise.resolve().then(()=>{
            if(controller.signal.aborted)return null;
            attempt.invoked=true;attempt.invokedAt=new Date().toISOString();
            return source.recover({operationId:binding.operationId,source:{id:source.id,sourceRef:source.sourceRef,layer:source.layer},
              missingRanges:coverage().find(c=>c.sourceId===source.id)?.missingRanges||[],signal:controller.signal});
          });
          const late=status=>{if(!['timed-out','cancelled'].includes(attempt.status))return;
            try{recordEvidence('trace-recovery-late-settlement',{...binding,recoveryId:id,sourceId:source.id,status,
              lateContentNotRetained:true,standing:'sealed receipt unchanged; reconcile original through authorized source'});}catch{}};
          pending.then(()=>late('resolved'),()=>late('rejected'));
          const result=await Promise.race([pending,stopped]);
          if (controller.signal.aborted) attempt.status=signal?.aborted?'cancelled':'timed-out';
          else if (result?.status==='unavailable') attempt.status='unavailable';
          else if (!result || !Array.isArray(result.events)) attempt.status='invalid-result';
          else if(result.operationId!==binding.operationId||!text(result.sourceInstanceRef))attempt.status='unverified-execution-binding';
          else {
            if(result.manifest) {
              if(result.manifest.sourceId!==source.id||result.manifest.sourceRef!==source.sourceRef||result.manifest.layer!==source.layer)
                failures.push({stage:'recovery-manifest-mismatch',sourceId:source.id});
              else declareManifest(result.manifest,id);
            }
            const formats=manifests.get(source.id)?.representations??source.representations??null;
            attempt.formatExpectation=formats?'source-declared':'unverified';
            for (const event of result.events) {
              if(event?.sourceId!==source.id||event?.sourceRef!==source.sourceRef||event?.layer!==source.layer) { failures.push({stage:'recovery-source-mismatch',sourceId:source.id});continue; }
              if(formats?!formats.includes(event.representation):event.representation==='derived-analysis') {
                failures.push({stage:'recovery-representation-mismatch',sourceId:source.id});continue;
              }
              capture(event,id);
            }
            attempt.status='retrieved';
            attempt.sourceInstanceRef=result.sourceInstanceRef;
            attempt.completeness=coverage().find(c=>c.sourceId===source.id)?.completeness||'unverified';
          }
        } catch { attempt.status='failed'; }
        finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
      }
      try {attempt.outcomeRecordId=recordEvidence('trace-recovery-outcome',{...binding,...attempt});if(!text(attempt.outcomeRecordId))throw Error('Outcome unconfirmed');}
      catch {attempt.outcomeUnconfirmed=true;}
    }
    finished=true; return snapshot();
  }
  const noteFailure = evidence => {if(!finished)failures.push({stage:text(evidence?.stage)?evidence.stage:'observer-failed',sourceId:text(evidence?.sourceId)?evidence.sourceId:null});};
  return Object.freeze({capture,declareManifest,registerSource,recover,snapshot,noteFailure});
}

/** Host-side evaluation only. readAdmittedItem must already enforce custody.
 * Every chunk/digest is checked; partial data never becomes recovered original.
 */
export async function reassembleTraceEvent(receipt, readAdmittedItem) {
  if (receipt?.status!=='retained'||typeof readAdmittedItem!=='function'||receipt.chunks?.length!==receipt.chunkCount) return null;
  try {
    const parts=[];
    for (let index=0;index<receipt.chunkCount;index++) {
      const ref=receipt.chunks[index],item=await readAdmittedItem(ref.id),v=item?.value;
      if(item?.id!==ref.id||item.digest!==memoryValueDigest(v)||v?.eventId!==receipt.eventId||
          v.chunkIndex!==index||v.chunkCount!==receipt.chunkCount||v.eventSha256!==receipt.sha256||v.totalBytes!==receipt.bytes) return null;
      const part=Buffer.from(v.dataBase64,'base64');
      if(hash(part)!==v.chunkSha256||hash(part)!==ref.sha256)return null;
      parts.push(part);
    }
    const bytes=Buffer.concat(parts);
    if(bytes.length!==receipt.bytes||hash(bytes)!==receipt.sha256)return null;
    const event=JSON.parse(bytes.toString('utf8'));
    if(event.payloadEncoding!=='illuci.exposed-value/1')return null;
    event.payload=fromJson(event.payload);event.transformations=fromJson(event.transformations);
    if(event.representation==='original-response-body-bytes'&&!validBody(event.payload))return null;
    return event;
  } catch {return null;}
}
