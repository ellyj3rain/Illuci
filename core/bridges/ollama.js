/**
 * illuci — Ollama Bridge
 *
 * Handles both local models (e.g. qwen36-abl:fast) and Ollama-cloud models
 * (e.g. deepseek-v3.1:671b-cloud). Model selected at dispatch time via
 * options.model.
 *
 * Two wire formats, granular per call ([A66] / DR-076):
 *   - OPENAI-COMPAT (`/v1/chat/completions`, default) — SSE streaming; the
 *     historical path; accepts the OpenAI param subset (temperature, top_p,
 *     max_tokens, stop, seed, frequency/presence_penalty).
 *   - NATIVE (`/api/chat`) — newline-delimited-JSON streaming; the full Ollama
 *     surface: an `options` object (num_ctx, num_predict, top_k, repeat_penalty,
 *     min_p, …) plus top-level `keep_alive` and `think`. Selected via
 *     `options.api: 'native'`, `OLLAMA_API=native`, or AUTOMATICALLY when a
 *     native-only param is requested (so setting num_ctx "just works").
 *
 * Granular control surface (all optional, all per-call):
 *   - options.params  — generation knobs (see PARAM list below)
 *   - options.api     — 'openai' | 'native' (else auto)
 *   - options.baseUrl — per-call endpoint override (local vs cloud vs remote)
 *   - options.model   — the model tag
 *
 * Default: qwen36-abl:fast (local). Endpoint: OLLAMA_URL / OLLAMA_HOST,
 * else http://localhost:11434.
 */

import { toOllamaThink } from "../reasoning/dial.js";
import { isMultimodalEnabled, attachImagesNative, attachImagesOpenAi } from "./multimodal.js";
import { splitReasoning, REASONING_STARVED_ERROR } from "./reasoning-split.js";
import { createTraceExposure } from './trace-exposure.js';

const DEFAULT_BASE_URL = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://localhost:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen36-abl:fast";
const DEFAULT_ROUTE_PROBE_TIMEOUT_MS = 2500;
const ROUTE_PROBE_CACHE_TTL_MS = 5000;
const routeProbeCache = new Map();

// Native /api/chat splits params: these go top-level, everything else into `options`.
const NATIVE_TOP_LEVEL = new Set(["keep_alive", "think", "format"]);
// Params that ONLY the native endpoint understands — their presence auto-selects native.
const NATIVE_ONLY_PARAMS = new Set([
  "num_ctx", "num_predict", "top_k", "repeat_penalty", "repeat_last_n",
  "min_p", "tfs_z", "mirostat", "mirostat_tau", "mirostat_eta",
  "num_gpu", "num_thread", "num_batch", "keep_alive", "think", "format",
]);
// Params the OpenAI-compat endpoint accepts (mapped onto the request body).
const OPENAI_PARAMS = new Set([
  "temperature", "top_p", "seed", "stop", "max_tokens",
  "frequency_penalty", "presence_penalty",
]);

export function resolveBaseUrl(options = {}) {
  return options.baseUrl || options.endpoint || DEFAULT_BASE_URL;
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function routeProbeTimeoutMs(options = {}) {
  return readPositiveInt(options.timeoutMs ?? process.env.ILLUCI_ROUTE_PROBE_TIMEOUT_MS, DEFAULT_ROUTE_PROBE_TIMEOUT_MS);
}

function routeProbeKey({ baseUrl, providerKey, model, timeoutMs }) {
  return [baseUrl, providerKey || "", model || "", timeoutMs].join("\u0000");
}

function cloneProbe(probe) {
  return probe ? JSON.parse(JSON.stringify(probe)) : probe;
}

function cacheRouteProbe(key, probe) {
  routeProbeCache.set(key, { checkedAt: Date.now(), probe: cloneProbe(probe) });
  return probe;
}

function getCachedRouteProbe(key) {
  const cached = routeProbeCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.checkedAt > ROUTE_PROBE_CACHE_TTL_MS) {
    routeProbeCache.delete(key);
    return null;
  }
  return cloneProbe(cached.probe);
}

function listedModelNames(listed) {
  return new Set((listed?.models || []).map((m) => String(m.name || "").toLowerCase()).filter(Boolean));
}

function shouldRequireListedModel(providerKey) {
  return providerKey === "ollama-local";
}

