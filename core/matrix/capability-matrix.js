/**
 * Capability matrix - role-routable compatibility projection.
 *
 * Priority 1 = primary; Priority 2 = concurrent amplifier; Priority 3 = fallback.
 * All concurrent models receive the same query and respond independently.
 *
 * This table is the current auto-selection gate, not the finished role graph.
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { isKimiInstalled, getGrokCommand, getAgyCommand } from "../bridges/tool-paths.js";
import { detectAuth as detectGeminiApiAuth } from "../bridges/gemini-api.js";
import { resolveLiveness, isChannelLive } from "../bridges/liveness.js";
import { isFleetLivenessEnabled, isFleetCurationEnabled, isFleetChannelsEnabled } from "../bridges/fleet-config.js";
import { isSuspended, resolveModelId, getEntry } from "../bridges/model-registry.js";
import { isPruned } from "../config/fleet-settings.js";
import { getCapabilities } from "../bridges/capabilities.js";
// DRL (Dynamic-Resilience Layer): breaker veto on the availability gate. Both
// imports depend only on bridges/model-registry.js (already imported above), so
// no cycle. Inert unless ILLUCI_DRL_ENABLED is on (isDrlEnabled is read at call
// time inside isAvailable); a never-seen model has no breaker entry and reads
// allowed, so flag-off availability is byte-identical to before.
import { isDrlEnabled } from "../resilience/config.js";
import { isBreakerOpen } from "../resilience/breaker.js";
import { reliabilityScore } from "../fleet/reliability.js";
import { createRequire } from "module";

// ── identity weld ──
// Every lookup and branch in this module canonicalizes its `model` argument
// through the registry first, so an alias (e.g. "claude-local") and its canonical
// id (e.g. "claude-fable") resolve to the SAME role-map row, availability, and
// mode support. `MODEL_CAPABILITIES` keeps whatever spelling it was authored with
// (some aliases like "claude-local", some canonical ids); the lookup is matched
// by canonical IDENTITY rather than by raw string. resolveModelId returns null
// for an unknown spelling, so we fall back to the raw string — an unknown id
// still misses the table and degrades exactly as before.
function canon(model) {
  return resolveModelId(model) ?? model;
}
// The canonical-id → MODEL_CAPABILITIES-key index, and the row/key lookups built
// on it, are defined just below the MODEL_CAPABILITIES object (they read it).

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGES_DIR = resolve(__dirname, "../bridges");

// Codex is an npm SDK (not a CLI tool path), so its availability is "is the package
// resolvable", mirroring the kimi/grok runtime-precondition idiom. The bridge lazy-imports
// @openai/codex-sdk and throws on a real query when it's absent; this lifts that check up to
// availability so resolveRole never seats codex-local when the SDK isn't installed.
const _require = createRequire(import.meta.url);
function isCodexSdkInstalled() {
  try { _require.resolve("@openai/codex-sdk"); return true; }
  catch { return false; }
}

// The xAI Grok Build CLI (grok-cli.js) is a subscription bridge (no API key); availability is
// "is grok.exe resolvable", mirroring the kimi/codex runtime-precondition idiom.
function isGrokCliPresent() {
  try { const p = getGrokCommand(); return !!p && existsSync(p); }
  catch { return false; }
}

// "is the agy CLI resolvable" — the live Gemini channel's NECESSARY precondition.
// Sufficiency (OAuth + ConPTY + render) is preflight-probe-determined, not asserted.
function isAgyPresent() {
  try { const p = getAgyCommand(); return !!p && existsSync(p); }
  catch { return false; }
}

// Role-routable rows. resolveRole / getConcurrentModels iterate THIS table, so a
// registry id with no row here is explicit-lineup/direct-dispatch only until it
// gets graph-owned role/profile binding. Rows are not seat requirements: operators can
// place any live model in any seat; this spine only supplies honest defaults for
// auto-fill, reseating, and mode-aware composition until work-permit binding makes the graph
// binding load-bearing.
export const MODEL_CAPABILITIES = {

  "claude-local": {
    architect:               { priority: 1, concurrent: true },
    arbiter:                 { priority: 1, concurrent: true },
    defender:                { priority: 1, concurrent: true },
    governor:                { priority: 1, concurrent: true },
    reporter:                { priority: 1, concurrent: true },
    analyst:                 { priority: 1, concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    validator:               { priority: 1, concurrent: true },
    auditor:                 { priority: 1, concurrent: true },
    prosecutor:              { priority: 1, concurrent: true },
    "language-generalist":   { priority: 1, concurrent: true },
    "language-specialist":   { priority: 1, concurrent: true },
    "framework-generalist":  { priority: 1, concurrent: true },
    "framework-specialist":  { priority: 1, concurrent: true },
    "framework-strategist":  { priority: 1, concurrent: true },
    "streams-specialist":    { priority: 1, concurrent: true },
    "concurrency-specialist":{ priority: 1, concurrent: true },
    "portability-specialist":{ priority: 1, concurrent: true },
    "platform-engineer":     { priority: 1, concurrent: true },
    diagnostician:           { priority: 1, concurrent: true },
    researcher:              { priority: 1, concurrent: true },
    consultant:              { priority: 1, concurrent: true },
  },

  // claude-opus / claude-sonnet: routable Claude identities. claude-opus defaults
  // through the Antigravity channel; legacy claude-local remains explicit-only.
  "claude-opus": {
    architect:               { priority: 1, concurrent: true },
    arbiter:                 { priority: 1, concurrent: true },
    defender:                { priority: 1, concurrent: true },
    governor:                { priority: 1, concurrent: true },
    reporter:                { priority: 1, concurrent: true },
    analyst:                 { priority: 1, concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    validator:               { priority: 1, concurrent: true },
    auditor:                 { priority: 1, concurrent: true },
    prosecutor:              { priority: 1, concurrent: true },
    "language-generalist":   { priority: 1, concurrent: true },
    "language-specialist":   { priority: 1, concurrent: true },
    "framework-generalist":  { priority: 1, concurrent: true },
    "framework-specialist":  { priority: 1, concurrent: true },
    "framework-strategist":  { priority: 1, concurrent: true },
    "streams-specialist":    { priority: 1, concurrent: true },
    "concurrency-specialist":{ priority: 1, concurrent: true },
    "portability-specialist":{ priority: 1, concurrent: true },
    "platform-engineer":     { priority: 1, concurrent: true },
    diagnostician:           { priority: 1, concurrent: true },
    researcher:              { priority: 1, concurrent: true },
    consultant:              { priority: 1, concurrent: true },
  },

  "claude-sonnet": {
    architect:               { priority: 1, concurrent: true },
    arbiter:                 { priority: 1, concurrent: true },
    defender:                { priority: 1, concurrent: true },
    governor:                { priority: 1, concurrent: true },
    reporter:                { priority: 1, concurrent: true },
    analyst:                 { priority: 1, concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    validator:               { priority: 1, concurrent: true },
    auditor:                 { priority: 1, concurrent: true },
    prosecutor:              { priority: 1, concurrent: true },
    "language-generalist":   { priority: 1, concurrent: true },
    "language-specialist":   { priority: 1, concurrent: true },
    "framework-generalist":  { priority: 1, concurrent: true },
    "framework-specialist":  { priority: 1, concurrent: true },
    "framework-strategist":  { priority: 1, concurrent: true },
    "streams-specialist":    { priority: 1, concurrent: true },
    "concurrency-specialist":{ priority: 1, concurrent: true },
    "portability-specialist":{ priority: 1, concurrent: true },
    "platform-engineer":     { priority: 1, concurrent: true },
    diagnostician:           { priority: 1, concurrent: true },
    researcher:              { priority: 1, concurrent: true },
    consultant:              { priority: 1, concurrent: true },
  },

  "codex-local": {
    implementer:             { priority: 1, concurrent: true },
    fixer:                   { priority: 1, concurrent: true },
    "attacker-whitebox":     { priority: 1, concurrent: true },
    arbiter:                 { priority: 1, concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    tester:                  { priority: 1, concurrent: true },
    architect:               { priority: 2, concurrent: true },
    "language-generalist":   { priority: 2, concurrent: true },
    "language-specialist":   { priority: 2, concurrent: true },
    "framework-generalist":  { priority: 2, concurrent: true },
    "framework-specialist":  { priority: 2, concurrent: true },
    "framework-strategist":  { priority: 2, concurrent: true },
    "streams-specialist":    { priority: 2, concurrent: true },
    "concurrency-specialist":{ priority: 2, concurrent: true },
    "portability-specialist":{ priority: 2, concurrent: true },
    "platform-engineer":     { priority: 2, concurrent: true },
    researcher:              { priority: 2, concurrent: true },
    consultant:              { priority: 2, concurrent: true },
  },

  // agy (Antigravity) — the LIVE Gemini channel, id "gemini". Same Gemini family
  // prompt assets as the now-suspended gemini-local/api transports; it replaces them
  // in auto-fill (they read isAvailable:false while suspended).
  "gemini": {
    analyst:                 { priority: 1,     concurrent: true },
    triager:                 { priority: 1,      concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    architect:               { priority: 2,                          concurrent: true },
    defender:                { priority: 2,     concurrent: true },
    arbiter:                 { priority: 2,                          concurrent: true },
    governor:                { priority: 2,                          concurrent: true },
    reporter:                { priority: 2,                          concurrent: true },
    validator:               { priority: 1,                          concurrent: true },
    auditor:                 { priority: 1,     concurrent: true },
    diagnostician:           { priority: 1,     concurrent: true },
    researcher:              { priority: 2,                          concurrent: true },
    "language-generalist":   { priority: 2, concurrent: true },
    "language-specialist":   { priority: 2, concurrent: true },
    "framework-generalist":  { priority: 2, concurrent: true },
  },
  "gemini-local": {
    analyst:                 { priority: 1,     concurrent: true },
    triager:                 { priority: 1,      concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    architect:               { priority: 2,                          concurrent: true },
    defender:                { priority: 2,     concurrent: true },
    arbiter:                 { priority: 2,                          concurrent: true },
    governor:                { priority: 2,                          concurrent: true },
    reporter:                { priority: 2,                          concurrent: true },
    validator:               { priority: 1,                          concurrent: true },
    auditor:                 { priority: 1,     concurrent: true },
    diagnostician:           { priority: 1,     concurrent: true },
    researcher:              { priority: 2,                          concurrent: true },
    "language-generalist":   { priority: 2, concurrent: true },
    "language-specialist":   { priority: 2, concurrent: true },
    "framework-generalist":  { priority: 2, concurrent: true },
  },

  // ─── Gemini family, transport "api" (gemini-api.js, HTTP) ───
  // Same family / prompt assets as gemini-local; routed by full registry id so
  // the three api ids are role-routable and included in write/execute predicates.
  "gemini-3.5-flash": {
    analyst:                 { priority: 1,     concurrent: true },
    triager:                 { priority: 1,      concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    architect:               { priority: 2,                          concurrent: true },
    defender:                { priority: 2,     concurrent: true },
    arbiter:                 { priority: 2,                          concurrent: true },
    governor:                { priority: 2,                          concurrent: true },
    reporter:                { priority: 2,                          concurrent: true },
    validator:               { priority: 1,                          concurrent: true },
    auditor:                 { priority: 1,     concurrent: true },
    diagnostician:           { priority: 1,     concurrent: true },
    researcher:              { priority: 2,                          concurrent: true },
    "language-generalist":   { priority: 2, concurrent: true },
    "language-specialist":   { priority: 2, concurrent: true },
    "framework-generalist":  { priority: 2, concurrent: true },
  },

  "gemini-3.1-pro": {
    analyst:                 { priority: 1,     concurrent: true },
    triager:                 { priority: 1,      concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    architect:               { priority: 2,                          concurrent: true },
    defender:                { priority: 2,     concurrent: true },
    arbiter:                 { priority: 2,                          concurrent: true },
    governor:                { priority: 2,                          concurrent: true },
    reporter:                { priority: 2,                          concurrent: true },
    validator:               { priority: 1,                          concurrent: true },
    auditor:                 { priority: 1,     concurrent: true },
    diagnostician:           { priority: 1,     concurrent: true },
    researcher:              { priority: 2,                          concurrent: true },
    "language-generalist":   { priority: 2, concurrent: true },
    "language-specialist":   { priority: 2, concurrent: true },
    "framework-generalist":  { priority: 2, concurrent: true },
  },

  "gemini-3.1-flash-lite": {
    analyst:                 { priority: 1,     concurrent: true },
    triager:                 { priority: 1,      concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    architect:               { priority: 2,                          concurrent: true },
    defender:                { priority: 2,     concurrent: true },
    arbiter:                 { priority: 2,                          concurrent: true },
    governor:                { priority: 2,                          concurrent: true },
    reporter:                { priority: 2,                          concurrent: true },
    validator:               { priority: 1,                          concurrent: true },
    auditor:                 { priority: 1,     concurrent: true },
    diagnostician:           { priority: 1,     concurrent: true },
    researcher:              { priority: 2,                          concurrent: true },
    "language-generalist":   { priority: 2, concurrent: true },
    "language-specialist":   { priority: 2, concurrent: true },
    "framework-generalist":  { priority: 2, concurrent: true },
  },

  // xAI API route. Suspended in MODEL_STATUS during the temporary API-route hold,
  // but the row remains so productization can restore the route by flipping status.
  grok: {
    "attacker-blackbox":    { priority: 1,   concurrent: true },
    "attacker-whitebox":    { priority: 1, concurrent: true },
    arbiter:                { priority: 1,                     concurrent: true },
    reviewer:               { priority: 1,                     concurrent: true },
    analyst:                { priority: 1,                     concurrent: true },
    architect:              { priority: 2,                     concurrent: true },
    fixer:                  { priority: 2,                     concurrent: true },
    recon:                  { priority: 1,   concurrent: true },
    exploiter:              { priority: 1, concurrent: true },
    "post-exploiter":       { priority: 1,  concurrent: true },
    governor:               { priority: 2,                     concurrent: true },
    prosecutor:             { priority: 1, concurrent: true },
    "framework-strategist": { priority: 2,                     concurrent: true },
    researcher:             { priority: 2,                     concurrent: true },
  },

  "grok-build": {
    "attacker-blackbox":     { priority: 1, concurrent: true },
    "attacker-whitebox":     { priority: 1, concurrent: true },
    recon:                   { priority: 1, concurrent: true },
    exploiter:               { priority: 1, concurrent: true },
    "post-exploiter":        { priority: 1, concurrent: true },
    prosecutor:              { priority: 1, concurrent: true },
    implementer:             { priority: 1, concurrent: true },
    fixer:                   { priority: 1, concurrent: true },
    tester:                  { priority: 1, concurrent: true },
    validator:               { priority: 1, concurrent: true },
    architect:               { priority: 1, concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    analyst:                 { priority: 1, concurrent: true },
    arbiter:                 { priority: 1, concurrent: true },
    defender:                { priority: 1, concurrent: true },
    governor:                { priority: 1, concurrent: true },
    diagnostician:           { priority: 1, concurrent: true },
    consultant:              { priority: 1, concurrent: true },
    reporter:                { priority: 1, concurrent: true },
    researcher:              { priority: 1, concurrent: true },
    "platform-engineer":     { priority: 1, concurrent: true },
    "framework-specialist":  { priority: 1, concurrent: true },
    "framework-generalist":  { priority: 1, concurrent: true },
    "framework-strategist":  { priority: 1, concurrent: true },
  },

  "grok-composer-2.5-fast": {
    reporter:                { priority: 1, concurrent: true },
    analyst:                 { priority: 1, concurrent: true },
    consultant:              { priority: 1, concurrent: true },
    reviewer:                { priority: 2, concurrent: true },
    architect:               { priority: 2, concurrent: true },
    arbiter:                 { priority: 2, concurrent: true },
    researcher:              { priority: 2, concurrent: true },
  },

  "kimi-cloud": {
    architect:               { priority: 1, concurrent: true },
    implementer:             { priority: 1, concurrent: true },
    fixer:                   { priority: 1, concurrent: true },
    reviewer:                { priority: 1, concurrent: true },
    defender:                { priority: 1, concurrent: true },
    arbiter:                 { priority: 1, concurrent: true },
    analyst:                 { priority: 1, concurrent: true },
    researcher:              { priority: 1, concurrent: true },
    tester:                  { priority: 1, concurrent: true },
    validator:               { priority: 1, concurrent: true },
    reporter:                { priority: 1, concurrent: true },
    consultant:              { priority: 1, concurrent: true },
    "language-generalist":   { priority: 1, concurrent: true },
    "language-specialist":   { priority: 1, concurrent: true },
    "framework-generalist":  { priority: 1, concurrent: true },
    "framework-specialist":  { priority: 1, concurrent: true },
    "framework-strategist":  { priority: 1, concurrent: true },
    "platform-engineer":     { priority: 1, concurrent: true },
  },

  deepseek: {
    "attacker-blackbox":     { priority: 1,    concurrent: true },
    "attacker-whitebox":     { priority: 1,  concurrent: true },
    fixer:                   { priority: 1,                          concurrent: true },
    reviewer:                { priority: 1,                          concurrent: true },
    implementer:             { priority: 2,                          concurrent: true },
    recon:                   { priority: 1,    concurrent: true },
    exploiter:               { priority: 1,  concurrent: true },
    "post-exploiter":        { priority: 1,   concurrent: true },
    analyst:                 { priority: 2,                          concurrent: true },
    tester:                  { priority: 2,                          concurrent: true },
    prosecutor:              { priority: 2,  concurrent: true },
  },

  "gpt-oss": {
    implementer:             { priority: 2, concurrent: true },
    reviewer:                { priority: 2, concurrent: true },
    tester:                  { priority: 2, concurrent: true },
    analyst:                 { priority: 2, concurrent: true },
    architect:               { priority: 3, concurrent: true },
  },

  "qwen-code": {
    implementer:             { priority: 1, concurrent: true },
    fixer:                   { priority: 1, concurrent: true },
    tester:                  { priority: 1, concurrent: true },
    reviewer:                { priority: 2, concurrent: true },
    "language-generalist":   { priority: 2, concurrent: true },
    "language-specialist":   { priority: 2, concurrent: true },
    "framework-generalist":  { priority: 2, concurrent: true },
    "framework-specialist":  { priority: 2, concurrent: true },
    "streams-specialist":    { priority: 2, concurrent: true },
    "concurrency-specialist":{ priority: 2, concurrent: true },
    "portability-specialist":{ priority: 2, concurrent: true },
    "platform-engineer":     { priority: 2, concurrent: true },
  },

  "qwen3.5": {
    analyst:                 { priority: 1, concurrent: true },
    researcher:              { priority: 1, concurrent: true },
    reviewer:                { priority: 2, concurrent: true },
    tester:                  { priority: 2, concurrent: true },
    architect:               { priority: 2, concurrent: true },
    "framework-strategist":  { priority: 2, concurrent: true },
    "language-generalist":   { priority: 1, concurrent: true },
    "framework-generalist":  { priority: 1, concurrent: true },
    "platform-engineer":     { priority: 2, concurrent: true },
  },

};

// ── canonical-identity row lookup (the weld) ──
// MODEL_CAPABILITIES keys are a mix of aliases ("claude-local") and canonical ids.
// Index them by canonical id once, so any spelling resolves the SAME row: a row
// keyed by an alias is reachable by its canonical id and vice-versa.
const CANON_TO_MATRIX_KEY = (() => {
  const m = new Map();
  for (const key of Object.keys(MODEL_CAPABILITIES)) m.set(canon(key), key);
  return m;
})();

// The MODEL_CAPABILITIES key (authored spelling) for any spelling, matched by
// canonical identity; falls back to a direct key hit, then null.
function matrixKeyFor(model) {
  return CANON_TO_MATRIX_KEY.get(canon(model)) ?? (MODEL_CAPABILITIES[model] ? model : null);
}

// The MODEL_CAPABILITIES row for any spelling, matched by canonical identity. null
// when no row exists (the unknown-id path stays identical to a raw missed lookup).
function capsFor(model) {
  const key = matrixKeyFor(model);
  return key == null ? null : MODEL_CAPABILITIES[key];
}

// Models that can reason about command execution (mode "execute") yet are NOT
// used for structured file authoring (mode "write"). grok and deepseek are the
// dedicated red-team / recon reasoners; this is the one write/execute distinction
// the capability spine does not carry as a field, so it lives here, by canonical
// id, applied on top of the spine-derived `known` predicate in supportsMode.
const WRITE_EXCLUDED = new Set(["grok", "deepseek"].map(canon));

// ─── AVAILABILITY ───

// Two availability sources coexist by design, and this is the authoritative one.
// isAvailable is the FAST STATIC SEATING GATE consulted by resolveRole /
// getConcurrentModels on every dispatch: it must answer synchronously, with no
// network, off the registry + presence predicates below. model-discovery.js
// (discoverModels / probeModel) is the OBSERVATIONAL live-probe layer — its
// "a hardcoded roster is wrong the moment it is written" thesis governs the
// discovery cache it writes (model-availability.json), which the DRL self-heal
// path (resilience/) and the governance audit consume. It is intentionally NOT
// on this synchronous seating hot path; the breaker veto above is the seam by
// which observed failure feeds back into this gate. So: static here, probed there,
// the breaker is the bridge — not a latent contradiction.
export function isAvailable(model) {
  // Reversible status first: a gov-suspended model (e.g. Fable 5) reads
  // unavailable while suspended, and returns to available the moment the
  // registry's MODEL_STATUS flag clears — no entry deletion, no re-wiring.
  // isSuspended canonicalizes internally; the switch canonicalizes here so an
  // alias (claude-local) and its canonical id (claude-fable) read identically.
  if (isSuspended(model)) return false;
  // Curation prune veto (P5): the settings/curation overlay can only NARROW the
  // governance-allowed set, so it sits AFTER the absolute suspension gate (a
  // suspended model stays unavailable regardless of curation). Dark behind
  // ILLUCI_FLEET_CURATION_ENABLED (under the umbrella); flag-off, isPruned is never
  // consulted and availability falls straight through — byte-identical.
  if (isFleetCurationEnabled() && isPruned(model)) return false;
  // DRL breaker veto: AFTER the reversible gov-suspension check (MODEL_STATUS
  // stays the override), BEFORE the existing availability arms. A canonical model
  // whose breaker is OPEN reads unavailable so resolveRole/getConcurrentModels
  // stop seating a backend that is failing hard; a half-open breaker reads
  // false-for-open (allowed) so the single probe dispatch can flow. Flag-gated:
  // with ILLUCI_DRL_ENABLED off this whole branch is skipped and availability falls
  // straight through to the switch exactly as before.
  if (isDrlEnabled() && isBreakerOpen(canon(model))) return false;
  // Multi-channel branch (P4): a model can carry several serving channels (e.g. a
  // cli transport AND an api transport); it is available if ANY channel is live.
  // Dark behind ILLUCI_FLEET_CHANNELS_ENABLED (under the umbrella). A single-channel
  // row (no channels[] array) and flag-off both fall straight through to the
  // existing liveness/switch path below — byte-identical. Only a multi-channel row
  // with the flag ON takes this branch.
  if (isFleetChannelsEnabled()) {
    const e = getEntry(canon(model));
    if (e && Array.isArray(e.channels)) {
      return e.channels.some((c) => isChannelLive(c, {
        isAgyPresent, detectGeminiApiAuth, isCodexSdkInstalled,
        isKimiInstalled, isGrokCliPresent, xaiApiKey: process.env.XAI_API_KEY,
      }));
    }
  }
  // Dark behind ILLUCI_FLEET_LIVENESS_ENABLED (under the umbrella): the OFFLINE/liveness
  // layer relocated to liveness.js (the per-channel isLive seam, DR-134 P3). Flag-off,
  // the original switch below runs untouched (byte-identical); flag-on, it delegates
  // to the faithful-port oracle. The SUSPENDED + BREAKER vetoes above apply in both.
  if (isFleetLivenessEnabled()) {
    return resolveLiveness(canon(model), {
      isCodexSdkInstalled, detectGeminiApiAuth, isAgyPresent,
      isKimiInstalled, isGrokCliPresent, xaiApiKey: process.env.XAI_API_KEY,
    });
  }
  // ollama-cloud provider arm: every cloud-served ollama backend reads available
  // through the one provider check, so a newly-registered cloud tag is never
  // silently false for want of a hand-written case. This is the availability-honesty
  // posture the operator ratified for glm/kimi-cloud (both respond in <3s; the old
  // per-id switch was lying) extended to the whole provider: deepseek, gpt-oss,
  // qwen-code, qwen3.5, gemma4, minimax, glm, kimi-cloud. (kimi-cloud is the
  // ollama-hosted Kimi, distinct from kimi-local — the Moonshot CLI gated below.)
  {
    const e = getEntry(canon(model));
    if (e && e.provider === "ollama-cloud") return true;
  }
  // nvidia-nim provider arm (A26): every NIM model reads available iff a NIM credential is
  // configured (env NVIDIA_API_KEY / NVIDIA_NIM_API_KEY). One arm gates the whole lane, so
  // adding a NIM model needs no per-id case — the ease-of-addition seam. Key absent -> the
  // whole lane reads unavailable (no surprise auto-selection without an explicit opt-in key).
  {
    const e = getEntry(canon(model));
    if (e && e.provider === "nvidia-nim") return !!(process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY);
  }
  switch (canon(model)) {
    case "gpt-oss":       return isAgyPresent();
    // canon("claude-local") === "claude-fable"; the legacy Fable lane is not auto-routable.
    case "claude-fable":  return false;
    case "claude-opus":   return isAgyPresent();
    case "claude-sonnet": return true;
    case "codex-local":   return isCodexSdkInstalled();
    case "gemini-local":  return false; // CLI "Gemini Code Assist" tier deprecated (IneligibleTierError); use the gemini-3.* api transport
    // Gemini transport "api" (gemini-api.js): available only when a credential is
    // configured. detectAuth() returns an auth descriptor or throws loudly when
    // nothing is set up — same runtime-precondition idiom as kimi-local / grok.
    case "gemini-3.5-flash":
    case "gemini-3.1-pro":
    case "gemini-3.1-flash-lite":
      try { return !!detectGeminiApiAuth(); } catch { return false; }
    // The LIVE Gemini channel (id "gemini") via agy/Antigravity on the AI Ultra OAuth —
    // pro models, no free-tier 429. Presence is necessary; real liveness is probe-determined.
    case "gemini":        return isAgyPresent();
    case "kimi-local":    return isKimiInstalled();
    case "grok":          return !!process.env.XAI_API_KEY; // grok-4 via the HTTP API needs a key
    case "grok-build":
    case "grok-cli":
    case "grok-composer-2.5-fast":
                          return isGrokCliPresent(); // subscription Build CLI, no key
    default:              return false;
  }
}

// CORE RESOLUTION

/**
 * Resolve which models can handle a role, ordered by LEARNED reliability among
 * the currently-available (live-health-gated) candidates.
 *
 * [A48]/DR-128: the static per-(model,role) priority is demoted from the primary
 * sort key to the cold-start TIEBREAK. Ranking is: reliability DESC, then the
 * authored priority ASC, then model id. With DRL off (or every candidate at the
 * neutral prior — cold start), reliabilityScore returns 0.5 for all, so the order
 * collapses to the exact static-priority order this returned before — byte-
 * identical, which the golden-trace sweep pins. As a model earns or loses standing
 * (recordReliability at the dispatch seam), the live winners rise and the failing
 * lanes sink beneath even a higher-priority sibling. isAvailable() (the 4-layer
 * veto incl. the now-live DRL breaker) still removes a hard-dead lane entirely.
 */
