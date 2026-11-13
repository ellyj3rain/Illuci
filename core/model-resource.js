// The model-resource SELECTION layer.
//
// A model's IDENTITY is its vendor family (claude, grok, gemini, deepseek, glm, ...).
// variant + reasoning-dial + transport are selectable PROPERTIES. A selection tuple
// resolves DOWN to one of the flat registry entries (the immutable dispatch targets) plus
// a small params payload the bridge applies. This is the layer the orchestrator and the
// multi-persona injection system select at; it is a READ-ONLY consumer of the [A111]
// single source (illuci/core/bridges/model-registry.js) and adds nothing to dispatch.
//
// Designed under a ratified spec and built against a live dev-team + adversarial-debate
// company (2026-06-17). The back-compat invariants the debate pinned are honored here:
//  - PRECEDENCE: a known id/alias wins over a family default. select("claude-local")
//    stays claude-fable; a bare family default (frontier) only applies to an explicit
//    family selection that is NOT itself a known alias.
//  - getEntry / resolveModelId / buildModelDefaults are re-exported UNCHANGED (no synthetic
//    entries, no shape pollution).
//  - the reasoning dial maps per-entry, not globally.

import {
  MODEL_REGISTRY,
  FAMILIES,
  REASONING_DIAL,
  aliasIndex,
  getEntry,
  resolveModelId,
  buildModelDefaults,
} from "./bridges/model-registry.js";
import { existsSync } from "fs";
// P4 multi-channel (DR-134): consumed ONLY behind ILLUCI_FLEET_CHANNELS_ENABLED. Both
// imports are leaf-safe (fleet-config reads env; channel-select imports the pure
// liveness oracle), so no cycle. Flag-off, resolve() never touches either and its
// return shape is byte-identical to today.
import { isFleetChannelsEnabled } from "./bridges/fleet-config.js";
import { resolveChannel } from "./bridges/channel-select.js";
import { getAgyCommand } from "./bridges/tool-paths.js";

// Re-export the registry's contract verbatim — model-resource is the unified consumer,
// and these must behave exactly as before (the debate's no-fabrication / no-pollution rule).
export { getEntry, resolveModelId, buildModelDefaults, aliasIndex, FAMILIES, REASONING_DIAL };

// Only multi-variant families take dot/colon selection sugar. A bare single-entry family
// (deepseek, glm, ...) is just its flat id, which the known-id path below already pins.
const FAMILY_KEYS = new Set(Object.keys(FAMILIES));
const FAMILY_INDEX = (() => {
  const index = new Map();
  for (const entry of MODEL_REGISTRY) {
    const bucket = index.get(entry.family);
    if (bucket) bucket.push(entry);
    else index.set(entry.family, [entry]);
  }
  for (const [family, entries] of index) index.set(family, Object.freeze([...entries]));
  return index;
})();
const SELECT_CACHE = new Map();
let agyPresenceCache;
const _warned = new Set();
function warnOnce(msg) { if (!_warned.has(msg)) { _warned.add(msg); console.warn(msg); } }

function cloneSelection(sel) {
  return { ...sel };
}

function cacheSelection(key, sel) {
  SELECT_CACHE.set(key, { ...sel });
  return sel;
}

function cachedStringSelection(input, compute) {
  const cached = SELECT_CACHE.get(input);
  if (cached) return cloneSelection(cached);
  return cacheSelection(input, compute());
}

function isAgyPresent() {
  if (agyPresenceCache !== undefined) return agyPresenceCache;
  try {
    const p = getAgyCommand();
    agyPresenceCache = !!p && existsSync(p);
  } catch {
    agyPresenceCache = false;
  }
  return agyPresenceCache;
}

export function resetModelResourceCaches() {
  SELECT_CACHE.clear();
  agyPresenceCache = undefined;
}

function narrowCandidates(candidates, key, value) {
  if (!value) return candidates;
  let narrowed = null;
  for (const entry of candidates) {
    const directMatch = (entry[key] ?? null) === value;
    const legacyMatch = key === "variant" && Array.isArray(entry.legacyVariants) && entry.legacyVariants.includes(value);
    if (directMatch || legacyMatch) {
      if (!narrowed) narrowed = [];
      narrowed.push(entry);
    }
  }
  return narrowed?.length ? narrowed : candidates;
}
function channelDeps(deps = {}) {
  return {
    ...deps,
    liveHelpers: {
      isAgyPresent,
      ...(deps.liveHelpers || {}),
    },
  };
}

/**
 * Normalize an input into a selection object { family, variant, reasoning, transport, _pinnedId? }.
 *
 * Hardened precedence (darwinian mutator cases):
 *  1. A known id / alias / cliAlias / provider-model-string PINS its entry — checked FIRST, so a
 *     real id containing dots (grok-composer-2.5-fast, gemini-3.1-pro) is never mis-parsed as sugar.
 *  2. Dot- or colon-tuple "family[.variant[.reasoning[.transport]]]" — ONLY when token0 is a known
 *     multi-variant family; >4 segments throws (never silently mis-interpreted).
 *  3. An object form: { id, reasoning? } pins (variant ignored, warn-once); { family, ... } selects.
 *  4. Otherwise the bare string is read as a family name (resolve validates / throws).
 */
