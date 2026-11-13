/**
 * illuci — Normalized Fleet/Serving layer: configuration (DR-134).
 *
 * The umbrella flag ILLUCI_FLEET_NORMALIZED_ENABLED + per-slice sub-flags (OD-6),
 * each read at CALL TIME (never module-load), default OFF, exact-string family
 * (1/true/yes/on/enabled), copying the DRL convention (resilience/config.js) so
 * coercion matches byte-for-byte. With the umbrella OFF the whole normalized
 * layer is inert and dispatch is byte-identical to today; a sub-flag takes effect
 * only when the umbrella is ALSO on, so each facet activates independently as it
 * proves out. The metadata floor (transport/auth) is additive and needs no flag;
 * the behavioral slices (the serving-module facade, liveness, curation, posture)
 * ride these flags.
 */

function readBool(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(n)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(n)) return false;
  return fallback;
}

/** The umbrella. Default OFF — the normalized layer is inert, getBridge returns
 *  the raw module, dispatch is byte-identical. Read at call time so a flip takes
 *  effect at once. */
export function isFleetNormalizedEnabled(env = process.env) {
  return readBool("ILLUCI_FLEET_NORMALIZED_ENABLED", false, env);
}

/** A per-slice sub-flag is active only when the umbrella is ALSO on (OD-6). */
function subFlag(name, env) {
  return isFleetNormalizedEnabled(env) && readBool(name, false, env);
}

/** The ServingModule facade replaces the raw getBridge return (the C2 identity
 *  stamp + the uniform never-empty seam). */
export function isServingModuleEnabled(env = process.env) {
  return subFlag("ILLUCI_FLEET_SERVING_MODULE_ENABLED", env);
}

/** Per-channel liveness (isLive) drives isAvailable (P3). */
export function isFleetLivenessEnabled(env = process.env) {
  return subFlag("ILLUCI_FLEET_LIVENESS_ENABLED", env);
}

/** Multi-channel resolution + dispatch (P4): a model row's channels[] is selected
 *  across at resolve time, and the chosen channel rides dispatch. Flag-off, resolve
 *  returns today's single-target shape and dispatch is byte-identical. */
export function isFleetChannelsEnabled(env = process.env) {
  return subFlag("ILLUCI_FLEET_CHANNELS_ENABLED", env);
}

/** The settings/curation prune overlay (P5). */
export function isFleetCurationEnabled(env = process.env) {
  return subFlag("ILLUCI_FLEET_CURATION_ENABLED", env);
}

/** The observed rate-posture in channel selection (P6). */
export function isFleetPostureEnabled(env = process.env) {
  return subFlag("ILLUCI_FLEET_POSTURE_ENABLED", env);
}

export default {
  isFleetNormalizedEnabled,
  isServingModuleEnabled,
  isFleetLivenessEnabled,
  isFleetChannelsEnabled,
  isFleetCurationEnabled,
  isFleetPostureEnabled,
};
