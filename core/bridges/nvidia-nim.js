/**
 * illuci — NVIDIA NIM API Bridge (OpenAI-compatible, HTTP)
 *
 * Direct API calls to NVIDIA's hosted NIM inference endpoint. No browser, no
 * session files. OpenAI-compatible: POST https://integrate.api.nvidia.com/v1/chat/completions
 * with `Authorization: Bearer <key>`, messages[], reading `choices[0].message.content`.
 * One endpoint, many models — each registry row differs only by its `model` wire string.
 *
 * Mirrors grok-api.js (OpenAI-compatible + fetch/apiKey injection + the A25 AbortSignal
 * guard) and grok-api.js (clean query + sessionState), with gemini-api.js's never-empty-success
 * invariant. The route probe mirrors ollama.js probeRoute so `illuci models --doctor` can
 * distinguish a missing key from a route failure.
 *
 * Env:
 *   NVIDIA_API_KEY                  — primary
 *   NVIDIA_NIM_API_KEY              — alias, checked if primary unset
 *   ILLUCI_NVIDIA_NIM_SECRETS_FILE     — OPTIONAL local-dev fallback: a path to a secrets file
 *                                     to read a bare `nvapi-` token from, ONLY when set.
 *                                     Default unset = no file fallback. Never committed/logged.
 *   NVIDIA_NIM_API_URL              — endpoint override (default below)
 *   NVIDIA_NIM_MODEL                — default model override
 */
import { resolveAmbientEnv } from "../connections/tenant-context.js";

import { readFileSync } from 'fs';
import { createTraceExposure } from './trace-exposure.js';

const API_URL = process.env.NVIDIA_NIM_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.NVIDIA_NIM_MODEL || 'deepseek-ai/deepseek-v4-pro';

const DEFAULT_ROUTE_PROBE_TIMEOUT_MS = 2500;
const ROUTE_PROBE_CACHE_TTL_MS = 5000;
const routeProbeCache = new Map();

// Some NIM models 400 on `reasoning_effort` (instruct-only families like gemma), exactly
// like xAI's non-reasoning Grok models. The always-present MODEL_DEFAULTS.reasoning would
// otherwise force the knob onto an incapable model; gate it off by a known marker.
const NIM_NON_REASONING = ['gemma'];
function nimReasoningCapable(model) {
  const m = String(model || '').toLowerCase();
  return !NIM_NON_REASONING.some((marker) => m.includes(marker));
}

/**
 * Read a bare `nvapi-` token (or a NVIDIA_NIM_API_KEY= / NVIDIA_API_KEY= assignment) out of a
 * secrets file. Never throws on a missing/unreadable file — returns null so the caller falls
 * through to the loud missing-key path. The key is never logged.
 */
