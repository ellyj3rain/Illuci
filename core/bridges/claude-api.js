/**
 * illuci — Claude API Bridge (agnostic, per-token)
 *
 * The provider-agnostic Anthropic path, distinct from claude.js (the
 * subscription CLI). Speaks the Anthropic Messages API directly over fetch
 * (no SDK dependency), so it streams cleanly and is harness-independent — the
 * "agnostic API option" half of the operator's Claude direction. Billed
 * per-token via ANTHROPIC_API_KEY, so it is opt-in (model id "claude-api"),
 * never the council default.
 *
 * Sub-model selection via options.model (a illuci sub-model id, CLI alias, or a
 * full Anthropic model id); default Fable 5. Exposes both query() (buffered)
 * and queryStream() (token-level SSE) so dispatch's streaming path is real
 * here, unlike the CLI bridges.
 */

import { getEntry } from "./model-registry.js";
import { toEffort } from "../reasoning/dial.js";
import { resolveAmbientEnv } from "../connections/tenant-context.js";
import { createTraceExposure } from './trace-exposure.js';
import { createHash } from 'node:crypto';

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = process.env.CLAUDE_API_MODEL || getEntry("claude-api").model;
const DEFAULT_MAX_TOKENS = 8192;

// Reasoning on the Messages API is the modern `output_config.effort` control (per the
// Anthropic effort docs): supported on Fable/Mythos 5, Opus/Sonnet/Haiku 5,
// and Opus 4.5-4.8 / Sonnet 4.6,
// with or without thinking, dial 1:1 to the effort enum. We deliberately do NOT send the
// legacy `thinking:{type:"enabled",budget_tokens}` shape — it returns a 400 on Opus
// 4.7/4.8 and is deprecated on 4.6.
const EFFORT_CAPABLE = /fable-5|mythos-5|opus-5(?:-|$)|sonnet-5(?:-|$)|haiku-5(?:-|$)|opus-4-[5678]\b|sonnet-4-6\b/;
// Of those, the models that ENABLE extended thinking via thinking:{type:"adaptive"}.
// Fable 5 / Mythos 5 are always-on adaptive (no block needed); effort drives them.
const ADAPTIVE_THINKING = /opus-4-[678]\b|sonnet-4-6\b/;
// `xhigh` also applies to 5.5 models; clamp it to `high` on the older unsupported models.
const XHIGH_CAPABLE = /fable-5|mythos-5|opus-5(?:-|$)|sonnet-5(?:-|$)|haiku-5(?:-|$)|opus-4-[78]\b/;

/** Resolve any known spelling to an Anthropic model id via the registry
 *  (the API always takes the full model id, never a CLI shortcut). */
function resolveApiModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  const entry = getEntry(requested);
  return entry ? entry.model : requested;
}

function buildMessages(userMessage, sessionState) {
  const messages = [];
  if (Array.isArray(sessionState)) {
    for (const m of sessionState) {
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: String(m.content ?? "") });
      }
    }
  }
  messages.push({ role: "user", content: userMessage });
  return messages;
}

/** [A22.5] Ambient-tenant-aware key resolution: explicit env > tenant context > process.env. */
export function resolveAnthropicApiKey(env) {
  return (env || resolveAmbientEnv()).ANTHROPIC_API_KEY || null;
}

function requireKey(env) {
  const key = resolveAnthropicApiKey(env);
  if (!key) throw new Error("claude-api: ANTHROPIC_API_KEY not set (the agnostic API bridge is per-token; set the key or use claude-local).");
  return key;
}

function buildBody(userMessage, options, stream) {
  const model = resolveApiModel(options.model);
  const body = {
    model,
    max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    messages: buildMessages(userMessage, options.sessionState),
  };
  if (options.systemPrompt) body.system = options.systemPrompt;
  // Reasoning via the modern output_config.effort control. Read the LIVE universal dial
  // (options.reasoning) — which the adaptive ladder steps per attempt — and translate it
  // 1:1 to the effort enum. Effort-incapable models (e.g. Haiku 4.5) emit no knob: a safe
  // no-op, never a guessed thinking shape that could 400.
  if (EFFORT_CAPABLE.test(model)) {
    let effort = toEffort(options.reasoning);
    if (effort === "xhigh" && !XHIGH_CAPABLE.test(model)) effort = "high";
    if (effort) {
      body.output_config = { effort };
      // Enable extended thinking on the adaptive-thinking models (Fable 5/Mythos 5 are
      // always-on, so they need no block — effort alone drives their thinking depth).
      if (ADAPTIVE_THINKING.test(model)) body.thinking = { type: "adaptive" };
    }
  }
  if (stream) body.stream = true;
  return body;
}

// This adapter sends only Messages text and never executes returned tool calls.
// The assertion describes this adapter, not the provider's internal computation.
export function assertResponseOnly() { return true; }
export function assertProviderAdmission() { return true; }

