/**
 * Active disposition registry.
 *
 * `dispositionRef` resolves to the dimensional preset library used by the
 * current disposition engine. Prototype-era non-dimensional bundles are not
 * registered here; they must be designed as their own runtime surface before
 * they can become active source again.
 */

import { DISPOSITION_PRESETS, getPreset, listPresets, validateAllPresets } from "./disposition-presets.js";

export { DISPOSITION_PRESETS, getPreset, listPresets, validateAllPresets };

export const DISPOSITION_KINDS = Object.freeze(["dimensional-preset"]);

export function resolveDisposition(ref) {
  if (!ref) return null;
  const preset = DISPOSITION_PRESETS[ref];
  if (!preset) return null;
  return {
    id: ref,
    kind: "dimensional-preset",
    profile: preset.profile,
    source: "preset",
  };
}

export function listDispositions() {
  return Object.keys(DISPOSITION_PRESETS).map((id) => ({ id, kind: "dimensional-preset" }));
}

export function hasDisposition(ref) {
  return !!resolveDisposition(ref);
}

export default {
  DISPOSITION_PRESETS,
  getPreset,
  listPresets,
  validateAllPresets,
  DISPOSITION_KINDS,
  resolveDisposition,
  listDispositions,
  hasDisposition,
};