export function resetRouteProbeCache() {
  routeProbeCache.clear();
}

/**
 * Merge the granular param bag with the legacy `maxTokens` option into a single
 * normalized object. Legacy `maxTokens` maps to `num_predict` when not set
 * explicitly. Undefined/null entries are dropped so they never override a
 * model/server default.
 */
function normalizeParams(options) {
  const p = { ...(options.params || {}) };
  if (p.num_predict === undefined && p.max_tokens === undefined && options.maxTokens !== undefined) {
    p.num_predict = options.maxTokens;
  }
  // Universal reasoning dial -> native /api/chat top-level `think` (boolean). An
  // explicit params.think always wins (the caller set it deliberately); otherwise the
  // live options.reasoning drives it. `think` is a NATIVE_ONLY_PARAM, so its presence
  // auto-selects the native endpoint (resolveApiMode). The adaptive ladder steps
  // options.reasoning; off/unset dial -> no think key (the server default rules).
  if (p.think === undefined) {
    const think = toOllamaThink(options.reasoning);
    if (think !== null) p.think = think;
  }
  for (const k of Object.keys(p)) {
    if (p[k] === undefined || p[k] === null) delete p[k];
  }
  return p;
}

function resolveApiMode(options, params) {
  if (options.api === "native" || options.api === "openai") return options.api;
  if (process.env.OLLAMA_API === "native") return "native";
  if (Object.keys(params).some((k) => NATIVE_ONLY_PARAMS.has(k))) return "native";
  return "openai";
}

function buildMessages(systemPrompt, sessionState, userMessage) {
  const messages = [{ role: "system", content: systemPrompt }];
  if (sessionState && Array.isArray(sessionState)) messages.push(...sessionState);
  messages.push({ role: "user", content: userMessage });
  return messages;
}

/**
 * Build the message array, optionally attaching options.images to the current
 * user turn in the wire format the resolved api mode expects. DARK: gated on
 * ILLUCI_MULTIMODAL_ENABLED; with the flag off or no images supplied this returns
 * the plain text-only messages, byte-identical to the historical path.
 */
function buildMessagesWithImages(systemPrompt, options, userMessage, api) {
  const messages = buildMessages(systemPrompt, options.sessionState, userMessage);
  if (!isMultimodalEnabled() || !options.images || !options.images.length) return messages;
  return api === "native"
    ? attachImagesNative(messages, options.images)
    : attachImagesOpenAi(messages, options.images);
}

/** Native /api/chat body: top-level keep_alive/think/format + nested `options`. */
function buildNativeBody(model, messages, stream, params, tools) {
  const body = { model, messages, stream };
  const options = {};
  for (const [k, v] of Object.entries(params)) {
    if (NATIVE_TOP_LEVEL.has(k)) body[k] = v;
    else options[k] = v;
  }
  if (Object.keys(options).length > 0) body.options = options;
  if (tools && tools.length) body.tools = tools;
  return body;
}

/** OpenAI-compat body: map the recognized param subset; drop native-only ones. */
function buildOpenAiBody(model, messages, stream, params, tools) {
  const body = { model, messages };
  for (const [k, v] of Object.entries(params)) {
    if (k === "num_predict") body.max_tokens = v; // native name → openai name
    else if (OPENAI_PARAMS.has(k)) body[k] = v;
    // native-only params silently ignored on this endpoint
  }
  if (body.max_tokens === undefined) body.max_tokens = 4096;
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (tools && tools.length) body.tools = tools;
  return body;
}

/**
 * Map an Ollama model tag back to its illuci alias for provenance labeling.
 * Longest-prefix match wins so more specific tags beat generic ones.
 */
function detectAlias(modelTag) {
  if (!modelTag) return "ollama";
  const tag = modelTag.toLowerCase();
  const patterns = [
    ["deepseek",       "deepseek"],
    ["gpt-oss",        "gpt-oss"],
    ["qwen3-coder",    "qwen-code"],
    ["qwen3.5",        "qwen3.5"],
    ["qwen3-vl",       "qwen3-vl"],
    ["gemma4",         "gemma4"],
    ["gemma3",         "gemma3"],
    ["glm-",           "glm"],
    ["minimax",        "minimax"],
    ["kimi",           "kimi-cloud"],
    ["qwen36-abl",     "ollama"],
    ["qwen3.6-abl",    "ollama"],
  ];
  for (const [prefix, alias] of patterns) {
    if (tag.includes(prefix)) return alias;
  }
  return "ollama";
}

