/**
 * illuci — Model Discovery
 *
 * What models are ACTUALLY reachable, found live rather than asserted by a table.
 * A hardcoded roster can become stale. Discovery reports evidence for the
 * selected route; no one account, endpoint or probe proves global availability.
 *
 * Evidence sources, no asserted inference availability:
 *   - ollama-served models: GET {base}/api/tags provides endpoint inventory,
 *     not a successful inference or cloud entitlement.
 *   - Codex app-server and Grok Build can supply selected-profile catalogs.
 *     Catalog rows remain advertised-but-unverified and grant no execution.
 *   - other vendor CLI candidates stay account-unbound. Discovery never turns
 *     an ambient agentic invocation into an account availability probe.
 *
 * Probe results cache to disk with a TTL; `invalidate(id)` drops an entry so a
 * real dispatch 404 makes the set self-heal on the next read.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getEntry, isSuspended, listModels } from "./model-registry.js";
import { getBridgeLoader } from "./bridge-loaders.js";
import { runtimeDataPath } from "../data/paths.js";
import { classifyError } from "../dispatch/retry.js";
import * as ollama from "./ollama.js";

export const CACHE_PATH = runtimeDataPath("telemetry", "model-availability.json");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // a day; CLI availability changes slowly
const THROTTLE_TTL_MS = 2 * 60 * 1000;      // a 429 is minutes-scale, not the 24h liveness TTL
// These bridges run agentic processes. Discovery has no authenticated worker,
// account, original-attempt reservation or cessation binding for them.
const UNBOUND_AGENTIC_BRIDGES = new Set(['codex.js', 'grok-cli.js', 'claude.js', 'gemini.js', 'agy.js', 'kimi.js']);
const accountCatalogProjections = new WeakMap();
const grokCatalogProjections = new WeakMap();
export function isAccountCatalogProjection(value) {
  const binding = value && accountCatalogProjections.get(value);
  if (!binding) return false;
  try {
    const current = binding.now();
    return Number.isFinite(current) && current >= binding.observedAt && current - binding.observedAt <= binding.maxAgeMs;
  } catch { return false; }
}
export function isGrokCatalogProjection(value) {
  const binding = value && grokCatalogProjections.get(value);
  if (!binding) return false;
  try {
    const current = binding.now();
    return Number.isFinite(current) && current >= binding.observedAt && current - binding.observedAt <= binding.maxAgeMs;
  } catch { return false; }
}

// Substrings in a probe response that mean "this model is not reachable" (dropped
// from the plan, renamed, never existed). Distinct from install/network/auth
// faults, which leave availability UNKNOWN rather than asserting unavailable.
const NOT_FOUND_MARKERS = [
  "may not exist", "not found", "does not exist", "no access",
  "invalid model", "unknown model", "model not found", "not_found",
  "is not recognized", "404",
];

// ── ollama family tagging ──────────────────────────────────────────────────
// Map a live ollama tag to a illuci capability family (FAMILY_PROFILES key shape).
// `includes` not `startsWith`: community tags carry a namespace prefix
// (huihui_ai/Qwen3.6-...). Most specific match first.
export function ollamaFamily(name) {
  const n = name.toLowerCase();
  if (n.includes("deepseek")) return "deepseek";
  if (n.includes("gpt-oss")) return "gpt";
  if (n.includes("qwen")) return "qwen";
  if (n.includes("kimi")) return "kimi";
  if (n.includes("glm")) return "glm";
  if (n.includes("gemma")) return "gemma";
  if (n.includes("minimax")) return "minimax";
  return "llama";
}

/** Ollama's endpoint inventory is not proof of model execution or cloud account
 * entitlement. Cloud vs local is inferred from the returned tag. */