export function resolveRole(role) {
  const candidates = [];
  for (const [model, capabilities] of Object.entries(MODEL_CAPABILITIES)) {
    const cap = capabilities[role];
    if (!cap) continue;
    if (!isAvailable(model)) continue;
    candidates.push({
      model,
      priority: cap.priority,
      concurrent: cap.concurrent,
      reliability: reliabilityScore(model),
    });
  }
  candidates.sort((a, b) =>
    (b.reliability - a.reliability) || (a.priority - b.priority) || a.model.localeCompare(b.model));
  return candidates.map(({ model, priority, concurrent }) => ({ model, priority, concurrent }));
}

/**
 * Get all models that should fire concurrently for a role.
 * Returns every available model flagged concurrent, ordered by priority.
 * If none are concurrent, returns the single best fallback.
 */
export function getConcurrentModels(role) {
  const all = resolveRole(role);
  const concurrent = all.filter((c) => c.concurrent);
  if (concurrent.length > 0) return concurrent;
  return all.length > 0 ? [all[0]] : [];
}

/** Best single model for a role. */
export function getPrimary(role) {
  const all = resolveRole(role);
  return all.length > 0 ? all[0] : null;
}

/** Fallback chain excluding the primary. */
export function getFallbacks(role) {
  return resolveRole(role).slice(1);
}

