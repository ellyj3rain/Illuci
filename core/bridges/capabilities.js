/**
 * illuci — Model Capability Spine
 *
 * Single source of truth for what each model family and sub-model can actually
 * do, so dispatch and consumer UIs (OTL) stop guessing. The core-loop audit
 * found reasoning tiers were cosmetic and sub-models / speed tiers / streaming /
 * native-tool support were unmodeled; this is the model.
 *
 * Three layers, merged by getCapabilities(modelId):
 *   1. FAMILY_PROFILES[family]  — the family's baseline (streaming, native
 *      tools, context window, reasoning tier set, speed tier set, sub-model
 *      roster). A "sub-model" is a selectable variant within the family that a
 *      UI can toggle (e.g. Claude → Fable 5 / Opus 4.8 / Sonnet 4.6 / Haiku 4.5).
 *   2. MODEL_DEFAULTS[modelId]  — dispatch-time options (model string, provider,
 *      reasoning default, adaptive tier timeouts). Imported, not duplicated.
 *   3. MODEL_CAPABILITY_OVERRIDES[modelId] — per-id corrections (e.g. a fast
 *      speed-tier variant, a low-reasoning lite model).
 *
 * "Tiers" here are real: a reasoning/speed tier only appears if the bridge can
 * actually act on it (grok --effort, codex reasoning tiers, gemini thinking,
 * ollama-cloud think). A flat `reasoning: "high"` default in MODEL_DEFAULTS is
 * the chosen tier; the tier SET lives here.
 */

import { buildModelDefaults, listModels, listModelIds, resolveModelId, getEntry, NVIDIA_NIM_MANIFEST } from "./model-registry.js";

// Derived view of dispatch defaults (canonical ids); alias spellings
// canonicalize via resolveModelId before any table lookup.
const MODEL_DEFAULTS = buildModelDefaults();

// Claude family sub-models, DERIVED from the model registry (the single
// source of truth) - id/label/model/tier/cliAlias live there, once.
export const CLAUDE_SUBMODELS = listModels()
  .filter((e) => e.family === "claude" && e.id !== "claude-api")
  .map(({ id, label, model, tier, cliAlias }) => ({ id, label, model, tier, ...(cliAlias ? { cliAlias } : {}) }));

// Grok Build candidates are also registry-derived. Account catalogs decide which
// rows are currently advertised; this roster preserves explicit current and
// historical identities without duplicating provider strings here.
export const GROK_SUBMODELS = listModels()
  .filter((e) => e.family === "grok" && e.bridge === "grok-cli.js")
  .map(({ id, label, model, tier }) => ({
    id,
    label: label || id,
    model,
    tier: tier || "legacy",
    reasoning: id !== "grok-composer-2.5-fast",
  }));

/**
 * Family baselines. `reasoning.tiers` / `speed.tiers` are ordered
 * strongest→fastest. `default` names the shipped choice. `supported:false`
 * means the family exposes no such control (the UI shows it disabled/absent).
 */
