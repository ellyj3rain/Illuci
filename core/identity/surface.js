/**
 * illuci/core/identity/surface.js — the substrate's OUTWARD surface identity.
 *
 * Single source of how the substrate names ITSELF on surfaces a consumer
 * renders. Internal/dev consumption (Claude/Codex harnesses, local runs)
 * keeps the real names; OTL's production state flips to "eon" so internal
 * project identities (GZDS, illuci, internal consumers) never reach the surface.
 *
 * "eon" is a SURFACE alias, not a code rename: `illuci/` stays the code id, GZDS
 * governance stays. This module is the ONLY place the surface name is defined.
 * Ratified at [A68] / DR-079; see CLAUDE.md § Substrate-vs-product casing.
 *
 * Mode is env-driven (EON_SURFACE_MODE), default-internal — internal surfaces
 * change ONLY when a deployment (OTL) opts in. A deployed server reads the env
 * once at launch; render/read paths re-read it per call so in-process flips
 * (tests, co-located OTL composition) are honored too.
 */

const EON = {
  mode: 'eon',
  name: 'eon',
  serverName: 'eon-mcp',
  scheme: 'eon',
  uriRoot: '', // eon://<path> — no internal segment
  logTag: 'eon',
  defaultAudience: 'external',
};

const INTERNAL = {
  mode: 'internal',
  name: 'gzds-illuci',
  serverName: 'gzds-illuci-mcp',
  scheme: 'gzds',
  uriRoot: 'illuci', // gzds://illuci/<path>
  logTag: 'illuci-mcp',
  defaultAudience: 'GZDS-internal',
};

/** True when the substrate should present its OTL-production surface as eon. */
export function isEonSurface() {
  const v = (process.env.EON_SURFACE_MODE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'eon' || v === 'on';
}

/** The active surface descriptor. */
export function surface() {
  return isEonSurface() ? EON : INTERNAL;
}

export function surfaceName() {
  return surface().name;
}

export function surfaceServerName() {
  return surface().serverName;
}

export function surfaceLogTag() {
  return surface().logTag;
}

export function surfaceAudience() {
  return surface().defaultAudience;
}

/**
 * Build a resource URI under the surface scheme.
 *   surfaceUri('decisions') → internal 'gzds://illuci/decisions' | eon 'eon://decisions'
 */
export function surfaceUri(path) {
  const s = surface();
  const root = s.uriRoot ? `${s.uriRoot}/` : '';
  return `${s.scheme}://${root}${path}`;
}

/** Tenant id from the surface-neutral env var first, internal var next. */
export function surfaceTenantId() {
  return process.env.EON_TENANT_ID || process.env.GZDS_TENANT_ID || 'default';
}

// Compound tokens are listed before atomic ones, and internal file paths
// before the bare `illuci` token, so "gzds-illuci" / "illuci/core/x" don't degrade
// into "eon-eon" / "eon/core/x".
const SCRUB_RULES = [
  [/gzds-illuci-mcp/gi, 'eon-mcp'],
  [/gzds-illuci/gi, 'eon'],
  [/ILLUCI[\-_]?CLI/gi, 'eon'], // internal CLI/system name; no word boundary, so before \bneo\b
  // File paths: match segments + dotted filenames but stop before trailing
  // sentence punctuation (don't swallow the period after "logger.js.").
  [/\bneo\/[\w\-/]+(?:\.[\w\-]+)*/g, 'the substrate'],
  [/\bconstitutional\/[\w\-/]+(?:\.[\w\-]+)*/g, 'the governance spec'],
  [/\bclaude\/system\/[\w\-/]+(?:\.[\w\-]+)*/g, 'the harness'],
  [/\bGZDS\b/g, 'eon'],
  [/\bgzds\b/g, 'eon'],
  [/\bneo-side\b/gi, 'substrate-side'],
  [/\bneo\b/gi, 'eon'],
  [/\bCymelicra\b/gi, 'a consumer'],
  [/\bMatrice\b/gi, 'a consumer'],
];

/**
 * Scrub internal identifiers from a free-text surface string. Internal mode
 * returns the text unchanged; eon mode replaces internal project / structure
 * tokens with the surface identity and strips internal file paths. This is a
 * backstop for free text (descriptions, rendered preambles) — structured
 * fields (server name, URIs, audience) route through the helpers above.
 */
export function scrub(text) {
  if (!isEonSurface() || typeof text !== 'string') return text;
  let out = text;
  for (const [re, repl] of SCRUB_RULES) out = out.replace(re, repl);
  return out;
}

export default {
  isEonSurface,
  surface,
  surfaceName,
  surfaceServerName,
  surfaceLogTag,
  surfaceAudience,
  surfaceUri,
  surfaceTenantId,
  scrub,
};
