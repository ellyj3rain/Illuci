/**
 * illuci — Grok API Bridge (xAI Direct)
 *
 * Direct API calls to xAI's grok endpoint. No browser, no Playwright,
 * no session files. Uses XAI_API_KEY env var or .env file.
 *
 * xAI API is OpenAI-compatible: POST to https://api.x.ai/v1/chat/completions
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { toEffort } from '../reasoning/dial.js';
import { resolveAmbientEnv } from '../connections/tenant-context.js';
import { createTraceExposure } from './trace-exposure.js';
import { queryResponses, streamResponses } from './grok-responses.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_URL = process.env.XAI_API_URL || 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.XAI_MODEL || 'grok-4.20-0309-reasoning';

// Capability gate: xAI 400s on reasoning_effort for non-reasoning Grok models
// (grok-build, the composer fast variants). The always-present MODEL_DEFAULTS.reasoning
// would otherwise force the knob onto an incapable model. A model is reasoning-capable
// unless its id carries a known non-reasoning marker (mirrors grok-cli.js's guard).
const GROK_NON_REASONING = ['grok-build', 'composer', 'fast', 'mini'];
function grokReasoningCapable(model) {
  const m = String(model || '').toLowerCase();
  return !GROK_NON_REASONING.some((marker) => m.includes(marker));
}

/** [A22.5] Ambient-tenant-aware key resolution: explicit env > tenant context > process.env (+ dev .env file). */
export function resolveXaiApiKey(env) {
  const e = env || resolveAmbientEnv();
  if (e.XAI_API_KEY) return e.XAI_API_KEY;

  // Try .env file in project root (dev fallback)
  try {
    const root = resolve(__dirname, '..', '..');
    const envFile = readFileSync(resolve(root, '.env'), 'utf-8');
    const match = envFile.match(/^XAI_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch {}

  return null;
}

function getApiKey(env) {
  const key = resolveXaiApiKey(env);
  if (key) return key;
  throw new Error('XAI_API_KEY not set. Set it in env or .env file.');
}

export async function query(userMessage, options = {}) {
  const model = options.model || MODEL;
  if (model === 'grok-4.7') return queryResponses(userMessage, { ...options, model, apiKey: options.apiKey || getApiKey(resolveAmbientEnv(options.env)) });
  const trace = createTraceExposure(options,'illuci.bridge.grok-api');
  const start = Date.now();
  const apiKey = getApiKey(resolveAmbientEnv(options.env));

  const messages = [];

  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }

  if (options.sessionState?.length) {
    for (const m of options.sessionState) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }

  messages.push({ role: 'user', content: userMessage });

  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens || 16384,
  };

  // Universal reasoning dial -> xAI's OpenAI-compatible reasoning_effort. Read the
  // LIVE options.reasoning at body-build time so the adaptive ladder's stepped tier
  // (xhigh->high->medium) reaches the wire per attempt. Omitted for the "off"/unknown
  // dial AND for non-reasoning Grok models (capability gate) so it can never 400.
  const effort = toEffort(options.reasoning);
  if (effort && grokReasoningCapable(model)) {
    body.reasoning_effort = effort;
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await trace.text(response);
    throw new Error(`Grok API ${response.status}: ${err}`);
  }

  const data = await trace.json(response); await trace.finish();
  const latency = Date.now() - start;

  return {
    model: data.model || model,
    response: data.choices?.[0]?.message?.content || null,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
      total_tokens: data.usage?.total_tokens || 0,
    },
    latency,
  };
}

/**
 * Streaming sibling of query(). xAI is OpenAI-compatible, so the wire format is the
 * same SSE `data: {choices:[{delta:{content}}]}` stream ollama's OpenAI-compat mode
 * parses. Yields { type: "delta", text, reasoning } per chunk and one terminal
 * { type: "final", response, usage, sessionState }. options.signal (the loop's
 * AbortSignal) aborts the fetch; a wall-clock timeout guards a stuck stream.
 * options.fetch / options.apiKey are injectable for tests.
 */
