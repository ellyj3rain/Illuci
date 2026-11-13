/**
 * illuci — Model Registry: THE single source of truth for model identity.
 *
 * Operator directive (2026-06-11): "surface what exists programmatically and
 * deduplicate and standardize." Before this module, model identity lived in
 * five places that drifted independently: the getBridge alias map, the
 * MODEL_DEFAULTS table, CLAUDE_SUBMODELS in capabilities.js, per-bridge
 * DEFAULT_MODEL constants, and a bolt-on LEGACY_ALIASES map. Saved seat
 * assignments broke whenever any of them disagreed.
 *
 * Now: ONE entry per dispatchable model. Everything else derives:
 *   - the bridge loader map           (index.js getBridge)
 *   - MODEL_DEFAULTS                  (index.js, canonical ids only)
 *   - CLAUDE_SUBMODELS                (capabilities.js, filtered + mapped)
 *   - per-bridge model resolution     (claude.js / claude-api.js via getEntry)
 *
 * Entry shape:
 *   id        canonical dispatch id (the ONLY key consumers should persist)
 *   bridge    bridge module file inside core/bridges/
 *   family    capability family (claude / gemini / grok / kimi / ...)
 *   provider  throttle + routing provider key
 *   model     provider-side model string (omit where the CLI's own default rules)
 *   reasoning default reasoning tier
 *   label     human label (capability surfaces)
 *   tier      capability tier label (frontier / balanced / fast)
 *   cliAlias  shortcut the vendor CLI accepts (omit where none exists - the
 *             Claude CLI has NO "fable" shortcut; that 404 is why this file exists)
 *   aliases   historical / loose spellings that must keep resolving (saved seat
 *             assignments, org files, operator shorthand) - data, not code
 *   adaptive  adaptive dispatch config (reasoning tiers / timeouts)
 *
 * This module is DATA + pure functions. It imports nothing from the bridge
 * graph, so every bridge may import it without cycles.
 */