// ─── INTROSPECTION ───

/** All roles a given model can fill. */
export function getModelRoles(model) {
  const caps = capsFor(model);
  if (!caps) return [];
  return Object.entries(caps)
    .map(([role, cap]) => ({ role, ...cap }))
    .sort((a, b) => a.priority - b.priority);
}

/** Full matrix snapshot for diagnostics. */
export function getMatrix() {
  const roles = new Set();
  for (const caps of Object.values(MODEL_CAPABILITIES)) {
    for (const role of Object.keys(caps)) roles.add(role);
  }
  const matrix = {};
  for (const role of [...roles].sort()) {
    matrix[role] = resolveRole(role).map((r) => ({
      model: r.model, priority: r.priority, concurrent: r.concurrent,
    }));
  }
  return matrix;
}

export const MODELS = Object.keys(MODEL_CAPABILITIES);
export function getRoles() {
  const roles = new Set();
  for (const caps of Object.values(MODEL_CAPABILITIES)) {
    for (const role of Object.keys(caps)) roles.add(role);
  }
  return [...roles].sort();
}

/**
 * Check if a model supports a given execution mode.
 * Models must have specific capabilities for certain modes:
 * - write: needs structured output capability (codex, gemini, claude, kimi)
 * - execute: needs command reasoning capability (all frontier models)
 * - delegate: needs native tool-use (codex only currently)
 * - read/respond: any model
 *
 * @param {string} model — model ID
 * @param {string} mode — execution mode (respond, write, read, execute, delegate)
 * @returns {boolean}
 */