export async function* queryStream(userMessage, options = {}) {
  const model = options.model || MODEL;
  if (model === 'grok-4.7') {
    yield* streamResponses(userMessage, { ...options, model, apiKey: options.apiKey || getApiKey(resolveAmbientEnv(options.env)) });
    return;
  }
  const trace = createTraceExposure(options,'illuci.bridge.grok-api');
  const start = Date.now();
  const apiKey = options.apiKey || getApiKey(resolveAmbientEnv(options.env));
  const doFetch = options.fetch || fetch;

  const messages = [];
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
  if (options.sessionState?.length) {
    for (const m of options.sessionState) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  messages.push({ role: 'user', content: userMessage });

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens || 16384,
  };
  const effort = toEffort(options.reasoning);
  if (effort && grokReasoningCapable(model)) body.reasoning_effort = effort;

  // Abort: thread the loop's signal; combine with a wall-clock timeout so a stuck
  // stream cannot pin the run. AbortSignal.any -> either fires.
  const timeout = AbortSignal.timeout(options.timeoutMs || 120000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response;
  try {
    response = await doFetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw Object.assign(new Error('Grok API: stream request outcome is unconfirmed', { cause }), { outcome: 'unknown', retrySafe: false });
  }
  if (!response.ok) throw new Error(`Grok API ${response.status}: ${await trace.text(response)}`);
  if (!response.body) throw Object.assign(new Error('Grok API: response body is not streamable'), { outcome: 'unknown', retrySafe: false });

  let answer = '';
  let reasoning = '';
  let usage = {};
  let finished = false, finishReason = null;
  try { for await (const rawLine of trace.lines(response.body)) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { finished = true; continue; }
      let json;
      try { json = JSON.parse(data); } catch {
        await trace.failure('provider-event-parse-failed');
        throw Object.assign(new Error('Grok API: invalid stream event'), { outcome: 'unknown', retrySafe: false });
      }
      if (json.error) throw Object.assign(new Error('Grok API: stream reported an error'), { outcome: 'unknown', retrySafe: false });
      if (json.usage) {
        usage = {
          prompt_tokens: json.usage.prompt_tokens || 0,
          completion_tokens: json.usage.completion_tokens || 0,
          total_tokens: json.usage.total_tokens || 0,
        };
      }
      const delta = json.choices?.[0]?.delta || {};
      if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
      if (delta.content) {
        answer += delta.content;
        yield { type: 'delta', text: delta.content, reasoning: false };
      }
      if (delta.reasoning_content || delta.reasoning) {
        const r = delta.reasoning_content || delta.reasoning;
        reasoning += r;
        yield { type: 'delta', text: r, reasoning: true };
      }
  } } catch (cause) {
    if (cause?.retrySafe === false) throw cause;
    throw Object.assign(new Error('Grok API: stream outcome is unconfirmed', { cause }), { outcome: 'unknown', retrySafe: false });
  }

  if (finishReason && !['stop', 'length'].includes(finishReason)) {
    throw Object.assign(new Error(`Grok API: stream terminated with ${finishReason}`), { retrySafe: false });
  }
  if (!finished && !finishReason) {
    throw Object.assign(new Error('Grok API: stream ended without completion'), { outcome: 'unknown', retrySafe: false });
  }
  if (!answer.trim()) throw Object.assign(new Error('Grok API: stream contained no assistant answer'), { retrySafe: false });
  const text = answer;
  yield {
    type: 'final',
    model,
    role: options.role || 'agent',
    response: text,
    ...(reasoning ? { reasoning } : {}),
    usage,
    latency: Date.now() - start,
    sessionState: [
      ...(options.sessionState || []),
      { role: 'user', content: userMessage },
      { role: 'assistant', content: text },
    ],
  };
}
