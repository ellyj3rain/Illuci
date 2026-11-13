import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryStream } from './grok-api.js';
import { queryResponses } from './grok-responses.js';

const result = { status: 'completed', model: 'grok-4.7', output: [
  { type: 'reasoning', encrypted_content: 'fixture-only' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
const opts = { model: 'grok-4.7', apiKey: 'fixture', reasoning: 'max' };

test('lost error-response bodies remain non-retryable for buffered and streaming calls', async () => {
  const broken = { ...opts, fetch: async () => ({ ok: false, status: 503, text: async () => { throw Error('synthetic body loss'); } }) };
  const isUnconfirmed = error => error.code === 'ILLUCI_PROVIDER_OUTCOME_UNCONFIRMED' && error.outcome === 'unknown' && error.retrySafe === false;
  await assert.rejects(query('question', broken), isUnconfirmed);
  await assert.rejects(async () => { for await (const _ of queryStream('question', broken)) {} }, isUnconfirmed);
});

test('legacy Grok partial stream loss preserves unknown outcome for dispatch', async () => {
  const encoder = new TextEncoder();
  const emitted = [];
  await assert.rejects(async () => {
    for await (const event of queryStream('q', { model: 'grok-3', apiKey: 'fixture', fetch: async () => ({
      ok: true, body: (async function* () {
        yield encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        throw new Error('synthetic transport loss');
      })(),
    }) })) emitted.push(event);
  }, error => error.outcome === 'unknown' && error.retrySafe === false);
  assert.equal(emitted[0].text, 'partial');
  assert.equal(emitted.some(event => event.type === 'final'), false);
});

test('Grok 4.7 uses Responses and retains native output without automatic replay', async () => {
  let observed;
  const actual = await query('question', { ...opts, fetch: async (url, init) => {
    observed = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => result };
  } });
  assert.equal(observed.url, 'https://api.x.ai/v1/responses');
  assert.equal(observed.body.model, 'grok-4.7');
  assert.equal(observed.body.store, false);
  assert.deepEqual(observed.body.reasoning, { effort: 'xhigh' });
  assert.equal('messages' in observed.body, false);
  assert.equal(actual.response, 'answer');
  assert.deepEqual(actual.nativeOutput, result.output);
  assert.equal(actual.usage.total_tokens, 5);
  assert.match(actual.continuity, /text-only/);
});

test('environment-selected Grok 4.7 uses the Responses protocol in buffered and streaming routes', async () => {
  const previous = process.env.XAI_MODEL;
  process.env.XAI_MODEL = 'grok-4.7';
  try {
    const bridge = await import(`./grok-api.js?configured-model=${Date.now()}`);
    const calls = [];
    const buffered = await bridge.query('question', { apiKey: 'fixture', fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => result };
    } });
    const enc = new TextEncoder(), events = [];
    const lines = ['data: {"type":"response.output_text.delta","delta":"answer"}\n\n', `data: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`];
    for await (const event of bridge.queryStream('question', { apiKey: 'fixture', fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, body: (async function* () { for (const line of lines) yield enc.encode(line); })() };
    } })) events.push(event);
    assert.equal(buffered.response, 'answer');
    assert.equal(events.at(-1).response, 'answer');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url === 'https://api.x.ai/v1/responses' && call.body.model === 'grok-4.7' && !('messages' in call.body)));
  } finally {
    if (previous === undefined) delete process.env.XAI_MODEL; else process.env.XAI_MODEL = previous;
  }
});

