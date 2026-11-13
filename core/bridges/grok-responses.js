/** xAI Responses text transport for an explicitly selected Grok 4.7 model.
 * Native items may be carried only when a caller explicitly supplies a history;
 * the caller owns its provenance, disclosure and custody. No tools are executed. */
import { toEffort } from '../reasoning/dial.js';
import { createTraceExposure } from './trace-exposure.js';

const DEFAULT_ENDPOINT = 'https://api.x.ai/v1/responses';
const unconfirmed = (message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined),
  { code: 'ILLUCI_PROVIDER_OUTCOME_UNCONFIRMED', outcome: 'unknown', retrySafe: false });
const usageOf = usage => ({ prompt_tokens: usage?.input_tokens ?? 0,
  completion_tokens: usage?.output_tokens ?? 0, total_tokens: usage?.total_tokens ?? 0 });
const outputText = output => (Array.isArray(output) ? output : [])
  .filter(item => item?.type === 'message' && item.role === 'assistant')
  .flatMap(item => Array.isArray(item.content) ? item.content : [])
  .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
  .map(part => part.text).join('');

function request(userMessage, options, stream) {
  if (typeof userMessage !== 'string') throw new TypeError('Responses text input must be a string');
  const input = [];
  if (options.nativeHistory !== undefined) {
    const history = options.nativeHistory;
    if (!history || history.schema !== 'illuci.xai.responses-history/1' || history.model !== options.model ||
        !Array.isArray(history.input) || !history.input.length || history.input.length > 2048 ||
        options.systemPrompt || (options.sessionState && options.sessionState.length)) throw new TypeError('Explicit native history must match the selected model and cannot be mixed with text history');
    for (const item of history.input) {
      if (!nativeHistoryItem(item)) throw new TypeError('Unsupported native history item; no provider request was sent');
      input.push(structuredClone(item));
    }
  } else {
    if (options.systemPrompt) input.push({ role: 'system', content: options.systemPrompt });
    for (const m of options.sessionState || []) {
      if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') input.push({ role: m.role, content: m.content });
    }
  }
  input.push({ role: 'user', content: userMessage });
  const body = { model: options.model, input, store: false, ...(stream ? { stream: true } : {}) };
  const effort = toEffort(options.reasoning);
  if (effort) body.reasoning = { effort: effort === 'max' ? 'xhigh' : effort };
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (typeof options.temperature === 'number') body.temperature = options.temperature;
  return body;
}

// The supported text continuation carries reasoning and message items exactly.
// Tool calls require a separate host execution/permission contract and are not accepted.
function nativeHistoryItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (item.type === 'reasoning') return typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
  if (item.type === 'message') return item.role === 'assistant' && Array.isArray(item.content) &&
    item.content.every(part => part && ['output_text', 'refusal'].includes(part.type));
  return item.type === undefined && ['system','user','assistant'].includes(item.role) && typeof item.content === 'string';
}

function normalized(result, userMessage, options, latency, input) {
  if (result?.status !== 'completed') throw unconfirmed(`grok-responses: outcome ${result?.status || 'unknown'}`);
  const response = outputText(result.output);
  if (!response) throw unconfirmed('grok-responses: completed response contained no assistant text');
  const candidate = options.returnNativeHistory === true && (!result.model || result.model === options.model) && result.output.every(nativeHistoryItem)
    ? { schema: 'illuci.xai.responses-history/1', model: options.model, input: structuredClone([...input, ...result.output]) } : null;
  return { model: result.model || options.model, requestedModel: options.model, role: options.role || 'agent', response,
    usage: usageOf(result.usage), latency, nativeOutput: structuredClone(result.output),
    continuity: options.nativeHistory ? 'explicit caller-supplied native history; provenance unverified' : 'text-only; native output retained for separately authorized continuation',
    ...(options.returnNativeHistory === true ? { nativeHistoryCandidate: candidate,
      nativeHistoryStatus: candidate ? 'candidate-unverified' : 'unsupported-native-output' } : {}),
    sessionState: [...(options.sessionState || []), { role: 'user', content: userMessage }, { role: 'assistant', content: response }] };
}

async function call(userMessage, options, stream, trace) {
  const doFetch = options.fetch || fetch;
  const body = request(userMessage, options, stream);
  const timeout = AbortSignal.timeout(options.timeoutMs || 120000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let res;
  try {
    res = await doFetch(process.env.XAI_RESPONSES_URL || DEFAULT_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body), signal,
    });
  } catch (cause) { throw unconfirmed('grok-responses: request outcome requires reconciliation', cause); }
  if (!res.ok) {
    let detail;
    try { detail = (await trace.text(res)).slice(0, 300); }
    catch (cause) { throw unconfirmed(`grok-responses ${res.status}: error response could not be read`, cause); }
    throw unconfirmed(`grok-responses ${res.status}: ${detail}`);
  }
  return { res, input: body.input };
}

export async function queryResponses(userMessage, options) {
  options = { ...options, sessionState: structuredClone(options.sessionState || []) };
  const start = Date.now(), trace = createTraceExposure(options, 'illuci.bridge.grok-responses');
  const { res, input } = await call(userMessage, options, false, trace);
  let value;
  try { value = await trace.json(res); await trace.finish(); }
  catch (cause) { throw unconfirmed('grok-responses: response could not be read', cause); }
  return normalized(value, userMessage, options, Date.now() - start, input);
}

export async function* streamResponses(userMessage, options) {
  options = { ...options, sessionState: structuredClone(options.sessionState || []) };
  const start = Date.now(), trace = createTraceExposure(options, 'illuci.bridge.grok-responses');
  const { res, input } = await call(userMessage, options, true, trace);
  if (!res.body) throw unconfirmed('grok-responses: response body is not streamable');
  let terminal = null, streamed = '';
  try { for await (const block of trace.sse(res.body)) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let event; try { event = JSON.parse(data); } catch { await trace.failure('provider-event-parse-failed'); throw unconfirmed('grok-responses: invalid stream event'); }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') { streamed += event.delta; yield { type: 'delta', text: event.delta, reasoning: false }; }
    if (event.type === 'response.completed') terminal = event.response;
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw unconfirmed(`grok-responses: stream ${event.type}`);
  } } catch (cause) {
    if (cause?.retrySafe === false) throw cause;
    throw unconfirmed('grok-responses: stream outcome requires reconciliation', cause);
  }
  if (!terminal) throw unconfirmed('grok-responses: stream ended without completed response');
  const final = normalized(terminal, userMessage, options, Date.now() - start, input);
  if (streamed && streamed !== final.response) throw unconfirmed('grok-responses: final output differs from stream');
  yield { type: 'final', ...final };
}