export const FAMILY_PROFILES = {
  claude: {
    label: "Claude",
    streaming: true,
    nativeTools: true,
    contextWindow: 200000,
    // Claude's "reasoning tier" is expressed as sub-model choice + (for the API
    // path) a thinking budget; the CLI path selects via --model.
    reasoning: { supported: true, tiers: ["frontier", "balanced", "fast"], default: "frontier", control: "submodel" },
    speed: { supported: true, tiers: ["quality", "fast"], default: "quality", control: "submodel" },
    subModels: CLAUDE_SUBMODELS,
    // ultra-effort surface: Fable 5 in Claude Code has a "fast mode" (Opus with
    // faster output) toggled by the harness, not a dispatch flag — modeled as a
    // capability flag a consumer can surface, not a illuci dispatch parameter.
    ultra: { available: true, label: "Fast mode (Opus 4.8/4.7/4.6)", note: "Claude Code /fast; harness-side, not a dispatch flag" },
  },
  grok: {
    label: "Grok",
    streaming: false,
    nativeTools: true,
    contextWindow: 256000,
    reasoning: { supported: true, tiers: ["xhigh", "high", "medium", "low"], default: "high", control: "reasoning-effort" },
    speed: { supported: true, tiers: ["quality", "fast"], default: "quality", control: "submodel" },
    subModels: GROK_SUBMODELS,
    ultra: { available: true, label: "xhigh effort", note: "grok --reasoning-effort xhigh" },
  },
  gemini: {
    label: "Gemini",
    streaming: false,
    nativeTools: true,
    contextWindow: 1000000,
    reasoning: { supported: true, tiers: ["high", "low"], default: "high", control: "thinking" },
    speed: { supported: true, tiers: ["pro", "flash", "flash-lite"], default: "pro", control: "submodel" },
    subModels: [
      { id: "gemini-3.1-pro",        label: "3.1 Pro",        model: "gemini-3.1-pro",        tier: "pro",        reasoning: "high" },
      { id: "gemini-3.5-flash",      label: "3.5 Flash",      model: "gemini-3.5-flash",      tier: "flash",      reasoning: "high" },
      { id: "gemini-3.1-flash-lite", label: "3.1 Flash-Lite", model: "gemini-3.1-flash-lite", tier: "flash-lite", reasoning: "low" },
    ],
    ultra: { available: false },
  },
  // Ollama-hosted upper-tier cloud OSS models. Native tool-calling exists on
  // the bridge; reasoning "think" is supported by the cloud models that ship it.
  "ollama-cloud": {
    label: "Ollama Cloud (OSS)",
    streaming: true,
    nativeTools: true,
    contextWindow: 128000,
    reasoning: { supported: true, tiers: ["high", "medium", "low"], default: "high", control: "think" },
    speed: { supported: false },
    subModels: [
      { id: "deepseek",   label: "DeepSeek V4 Pro", model: "deepseek-v4-pro:cloud",   reasoning: "high" },
      { id: "glm",        label: "GLM-5.2",         model: "glm-5.2:cloud",           reasoning: "high" },
      { id: "kimi-cloud", label: "Kimi K2.7 Code",  model: "kimi-k2.7-code:cloud",    reasoning: "high" },
      { id: "qwen-code",  label: "Qwen3 Coder 480B", model: "qwen3-coder:480b-cloud", reasoning: "high" },
      { id: "minimax",    label: "MiniMax M3",      model: "minimax-m3:cloud",        reasoning: "high" },
      { id: "qwen3.5",    label: "Qwen3.5 397B",    model: "qwen3.5:397b-cloud",      reasoning: "high" },
      { id: "gemma4",     label: "Gemma4 31B",      model: "gemma4:31b-cloud",        reasoning: "high" },
    ],
    ultra: { available: false },
  },
  "ollama-local": {
    label: "Ollama Local",
    streaming: true,
    nativeTools: true,
    contextWindow: 32000,
    reasoning: { supported: false },
    speed: { supported: false },
    subModels: [{ id: "ollama", label: "Qwen36 Abliterated 35B", model: "qwen36-abl:fast" }],
    ultra: { available: false },
  },
  gpt: {
    label: "GPT (Codex)",
    streaming: false,
    nativeTools: true,
    contextWindow: 256000,
    reasoning: { supported: true, tiers: ["xhigh", "high", "medium"], default: "xhigh", control: "effort" },
    speed: { supported: false },
    subModels: [
      { id: "gpt-oss", label: "GPT-OSS 120B", model: "GPT-OSS 120B (Medium)", reasoning: "high" },
      { id: "codex-local", label: "Codex", model: "codex" },
    ],
    ultra: { available: true, label: "xhigh effort" },
  },
  kimi: {
    label: "Kimi (Moonshot)",
    streaming: false,
    nativeTools: false,
    contextWindow: 256000,
    reasoning: { supported: true, tiers: ["high", "low"], default: "high", control: "effort" },
    speed: { supported: false },
    subModels: [{ id: "kimi-local", label: "Kimi (CLI)", model: "kimi-local" }],
    ultra: { available: false },
  },
  // NVIDIA NIM: one OpenAI-compatible HTTP endpoint, many models. Streaming-capable;
  // this raw chat-completions path exposes no native tool-calling. reasoning_effort is
  // the dial (control "effort"), gated off instruct-only families by the bridge. A few
  // representative sub-models DERIVED from NVIDIA_NIM_MANIFEST (the single source).
  "nvidia-nim": {
    label: "NVIDIA NIM",
    streaming: true,
    nativeTools: false,
    contextWindow: 128000,
    reasoning: { supported: true, tiers: ["high", "low"], default: "high", control: "effort" },
    speed: { supported: false },
    subModels: NVIDIA_NIM_MANIFEST
      .filter((m) => ["nim-deepseek-v4-pro", "nim-nemotron-3-ultra", "nim-mistral-large-3", "nim-llama-3.2-90b-vision"].includes(m.id))
      .map((m) => ({ id: m.id, label: m.label, model: m.model, reasoning: m.reasoning })),
    ultra: { available: false },
  },
};