// ── NVIDIA NIM manifest (A26) ───────────────────────────────────────────────
// One endpoint (integrate.api.nvidia.com/v1/chat/completions), MANY models — each
// row differs only by its wire `model` string. Add a NIM chat/VLM model by adding
// ONE line here; the registry indexes, dispatch defaults, resource profiles, and
// key-gated availability all derive from it (the ease-of-addition seam — the moat).
// modality: "chat" | "vlm" (both ride the OpenAI chat-completions endpoint).
// ollamaRedundant flags models ALSO served on the ollama-cloud lane (folded in for parity).
// fleetUse separates deliberation-seat candidates from delegate-only utility lanes.
// Small/utility NIM routes stay callable for artifact work without polluting topology seats.
export const NVIDIA_NIM_MANIFEST = Object.freeze([
  // chat — NIM-distinct (not on the ollama-cloud lane)
  { id: "nim-nemotron-3-ultra",     model: "nvidia/nemotron-3-ultra-550b-a55b",          label: "Nemotron 3 Ultra 550B (NIM)", modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "architecture", "review"] },
  { id: "nim-nemotron-3-super",     model: "nvidia/nemotron-3-super-120b-a12b",          label: "Nemotron 3 Super 120B (NIM)", modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "synthesis", "review"] },
  { id: "nim-mistral-large-3",      model: "mistralai/mistral-large-3-675b-instruct-2512", label: "Mistral Large 3 675B (NIM)", modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "structured-output", "code-review"] },
  { id: "nim-llama-4-maverick",     model: "meta/llama-4-maverick-17b-128e-instruct",    label: "Llama 4 Maverick (NIM)",     modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "creative-synthesis", "review"] },
  { id: "nim-step-3.7-flash",       model: "stepfun-ai/step-3.7-flash",                  label: "Step 3.7 Flash (NIM)",        modality: "chat", tier: "fast",     reasoning: "high", fleetUse: "delegate", capabilityLanes: ["fast-second-pass", "structured-rewrite", "artifact-skim"] },
  // chat — redundant with the ollama-cloud lane (folded in for parity)
  { id: "nim-deepseek-v4-pro",      model: "deepseek-ai/deepseek-v4-pro",                label: "DeepSeek V4 Pro (NIM)",       modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "code-analysis", "adversarial-review"], ollamaRedundant: true },
  { id: "nim-deepseek-v4-flash",    model: "deepseek-ai/deepseek-v4-flash",              label: "DeepSeek V4 Flash (NIM)",     modality: "chat", tier: "fast",     reasoning: "high", fleetUse: "delegate", capabilityLanes: ["fast-code-skim", "second-opinion", "artifact-triage"], ollamaRedundant: true },
  { id: "nim-glm-5.1",              model: "z-ai/glm-5.1",                               label: "GLM 5.1 (NIM)",               modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "structured-analysis", "review"], ollamaRedundant: true },
  { id: "nim-qwen3.5-122b",         model: "qwen/qwen3.5-122b-a10b",                     label: "Qwen3.5 122B (NIM)",          modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "code-synthesis", "architecture"], ollamaRedundant: true },
  { id: "nim-kimi-k2.6",            model: "moonshotai/kimi-k2.6",                       label: "Kimi K2.6 (NIM)",             modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "long-context", "code-review"], ollamaRedundant: true },
  { id: "nim-minimax-m3",           model: "minimaxai/minimax-m3",                       label: "MiniMax M3 (NIM)",            modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "structured-output", "planning"], ollamaRedundant: true },
  { id: "nim-gpt-oss-120b",         model: "openai/gpt-oss-120b",                        label: "GPT-OSS 120B (NIM)",          modality: "chat", tier: "frontier", reasoning: "high", fleetUse: "seat", capabilityLanes: ["deliberation", "open-model-review", "code-analysis"], ollamaRedundant: true },
  // chat — proven downstream (Air A26 NIM dogfood, 2026-07-01)
  { id: "nim-nemotron-3-nano-omni", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", label: "Nemotron 3 Nano Omni 30B (NIM)", modality: "chat", tier: "fast", reasoning: "high", fleetUse: "delegate", capabilityLanes: ["audio-input", "image-input", "fast-multimodal-triage"] },
  { id: "nim-riva-translate-4b",    model: "nvidia/riva-translate-4b-instruct-v1.1",     label: "Riva Translate 4B v1.1 (NIM)", modality: "chat", tier: "fast",     reasoning: "medium", fleetUse: "delegate", capabilityLanes: ["translation", "localization", "text-transform"] },
  // vlm — vision-language (multimodal chat endpoint; text works today, image input is a follow-up)
  { id: "nim-llama-3.2-90b-vision", model: "meta/llama-3.2-90b-vision-instruct",         label: "Llama 3.2 90B Vision (NIM)",  modality: "vlm",  tier: "frontier", reasoning: "high", fleetUse: "delegate", capabilityLanes: ["visual-analysis", "multimodal-review", "vision-triage"] },
  { id: "nim-nemotron-nano-12b-vl", model: "nvidia/nemotron-nano-12b-v2-vl",             label: "Nemotron Nano 12B VL (NIM)",  modality: "vlm",  tier: "balanced", reasoning: "high", fleetUse: "delegate", capabilityLanes: ["vision-triage", "artifact-inspection", "image-grounding"] },
]);

/** A NIM manifest entry -> a flat MODEL_REGISTRY dispatch row (all NIM rows share bridge/provider/auth). */
function nimRegistryRow(m) {
  return {
    id: m.id,
    bridge: "nvidia-nim.js",
    transport: "nvidia",
    family: "nvidia-nim",
    provider: "nvidia-nim",
    auth: "api-key",
    model: m.model,
    label: m.label,
    tier: m.tier,
    modality: m.modality,
    reasoning: m.reasoning || "high",
    fleetUse: m.fleetUse || "seat",
    capabilityLanes: [...(m.capabilityLanes || [])],
    ...(m.ollamaRedundant ? { ollamaRedundant: true } : {}),
  };
}

