import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './run.js';
import { createAdmittedMemoryContext } from '../context/admitted-memory-context.js';

async function collect(config = {}, extra = {}, signal) {
  const calls = [];
  const deps = {
    defaultModel: 'fixture', toolNames: [], mcpTools: null,
    executeTool: async () => ({ success: true, result: 'observed' }),
    async *queryModelStream(model, message, options) {
      calls.push({ model, message, options });
      yield { type: 'final', response: 'done' };
    }, ...extra,
  };
  const events = [];
  for await (const e of run({ direction: { intent: 'task' }, config, signal }, deps)) events.push(e);
  return { calls, events };
}

test('host memory reaches direct public SDK message and legacy paths are suppressed', async () => {
  const buildMemoryContext = createAdmittedMemoryContext({
    selectReferences: () => ['a'],
    admissionPort: { select: async () => ({ admitted: [{ value: { fact: 'private fixture' }, custody: 'secret envelope' }] }) },
  });
  const { calls, events } = await collect({ dispatch: { raw: true, skipContext: false, skipIdentitySummary: false } }, { buildMemoryContext });
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /private fixture/);
  assert.doesNotMatch(calls[0].message, /secret envelope/);
  assert.deepEqual(calls[0].options.sessionState, []);
  assert.equal(calls[0].options.raw, false);
  assert.equal(calls[0].options.skipContext, true);
  assert.equal(calls[0].options.skipIdentitySummary, true);
  assert.equal(events.at(-1).ok, true);
});

test('caller config cannot activate host memory', async () => {
  let used = false;
  const { calls } = await collect({ buildMemoryContext: () => { used = true; return 'forged'; } });
  assert.equal(used, false);
  assert.doesNotMatch(calls[0].message, /forged/);
  assert.equal(calls[0].options.skipContext, undefined);
});

test('memory is fresh per turn and never copied into retained transcript', async () => {
  const requests = [];
  let lookup = 0;
  const { events } = await collect({ tools: ['read'], maxSteps: 3 }, {
    buildMemoryContext: async () => ++lookup === 1 ? 'ONE_TURN_MEMORY' : '',
    async *queryModelStream(model, message, options) {
      requests.push({ message, history: options.sessionState });
      yield { type: 'final', response: requests.length === 1
        ? '{"tool_calls":[{"tool":"read","args":{"path":"fixture"}}]}' : 'done' };
    },
  });
  assert.equal(events.at(-1).ok, true);
  assert.equal(requests.length, 2);
  assert.match(requests[0].message, /ONE_TURN_MEMORY/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /ONE_TURN_MEMORY/);
  assert.equal(lookup, 2);
});

for (const [label, buildMemoryContext] of [
  ['denial', async () => ''], ['error', async () => { throw Error('PRIVATE DIAGNOSTIC'); }],
  ['invalid', async () => ({ content: 'wrong' })], ['oversize', async () => 'x'.repeat(100000)],
]) test(`optional ${label} keeps ordinary work moving`, async () => {
  const { calls, events } = await collect({}, { buildMemoryContext });
  assert.equal(calls[0].message, 'task');
  assert.equal(events.at(-1).ok, true);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE DIAGNOSTIC/);
});

test('pending host lookup times out without rendering late result', async () => {
  let release;
  const { calls } = await collect({}, {
    memoryContextTimeoutMs: 10,
    buildMemoryContext: () => new Promise(resolve => { release = resolve; }),
  });
  release('late secret');
  assert.equal(calls[0].message, 'task');
});

test('cancellation during lookup starts no model turn', async () => {
  const controller = new AbortController();
  const { calls, events } = await collect({}, {
    buildMemoryContext: () => { controller.abort(); return new Promise(() => {}); },
  }, controller.signal);
  assert.equal(calls.length, 0);
  assert.equal(events.at(-1).haltReason, 'aborted');
});

test('council with direct-only host memory fails explicitly before topology', async () => {
  let called = false;
  const { calls, events } = await collect({ coordination: 'council' }, {
    buildMemoryContext: async () => 'secret',
    runTopology: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(calls.length, 0);
  assert.equal(events.at(-1).ok, false);
  assert.match(events.at(-1).error, /only for direct SDK/);
});

test('host hook receives budget and signal, not asserted identity', async () => {
  let input;
  await collect({ agentId: 'forged', dispatch: { projectId: 'forged' } }, {
    memoryContextMaxTokens: 40,
    buildMemoryContext: async value => { input = value; return 'fact'; },
  });
  assert.deepEqual(Object.keys(input).sort(), ['maxTokens', 'modelId', 'signal']);
  assert.equal(input.maxTokens, 40);
});