async function prepareRequest(userMessage, options, stream) {
  const body = buildBody(userMessage, options, stream);
  if (options.responseOnly !== undefined && options.responseOnly !== false) {
    if (options.responseOnly !== true || typeof userMessage !== 'string' ||
        (body.system !== undefined && typeof body.system !== 'string') ||
        !body.messages.every(message => typeof message.content === 'string')) {
      throw Error('Response-only Messages requests require text content');
    }
    assertResponseOnly();
  }
  const wireBody = JSON.stringify(body), signal = options.signal;
  const required = options.requireProviderAdmission;
  const admit = options.beforeProviderRequest;
  if (required !== undefined && required !== false && required !== true) throw Error('Invalid provider admission constraint');
  if (required === true && (options.responseOnly !== true || typeof admit !== 'function')) throw Error('Response-only provider admission callback required');
  if (admit !== undefined) {
    if (typeof admit !== 'function') throw Error('Invalid provider admission callback');
    const descriptor = Object.freeze({ schema: 'illuci.provider-request/1', bridge: 'claude-api.js', transport: 'https',
      recipient: API_URL, method: 'POST', model: body.model, stream, responseOnly: options.responseOnly === true,
      payloadFormat: 'anthropic.messages.text', payloadSha256: createHash('sha256').update(wireBody).digest('hex'),
      capabilityRequirements: Object.freeze([]) });
    if (await admit(descriptor) !== true) throw Error('Provider admission was not acknowledged');
  }
  // Capture the actual body/signal before the approval await. A later options
  // mutation cannot change the admitted bytes; cancellation still prevents fetch.
  if (signal?.aborted) throw new DOMException('Owned query aborted before provider handoff', 'AbortError');
  return { body: wireBody, signal,
    ...(typeof admit === 'function' || options.responseOnly === true ? { redirect: 'error' } : {}) };
}

export async function query(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.claude-api');
  const key = requireKey(resolveAmbientEnv(options.env));
  const start = Date.now();
  const request = await prepareRequest(userMessage, options, false);
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION },
    ...request,
  });
  if (!res.ok) {
    const txt = await trace.text(res).catch(() => "");
    throw new Error(`claude-api ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await trace.json(res); await trace.finish();
  const response = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const usage = json.usage
    ? {
        prompt_tokens: json.usage.input_tokens || 0,
        completion_tokens: json.usage.output_tokens || 0,
        total_tokens: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0),
      }
    : {};
  const sessionState = [
    ...(options.sessionState || []),
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ];
  return { model: "claude-api", role: options.role || "agent", response, usage, latency: Date.now() - start, sessionState };
}

/**
 * Token-level streaming over the Messages SSE stream. Yields
 * { type: "delta", text } chunks and a terminal
 * { type: "final", response, usage, latency }. Honors options.signal.
 */
export async function* queryStream(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.claude-api');
  const key = requireKey(resolveAmbientEnv(options.env));
  const start = Date.now();
  const request = await prepareRequest(userMessage, options, true);
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION },
    ...request,
  });
  if (!res.ok || !res.body) {
    const txt = res.body ? await trace.text(res).catch(() => "") : "";
    throw new Error(`claude-api stream ${res.status}: ${txt.slice(0, 300)}`);
  }

  let response = "";
  let usage = {};
  let stopped = false, stopReason = null;

  for await (const evt of trace.sse(res.body)) {
      const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let payload;
      try { payload = JSON.parse(dataLine.slice(5).trim()); } catch {
        await trace.failure('provider-event-parse-failed');
        throw Object.assign(new Error('claude-api: invalid stream event'), { outcome: 'unknown', retrySafe: false });
      }
      if (payload.type === 'error') throw Object.assign(new Error('claude-api: stream reported an error'), { outcome: 'unknown', retrySafe: false });
      if (payload.type === 'message_stop') stopped = true;
      if (payload.type === 'message_delta' && payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
      if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
        response += payload.delta.text;
        yield { type: "delta", text: payload.delta.text, reasoning: false };
      } else if (payload.type === "message_delta" && payload.usage) {
        usage.completion_tokens = payload.usage.output_tokens || usage.completion_tokens || 0;
      } else if (payload.type === "message_start" && payload.message?.usage) {
        usage.prompt_tokens = payload.message.usage.input_tokens || 0;
      }
  }

  if (!stopped) throw Object.assign(new Error('claude-api: stream ended without message_stop'), { outcome: 'unknown', retrySafe: false });

  // The shared reader flushes EOF, while retaining original fetch-body bytes
  // for every provider block, including those this text parser does not project.
  usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  const sessionState = [
    ...(options.sessionState || []),
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ];
  yield { type: "final", model: "claude-api", role: options.role || "agent", response, usage, latency: Date.now() - start, sessionState,
    stopReason, ...(stopReason === 'refusal' ? { refused: true } : {}),
    ...(['pause_turn', 'tool_use'].includes(stopReason) ? { continuationRequired: true } : {}) };
}

export default { query, queryStream, assertResponseOnly, assertProviderAdmission };