export const MODEL_REGISTRY = [
  // ── ollama-served (local + cloud) ──
  { id: "ollama",     bridge: "ollama.js", transport: "ollama", family: "qwen",     provider: "ollama-local", auth: "local", model: "qwen36-abl:fast" },
  { id: "deepseek",   bridge: "ollama.js", transport: "ollama", family: "deepseek", provider: "ollama-cloud", auth: "ollama-cloud", model: "deepseek-v4-pro:cloud",   reasoning: "high" },
  { id: "gpt-oss",    bridge: "agy.js", transport: "antigravity", family: "gpt",      provider: "google-antigravity", auth: "oauth-ultra", model: "GPT-OSS 120B (Medium)",      reasoning: "high",
    // P4 multi-channel (DR-134): gpt-oss reachable via agy/Antigravity or ollama-cloud.
    channels: [
      { transport: "antigravity", bridge: "agy.js",    provider: "google-antigravity", auth: "oauth-ultra",  model: "GPT-OSS 120B (Medium)" },
      { transport: "ollama",      bridge: "ollama.js", provider: "ollama-cloud",       auth: "ollama-cloud", model: "gpt-oss:120b-cloud" },
    ] },
  { id: "qwen-code",  bridge: "ollama.js", transport: "ollama", family: "qwen",     provider: "ollama-cloud", auth: "ollama-cloud", model: "qwen3-coder:480b-cloud",  reasoning: "high" },
  { id: "qwen3.5",    bridge: "ollama.js", transport: "ollama", family: "qwen",     provider: "ollama-cloud", auth: "ollama-cloud", model: "qwen3.5:397b-cloud",      reasoning: "high" },
  { id: "gemma4",     bridge: "ollama.js", transport: "ollama", family: "gemma",    provider: "ollama-cloud", auth: "ollama-cloud", model: "gemma4:31b-cloud",        reasoning: "high" },
  { id: "glm",        bridge: "ollama.js", transport: "ollama", family: "glm",      provider: "ollama-cloud", auth: "ollama-cloud", model: "glm-5.2:cloud",           reasoning: "high", aliases: ["glm-5:cloud"] },
  { id: "minimax",    bridge: "ollama.js", transport: "ollama", family: "minimax",  provider: "ollama-cloud", auth: "ollama-cloud", model: "minimax-m3:cloud",        reasoning: "high", aliases: ["minimax-m2.7:cloud"] },
  // Ollama-hosted Kimi; distinct from kimi-local (Moonshot CLI).
  { id: "kimi-cloud", bridge: "ollama.js", transport: "ollama", family: "kimi",     provider: "ollama-cloud", auth: "ollama-cloud", model: "kimi-k2.7-code:cloud",    reasoning: "high", aliases: ["kimi-k2.6:cloud"] },

  // ── vendor APIs / CLIs ──
  { id: "grok",       bridge: "grok-api.js", family: "grok",   variant: "grok-4", transport: "api", provider: "xai-api", auth: "api-key",      reasoning: "high" },
  // Provider identities are routing candidates; selected-account catalogs decide usability.
  { id: "grok-build", bridge: "grok-cli.js", family: "grok", variant: "grok-4.7", transport: "grok-build", provider: "xai-cli", auth: "subscription", model: "grok-4.7", reasoning: "high", label: "Grok 4.7", tier: "frontier",
    aliases: ["grok-cli"],
    adaptive: { reasoning: { supported: true, tiers: ["xhigh", "high", "medium", "low"],
      timeoutMs: { xhigh: 300000, high: 180000, medium: 120000, low: 90000 } } } },
  { id: "grok-build-fast", bridge: "grok-cli.js", family: "grok", variant: "grok-4.7-build-fast", transport: "grok-build", provider: "xai-cli", auth: "subscription", model: "grok-4.7-build-fast", reasoning: "high", label: "Grok 4.7 Build Fast", tier: "fast",
    adaptive: { reasoning: { supported: true, tiers: ["xhigh", "high", "medium", "low"],
      timeoutMs: { xhigh: 300000, high: 180000, medium: 120000, low: 90000 } } } },
  { id: "grok-build-4.6", bridge: "grok-cli.js", family: "grok", variant: "grok-4.6", transport: "grok-build", provider: "xai-cli", auth: "subscription", model: "grok-4.6", reasoning: "high", label: "Grok 4.6", tier: "legacy" },
  { id: "grok-build-4.5", bridge: "grok-cli.js", family: "grok", variant: "grok-4.5", transport: "grok-build", provider: "xai-cli", auth: "subscription", model: "grok-4.5", reasoning: "high", label: "Grok 4.5", tier: "legacy" },
  { id: "grok-build-4", bridge: "grok-cli.js", family: "grok", variant: "grok-4", transport: "grok-build", provider: "xai-cli", auth: "subscription", model: "grok-4", reasoning: "high", label: "Grok 4 (legacy Build)", tier: "legacy" },
  { id: "grok-build-0.1", bridge: "grok-cli.js", family: "grok", variant: "build-0.1", transport: "grok-build", provider: "xai-cli", auth: "subscription", model: "build-0.1", reasoning: "high", label: "Grok Build 0.1", tier: "legacy" },
  { id: "grok-composer-2.5-fast", bridge: "grok-cli.js", family: "grok", variant: "composer-2.5", transport: "grok-build", provider: "xai-cli", auth: "subscription", model: "grok-composer-2.5-fast", reasoning: "low", label: "Grok Composer 2.5 Fast", tier: "fast" },
  { id: "codex-local", bridge: "codex.js", transport: "sdk", family: "gpt",      provider: "openai", auth: "sdk",       reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low", "minimal"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000, minimal: 60000 } } } },
  // Explicit provider model candidates use the same independently configured adapter.
  { id: "codex-astra", bridge: "codex.js", transport: "sdk", family: "gpt", variant: "gpt-6-astra", provider: "openai", auth: "sdk", model: "gpt-6-astra", reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000 } } } },
  { id: "codex-sol",   bridge: "codex.js", transport: "sdk", family: "gpt", variant: "gpt-6-sol",   provider: "openai", auth: "sdk", model: "gpt-6-sol",   reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low", "minimal"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000, minimal: 60000 } } } },
  { id: "codex-luna",  bridge: "codex.js", transport: "sdk", family: "gpt", variant: "gpt-6-luna",  provider: "openai", auth: "sdk", model: "gpt-6-luna",  reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low", "minimal"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000, minimal: 60000 } } } },
  { id: "codex-terra", bridge: "codex.js", transport: "sdk", family: "gpt", variant: "gpt-6.1-terra", provider: "openai", auth: "sdk", model: "gpt-6.1-terra", reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low", "minimal"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000, minimal: 60000 } } } },
  // Explicit legacy provider targets remain separately addressable; they are
  // never used as an implicit fallback for the current family names.
  { id: "codex-sol-5.6", bridge: "codex.js", transport: "sdk", family: "gpt", variant: "gpt-5.6-sol", provider: "openai", auth: "sdk", model: "gpt-5.6-sol", reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low", "minimal"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000, minimal: 60000 } } } },
  { id: "codex-terra-5.6", bridge: "codex.js", transport: "sdk", family: "gpt", variant: "gpt-5.6-terra", provider: "openai", auth: "sdk", model: "gpt-5.6-terra", reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low", "minimal"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000, minimal: 60000 } } } },
  { id: "codex-luna-5.6", bridge: "codex.js", transport: "sdk", family: "gpt", variant: "gpt-5.6-luna", provider: "openai", auth: "sdk", model: "gpt-5.6-luna", reasoning: "xhigh",
    adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high", "medium", "low", "minimal"],
      timeoutMs: { max: 360000, xhigh: 300000, high: 180000, medium: 120000, low: 90000, minimal: 60000 } } } },
  { id: "gemini-local",          bridge: "gemini.js", family: "gemini", variant: "default",        transport: "local", provider: "google", auth: "oauth", reasoning: "high" },
  { id: "gemini-3.5-flash",      bridge: "gemini-api.js", family: "gemini", variant: "3.5-flash",      transport: "api", provider: "google", auth: "api-key", model: "gemini-3.5-flash",      reasoning: "high" },
  { id: "gemini-3.1-pro",        bridge: "gemini-api.js", family: "gemini", variant: "3.1-pro",        transport: "api", provider: "google", auth: "api-key", model: "gemini-3.1-pro-preview", reasoning: "high" },
  { id: "gemini-3.1-flash-lite", bridge: "gemini-api.js", family: "gemini", variant: "3.1-flash-lite", transport: "api", provider: "google", auth: "api-key", model: "gemini-3.1-flash-lite", reasoning: "low" },
  // The LIVE Gemini channel: agy (Antigravity) on the operator's AI Ultra OAuth — pro models, NO free-tier 429
  // (the gemini-api transport above 429s on pro). Bare "gemini" resolves here (family defaultTransport "antigravity").
  { id: "gemini", bridge: "agy.js", family: "gemini", variant: "3.1-pro", transport: "antigravity", provider: "google-antigravity", auth: "oauth-ultra", model: "Gemini 3.1 Pro (High)", reasoning: "high", aliases: ["agy", "gemini-pro"] },
  { id: "kimi-local", bridge: "kimi.js",   transport: "cli", family: "kimi",     provider: "moonshot", auth: "subscription",     reasoning: "high" },

  // ── claude family (vendor CLI; one entry per sub-model, capability fields inline) ──
  // "claude-local" was a duplicate row pinned to the same model as claude-fable -
  // it is now an ALIAS, so enumeration dispatches each claude sub-model once.
  // No cliAlias for Fable: the Claude CLI has no "fable" shortcut (404 verified
  // live); dispatch goes by the full model id.
  { id: "claude-fable",  bridge: "claude.js", family: "claude", variant: "fable",  transport: "cli", provider: "anthropic", auth: "subscription", model: "claude-opus-4-8",            reasoning: "frontier", label: "Opus 4.8",    tier: "frontier",
    aliases: ["fable", "claude-local"] },
  { id: "claude-opus",   bridge: "agy.js", family: "claude", variant: "opus",   transport: "antigravity", provider: "google-antigravity", auth: "oauth-ultra", model: "Claude Opus 4.6 (Thinking)",           reasoning: "frontier", label: "Opus 4.6",   tier: "frontier", cliAlias: "opus",
    aliases: ["claude", "anthropic"],
    // P4 multi-channel (DR-134): Opus reachable via agy/Antigravity (4.6) or the Claude CLI (4.8).
    channels: [
      { transport: "antigravity", bridge: "agy.js",    provider: "google-antigravity", auth: "oauth-ultra",  model: "Claude Opus 4.6 (Thinking)" },
      { transport: "cli",         bridge: "claude.js", provider: "anthropic",          auth: "subscription", model: "claude-opus-4-8" },
    ] },
  { id: "claude-sonnet", bridge: "claude.js", family: "claude", variant: "sonnet", transport: "cli", provider: "anthropic", auth: "subscription", model: "claude-sonnet-4-6",         reasoning: "balanced", label: "Sonnet 4.6", tier: "balanced", cliAlias: "sonnet",
    // P4 multi-channel (DR-134): Sonnet reachable via the Claude CLI OR agy/Antigravity.
    channels: [
      { transport: "cli",         bridge: "claude.js", provider: "anthropic",          auth: "subscription", model: "claude-sonnet-4-6" },
      { transport: "antigravity", bridge: "agy.js",    provider: "google-antigravity", auth: "oauth-ultra",  model: "Claude Sonnet 4.6 (Thinking)" },
    ] },
  { id: "claude-haiku",  bridge: "claude.js", family: "claude", variant: "haiku",  transport: "cli", provider: "anthropic", auth: "subscription", model: "claude-haiku-4-5-20251001", reasoning: "fast",     label: "Haiku 4.5",  tier: "fast",     cliAlias: "haiku" },
  // Agnostic Anthropic API (per-token, streaming-clean) - a distinct dispatch
  // surface, not an alias of the CLI entries.
  { id: "claude-api",    bridge: "claude-api.js", family: "claude", variant: "fable", transport: "api", provider: "anthropic-api", auth: "api-key", model: "claude-fable-5",    reasoning: "frontier" },

  // ── NVIDIA NIM (OpenAI-compatible HTTP; derived from NVIDIA_NIM_MANIFEST above) ──
  ...NVIDIA_NIM_MANIFEST.map(nimRegistryRow),
];

// ── indexes (built once; the registry is static data) ──

const BY_ID = new Map(MODEL_REGISTRY.map((e) => [e.id, e]));
const BY_LOOKUP = (() => {
  const m = new Map();
  for (const e of MODEL_REGISTRY) {
    m.set(e.id, e);
    if (e.cliAlias && !m.has(e.cliAlias)) m.set(e.cliAlias, e);
    for (const a of e.aliases ?? []) if (!m.has(a)) m.set(a, e);
  }
  // Provider model strings resolve too. On collisions, canonical ids and aliases
  // take precedence, then the first registry row owning the provider string wins.
  for (const e of MODEL_REGISTRY) {
    if (e.model && !m.has(e.model)) m.set(e.model, e);
  }
  return m;
})();

// ── v2 selection layer (consumed by illuci/core/model-resource.js) ──
// IDENTITY is the family; variant / transport / reasoning are selectable properties that
// resolve DOWN to one of the flat entries above (the immutable dispatch targets). The
// existing entries + functions are UNCHANGED; this is purely additive. The default variant
// is FRONTIER per operator ratification, and is only the fallback when a selection leaves
// the variant unspecified. Single-entry families (deepseek, glm, ...) need no FAMILIES row -
// a bare family resolves to its one entry.
export const FAMILIES = Object.freeze({
  claude: { variants: ["opus", "sonnet", "haiku", "fable"], transports: ["antigravity", "cli", "api"],
            defaultVariant: "opus", defaultTransport: "antigravity", defaultReasoning: "high" },
  grok:   { variants: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5", "grok-4", "build-0.1", "composer-2.5"], transports: ["api", "grok-build"],
            defaultVariant: "grok-4.7", defaultTransport: "grok-build", defaultReasoning: "high" },
  gemini: { variants: ["3.1-pro", "3.5-flash", "3.1-flash-lite", "default"], transports: ["antigravity", "api", "local"],
            defaultVariant: "3.1-pro", defaultTransport: "antigravity", defaultReasoning: "high" },
});

// Every known spelling (canonical id, cliAlias, alias, provider model string) -> canonical id.
// Generated from BY_LOOKUP so it can never drift from resolveModelId: every flat id/alias
// maps to the SAME dispatch target it always did (the back-compat seam).
export const aliasIndex = (() => {
  const idx = {};
  for (const [key, entry] of BY_LOOKUP) idx[key] = entry.id;
  return idx;
})();

/** The universal reasoning dial (positions, ascending), seeded from Grok Build's tier list. */
export const REASONING_DIAL = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]); // [A110] minimal promoted (mirrors core/reasoning/dial.js)

