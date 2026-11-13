/**
 * illuci — Gemini API Bridge (Google Direct, HTTP)
 *
 * The canonical `transport: "api"` path for the Gemini family. Sibling to the
 * CLI bridge `gemini.js` (transport: "local"), exactly as grok-api.js sibling
 * grok-cli.js. No CLI process, no OAuth subscription session, no agent loop:
 * one governed HTTP completion that slots into the same request/parse/verify
 * pipeline as every other vendor.
 *
 * Auth is AUTO-DETECTED, following Google's own GOOGLE_GENAI_USE_VERTEXAI
 * convention so behaviour is predictable across personal and enterprise runs:
 *   - Vertex AI  (aiplatform.googleapis.com, OAuth bearer from ADC) when
 *     GOOGLE_GENAI_USE_VERTEXAI=true OR a Vertex project is configured and no
 *     Developer key is present.
 *   - Developer API (generativelanguage.googleapis.com, x-goog-api-key) when a
 *     GEMINI_API_KEY / GOOGLE_API_KEY is present.
 *   - Otherwise it throws LOUDLY — it never silently succeeds with an empty
 *     payload (the exact agy failure mode this bridge exists to avoid).
 *
 * The wire shape is identical for both surfaces (research-confirmed); only host
 * and auth header differ.
 */

import { execFileSync } from "child_process";
import { normalizeDial, toGeminiThinking } from "../reasoning/dial.js";
import { isMultimodalEnabled, normalizeImages } from "./multimodal.js";
import { resolveAmbientEnv } from "../connections/tenant-context.js";
import { createTraceExposure } from './trace-exposure.js';

const GENLANG_HOST = process.env.GEMINI_API_HOST || "https://generativelanguage.googleapis.com";
const GENLANG_VERSION = process.env.GEMINI_API_VERSION || "v1beta";
// Own env var (NOT the CLI bridge's GEMINI_BRIDGE_MODEL) so an operator override
// for one transport never silently rewrites the other's default.
const DEFAULT_MODEL = process.env.GEMINI_API_BRIDGE_MODEL || "gemini-3.5-flash";

/**
 * Decide which surface + credential to use. Throws loudly when nothing is
 * configured — a missing credential is a hard, visible failure, never a
 * silent empty response.
 */
export function detectAuth(env = resolveAmbientEnv()) { // [A22.5] ambient-tenant-aware default (=== process.env outside a tenant context)
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null;
  const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID || null;
  // Follow Google's GOOGLE_GENAI_USE_VERTEXAI convention, normalized for case +
  // whitespace: an explicit true/1 forces Vertex; an explicit false/0 forces the
  // Developer API and is never silently overridden by a stray project var.
  const flag = String(env.GOOGLE_GENAI_USE_VERTEXAI ?? "").trim().toLowerCase();
  const explicitVertex = flag === "true" || flag === "1";
  const explicitDeveloper = flag === "false" || flag === "0";
  // Vertex when explicitly requested, or — absent an explicit Developer choice
  // and a Developer key — when a Vertex project / ADC is configured.
  const useVertex = explicitVertex || (!explicitDeveloper && !key && (project || env.GOOGLE_APPLICATION_CREDENTIALS));

  if (useVertex) {
    if (!project) {
      throw new Error(
        "gemini-api: Vertex selected but GOOGLE_CLOUD_PROJECT is not set. " +
        "Set GOOGLE_CLOUD_PROJECT (+ run `gcloud auth application-default login`), " +
        "or set GEMINI_API_KEY to use the AI Studio Developer API instead."
      );
    }
    const location = env.GOOGLE_CLOUD_LOCATION || env.VERTEX_LOCATION || "global";
    return { mode: "vertex", project, location };
  }

  if (key) return { mode: "developer", key };

  throw new Error(
    "gemini-api: no Gemini credential found. Set GEMINI_API_KEY (AI Studio, " +
    "x-goog-api-key), or configure Vertex (GOOGLE_CLOUD_PROJECT + " +
    "`gcloud auth application-default login`, with GOOGLE_GENAI_USE_VERTEXAI=true)."
  );
}

/** Mint a short-lived ADC bearer for Vertex. Dependency-free: shells gcloud,
 *  which the Vertex path already implies is installed/authed. Overridable for
 *  tests via options.accessToken. */
export function mintVertexToken() {
  try {
    return execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf-8",
      timeout: 20000,
    }).trim();
  } catch (e) {
    throw new Error(
      "gemini-api: failed to mint a Vertex ADC access token via `gcloud auth " +
      "application-default print-access-token`. Ensure gcloud is installed and " +
      `ADC is configured. Underlying: ${(e && e.message ? e.message : String(e)).substring(0, 200)}`
    );
  }
}