export async function discoverOllama(options = {}) {
  let listed;
  try {
    listed = await (options._listModels || ollama.models)({ timeoutMs: options.timeoutMs || 12000 });
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
  const models = (listed.models || []).map((m) => {
    const cloud = /(?::cloud|-cloud)$/i.test(m.name); // e.g. :cloud or :671b-cloud
    return {
      id: m.name,
      label: m.name,
      family: ollamaFamily(m.name),
      provider: cloud ? "ollama-cloud" : "ollama-local",
      bridge: "ollama.js",
      available: null,
      status: "listed-unverified",
      source: "ollama",
      localityBasis: "model-tag-only",
      actualEndpoint: "unknown",
      disclosureSuitability: "unknown",
      executionAuthority: "none",
      parameterSize: m.parameterSize || null,
    };
  });
  return { models };
}

// ── cache ───────────────────────────────────────────────────────────────────
function readCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(readFileSync(CACHE_PATH, "utf-8")); } catch { return {}; }
}
function writeCache(cache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/** Drop a model's cached availability so the next discovery re-probes it.
 *  The dispatch layer calls this on a not-found at dispatch time. */
export function invalidate(id) {
  const cache = readCache();
  if (id in cache) { delete cache[id]; writeCache(cache); }
}

// ── probe ─────────────────────────────────────────────────────────────────
export function classifyProbe(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (NOT_FOUND_MARKERS.some((m) => t.includes(m))) return "unavailable";
  return "available";
}

/** Grade a probe FAULT (a thrown error, or a returned error object passed as
 *  { message }) into a verdict. classifyProbe is a text denylist that CANNOT see
 *  an HTTP 429 — a quota error reads "available" — so faults are graded on the
 *  error object/code first:
 *    - a missing / unloadable bridge module      -> "missing"     (permanent)
 *    - 429 / rate-limit / quota / overloaded     -> "throttled"   (minutes-scale)
 *    - 401/403 -> "auth-or-access-denied", not proof a model is retired
 *    - 400/422 -> "invalid-request", not proof a model is retired
 *    - model-not-found / 404 -> "unavailable" for this particular route
 *    - anything else (a transient blip)           -> "unknown"    (non-blocking) */
export function gradeError(err, text) {
  const code = err?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ENOENT") return "missing";
  const msg = String(err?.message ?? text ?? "");
  if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg) || /quota/i.test(msg) || /overloaded/i.test(msg)) return "throttled";
  if (/\b(?:401|403)\b/.test(msg) || /unauthori[sz]ed|forbidden/i.test(msg)) return "auth-or-access-denied";
  if (/\b(?:400|422)\b/.test(msg) || /bad request/i.test(msg)) return "invalid-request";
  if (classifyError(err) === "permanent") return "unavailable";
  return classifyProbe(text) === "unavailable" ? "unavailable" : "unknown";
}

/** Probe one vendor-CLI candidate for reachability: a trivial dispatch through
 *  its bridge, classified. Never throws — a fault leaves it UNKNOWN, so a
 *  transient blip does not wrongly drop a model. */
export async function probeModel(candidate, options = {}) {
  const { id, bridge, model } = candidate;
  if (isSuspended(id) || isSuspended(model)) {
    return { id, available: false, status: "suspended", detail: "Existing model or route hold; probe not attempted" };
  }
  // An agentic invocation is an effect, not an account-specific metadata read.
  // Unbound discovery must not launch it or infer identity from its environment.
  if (UNBOUND_AGENTIC_BRIDGES.has(bridge)) {
    return { id, available: null, status: "unknown", detail: "Account and authorized agentic probe are not bound; probe not attempted" };
  }
  let status = "unknown";
  let detail = null;
  try {
    const loadBridge = getBridgeLoader(bridge);
    if (!loadBridge) return { id, available: false, status: "missing", detail: `unknown bridge ${bridge}` };
    const mod = await loadBridge();
    const fn = mod.query || mod.default?.query;
    // No query export — a PERMANENT transport fault (missing), distinct from a
    // transient blip, so the gate can HALT/reseat rather than fail-soft past it.
    if (typeof fn !== "function") return { id, available: false, status: "missing", detail: "no query()" };
    // maxTokens 16 (not 1): an HTTP bridge with maxOutputTokens=1 returns a
    // MAX_TOKENS finish with no text, which a never-empty bridge (gemini-api)
    // correctly rejects — so a 1-token probe could never confirm reachability.
    const res = await fn("ping", { model: model || id, maxTokens: 16, timeoutMs: options.timeoutMs || 30000 });
    const text = res?.response ?? res?.error ?? JSON.stringify(res ?? "");
    // A bridge that RETURNS an error object is graded by the error grader, not the
    // bare text denylist (which would read a returned 429 as "available").
    status = res?.error ? gradeError({ message: String(res.error) }, String(res.error)) : classifyProbe(text);
    detail = status === "available" ? null : String(text).slice(0, 160);
  } catch (err) {
    // Grade the ERROR OBJECT first: classifyProbe cannot see an HTTP 429 (a quota
    // error reads "available"). missing / throttled / unavailable / unknown.
    const msg = err instanceof Error ? err.message : String(err);
    status = gradeError(err, msg);
    detail = msg.slice(0, 160);
  }
  // available: true only when reachable; false for missing/throttled/unavailable;
  // null for a transient unknown (a blip never wrongly drops a model).
  return { id, available: status === "available" ? true : status === "unknown" ? null : false, status, detail };
}

