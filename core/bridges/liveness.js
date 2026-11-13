/**
 * illuci/core/bridges/liveness.js — the relocatable liveness oracle (DR-134, P3).
 *
 * The OFFLINE layer of the 4-layer availability veto, lifted out of the
 * capability-matrix isAvailable switch into one place. Today the switch answers
 * "is this identity live" inline; P4 (multi-channel) needs that answer per CHANNEL
 * (a model can be live on agy and dead on its api transport), which a switch
 * buried in the matrix cannot express. This module is the seam a per-channel
 * ServingModule.isLive will call.
 *
 * Pure + dependency-injected — the retry.js "dependency-free atom" mold: the
 * presence helpers (isCodexSdkInstalled, isAgyPresent, ...) are passed in, so this
 * module imports nothing and is trivially testable. It is a FAITHFUL port of the
 * switch it relocates: byte-identical results for every id (parity-tested), so the
 * relocation changes structure, not behavior. Honest per-channel liveness and the
 * probe-determined refinements ride on top of this seam in later slices.
 *
 * Dark behind ILLUCI_FLEET_LIVENESS_ENABLED (under the umbrella): flag-off, isAvailable
 * runs its original switch untouched; flag-on, isAvailable delegates here.
 *
 * @module core/bridges/liveness
 */

/**
 * Resolve sync liveness for a CANONICAL identity id. Sync = presence-grade
 * (CLI/SDK/key reachable, daemon optimism); real reachability for daemon/network
 * channels is preflight-probe-determined, not asserted here (same posture as the
 * switch this ports).
 *
 * @param {string} canonicalId — the canonicalized identity id (caller canon()s)
 * @param {object} h — injected presence helpers:
 *   isCodexSdkInstalled() · detectGeminiApiAuth() · isAgyPresent() ·
 *   isKimiInstalled() · isGrokCliPresent() · xaiApiKey (string|undefined)
 * @returns {boolean}
 */
export function resolveLiveness(canonicalId, h) {
  switch (canonicalId) {
    // ollama-cloud backends + the cli claude identity: optimistic-live (presence
    // is the daemon/subscription; real liveness is probe-determined).
    case "deepseek":
      return true;
    case "gpt-oss":
      return h.isAgyPresent();
    case "qwen-code":
    case "qwen3.5":
    case "gemma4":
    case "minimax":
    case "glm":
    case "kimi-cloud":
      return true;
    // claude-fable / claude-local is a legacy explicit lane and is not live for automatic routing.
    case "claude-fable":
      return false;
    // claude-opus defaults through Antigravity; claude-sonnet keeps the CLI primary lane.
    case "claude-opus":
      return h.isAgyPresent();
    case "claude-sonnet":
      return true;
    case "codex-local":
      return h.isCodexSdkInstalled();
    // CLI "Gemini Code Assist" tier deprecated (IneligibleTierError) — use gemini-3.* api.
    case "gemini-local":
      return false;
    // Gemini api transport: live only when a credential is configured.
    case "gemini-3.5-flash":
    case "gemini-3.1-pro":
    case "gemini-3.1-flash-lite":
      try { return !!h.detectGeminiApiAuth(); } catch { return false; }
    // The live Gemini channel via agy/Antigravity — presence necessary, real
    // liveness probe-determined.
    case "gemini":
      return h.isAgyPresent();
    case "kimi-local":
      return h.isKimiInstalled();
    case "grok":
      return !!h.xaiApiKey; // grok-4 via the HTTP API needs a key
    case "grok-build":
    case "grok-cli":
    case "grok-composer-2.5-fast":
      return h.isGrokCliPresent(); // subscription Build CLI, no key
    default:
      return false;
  }
}

/**
 * Resolve sync liveness for a single CHANNEL (P4, multi-channel). A model can be
 * live on one transport and dead on another (e.g. live on agy, dead on its api
 * transport); resolveLiveness answers per IDENTITY, this answers per CHANNEL by
 * mapping the channel's transport to the matching presence precondition. Same
 * presence-grade posture as resolveLiveness (CLI/SDK/key reachable, daemon
 * optimism; real reachability is preflight-probe-determined).
 *
 * @param {object} channel — a channels[] entry { transport, bridge, provider, auth, model }
 * @param {object} h — injected presence helpers (same mold as resolveLiveness):
 *   isAgyPresent() · detectGeminiApiAuth() · isCodexSdkInstalled() ·
 *   isKimiInstalled() · isGrokCliPresent() · xaiApiKey (string|undefined)
 * @returns {boolean}
 */
export function isChannelLive(channel, h) {
  switch (channel?.transport) {
    // The live Gemini channel via agy/Antigravity — presence necessary, real
    // liveness probe-determined.
    case "antigravity":
      return h.isAgyPresent();
    // Subscription CLI transports (the claude / grok-build / kimi families):
    // optimistic-live (the subscription is the daemon; real liveness is probe-
    // determined). Presence of the runtime is the preflight layer's concern.
    case "cli":
      return true;
    // ollama daemon channels: optimistic-live (the daemon probe is preflight).
    case "ollama":
      return true;
    // HTTP api transport (gemini-api.js): live only when a credential is
    // configured; detectGeminiApiAuth throws loudly when nothing is set up.
    case "api":
      try { return !!h.detectGeminiApiAuth(); } catch { return false; }
    // Codex npm SDK transport: live when the package resolves.
    case "sdk":
      return h.isCodexSdkInstalled();
    // The xAI Grok Build CLI (subscription, no key): live when grok.exe resolves.
    case "grok-build":
      return h.isGrokCliPresent();
    default:
      return false;
  }
}

export default { resolveLiveness, isChannelLive };