/** Build the {url, headers} for a generateContent call given the resolved auth. */
function buildRequest(auth, model, options, stream = false) {
  // The streaming RPC is a distinct method + the SSE transport flag.
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  if (auth.mode === "vertex") {
    const host = auth.location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${auth.location}-aiplatform.googleapis.com`;
    const url = `${host}/v1/projects/${auth.project}/locations/${auth.location}` +
      `/publishers/google/models/${model}:${method}`;
    const token = options.accessToken || mintVertexToken();
    return { url, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } };
  }
  // developer
  const url = `${GENLANG_HOST}/${GENLANG_VERSION}/models/${model}:${method}`;
  return { url, headers: { "Content-Type": "application/json", "x-goog-api-key": auth.key } };
}

/** Map the bridge's option bag + prior turns into a Gemini request body. */
function buildBody(userMessage, options, model) {
  const contents = [];
  if (options.sessionState && Array.isArray(options.sessionState)) {
    for (const m of options.sessionState) {
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
    }
  }
  // Current user turn. DARK multimodal: when ILLUCI_MULTIMODAL_ENABLED and images are
  // supplied, append Gemini inline_data parts (mime_type + base64) after the text.
  // Flag off or no images -> a single text part, byte-identical to the prior path.
  const userParts = [{ text: userMessage }];
  if (isMultimodalEnabled() && Array.isArray(options.images) && options.images.length) {
    for (const img of normalizeImages(options.images)) {
      userParts.push({ inline_data: { mime_type: img.mediaType, data: img.base64 } });
    }
  }
  contents.push({ role: "user", parts: userParts });

  const body = { contents };
  if (options.systemPrompt) {
    body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
  }
  const generationConfig = {};
  if (options.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
  if (typeof options.temperature === "number") generationConfig.temperature = options.temperature;
  // Read the live universal dial. Documented newer models take thinking levels;
  // historical models retain their existing budget behavior. An explicit boolean
  // thinking option takes precedence, and an unset control is omitted.
  // These exact documented models use levels rather than the 2.5 budget API.
  // Preserve unrecognized model behavior until its capabilities are established.
  const levels = {
    "gemini-3.8-flash": ["low", "medium", "high"],
    "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
    "gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
    "gemini-3.1-flash-lite": ["minimal", "low", "medium", "high"],
    "gemini-4-argon": ["low", "medium", "high"],
  }[model];
  if (levels) {
    const dial = normalizeDial(options.reasoning);
    if (options.thinking === false || (options.thinking !== true && dial === "off")) {
      throw new Error(`gemini-api: ${model} does not support disabling thinking`);
    }
    if (options.thinking !== true && dial && dial !== "off") {
      const ordered = ["minimal", "low", "medium", "high"];
      const wanted = ["xhigh", "max"].includes(dial) ? "high" : dial;
      const index = ordered.indexOf(wanted);
      const selected = levels.find(level => ordered.indexOf(level) >= index) || levels.at(-1);
      generationConfig.thinkingConfig = { thinkingLevel: selected };
    }
  } else {
    const thinking = typeof options.thinking === "boolean"
      ? options.thinking : toGeminiThinking(options.reasoning);
    if (thinking === false && /^gemini-2\.5-pro(?:-|$)/.test(model)) {
      throw new Error(`gemini-api: ${model} does not support disabling thinking`);
    }
    if (thinking === false) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    else if (thinking === true) generationConfig.thinkingConfig = { thinkingBudget: -1 };
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

/** Extract the answer text, asserting a non-empty completion. Throws loudly on
 *  any non-answer outcome (blocked prompt, empty candidates, no text, a
 *  finishReason that produced no content) — this bridge must never return an
 *  empty success. */
function extractResponse(data, model) {
  // A 200 with a null / non-object body is an empty success, not an answer.
  if (!data || typeof data !== "object") {
    throw new Error(`gemini-api: ${model} returned a non-object body (empty success) — refusing to report empty.`);
  }
  // Prompt-level block (no candidates at all).
  if (data.promptFeedback?.blockReason) {
    throw new Error(`gemini-api: prompt blocked (${data.promptFeedback.blockReason}) for ${model}`);
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    throw new Error(`gemini-api: ${model} returned no candidates (empty success) — refusing to report empty.`);
  }
  const parts = cand.content?.parts;
  const text = Array.isArray(parts)
    ? parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim()
    : "";
  if (!text) {
    const reason = cand.finishReason || "UNKNOWN";
    throw new Error(`gemini-api: ${model} produced no text (finishReason=${reason}) — refusing to report empty.`);
  }
  // Non-empty text but an abnormal terminal reason is a filtered/aborted
  // answer, not a completion. STOP = clean; MAX_TOKENS = a real (if truncated)
  // answer we keep; anything else (SAFETY, RECITATION, BLOCKLIST,
  // PROHIBITED_CONTENT, SPII, MALFORMED_FUNCTION_CALL, ...) is a non-answer we
  // refuse to pass off as success — the misleading-success half of the invariant.
  const reason = cand.finishReason;
  if (reason && reason !== "STOP" && reason !== "MAX_TOKENS") {
    throw new Error(`gemini-api: ${model} terminated abnormally (finishReason=${reason}) — refusing to report a filtered/partial answer as success.`);
  }
  return text;
}

export async function query(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.gemini-api');
  const start = Date.now();
  const model = options.model || DEFAULT_MODEL;
  const auth = detectAuth(resolveAmbientEnv(options.env)); // [A22.5] tenant-context-aware
  const { url, headers } = buildRequest(auth, model, options);
  const body = buildBody(userMessage, options, model);

  const doFetch = options.fetch || fetch;
  const response = await doFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = "";
    try { detail = await trace.text(response); } catch {}
    throw new Error(`gemini-api ${response.status} (${auth.mode}, ${model}): ${detail.substring(0, 400)}`);
  }

  let data;
  try {
    data = await trace.json(response); await trace.finish();
  } catch (e) {
    throw new Error(
      `gemini-api: ${model} (${auth.mode}) returned a ${response.status} with an unparseable body — ` +
      `${(e && e.message ? e.message : String(e)).substring(0, 200)}`
    );
  }
  const responseText = extractResponse(data, model);
  const latency = Date.now() - start;

  const um = data.usageMetadata || {};
  const usage = {
    prompt_tokens: um.promptTokenCount || 0,
    completion_tokens: um.candidatesTokenCount || 0,
    total_tokens: um.totalTokenCount || ((um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)),
  };

  const priorMessages = options.sessionState || [];
  const sessionState = [
    ...priorMessages,
    { role: "user", content: userMessage },
    { role: "assistant", content: responseText },
  ];

  return {
    model,                                    // the stable registry id (matches the CLI sibling + roster)
    modelVersion: data.modelVersion || null,  // the exact served version, observability only (non-contract)
    role: options.role || "agent",
    response: responseText,
    usage,
    latency,
    sessionState,
  };
}

/**
 * Streaming sibling of query(). Calls `:streamGenerateContent?alt=sse` and parses the
 * Gemini SSE shape (`data: {candidates:[{content:{parts:[{text, thought?}]}}]}`), yielding
 * { type: "delta", text, reasoning } per chunk and one terminal { type: "final", ... }.
 * Honors the bridge's no-empty-success invariant (an abnormal finishReason with no text
 * throws). options.signal aborts the fetch; options.fetch is injectable for tests.
 */
export async function* queryStream(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.gemini-api');
  const start = Date.now();
  const model = options.model || DEFAULT_MODEL;
  const auth = detectAuth(resolveAmbientEnv(options.env)); // [A22.5] tenant-context-aware
  const { url, headers } = buildRequest(auth, model, options, true);
  const body = buildBody(userMessage, options, model);

  const doFetch = options.fetch || fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs || 120000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });

  if (!response.ok) {
    let detail = "";
    try { detail = await trace.text(response); } catch {}
    throw new Error(`gemini-api ${response.status} (${auth.mode}, ${model}): ${detail.substring(0, 400)}`);
  }
  if (!response.body) throw new Error(`gemini-api: ${model} response body is not streamable`);

  let answer = "";
  let reasoning = "";
  let usage = {};
  let lastFinishReason = null;
  for await (const rawLine of trace.lines(response.body)) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let json;
      try { json = JSON.parse(data); } catch {
        await trace.failure('provider-event-parse-failed');
        throw Object.assign(new Error(`gemini-api: ${model} stream contained an invalid event`), { outcome: 'unknown', retrySafe: false });
      }
      if (json.promptFeedback?.blockReason) {
        throw Object.assign(new Error(`gemini-api: prompt blocked (${json.promptFeedback.blockReason}) for ${model}`), { retrySafe: false });
      }
      const cand = json.candidates?.[0];
      if (cand) {
        if (cand.finishReason) lastFinishReason = cand.finishReason;
        const parts = cand.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            const t = p.text || "";
            if (!t) continue;
            if (p.thought) { reasoning += t; yield { type: "delta", text: t, reasoning: true }; }
            else { answer += t; yield { type: "delta", text: t, reasoning: false }; }
          }
        }
      }
      if (json.usageMetadata) {
        const um = json.usageMetadata;
        usage = {
          prompt_tokens: um.promptTokenCount || 0,
          completion_tokens: um.candidatesTokenCount || 0,
          total_tokens: um.totalTokenCount || ((um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)),
        };
      }
  }

  if (lastFinishReason && lastFinishReason !== "STOP" && lastFinishReason !== "MAX_TOKENS") {
    throw Object.assign(new Error(`gemini-api: ${model} stream terminated abnormally (finishReason=${lastFinishReason}).`), { retrySafe: false });
  }
  if (!lastFinishReason) {
    throw Object.assign(new Error(`gemini-api: ${model} stream ended without a finish reason`), { outcome: 'unknown', retrySafe: false });
  }
  const text = answer;
  if (!text.trim()) {
    throw Object.assign(new Error(`gemini-api: ${model} stream contained no assistant answer`), { retrySafe: false });
  }
  yield {
    type: "final",
    model,
    role: options.role || "agent",
    response: text,
    ...(reasoning ? { reasoning } : {}),
    usage,
    latency: Date.now() - start,
    sessionState: [
      ...(options.sessionState || []),
      { role: "user", content: userMessage },
      { role: "assistant", content: text },
    ],
  };
}

export default { query, queryStream, detectAuth, mintVertexToken };