export function supportsMode(model, mode) {
  // Canonicalize the row lookup so an alias and its canonical id read identically.
  const caps = capsFor(model);
  if (!caps) return false;

  switch (mode) {
    case "respond":
    case "read":
      // Any model with any role capability can do text I/O
      return true;

    case "execute":
      // Reason about command execution: any model the capability spine KNOWS
      // (resolves to a real family profile). Every model carrying a role row in
      // MODEL_CAPABILITIES is known, so this reproduces the prior "all of them"
      // set while deriving from the spine instead of a hardcoded id array — an
      // unknown id (no profile) correctly stays out.
      return getCapabilities(canon(model)).known === true;

    case "write":
      // Produce structured file operations: a known model that is NOT one of the
      // dedicated red-team reasoners. grok and deepseek reason about commands
      // (execute) but are not used for structured authoring — the one piece of
      // curated policy the spine does not yet carry as a field, named explicitly
      // here (and canonicalized) rather than buried in an opaque id array.
      return getCapabilities(canon(model)).known === true && !WRITE_EXCLUDED.has(canon(model));

    case "delegate":
      // Only Codex has native tool-use via queryWithWrite
      return canon(model) === "codex-local";

    default:
      return false;
  }
}

/**
 * Get the list of models that support a given execution mode.
 * @param {string} mode — execution mode
 * @returns {string[]} model IDs
 */