/** The registry entry for any known spelling (canonical id, alias, cliAlias,
 *  or provider model string). Null for unknown - callers decide forward-compat. */
export function getEntry(requested) {
  if (!requested) return null;
  return BY_LOOKUP.get(requested) ?? null;
}

/** Canonical id for any known spelling; null for unknown. */
export function resolveModelId(requested) {
  return getEntry(requested)?.id ?? null;
}

// Installation-owned route holds. Populate this map with explicitly selected,
// dated status records for your deployment. Catalog presence is not availability.
export const MODEL_STATUS = Object.freeze({});

/** Reversible suspension check for any spelling (canonicalizes first). True only
 *  while a model is actively suspended; flips to false the moment status clears. */
export function isSuspended(requested) {
  if (!requested) return false;
  const entry = getEntry(requested);
  for (const key of [requested, entry?.id, entry?.model]) {
    if (key && MODEL_STATUS[key]?.suspended === true) return true;
  }
  return false;
}

/** All entries (canonical, deduplicated). */
export function listModels() {
  return [...MODEL_REGISTRY];
}

/** All canonical dispatch ids. */
export function listModelIds() {
  return MODEL_REGISTRY.map((e) => e.id);
}

/** Dispatch-time defaults keyed by CANONICAL id only - the MODEL_DEFAULTS
 *  shape consumers already use ({ model?, family, provider, reasoning?,
 *  adaptive? }); identity fields (label/tier/cliAlias/aliases/bridge) stay
 *  registry-internal. */
export function buildModelDefaults() {
  const out = {};
  for (const e of MODEL_REGISTRY) {
    const d = { family: e.family, provider: e.provider };
    if (e.model) d.model = e.model;
    if (e.reasoning) d.reasoning = e.reasoning;
    if (e.adaptive) d.adaptive = e.adaptive;
    out[e.id] = d;
  }
  return out;
}

export default {
  MODEL_REGISTRY, getEntry, resolveModelId, listModels, listModelIds, buildModelDefaults,
};