function readNvidiaKeyFromSecretsFile(file) {
  try {
    const text = readFileSync(file, 'utf-8');
    const assigned = text.match(/^\s*(?:export\s+)?(?:NVIDIA_NIM_API_KEY|NVIDIA_API_KEY)\s*=\s*["']?(nvapi-[A-Za-z0-9_-]+)/m);
    if (assigned) return assigned[1];
    const bare = text.match(/\bnvapi-[A-Za-z0-9_-]+/);
    if (bare) return bare[0];
  } catch { /* missing/unreadable secrets file -> no fallback */ }
  return null;
}

/**
 * Resolve the NVIDIA NIM credential. Env first (NVIDIA_API_KEY, then NVIDIA_NIM_API_KEY); then,
 * ONLY when ILLUCI_NVIDIA_NIM_SECRETS_FILE explicitly points at a file, a local-dev fallback that
 * reads a bare `nvapi-` token from it. Returns null when no credential is resolvable.
 * `env` is injectable for hermetic tests.
 */
export function resolveNvidiaApiKey(env = process.env) {
  if (env.NVIDIA_API_KEY) return env.NVIDIA_API_KEY;
  if (env.NVIDIA_NIM_API_KEY) return env.NVIDIA_NIM_API_KEY;
  const file = env.ILLUCI_NVIDIA_NIM_SECRETS_FILE;
  if (file) {
    const key = readNvidiaKeyFromSecretsFile(file);
    if (key) return key;
  }
  return null;
}

/** True when a NIM credential is resolvable from env alone (the doctor's static presence axis). */
export function hasNvidiaEnvKey(env = process.env) {
  return Boolean(env.NVIDIA_API_KEY || env.NVIDIA_NIM_API_KEY);
}

/**
 * Build an OpenAI-style content value for a user turn: a plain string when text-only (backward
 * compatible), or a content-part array when images/audio are attached. [A19.3] (Air dogfood rec #1)
 * turns on multimodal INPUT for the vlm/omni models over the same OpenAI-compatible endpoint —
 * `options.images` = [url | {url}], `options.audio` = [{data, format}]. Secret-free; no model change.
 */
export function buildUserContent(userMessage, options = {}) {
  const images = Array.isArray(options.images) ? options.images : [];
  const audio = Array.isArray(options.audio) ? options.audio : [];
  if (images.length === 0 && audio.length === 0) return userMessage;
  const parts = [];
  if (userMessage != null && userMessage !== '') parts.push({ type: 'text', text: userMessage });
  for (const img of images) {
    const url = typeof img === 'string' ? img : img?.url;
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  for (const a of audio) {
    if (a?.data) parts.push({ type: 'input_audio', input_audio: { data: a.data, format: a.format || 'wav' } });
  }
  return parts;
}

function buildMessages(userMessage, options) {
  const messages = [];
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
  if (options.sessionState?.length) {
    for (const m of options.sessionState) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  messages.push({ role: 'user', content: buildUserContent(userMessage, options) });
  return messages;
}

/**
 * Query an NVIDIA NIM model (OpenAI chat-completions shape).
 * `options.fetch` / `options.apiKey` / `options.env` are injectable for hermetic tests.
 * @returns {Promise<{ model, role, response, usage, latency, sessionState }>}
 */
export async function query(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.nvidia-nim');
  const start = Date.now();
  // Missing key throws BEFORE any fetch (the doctor reads env presence as missing-auth);
  // a non-2xx from a real request throws AFTER fetch (route failure / BRIDGE_FAILURE).
  const apiKey = options.apiKey || resolveNvidiaApiKey(resolveAmbientEnv(options.env));
  if (!apiKey) {
    throw new Error(
      'nvidia-nim: no credential. Set NVIDIA_API_KEY or NVIDIA_NIM_API_KEY (Bearer) for '
      + 'https://integrate.api.nvidia.com, or point ILLUCI_NVIDIA_NIM_SECRETS_FILE at a secrets file (local dev).',
    );
  }
  const doFetch = options.fetch || fetch;
  const model = options.model || DEFAULT_MODEL;

  const body = {
    model,
    messages: buildMessages(userMessage, options),
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens || 16384,
  };
  // OpenAI-compatible reasoning_effort, gated off instruct-only families so it can never 400.
  if (options.reasoning && nimReasoningCapable(model)) {
    body.reasoning_effort = options.reasoning;
  }

  // A25 AbortSignal guard (grok-api.js / gemini-api.js): forward options.signal ANDed with a
  // wall-clock timeout; never forward a bare null (codex.js documents why).
  const timeout = AbortSignal.timeout(options.timeoutMs || 180000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const resp = await doFetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    let detail = '';
    try { detail = await trace.text(resp); } catch { /* body may be unreadable */ }
    throw new Error(`nvidia-nim ${resp.status} (${model}): ${detail.slice(0, 400)}`);
  }

  const data = await trace.json(resp); await trace.finish();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content || '';
  if (!text) {
    // A reasoning model can spend a small max_tokens budget entirely on hidden reasoning_content,
    // returning empty content with finish_reason 'length' (Air A26 NIM dogfood: gpt-oss-120b at
    // max_tokens 24). That is a truncated reasoning turn, not a real empty success — retry ONCE with
    // a larger cap before refusing, so a tiny caller/probe budget never mis-reports a working model.
    const truncatedReasoning = choice?.finish_reason === 'length'
      && (choice?.message?.reasoning_content || options.reasoning || nimReasoningCapable(model));
    if (truncatedReasoning && !options._retriedForReasoningBudget) {
      const nextCap = Math.max((body.max_tokens || 0) * 2, 512);
      return query(userMessage, { ...options, maxTokens: nextCap, _retriedForReasoningBudget: true });
    }
    throw new Error(`nvidia-nim: ${model} returned no content (empty success refused).`);
  }
  const usage = data.usage || {};

  return {
    model,
    role: options.role || 'agent',
    response: text,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
    latency: Date.now() - start,
    sessionState: [
      ...(options.sessionState || []),
      { role: 'user', content: userMessage },
      { role: 'assistant', content: text },
    ],
  };
}

export function resetRouteProbeCache() {
  routeProbeCache.clear();
}

/**
 * Non-dispatching route-readiness probe for the doctor. Distinguishes three states the
 * doctor folds into liveness — and NEVER leaks the key into a result or error:
 *   - MISSING KEY  -> status:"missing-key", staticAvailable:false  (no network call made)
 *   - ROUTE FAIL   -> status:"unreachable", staticAvailable:false  (HTTP/network error; status only, no body)
 *   - OK           -> status:"reachable",   staticAvailable:true
 * Mirrors ollama.js probeRoute's result shape + TTL cache. `options.fetch`/`options.env` injectable.
 */
export async function probeRoute(options = {}) {
  const endpoint = options.endpoint || options.baseUrl || API_URL;
  const providerKey = options.providerKey || options.provider || null;
  const providerModelString = options.model || options.providerModel || null;
  const rawTimeout = Number(options.timeoutMs ?? process.env.ILLUCI_ROUTE_PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_ROUTE_PROBE_TIMEOUT_MS;
  const cacheKey = [endpoint, providerKey || '', providerModelString || '', timeoutMs].join('');

  if (!options.noCache && routeProbeCache.has(cacheKey)) {
    const cached = routeProbeCache.get(cacheKey);
    if (Date.now() - cached.checkedAt <= ROUTE_PROBE_CACHE_TTL_MS) return JSON.parse(JSON.stringify(cached.probe));
    routeProbeCache.delete(cacheKey);
  }

  const base = (extra) => ({
    probe: 'nvidia-nim', endpoint, providerKey, providerModelString, modelListed: null, timeoutMs, ...extra,
  });
  let probe;
  const apiKey = options.apiKey || resolveNvidiaApiKey(resolveAmbientEnv(options.env));
  if (!apiKey) {
    probe = base({
      status: 'missing-key', staticAvailable: false,
      lastError: 'No NVIDIA_API_KEY / NVIDIA_NIM_API_KEY configured for the NVIDIA NIM lane.',
    });
  } else {
    try {
      const doFetch = options.fetch || fetch;
      // Cheap reachability: GET the sibling /v1/models. 200/401/403 all prove the route is up.
      const modelsUrl = endpoint.replace(/\/chat\/completions\/?$/, '/models');
      const resp = await doFetch(modelsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }, // never logged
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok || resp.status === 401 || resp.status === 403) {
        probe = base({ status: 'reachable', staticAvailable: true, lastError: null });
      } else {
        // Route failure — status only, never the response body (could echo request context).
        probe = base({ status: 'unreachable', staticAvailable: false, lastError: `NVIDIA NIM route probe HTTP ${resp.status}` });
      }
    } catch (err) {
      probe = base({ status: 'unreachable', staticAvailable: false, lastError: err?.message || 'NVIDIA NIM route probe failed' });
    }
  }

  if (!options.noCache) routeProbeCache.set(cacheKey, { checkedAt: Date.now(), probe: JSON.parse(JSON.stringify(probe)) });
  return probe;
}

export default { query, probeRoute, resolveNvidiaApiKey, hasNvidiaEnvKey, resetRouteProbeCache };