export function select(input) {
  if (input && typeof input === "object") {
    if (input.id) {
      const e = getEntry(input.id);
      if (!e) throw new Error(`model-resource: unknown id "${input.id}"`);
      if (input.variant) warnOnce(`model-resource: variant "${input.variant}" ignored on pinned id "${input.id}"`);
      return { family: e.family, variant: e.variant ?? null, reasoning: input.reasoning ?? null, transport: e.transport ?? null, _pinnedId: e.id };
    }
    return { family: input.family ?? null, variant: input.variant ?? null, reasoning: input.reasoning ?? null, transport: input.transport ?? null };
  }

  const s = String(input ?? "").trim();
  if (!s) return { family: null, variant: null, reasoning: null, transport: null };

  return cachedStringSelection(s, () => {
    // 1. Known id / alias wins (this is the dot-in-id guard, mutator case 6).
    const known = getEntry(s);
    if (known) {
      return { family: known.family, variant: known.variant ?? null, reasoning: null, transport: known.transport ?? null, _pinnedId: known.id };
    }

    // 2. Dot- or colon-tuple, ONLY when token0 is a known multi-variant family.
    for (const sep of [".", ":"]) {
      if (s.includes(sep)) {
        const parts = s.split(sep);
        if (FAMILY_KEYS.has(parts[0])) {
          if (parts.length > 4) {
            throw new Error(`model-resource: too many segments in selection "${s}" (family${sep}variant${sep}reasoning${sep}transport)`);
          }
          const [family, variant, reasoning, transport] = parts;
          return { family, variant: variant || null, reasoning: reasoning || null, transport: transport || null };
        }
      }
    }

    // 4. Bare unknown string -> read as a family (resolve will validate / throw, never fabricate).
    return { family: s, variant: null, reasoning: null, transport: null };
  });
}

/** Map the universal reasoning dial to the entry's bridge param. Per-entry so a position
 *  means the same compute posture but is applied with the right provider knob. */
function buildParams(entry, reasoning) {
  if (reasoning == null || reasoning === "") return {};
  const pos = String(reasoning).toLowerCase();
  // Clamp to the dial; unknown positions pass through (a bridge may know more).
  const value = REASONING_DIAL.includes(pos) ? pos : pos;
  // The dispatch layer already consumes options.reasoning across bridges; carry it there.
  return { reasoning: value };
}

/**
 * Resolve a selection (string | object) to { selection, entry, params }.
 * `entry` is an existing registry entry — the immutable dispatch target. Never fabricates.
 *
 * P4 multi-channel (DR-134): when ILLUCI_FLEET_CHANNELS_ENABLED is on AND the resolved
 * entry carries channels[], an additive `channel` key is appended to the return
 * (the chosen channels[] view). Flag-off OR no channels[] -> the return is byte-
 * identical to before (no `channel` key). `deps` is the optional injection seam for
 * channel selection (live oracle + per-channel throttle view); the single-arg call
 * resolve(input) stays the existing contract.
 *
 * @param {string|object} input
 * @param {object} [deps] — channel-selection injection: { isChannelLive?, channelThrottleState?, liveHelpers? }
 * @throws if the family is unknown or no entry matches.
 */
export function resolve(input, deps = {}) {
  const sel = select(input);

  // A pinned id/alias resolves straight to its entry (family default never overrides it).
  if (sel._pinnedId) {
    const entry = getEntry(sel._pinnedId);
    const base = { selection: { family: entry.family, variant: entry.variant ?? null, reasoning: sel.reasoning ?? null, transport: entry.transport ?? null }, entry, params: buildParams(entry, sel.reasoning) };
    // P4: additive channel selection on the pinned-id fast path. Implicit
    // multi-channel selection stays flag-gated, but an explicit transport pin is
    // itself the operator-selected channel contract and must not silently erase.
    if ((isFleetChannelsEnabled() || sel.transport) && Array.isArray(entry.channels)) {
      const channel = resolveChannel(entry, sel, channelDeps(deps));
      return { ...base, channel };
    }
    return base;
  }

  if (!sel.family) throw new Error(`model-resource: cannot resolve "${input}" — no known id/alias and no family`);

  const candidatesInFamily = FAMILY_INDEX.get(sel.family) || [];
  if (candidatesInFamily.length === 0) throw new Error(`model-resource: unknown family "${sel.family}"`);

  const fam = FAMILIES[sel.family] || null;
  const variant = sel.variant ?? fam?.defaultVariant ?? null;
  const transport = sel.transport ?? fam?.defaultTransport ?? null;
  const reasoning = sel.reasoning ?? fam?.defaultReasoning ?? null;

  // Narrow by variant then transport, but never down to nothing: if a narrowing matches
  // no entry, keep the prior set (closest-match) rather than fabricate or throw.
  let candidates = candidatesInFamily;
  candidates = narrowCandidates(candidates, "variant", variant);
  candidates = narrowCandidates(candidates, "transport", transport);

  // Precedence on a tie: registry order (canonical). `reasoning` (default-filled) is the
  // resolved DISPLAY value; params carries an override ONLY when the selection set it
  // explicitly, so an unspecified dial leaves the entry's own default (and dispatch) intact.
  const entry = candidates[0];
  const base = { selection: { family: sel.family, variant, reasoning, transport }, entry, params: buildParams(entry, sel.reasoning) };
  // P4 multi-channel (DR-134): additive channel selection AFTER the cross-row
  // transport narrow yields `entry` (flag + channels[] gated). The selection's
  // resolved transport feeds resolveChannel as the explicit pin. Flag-off OR no
  // channels[] -> byte-identical (no `channel` key).
  if ((isFleetChannelsEnabled() || sel.transport) && Array.isArray(entry.channels)) {
    const channel = resolveChannel(entry, { ...sel, transport }, channelDeps(deps));
    return { ...base, channel };
  }
  return base;
}

/** List the families that have a first-class selection profile (multi-variant). */
export function listFamilies() {
  return Object.keys(FAMILIES);
}

export default { select, resolve, listFamilies, getEntry, resolveModelId, buildModelDefaults, FAMILIES, REASONING_DIAL, aliasIndex, resetModelResourceCaches };