export function getModelsForMode(mode) {
  return Object.keys(MODEL_CAPABILITIES).filter(m => supportsMode(m, mode));
}

/**
 * Runtime override — tune priority, add capabilities, respond to TOS events.
 * Call this when a model gets rate-limited or flagged to demote it dynamically.
 */
export function setCapability(model, role, capability) {
  // Mutate the row that already carries this canonical identity (so setting a
  // capability via an alias updates the same row a canonical-id read sees). If
  // none exists, create one under the given spelling and register it so later
  // canonical lookups resolve it.
  let key = matrixKeyFor(model);
  if (key == null) {
    key = model;
    MODEL_CAPABILITIES[key] = {};
    CANON_TO_MATRIX_KEY.set(canon(key), key);
  }
  MODEL_CAPABILITIES[key][role] = capability;
}

/**
 * Demote a model across all roles (e.g., after a TOS flag or 429 burst).
 * Increases priority number by `amount` for every role.
 */
export function demoteModel(model, amount = 1) {
  const caps = capsFor(model);
  if (!caps) return;
  for (const role of Object.keys(caps)) {
    caps[role].priority = Math.min(caps[role].priority + amount, 5);
    if (caps[role].priority > 2) caps[role].concurrent = false;
  }
  console.error(`[capability-matrix] ${model} demoted by ${amount} across all roles`);
}

/**
 * Promote a model across all roles (e.g., after confirming TOS stability).
 */
export function promoteModel(model, amount = 1) {
  const caps = capsFor(model);
  if (!caps) return;
  for (const role of Object.keys(caps)) {
    caps[role].priority = Math.max(caps[role].priority - amount, 1);
  }
  console.error(`[capability-matrix] ${model} promoted by ${amount} across all roles`);
}

export default {
  resolveRole, getConcurrentModels, getPrimary, getFallbacks,
  getModelRoles, getMatrix, setCapability, demoteModel, promoteModel,
  supportsMode, getModelsForMode,
  MODELS, getRoles,
};