// Per-model corrections layered over the family profile.
export const MODEL_CAPABILITY_OVERRIDES = {
  "grok-build-fast": { speedTier: "fast" },
  "grok-build-4.5": { reasoning: { supported: true, tiers: ["high", "medium", "low"], default: "high", control: "reasoning-effort" } },
  "grok-composer-2.5-fast": { reasoning: { supported: false }, speedTier: "fast" },
  "gemini-3.1-flash-lite": { reasoningDefault: "low", speedTier: "flash-lite" },
  "claude-haiku": { speedTier: "fast", reasoningDefault: "fast" },
  // The agnostic Anthropic API path: streaming-clean, per-token billed.
  "claude-api": { streaming: true, billing: "api" },
};

/**
 * The Claude family resolves family capabilities from the registry entry. Provider
 * routing stays diagnostic: claude-opus now defaults through Antigravity, legacy
 * claude-fable/local routes through the Anthropic CLI, and claude-api remains
 * the per-token Anthropic API path.
 */
function familyOf(modelId) {
  // The registry entry is the single source of family identity. getEntry resolves
  // any spelling (canonical id, cliAlias, alias, provider model string) to its
  // entry, so the prior prefix-sniff fallback (modelId.startsWith("claude"|…)) is
  // gone — every claude/gemini/grok sub-model id and every alias gets its family
  // from the entry, not from a string heuristic that could miscategorize.
  const entry = getEntry(resolveModelId(modelId) ?? modelId);
  const family = entry?.family;
  if (!family) return null;
  // Ollama cloud vs local is a provider distinction the family profile keys on
  // (the family profiles are "ollama-cloud" / "ollama-local", not the model's
  // own family like "deepseek"); honor the provider when it names a profile.
  if (entry.provider && FAMILY_PROFILES[entry.provider]) return entry.provider;
  if (FAMILY_PROFILES[family]) return family;
  return family;
}

/**
 * Compute a full capability descriptor for a model id from the live tables:
 * family baseline + dispatch defaults + per-id overrides, flattened for a
 * consumer to render and for dispatch to consult. Never throws — unknown ids
 * return a minimal descriptor.
 *
 * NOTE: the returned object aliases live FAMILY_PROFILES sub-objects by
 * reference (reasoning.tiers, subModels point INTO FAMILY_PROFILES). Callers
 * that retain the result long-term must clone first — see SEEDED_CAPABILITIES.
 */
export function computeCapabilities(modelId) {
  const canonicalId = resolveModelId(modelId) ?? modelId;
  const family = familyOf(canonicalId);
  const profile = family ? FAMILY_PROFILES[family] : null;
  const defaults = MODEL_DEFAULTS[canonicalId] || {};
  const overrides = MODEL_CAPABILITY_OVERRIDES[canonicalId] || {};

  if (!profile) {
    return {
      modelId, family: family || "unknown", known: false,
      streaming: false, nativeTools: false, contextWindow: null,
      reasoning: { supported: false }, speed: { supported: false },
      subModels: [], provider: defaults.provider || null,
    };
  }

  const reasoning = overrides.reasoning || profile.reasoning;
  const reasoningDefault = overrides.reasoningDefault || defaults.reasoning || reasoning?.default || null;

  return {
    modelId,
    family,
    label: profile.label,
    known: true,
    provider: defaults.provider || null,
    model: defaults.model || null,
    streaming: overrides.streaming ?? profile.streaming,
    nativeTools: profile.nativeTools,
    contextWindow: profile.contextWindow,
    reasoning: reasoning?.supported
      ? { supported: true, tiers: reasoning.tiers, default: reasoningDefault, control: reasoning.control }
      : { supported: false },
    speed: profile.speed?.supported
      ? { supported: true, tiers: profile.speed.tiers, default: overrides.speedTier || profile.speed.default, control: profile.speed.control }
      : { supported: false },
    subModels: profile.subModels || [],
    ultra: profile.ultra || { available: false },
    billing: overrides.billing || (defaults.provider === "ollama-local" ? "local" : "subscription"),
    adaptive: defaults.adaptive || null,
  };
}

