/**
 * illuci/core/bridges/serving-module.js — the uniform ServingModule contract (DR-134).
 *
 * A ServingModule is a bridge welded to its resolved registry identity, exposing
 * a uniform contract so a model-serving module is a normalized, swappable unit.
 * The 12 bridges ALREADY share query(userMessage, options); this DECLARES the
 * contract, validates it, and provides the seam for the net-new methods (isLive /
 * resolveModelString / capabilities) that the bridges grow in later slices. It
 * does NOT rewrite bridge internals — it is a thin facade by relocation.
 *
 * Two invariants are enforced uniformly, once, for every bridge through the facade:
 *   - C2 identity stamp: the result is stamped with the resolved IDENTITY id, so
 *     provenance records the identity (e.g. "claude-opus") rather than the bridge's
 *     literal model (e.g. agy returns model:"agy"). The served model string is
 *     preserved as `servedModel`.
 *   - never-empty pass-through: the facade does not swallow a bridge's never-empty
 *     throw; it surfaces it (the bridges already guard this; the facade keeps it).
 *
 * Dark behind ILLUCI_FLEET_SERVING_MODULE_ENABLED (under the umbrella, see
 * fleet-config.js): flag-off, getBridge returns the raw module exactly as before
 * (byte-identical) — this module is only consulted when the flag is on.
 *
 * @module core/bridges/serving-module
 */

/** Required + optional methods of the ServingModule contract. `query` is the one
 *  every bridge already has; the rest are optional (present where the bridge
 *  implements them) and grow over the migration. */
export const REQUIRED_METHODS = ["query"];
export const OPTIONAL_METHODS = ["queryStream", "queryWithWrite", "isLive", "resolveModelString", "capabilities", "retrieveTrace", "assertResponseOnly", "assertProviderAdmission"];

/** Resolve a bridge module's query fn (named or default export), or null. */
function resolveQuery(mod) {
  const q = mod?.query || mod?.default?.query;
  return typeof q === "function" ? q : null;
}

/**
 * Validate a loaded bridge module against the ServingModule contract. Never
 * throws. Returns { ok, missing[] } — `missing` lists absent REQUIRED methods.
 */
export function validateServingModule(mod) {
  const missing = resolveQuery(mod) ? [] : ["query"];
  return { ok: missing.length === 0, missing };
}

/**
 * Weld a loaded bridge module to its resolved registry identity into a
 * ServingModule view. The view exposes the bridge's methods uniformly and applies
 * the C2 identity stamp on the query result. Optional methods are passed through
 * only when the underlying bridge implements them (so duck-typing at the call site
 * keeps working). The raw module is available as `.raw`.
 *
 * @param {object} mod — the loaded bridge module namespace
 * @param {object} entry — the resolved registry identity (id/transport/bridge/...)
 * @returns {object} the ServingModule view
 */
export function makeServingModule(mod, entry) {
  const query = resolveQuery(mod);
  const id = entry?.id ?? null;

  const view = {
    id,
    transport: entry?.transport ?? null,
    auth: entry?.auth ?? null,
    bridge: entry?.bridge ?? null,
    raw: mod,
    async query(userMessage, options = {}) {
      const res = await query(userMessage, options);
      // C2 — stamp the resolved identity; preserve the served model string.
      if (res && typeof res === "object" && id) {
        const servedModel = res.model;
        return {
          ...res,
          model: id,
          ...(servedModel && servedModel !== id ? { servedModel } : {}),
          ...(entry?.transport ? { channel: entry.transport } : {}),
        };
      }
      return res;
    },
  };

  // Optional pass-throughs — declared on the view only when the bridge has them.
  for (const m of OPTIONAL_METHODS) {
    const fn = mod?.[m] || mod?.default?.[m];
    if (typeof fn === "function") view[m] = fn.bind(mod.default ?? mod);
  }
  return view;
}

export default { REQUIRED_METHODS, OPTIONAL_METHODS, validateServingModule, makeServingModule };