/** The vendor-CLI candidates to probe: every registry model NOT served by ollama
 *  (the registry's routing/capability role). These are candidates, not an
 *  availability assertion. */
function cliCandidates() {
  return listModels()
    .filter((e) => e.bridge !== "ollama.js")
    .map((e) => ({ id: e.id, family: e.family, provider: e.provider, bridge: e.bridge, model: e.model || e.id, label: e.label || e.id }));
}

/** Project an existing owning-host account observation. This is catalog
 * evidence, not authentication, permission, or proof of successful inference. */
export async function discoverCodexAccountCatalog({ selection, readObservation, now = Date.now, maxAgeMs = 60000 } = {}) {
  const unavailable = status => ({ status, models: [], complete: false, authority: 'none', inferenceVerified: false });
  if (!selection || typeof selection.accountId !== 'string' || !selection.accountId ||
      !/^[a-f0-9]{64}$/.test(selection.subjectSha256 || '') || typeof readObservation !== 'function' ||
      typeof now !== 'function' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return unavailable('invalid-selection');
  const selected = Object.freeze({ accountId: selection.accountId, subjectSha256: selection.subjectSha256 });
  let observation;
  try { observation = structuredClone(await readObservation(selected)); }
  catch { return unavailable('observation-unavailable'); }
  if (!observation || observation.source !== 'official-codex-app-server' || observation.identityMatched !== true ||
      observation.accountId !== selected.accountId || observation.subjectSha256 !== selected.subjectSha256 ||
      !Array.isArray(observation.models) || typeof observation.modelsComplete !== 'boolean' ||
      !Number.isFinite(observation.observedAt)) return unavailable('observation-mismatch');
  let checkedAt;
  try { checkedAt = now(); } catch { return unavailable('observation-stale'); }
  if (!Number.isFinite(checkedAt) || observation.observedAt > checkedAt || checkedAt - observation.observedAt > maxAgeMs) return unavailable('observation-stale');
  if (observation.models.length > 1000) return unavailable('catalog-invalid');
  const names = new Set(), models = [];
  for (const item of observation.models) {
    if (!item || typeof item.model !== 'string' || !item.model || item.model.length > 256 || names.has(item.model) ||
        !Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.some(e => typeof e !== 'string' || !e || e.length > 256) ||
        (item.defaultReasoningEffort != null && (typeof item.defaultReasoningEffort !== 'string' || item.defaultReasoningEffort.length > 256))) return unavailable('catalog-invalid');
    names.add(item.model);
    models.push(Object.freeze({ model: item.model, supportedReasoningEfforts: Object.freeze([...item.supportedReasoningEfforts]),
      isDefault: item.isDefault === true, defaultReasoningEffort: item.defaultReasoningEffort ?? null,
      status: 'advertised-unverified', available: null }));
  }
  const projection = Object.freeze({ status: 'host-reported', source: observation.source, accountId: selected.accountId, subjectSha256: selected.subjectSha256,
    observedAt: observation.observedAt, complete: observation.modelsComplete, models: Object.freeze(models),
    authority: 'none', inferenceVerified: false });
  accountCatalogProjections.set(projection, { now, observedAt: observation.observedAt, maxAgeMs });
  return projection;
}

/** Resolve an explicit Illuci candidate through one fresh selected-account catalog.
 * The result is preparation evidence only; it grants no authority or entitlement. */
export function selectCodexAccountModel(catalog,{model,reasoning}={}) {
  const unavailable = (status, providerModel = null) => Object.freeze({ status, model: providerModel, reasoning: reasoning ?? null, authority: 'none', inferenceVerified: false });
  if (!isAccountCatalogProjection(catalog)) return unavailable('catalog-unavailable');
  if (typeof model !== 'string' || !model || typeof reasoning !== 'string' || !reasoning) return unavailable('selection-invalid');
  const entry = getEntry(model);
  const providerModel = entry?.bridge === 'codex.js' && entry?.provider === 'openai' ? entry.model : model;
  if (typeof providerModel !== 'string' || !providerModel) return unavailable('selection-invalid');
  const observed = catalog.models.find(item => item.model === providerModel);
  if (!observed) return unavailable(catalog.complete ? 'model-not-advertised' : 'model-unobserved-partial-catalog', providerModel);
  if (!observed.supportedReasoningEfforts.includes(reasoning)) return unavailable('reasoning-not-advertised', providerModel);
  return Object.freeze({ status: 'advertised-unverified', source: catalog.source, accountId: catalog.accountId,
    subjectSha256: catalog.subjectSha256, observedAt: catalog.observedAt, complete: catalog.complete,
    model: providerModel, reasoning, isDefault: observed.isDefault, defaultReasoningEffort: observed.defaultReasoningEffort,
    authority: 'none', inferenceVerified: false });
}

/** Project one selected Grok profile's official CLI catalog observation. Cached
 * names from an unauthenticated or failed refresh never become account models. */
export async function discoverGrokAccountCatalog({ selection, readObservation, now = Date.now, maxAgeMs = 60000 } = {}) {
  const unavailable = (status, cachedCandidates = []) => Object.freeze({ status, source: 'official-grok-build-cli',
    models: Object.freeze([]), cachedCandidates: Object.freeze(cachedCandidates), complete: false,
    authority: 'none', inferenceVerified: false });
  if (!selection || typeof selection.profileId !== 'string' || !selection.profileId ||
      !/^[a-f0-9]{64}$/.test(selection.profileHomeSha256 || '') || typeof readObservation !== 'function' ||
      typeof now !== 'function' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return unavailable('invalid-selection');
  const selected = Object.freeze({ profileId: selection.profileId, profileHomeSha256: selection.profileHomeSha256 });
  let observation;
  try { observation = structuredClone(await readObservation(selected)); }
  catch { return unavailable('observation-unavailable'); }
  if (!observation || observation.source !== 'official-grok-build-cli' ||
      observation.profileBindingMatched !== true || observation.profileId !== selected.profileId ||
      observation.profileHomeSha256 !== selected.profileHomeSha256 || !Number.isFinite(observation.observedAt) ||
      !Array.isArray(observation.models) || !Array.isArray(observation.cachedCandidates) ||
      typeof observation.complete !== 'boolean') return unavailable('observation-mismatch');
  let checkedAt;
  try { checkedAt = now(); } catch { return unavailable('observation-stale'); }
  if (!Number.isFinite(checkedAt) || observation.observedAt > checkedAt ||
      checkedAt - observation.observedAt > maxAgeMs) return unavailable('observation-stale');
  const validNames = names => names.length <= 1000 && names.every(name =>
    typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(name)) && new Set(names).size === names.length;
  if (!validNames(observation.models) || !validNames(observation.cachedCandidates)) return unavailable('catalog-invalid');
  if (observation.status !== 'catalog-reported' || observation.authenticated !== true || observation.complete !== true) {
    const status = observation.status === 'unauthenticated' ? 'unauthenticated' : 'catalog-unavailable';
    const projection = Object.freeze({ status, source: observation.source, profileId: selected.profileId,
      profileHomeSha256: selected.profileHomeSha256, observedAt: observation.observedAt, complete: false,
      models: Object.freeze([]), cachedCandidates: Object.freeze([...observation.cachedCandidates]),
      accountIdentityVerified: observation.accountIdentityVerified === true, authority: 'none', inferenceVerified: false });
    grokCatalogProjections.set(projection, { now, observedAt: observation.observedAt, maxAgeMs });
    return projection;
  }
  const projection = Object.freeze({ status: 'host-reported', source: observation.source,
    profileId: selected.profileId, profileHomeSha256: selected.profileHomeSha256,
    observedAt: observation.observedAt, complete: true,
    models: Object.freeze(observation.models.map(model => Object.freeze({ model, status: 'advertised-unverified', available: null }))),
    cachedCandidates: Object.freeze([]), accountIdentityVerified: observation.accountIdentityVerified === true,
    authority: 'none', inferenceVerified: false });
  grokCatalogProjections.set(projection, { now, observedAt: observation.observedAt, maxAgeMs });
  return projection;
}

/** Resolve one Grok registry candidate through a fresh selected-profile catalog. */
export function selectGrokAccountModel(catalog, { model } = {}) {
  const unavailable = (status, providerModel = null) => Object.freeze({ status, model: providerModel,
    authority: 'none', inferenceVerified: false });
  if (!isGrokCatalogProjection(catalog)) return unavailable('catalog-unavailable');
  if (catalog.status === 'unauthenticated') return unavailable('unauthenticated');
  if (catalog.status !== 'host-reported') return unavailable('catalog-unavailable');
  if (typeof model !== 'string' || !model) return unavailable('selection-invalid');
  const entry = getEntry(model);
  const providerModel = entry?.bridge === 'grok-cli.js' && entry?.provider === 'xai-cli' ? entry.model : model;
  if (typeof providerModel !== 'string' || !providerModel) return unavailable('selection-invalid');
  const observed = catalog.models.find(item => item.model === providerModel);
  if (!observed) return unavailable(catalog.complete ? 'model-not-advertised' : 'model-unobserved-partial-catalog', providerModel);
  return Object.freeze({ status: 'advertised-unverified', source: catalog.source, profileId: catalog.profileId,
    profileHomeSha256: catalog.profileHomeSha256, observedAt: catalog.observedAt, complete: catalog.complete,
    model: providerModel, accountIdentityVerified: catalog.accountIdentityVerified,
    authority: 'none', inferenceVerified: false });
}

/**
 * The observed model set. Ollama entries are listed but unverified; other candidates carry
 * their cached availability, or are freshly probed when `probe` is true and the
 * cache is missing/stale.
 *
 * @returns {Promise<{ models: Array, ollamaError?: string }>}
 */
export async function discoverModels({ probe = false, ttlMs = DEFAULT_TTL_MS, accountCatalog = null,
  grokCatalog = null, includeOllama = true, _ollamaDiscovery = discoverOllama } = {}) {
  if (typeof includeOllama !== 'boolean') throw TypeError('includeOllama must be boolean');
  if ((accountCatalog !== null || grokCatalog !== null) && probe) throw TypeError('Account catalog cannot be combined with ambient provider probes');
  const ollamaResult = includeOllama ? await _ollamaDiscovery() : { models: [] };
  const codexAccountCatalog = accountCatalog === null ? null : await discoverCodexAccountCatalog(accountCatalog);
  const grokAccountCatalog = grokCatalog === null ? null : await discoverGrokAccountCatalog(grokCatalog);
  const cache = readCache();
  const now = Date.now();

  const cli = [];
  for (const c of cliCandidates()) {
    let entry = cache[c.id];
    if (isSuspended(c.id) || isSuspended(c.model)) {
      cli.push({ ...c, source: "registry-hold", available: false, status: "suspended", checkedAt: null });
      continue;
    }
    if (c.bridge === 'grok-cli.js' && grokAccountCatalog) {
      const selected = selectGrokAccountModel(grokAccountCatalog, { model: c.id });
      cli.push({ ...c, source: grokAccountCatalog.source, available: null,
        status: selected.status, checkedAt: grokAccountCatalog.observedAt });
      continue;
    }
    if (UNBOUND_AGENTIC_BRIDGES.has(c.bridge)) {
      // Old cache rows have neither account nor attempt provenance. Never use
      // an ambient account's historical result as the selected account's fact.
      cli.push({ ...c, source: "account-unbound", available: null, status: "unknown", checkedAt: null });
      continue;
    }
    // A 429 is a minutes-scale condition, not the 24h liveness TTL — re-probe a
    // throttled entry far sooner so a momentary 429 doesn't pin a model dead all day.
    const entryTtl = entry?.status === "throttled" ? THROTTLE_TTL_MS : ttlMs;
    const stale = !entry || (now - (entry.checkedAt || 0)) > entryTtl;
    if (probe && stale) {
      const p = await probeModel(c);
      entry = { available: p.available, status: p.status, checkedAt: now, ...(p.detail ? { detail: p.detail } : {}) };
      cache[c.id] = entry;
    }
    cli.push({
      ...c,
      source: "cli-probe",
      available: entry?.available ?? null,        // null = not yet probed
      status: entry?.status ?? "unprobed",
      checkedAt: entry?.checkedAt ?? null,
    });
  }
  if (probe) writeCache(cache);

  return {
    models: [...ollamaResult.models, ...cli],
    ...(codexAccountCatalog ? { codexAccountCatalog } : {}),
    ...(grokAccountCatalog ? { grokAccountCatalog } : {}),
    ...(ollamaResult.error ? { ollamaError: ollamaResult.error } : {}),
  };
}

export default { discoverModels, discoverOllama, probeModel, invalidate, CACHE_PATH,
  discoverCodexAccountCatalog, selectCodexAccountModel, discoverGrokAccountCatalog, selectGrokAccountModel };
