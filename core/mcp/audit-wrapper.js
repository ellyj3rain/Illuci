/** Existing mixed MCP/in-process audit boundary (Standard 16).
 * The decision logger owns structural append receipts. Bounded heuristic-redacted
 * previews remain process-local; neither lane authenticates caller assertions.
 */
import { randomUUID } from 'node:crypto';
import { logDecision } from '../decisions/logger.js';
import { surfaceTenantId } from '../identity/surface.js';
const MAX_ENTRIES = 2000, MAX_RECORD_BYTES = 64 * 1024;
const AUDIT_BUFFER = [];
let droppedEntries = 0;
const credentialKey = /api[-_]?key|token|authorization|secret|password|passwd|credential|private[-_]?key/i;
const binaryKey = /^(data|base64|bytes|image_data)$/i;
const own = (value, key) => {
  try { const d = value && Object.getOwnPropertyDescriptor(value, key); return d && Object.hasOwn(d, 'value') ? d.value : undefined; }
  catch { return undefined; }
};
function scrubText(value, counts) {
  // Redact before bounding: a long PEM must not retain its opening/body prefix.
  let result = value.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,
    () => { counts.redacted++; return '[redacted-private-key]'; });
  result = result.replace(/\bBearer\s+[^\s,;"']+/gi,
    () => { counts.redacted++; return 'Bearer [redacted-credential]'; });
  result = result.replace(/(["']?(?:api[-_]?key|\w*token|authorization|secret|password|passwd|credential)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (_, key) => { counts.redacted++; return key + '[redacted-credential]'; });
  if (result.length > 4096) { counts.truncated++; result = result.slice(0, 4000) + '[truncated]'; }
  return result;
}
function previewValue(value, counts, depth = 0, seen = new Set(), key = '') {
  if (credentialKey.test(key)) { counts.redacted++; return { redacted: 'credential' }; }
  if (binaryKey.test(key) && value != null) { counts.redacted++; return { redacted: 'binary-payload' }; }
  if (typeof value === 'string') return scrubText(value, counts);
  if (value == null || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[nonfinite]';
  if (typeof value !== 'object') return '[' + typeof value + ']';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) { counts.redacted++; return { redacted: 'binary-payload' }; }
  if (depth >= 6 || seen.has(value)) { counts.omitted++; return '[depth-or-cycle-omitted]'; }
  seen.add(value);
  try {
    const keys = Object.keys(value);
    if (keys.length > 32) counts.omitted += keys.length - 32;
    const entries = keys.slice(0,32).map(k => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d || !Object.hasOwn(d, 'value')) { counts.omitted++; return [k, '[accessor-omitted]']; }
      return [scrubText(k, counts), previewValue(d.value, counts, depth + 1, seen, k)];
    });
    return Array.isArray(value) ? entries.map(([,v]) => v) : Object.fromEntries(entries);
  } catch { counts.omitted++; return '[uninspectable]'; }
  finally { seen.delete(value); }
}
// No free text, credential fingerprints or recursive copies of prior log reads.
function shape(value) {
  if (value === null) return { type: 'null' };
  if (typeof value !== 'object') return { type: typeof value };
  try { return { type: Array.isArray(value) ? 'array' : 'object', ownFieldCount: Object.keys(value).length }; }
  catch { return { type: 'uninspectable' }; }
}
function emitPreview(entry) {
  const counts = { redacted: 0, truncated: 0, omitted: 0 };
  let safe = previewValue(entry, counts);
  safe.preview = { heuristicRedaction: true, ...counts };
  if (Buffer.byteLength(JSON.stringify(safe)) > MAX_RECORD_BYTES) {
    for (const key of ['request_payload','response_payload','args_summary','result_summary']) {
      if (Object.hasOwn(safe, key)) safe[key] = { omitted: 'record-byte-limit' };
    }
    safe.preview.recordByteLimitOmission = true;
  }
  if (Buffer.byteLength(JSON.stringify(safe)) > MAX_RECORD_BYTES) {
    safe = { operation_id: entry.operation_id, attempt_id: entry.attempt_id,
      completion_id: entry.completion_id ?? null, handler_outcome: entry.handler_outcome,
      audit_outcome: entry.audit_outcome, preview: { ...counts, heuristicRedaction: true, recordByteLimitOmission: true } };
  }
  if (AUDIT_BUFFER.length === MAX_ENTRIES) { AUDIT_BUFFER.shift(); droppedEntries++; }
  AUDIT_BUFFER.push(safe);
}
export function drainAuditBuffer() { return AUDIT_BUFFER.splice(0); }
export function auditBufferStats() { return { entries: AUDIT_BUFFER.length, maxEntries: MAX_ENTRIES, maxRecordBytes: MAX_RECORD_BYTES, droppedEntries }; }

// Preview construction is diagnostic. Arbitrary/uninspectable host values must
// never replace an already observed result, original throw or audit uncertainty.
function safelyPreview(build, identity) {
  try { emitPreview(build()); }
  catch {
    if (AUDIT_BUFFER.length === MAX_ENTRIES) { AUDIT_BUFFER.shift(); droppedEntries++; }
    AUDIT_BUFFER.push({ ...identity, preview: { heuristicRedaction: true,
      unavailable: true, reason: 'preview-generation-failed' } });
  }
}

/** Failed appends may have uncertain recording outcomes. A pre-attempt failure
 * prevents invocation. A post-handler failure cannot undo execution. Reconcile
 * operationId/attemptId before retry; preserve a handler throw separately.
 */
export class AuditWriteError extends Error {
  constructor({ stage, operationId, attemptId = null, handlerOutcome = 'not-invoked', handlerError, threw = false }) {
    super(stage === 'attempt' ? 'Required audit attempt append unconfirmed; handler not invoked'
      : 'Handler ' + handlerOutcome + '; audit completion append unconfirmed; reconcile before retry',
    threw ? { cause: handlerError } : undefined);
    this.name = 'AuditWriteError'; this.code = 'ILLUCI_AUDIT_WRITE_UNCONFIRMED';
    Object.assign(this, { stage, operationId, attemptId, handlerOutcome, executionObserved: stage === 'completion', auditOutcome: 'unconfirmed', retrySafe: false });
  }
}
function appendReceipt(base, phase, details) {
  return logDecision({
    humanStatus: 'operator-absent', modelStatus: [], context: 'existing MCP mixed audit boundary',
    type: 'boundary-audit', decision: phase, inputs: { requestShape: base.requestShape },
    outputs: phase === 'completion' ? { handlerOutcome: details.handlerOutcome, responseShape: details.responseShape } : null,
    metadata: { schema: 'illuci.boundary-audit/1', operationId: base.operationId, path: base.path,
      operation: base.operation, phase, attemptId: details.attemptId ?? null,
      authorizationAssessed: false, identityAuthenticated: false,
      humanStatusMeaning: 'no human approval or absence determination by this observer',
      payloadCapture: 'structural-only', ...details },
  });
}
async function observe({ path, operation, requestShape, preview }, invoke) {
  const operationId = randomUUID(), start = Date.now(), base = { operationId, path, operation, requestShape };
  let attempt;
  try { attempt = appendReceipt(base, 'attempt', { handlerOutcome: 'not-yet-invoked' }); }
  catch { throw new AuditWriteError({ stage: 'attempt', operationId }); }
  let result, handlerError, threw = false;
  try { result = await invoke(); } catch (error) { handlerError = error; threw = true; }
  const handlerOutcome = threw ? 'threw' : 'returned';
  const details = { attemptId: attempt.id, handlerOutcome, responseShape: shape(result), latencyMs: Date.now() - start };
  let completion;
  try { completion = appendReceipt(base, 'completion', details); }
  catch {
    safelyPreview(() => ({ ...preview(result, handlerError, threw), operation_id: operationId, attempt_id: attempt.id,
      handler_outcome: handlerOutcome, audit_outcome: 'unconfirmed', latency_ms: details.latencyMs, emitted_at: new Date().toISOString() }),
    { operation_id: operationId, attempt_id: attempt.id, handler_outcome: handlerOutcome, audit_outcome: 'unconfirmed' });
    throw new AuditWriteError({ stage: 'completion', operationId, attemptId: attempt.id, handlerOutcome, handlerError, threw });
  }
  safelyPreview(() => ({ ...preview(result, handlerError, threw), operation_id: operationId, attempt_id: attempt.id,
    completion_id: completion.id, handler_outcome: handlerOutcome, audit_outcome: 'append-acknowledged', latency_ms: details.latencyMs, emitted_at: new Date().toISOString() }),
  { operation_id: operationId, attempt_id: attempt.id, completion_id: completion.id,
    handler_outcome: handlerOutcome, audit_outcome: 'append-acknowledged' });
  if (threw) throw handlerError;
  return result;
}
export function auditBoundary(operationName, handler) {
  if (typeof operationName !== 'string' || !/^[a-zA-Z0-9_/-]{1,120}$/.test(operationName) || typeof handler !== 'function') throw new TypeError('Bounded operation name and handler required');
  return async function wrappedBoundaryHandler(request, context = {}) {
    return observe({ path: 'mcp_boundary', operation: operationName, requestShape: shape(own(request, 'params')),
      preview: (response, error, threw) => ({ path: 'mcp_boundary', operation: operationName,
        host_identity: own(context,'host') || own(own(request,'meta'),'host') || 'unknown',
        tenant_id: own(context,'tenant_id') || surfaceTenantId(), identity_authenticated: false,
        schema_name: own(own(request,'params'),'name') || null, schema_version: own(response,'schema_version') || null,
        request_payload: own(request,'params') ?? null, response_payload: threw ? null : response,
        error: threw ? (typeof error === 'string' ? error : own(error,'message') ?? '[non-message throw]') : null,
      }),
    }, () => handler(request, context));
  };
}
export async function auditWrap({ caller, callee, args = null }, fn) {
  if (typeof fn !== 'function') throw new TypeError('Invocation required');
  return observe({ path: 'in_process', operation: 'in-process', requestShape: shape(args),
    preview: (result, error, threw) => ({ path: 'in_process', caller, callee, tenant_id: surfaceTenantId(),
      identity_authenticated: false, args_summary: args, result_summary: threw ? null : result,
      error: threw ? (typeof error === 'string' ? error : own(error,'message') ?? '[non-message throw]') : null }),
  }, fn);
}