/**
 * Normalize provider-shaped tool calls into illuci's { id, name, args } shape at
 * the bridge boundary, so tool-protocol's native path consumes one shape.
 * Handles both wire formats:
 *   - native /api/chat:  { function: { name, arguments: {…object} } }
 *   - OpenAI-compat:     { id, type, function: { name, arguments: "json string" } }
 * Stringified arguments are JSON.parsed; unparseable arguments degrade to {}
 * so the executor fails loudly on missing params rather than silently.
 *
 * @returns {Array<{id?: string, name: string, args: object}>|undefined}
 */
function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return undefined;
  const calls = raw
    .filter(Boolean)
    .map((c) => {
      const fn = c.function || {};
      const name = fn.name || c.name || c.tool;
      let args = fn.arguments ?? c.arguments ?? c.args ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      return { id: c.id || undefined, name, args };
    })
    .filter((c) => c.name);
  return calls.length ? calls : undefined;
}

/**
 * Query Ollama (non-streaming). See module header for the granular options.
 *
 * @param {string} userMessage
 * @param {object} options — model, systemPrompt, sessionState, maxTokens, role,
 *   timeoutMs, params, api, baseUrl, tools, images (dark: ILLUCI_MULTIMODAL_ENABLED)
 * @returns {Promise<{ model, role, response, usage, latency, sessionState, toolCalls }>}
 */
export async function query(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.ollama');
  const model = options.model || DEFAULT_MODEL;
  const systemPrompt = options.systemPrompt || "You are a helpful assistant.";
  const params = normalizeParams(options);
  const api = resolveApiMode(options, params);
  const base = resolveBaseUrl(options);
  const start = Date.now();
  const messages = buildMessagesWithImages(systemPrompt, options, userMessage, api);
  const priorMessages = options.sessionState || [];

  let text = "";
  let reasoning = "";
  let starved = false;
  let usage = {};
  let toolCalls;

  if (api === "native") {
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildNativeBody(model, messages, false, params, options.tools)),
      signal: AbortSignal.timeout(options.timeoutMs || 120000),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await trace.text(resp)}`);
    const data = await trace.json(resp); await trace.finish();
    const msg = data.message || {};
    toolCalls = normalizeToolCalls(msg.tool_calls);
    // [A47]/F-089: the answer is msg.content ONLY. msg.thinking is the reasoning
    // trace — carried separately, NEVER substituted for an empty answer (that
    // fallback leaked the scratchpad as the response).
    ({ answer: text, reasoning, starved } = splitReasoning({ content: msg.content, reasoning: msg.thinking, hasToolCalls: !!toolCalls }));
    usage = {
      prompt_tokens: data.prompt_eval_count || 0,
      completion_tokens: data.eval_count || 0,
      total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    };
  } else {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOpenAiBody(model, messages, false, params, options.tools)),
      signal: AbortSignal.timeout(options.timeoutMs || 120000),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await trace.text(resp)}`);
    const data = await trace.json(resp); await trace.finish();
    const msg = data.choices?.[0]?.message || {};
    toolCalls = normalizeToolCalls(msg.tool_calls);
    // Same rule for the OpenAI-compat shape: content is the answer, reasoning is
    // separate and never the fallback.
    ({ answer: text, reasoning, starved } = splitReasoning({ content: msg.content, reasoning: msg.reasoning, hasToolCalls: !!toolCalls }));
    const u = data.usage || {};
    usage = {
      prompt_tokens: u.prompt_tokens || 0,
      completion_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || 0,
    };
  }

  const result = {
    model: detectAlias(model),
    role: options.role || "agent",
    response: text,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    usage,
    latency: Date.now() - start,
    sessionState: [
      ...priorMessages,
      { role: "user", content: userMessage },
      { role: "assistant", content: text },
    ],
  };
  // [A47]/F-089: an empty answer with a real reasoning trace and no tool calls is
  // a budget-STARVED failure, not a silent empty success (eval_count is nonzero,
  // so reclassifyEmptySuccess can't catch it — the bridge marks it here). Honest,
  // observable (reasoning is still carried), and actionable (raise num_predict).
  if (starved) return { ...result, failed: true, error: REASONING_STARVED_ERROR };
  return result;
}

