import { run } from '../core/agent/index.js';

let turns = 0;
const events = [];
for await (const event of run({
  direction: { intent: 'Read a synthetic status and report it.' },
  config: { agent: 'local-fixture', tools: ['status'], maxSteps: 3 },
}, {
  toolNames: ['status'], mcpTools: null,
  async *queryModelStream() {
    turns += 1;
    yield { type: 'final', response: turns === 1
      ? '{"tool_calls":[{"tool":"status","args":{}}]}'
      : 'The synthetic status is ready.' };
  },
  executeTool: async (name) => ({ success: name === 'status', result: 'ready' }),
})) events.push(event);

const result = events.findLast(event => event.type === 'run_complete');
if (!result?.ok || turns !== 2 || !events.some(event => event.type === 'tool_result')) {
  throw new Error('The real agent loop did not complete the synthetic two-turn task.');
}
console.log(JSON.stringify({ turns, result, modelRequests: 0 }, null, 2));