test('Grok 4.7 streaming requires a completed event and never turns incomplete output into success', async () => {
  const enc = new TextEncoder();
  const response = lines => ({ ok: true, body: (async function* () { for (const line of lines) yield enc.encode(line); })() });
  const events = [];
  const lines = ['data: {"type":"response.output_text.delta","delta":"answer"}\n\n', `data: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`];
  for await (const event of queryStream('q', { ...opts, returnNativeHistory: true, fetch: async () => response(lines) })) events.push(event);
  assert.equal(events.find(e => e.type === 'delta').text, 'answer');
  assert.equal(events.at(-1).response, 'answer');
  assert.deepEqual(events.at(-1).nativeOutput, result.output);
  assert.equal(events.at(-1).nativeHistoryStatus, 'candidate-unverified');
  assert.deepEqual(events.at(-1).nativeHistoryCandidate.input.slice(-result.output.length), result.output);
  await assert.rejects(async () => { for await (const _ of queryStream('q', { ...opts, fetch: async () => response([lines[0]]) })) {} }, /without completed/);
  await assert.rejects(async () => { for await (const _ of queryStream('q', { ...opts, fetch: async () => response(['data: {"type":"response.incomplete"}\n\n']) })) {} }, /response.incomplete/);
});

test('Grok transport loss is uncertain and never marked safe to replay', async () => {
  let calls = 0;
  await assert.rejects(query('q', { ...opts, fetch: async () => { calls++; throw new Error('connection lost'); } }),
    error => error.retrySafe === false && error.outcome === 'unknown');
  assert.equal(calls, 1);
});

test('explicit native history preserves provider items across turns without a tool execution', async () => {
  let firstBody, secondBody;
  const first = await query('first question', { ...opts, returnNativeHistory: true, fetch: async (_url, init) => {
    firstBody = JSON.parse(init.body); return { ok: true, json: async () => result };
  } });
  const history = first.nativeHistoryCandidate;
  assert.equal(first.nativeHistoryStatus, 'candidate-unverified');
  assert.deepEqual(history.input, [...firstBody.input, ...result.output]);
  const second = await query('next question', { ...opts, nativeHistory: history, returnNativeHistory: true, fetch: async (_url, init) => {
    secondBody = JSON.parse(init.body); return { ok: true, json: async () => result };
  } });
  assert.deepEqual(secondBody.input, [...history.input, { role: 'user', content: 'next question' }]);
  assert.deepEqual(second.nativeHistoryCandidate.input, [...secondBody.input, ...result.output]);
  assert.match(second.continuity, /provenance unverified/);
});

test('invalid, mixed or tool-bearing native history is refused before fetch', async () => {
  let calls = 0;
  const fetch = async () => { calls++; throw Error('unexpected fetch'); };
  const valid = { schema: 'illuci.xai.responses-history/1', model: 'grok-4.7', input: [
    { role: 'user', content: 'prior' }, ...result.output,
  ] };
  for (const extra of [
    { nativeHistory: { ...valid, model: 'foreign' } },
    { nativeHistory: valid, sessionState: [{ role: 'user', content: 'ambiguous' }] },
    { nativeHistory: { ...valid, input: [...valid.input, { type: 'function_call', name: 'fixture' }] } },
  ]) await assert.rejects(query('q', { ...opts, ...extra, fetch }), /native history/i);
  assert.equal(calls, 0);
});

test('unsupported provider output remains visible but is not packaged as native text continuity', async () => {
  const response = { ...result, output: [...result.output, { type: 'function_call', name: 'fixture' }] };
  const actual = await query('q', { ...opts, returnNativeHistory: true, fetch: async () => ({ ok: true, json: async () => response }) });
  assert.equal(actual.nativeHistoryStatus, 'unsupported-native-output');
  assert.equal(actual.nativeHistoryCandidate, null);
  assert.deepEqual(actual.nativeOutput, response.output);
});

test('in-flight caller mutation cannot change the captured model or prior text history', async () => {
  const options = { ...opts, returnNativeHistory: true, sessionState: [{ role: 'user', content: 'original' }] };
  options.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.model, 'grok-4.7');
    options.model = 'foreign'; options.sessionState[0].content = 'changed';
    return { ok: true, json: async () => result };
  };
  const actual = await queryResponses('q', options);
  assert.equal(actual.nativeHistoryCandidate.model, 'grok-4.7');
  assert.equal(actual.nativeHistoryCandidate.input[0].content, 'original');
  assert.equal(actual.sessionState[0].content, 'original');
});