/**
 * Public capability accessor. Returns the SEEDED (deep-frozen, drift-free)
 * descriptor for any known model, with `.modelId` stamped to the RAW requested
 * spelling (byte-identical with the legacy behavior, which stamped `modelId`
 * verbatim regardless of canonicalization). Unknown ids fall through to a fresh
 * computeCapabilities — the minimal safe descriptor — which already stamps the
 * raw spelling. Never throws.
 *
 * The returned object is a shallow copy of the frozen seed, so callers may
 * overwrite top-level fields (as we do for `.modelId`) without mutating the
 * canonical seed; nested objects remain shared frozen instances.
 */
export function getCapabilities(modelId) {
  const canonicalId = resolveModelId(modelId) ?? modelId;
  const seeded = SEEDED_CAPABILITIES[canonicalId];
  if (seeded) return { ...seeded, modelId };
  return computeCapabilities(modelId);
}

/**
 * Resolve a requested reasoning tier against what the model supports.
 * Returns the requested tier if valid, else the model's default, else null.
 */
export function resolveReasoningTier(modelId, requested) {
  const cap = getCapabilities(modelId);
  if (!cap.reasoning?.supported) return null;
  if (requested && cap.reasoning.tiers?.includes(requested)) return requested;
  return cap.reasoning.default || null;
}

/** Resolve a requested speed tier against what the model supports. */
export function resolveSpeedTier(modelId, requested) {
  const cap = getCapabilities(modelId);
  if (!cap.speed?.supported) return null;
  if (requested && cap.speed.tiers?.includes(requested)) return requested;
  return cap.speed.default || null;
}

/** Every family with its selectable sub-models — the shape a UI library renders. */
export function listFamilies() {
  return Object.entries(FAMILY_PROFILES).map(([key, p]) => ({
    family: key,
    label: p.label,
    streaming: p.streaming,
    nativeTools: p.nativeTools,
    contextWindow: p.contextWindow,
    reasoning: p.reasoning,
    speed: p.speed,
    ultra: p.ultra,
    subModels: p.subModels,
  }));
}

/**
 * Recursively freeze a plain object/array graph. Used to lock FAMILY_PROFILES
 * and each SEEDED descriptor so the capability spine cannot be mutated in place
 * (a consumer holding a sub-object reference can't poison the source of truth).
 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Lock the family baselines (nested too). listFamilies / resolveReasoningTier /
// resolveSpeedTier keep reading FAMILY_PROFILES as before — reads are unaffected.
deepFreeze(FAMILY_PROFILES);

/**
 * Drift-free seed: the canonical capability descriptor for every registered
 * model, computed ONCE and frozen. getCapabilities serves a shallow copy from
 * here (with .modelId re-stamped) so repeated calls can't diverge from the
 * tables and can't be mutated by a consumer.
 *
 * DEEP-CLONE IS MANDATORY: computeCapabilities returns reasoning.tiers and
 * subModels BY REFERENCE into FAMILY_PROFILES. Seeding the live objects would
 * alias them — freezing the seed would then (already) freeze FAMILY_PROFILES'
 * inner arrays, and any future per-seed mutation would leak into the family
 * baseline. structuredClone severs the reference before freezing.
 */
const SEEDED_CAPABILITIES = (() => {
  const out = {};
  for (const id of listModelIds()) {
    out[id] = deepFreeze(structuredClone(computeCapabilities(id)));
  }
  return out;
})();

// Internal alias for tests: lets the no-drift suite compare the served
// (seeded) descriptor against a fresh computation without exporting a second
// public surface.
export { computeCapabilities as _computeCapabilitiesForTest };

export default { getCapabilities, computeCapabilities, resolveReasoningTier, resolveSpeedTier, listFamilies, FAMILY_PROFILES, CLAUDE_SUBMODELS };