/**
 * Streaming variant of query(). Async generator:
 *   - yields { type: "delta", text, reasoning } per token chunk
 *   - yields exactly one terminal { type: "final", model, role, response, usage,
 *       latency, sessionState, toolCalls }
 *
 * Parses SSE (OpenAI-compat) or newline-delimited JSON (native) per the resolved
 * api mode. Reasoning-model chain-of-thought (`reasoning`/`thinking`) is surfaced
 * separately via the `reasoning` flag.
 */
export async function* queryStream(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.ollama');
  const model = options.model || DEFAULT_MODEL;
  const systemPrompt = options.systemPrompt || "You are a helpful assistant.";
  const params = normalizeParams(options);
  const api = resolveApiMode(options, params);
  const base = resolveBaseUrl(options);
  const start = Date.now();
  const messages = buildMessagesWithImages(systemPrompt, options, userMessage, api);
  const priorMessages = options.sessionState || [];

  const url = api === "native" ? `${base}/api/chat` : `${base}/v1/chat/completions`;
  const body = api === "native"
    ? buildNativeBody(model, messages, true, params, options.tools)
    : buildOpenAiBody(model, messages, true, params, options.tools);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs || 120000),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await trace.text(resp)}`);
  if (!resp.body) throw new Error("Ollama: response body is not streamable");

  let answer = "";
  let reasoning = "";
  let usage = {};
  // Raw tool-call accumulator. Native mode appends whole calls as lines
  // arrive; OpenAI-compat mode merges per-index argument FRAGMENTS (the spec
  // streams `function.arguments` as incremental string pieces). Either way,
  // assignment-per-chunk would clobber earlier data — accumulate instead.
  const rawToolCalls = [];

  for await (const rawLine of trace.lines(resp.body)) {
      const line = rawLine.trim();
      if (!line) continue;

      if (api === "native") {
        // Native: each line is a JSON object {message:{content,thinking},done,...}
        let json;
        try { json = JSON.parse(line); } catch { await trace.failure('provider-event-parse-failed'); continue; }
        const msg = json.message || {};
        if (Array.isArray(msg.tool_calls)) rawToolCalls.push(...msg.tool_calls);
        if (msg.content) { answer += msg.content; yield { type: "delta", text: msg.content, reasoning: false }; }
        if (msg.thinking) { reasoning += msg.thinking; yield { type: "delta", text: msg.thinking, reasoning: true }; }
        if (json.done) {
          usage = {
            prompt_tokens: json.prompt_eval_count || 0,
            completion_tokens: json.eval_count || 0,
            total_tokens: (json.prompt_eval_count || 0) + (json.eval_count || 0),
          };
        }
      } else {
        // OpenAI-compat: SSE `data: {...}` lines.
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch { await trace.failure('provider-event-parse-failed'); continue; }
        if (json.usage) {
          usage = {
            prompt_tokens: json.usage.prompt_tokens || 0,
            completion_tokens: json.usage.completion_tokens || 0,
            total_tokens: json.usage.total_tokens || 0,
          };
        }
        const delta = json.choices?.[0]?.delta || {};
        if (Array.isArray(delta.tool_calls)) {
          for (const frag of delta.tool_calls) {
            const i = Number.isInteger(frag.index) ? frag.index : 0;
            const slot = rawToolCalls[i] ||
              (rawToolCalls[i] = { id: undefined, type: "function", function: { name: "", arguments: "" } });
            if (frag.id) slot.id = frag.id;
            if (frag.function?.name) slot.function.name += frag.function.name;
            if (frag.function?.arguments) slot.function.arguments += frag.function.arguments;
          }
        }
        if (delta.content) { answer += delta.content; yield { type: "delta", text: delta.content, reasoning: false }; }
        if (delta.reasoning) { reasoning += delta.reasoning; yield { type: "delta", text: delta.reasoning, reasoning: true }; }
      }
  }

  // [A47]/F-089: the final answer is the accumulated CONTENT stream only — the
  // reasoning stream (deltas flagged reasoning:true) is carried separately and
  // never substituted for an empty answer. Empty answer + real reasoning + no
  // tool calls = a budget-starved failure, surfaced honestly on the final frame.
  const finalToolCalls = normalizeToolCalls(rawToolCalls);
  const { answer: text, reasoning: reasoningTrace, starved } = splitReasoning({
    content: answer, reasoning, hasToolCalls: !!finalToolCalls,
  });
  yield {
    type: "final",
    model: detectAlias(model),
    role: options.role || "agent",
    response: text,
    ...(reasoningTrace ? { reasoning: reasoningTrace } : {}),
    toolCalls: finalToolCalls,
    usage,
    latency: Date.now() - start,
    ...(starved ? { failed: true, error: REASONING_STARVED_ERROR } : {}),
    sessionState: [
      ...priorMessages,
      { role: "user", content: userMessage },
      { role: "assistant", content: text },
    ],
  };
}

/**
 * Model discovery. Lists installed models (`/api/tags`) and, with { running: true },
 * currently-loaded models (`/api/ps`). Per-call endpoint via options.baseUrl.
 *
 * @returns {Promise<{ models: Array<{name, size, family, parameterSize, quantization, modified}>, running?: Array }>}
 */
export async function models(options = {}) {
  const base = resolveBaseUrl(options);
  const timeout = options.timeoutMs || 15000;

  const tagsResp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(timeout) });
  if (!tagsResp.ok) throw new Error(`Ollama ${tagsResp.status}: ${await tagsResp.text()}`);
  const tags = await tagsResp.json();
  const installed = (tags.models || []).map((m) => ({
    name: m.name,
    alias: detectAlias(m.name),
    size: m.size,
    family: m.details?.family || null,
    parameterSize: m.details?.parameter_size || null,
    quantization: m.details?.quantization_level || null,
    modified: m.modified_at || null,
  }));

  const result = { models: installed };

  if (options.running) {
    try {
      const psResp = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(timeout) });
      if (psResp.ok) {
        const ps = await psResp.json();
        result.running = (ps.models || []).map((m) => ({
          name: m.name,
          sizeVram: m.size_vram,
          expiresAt: m.expires_at || null,
        }));
      }
    } catch {
      // /api/ps is best-effort — older Ollama may not have it.
    }
  }

  return result;
}

/**
 * Non-token route readiness probe for Ollama-backed dispatch.
 *
 * This checks the daemon/catalog endpoint (`/api/tags`) with a short deadline so
 * CLI doctor and dispatch can fail before a model call burns the full query
 * timeout. Cloud routes only require endpoint reachability; local routes also
 * require the configured local tag to be listed.
 */
export async function probeRoute(options = {}) {
  const baseUrl = resolveBaseUrl(options);
  const providerKey = options.providerKey || options.provider || null;
  const providerModelString = options.model || options.providerModel || null;
  const timeoutMs = routeProbeTimeoutMs(options);
  const key = routeProbeKey({ baseUrl, providerKey, model: providerModelString, timeoutMs });

  if (!options.noCache) {
    const cached = getCachedRouteProbe(key);
    if (cached) return cached;
  }

  try {
    const listed = await models({ baseUrl, timeoutMs });
    const names = listedModelNames(listed);
    const modelListed = providerModelString ? names.has(String(providerModelString).toLowerCase()) : null;
    const missingLocalModel = shouldRequireListedModel(providerKey) && providerModelString && modelListed === false;
    const probe = {
      status: missingLocalModel ? "model-missing" : "reachable",
      staticAvailable: !missingLocalModel,
      probe: "ollama-tags",
      endpoint: baseUrl,
      providerKey,
      providerModelString,
      modelListed,
      modelCount: names.size,
      timeoutMs,
      lastError: missingLocalModel ? `Ollama model "${providerModelString}" is not listed by ${baseUrl}` : null,
    };
    return options.noCache ? probe : cacheRouteProbe(key, probe);
  } catch (err) {
    const message = err?.message || String(err || "Ollama route probe failed");
    const probe = {
      status: "unreachable",
      staticAvailable: false,
      probe: "ollama-tags",
      endpoint: baseUrl,
      providerKey,
      providerModelString,
      modelListed: null,
      modelCount: null,
      timeoutMs,
      lastError: message,
    };
    return options.noCache ? probe : cacheRouteProbe(key, probe);
  }
}

export default { query, queryStream, models, probeRoute, resolveBaseUrl, resetRouteProbeCache };
