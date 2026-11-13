/**
 * illuci — Fleet Settings: the operator's prune-overlay store (P5 of DR-134).
 *
 * The model registry (../bridges/model-registry.js) is the SINGLE source of
 * truth for which models EXIST, and MODEL_STATUS there is the GOVERNANCE layer
 * (BIS/export-control, retired transports — suspensions that are not the
 * operator's choice). This module is the orthogonal CURATION layer: the
 * operator's personal prune overlay over that fleet, persisted at the home leaf
 * `~/.illuci/fleet/settings.json`. Curation only ever NARROWS the visible fleet; it
 * never overrides governance (a governance-suspended model cannot be "restored"
 * out of suspension by curation — that distinction is enforced in restoreModel).
 *
 * Mirrors the load/persist idiom of ../skills/library.js: existsSync +
 * readFileSync + JSON.parse inside a try/catch that degrades to defaults on a
 * corrupt or unreadable file; mkdirSync(recursive) + writeFileSync on persist;
 * every mutation is logDecision-audited (type "config", humanStatus
 * "operator-initiated") via ../decisions/logger.js.
 *
 * Behavioral activation is gated upstream (ILLUCI_FLEET_CURATION_ENABLED via
 * ../bridges/fleet-config.js isFleetCurationEnabled). This module is the store;
 * with the flag off no consumer calls isPruned, so the fleet is byte-identical.
 *
 * Store shape (schemaVersion 1):
 *   {
 *     schemaVersion: 1,
 *     curation: {
 *       pruned: {
 *         "<canonicalId>": { since, reason, source: "operator-curation" }
 *       }
 *     }
 *   }
 *
 * DEFAULT SEED (written ONLY when no file exists; an existing file is never
 * clobbered): the operator's named four — qwen-code, qwen3.5 (the task-
 * specialists) plus the local ollama lane.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveIlluciHomeDir } from "../agents/home-dir.js";
import { logDecision } from "../decisions/logger.js";
import { resolveModelId, listModels, isSuspended } from "../bridges/model-registry.js";

const SETTINGS_FILE = resolveIlluciHomeDir("fleet", "settings.json");

const SCHEMA_VERSION = 1;

/**
 * The operator's named four — written only on first-ever load (no file).
 * These are the task-specialists (qwen-code, qwen3.5) plus the two auth:"local"
 * local lane (ollama). Canonicalized through resolveModelId so the seed is
 * keyed by canonical id even if these spellings ever become aliases.
 */
const DEFAULT_PRUNED_SEED = ["qwen-code", "qwen3.5", "ollama"];

// ─── MODULE-LEVEL CACHE ───

let _cache = null;

/** Reset the in-memory cache. Test hermeticity only. */
export function _resetFleetSettingsCache() {
  _cache = null;
}

// ─── STORE SHAPE ───

function defaultStore() {
  const pruned = {};
  const since = new Date().toISOString();
  for (const id of DEFAULT_PRUNED_SEED) {
    const canonical = resolveModelId(id) ?? id;
    pruned[canonical] = {
      since,
      reason: "default fleet curation seed",
      source: "operator-curation",
    };
  }
  return { schemaVersion: SCHEMA_VERSION, curation: { pruned } };
}

/** Coerce any parsed value into a well-formed store, never throwing. */
function normalizeStore(raw) {
  const store = raw && typeof raw === "object" ? raw : {};
  const curation = store.curation && typeof store.curation === "object" ? store.curation : {};
  const pruned = curation.pruned && typeof curation.pruned === "object" ? curation.pruned : {};
  return {
    schemaVersion: typeof store.schemaVersion === "number" ? store.schemaVersion : SCHEMA_VERSION,
    curation: { pruned },
  };
}

// ─── LOAD / PERSIST ───

/**
 * Load the store into the module cache. On first-ever load (no file) the default
 * seed is written so the store is materialized. A corrupt or unreadable file
 * degrades to the in-memory defaults WITHOUT clobbering the file on disk.
 */
function load() {
  if (_cache) return _cache;

  if (!existsSync(SETTINGS_FILE)) {
    // First-ever load: seed and materialize.
    _cache = defaultStore();
    try {
      persist(_cache, { seed: true });
    } catch {
      // Persisting the seed is best-effort; the in-memory store still stands.
    }
    return _cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    _cache = normalizeStore(parsed);
  } catch {
    // Corrupt / unreadable: degrade to defaults in memory; never clobber the file.
    _cache = defaultStore();
  }
  return _cache;
}

/** Write the store to disk (mkdirSync recursive + writeFileSync). */
function persist(store) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ─── PUBLIC API ───

/**
 * Is `modelId` pruned by operator curation? Canonicalizes via resolveModelId
 * first so any known spelling (alias, cliAlias, provider model string) resolves
 * to the same answer. THE INTERFACE OTHER AGENTS DEPEND ON.
 *
 * @param {string} modelId - any known model spelling.
 * @returns {boolean}
 */
export function isPruned(modelId) {
  if (!modelId) return false;
  const canonical = resolveModelId(modelId) ?? modelId;
  const store = load();
  return Object.prototype.hasOwnProperty.call(store.curation.pruned, canonical);
}

/**
 * A detached (deep-cloned) full view of the store. Mutating the result does not
 * touch the cache or disk.
 */
export function getFleetSettings() {
  const store = load();
  return JSON.parse(JSON.stringify(store));
}

/**
 * listModels() annotated with curation + effective status. Each entry carries:
 *   pruned       — true if operator-pruned
 *   suspended    — true if governance-suspended (registry MODEL_STATUS)
 *   effective    — "active" | "pruned" | "suspended" (governance wins over curation
 *                  for the effective label, since a suspended model is unavailable
 *                  regardless of curation).
 */
export function listCuratedFleet() {
  const store = load();
  const pruned = store.curation.pruned;
  return listModels().map((entry) => {
    const isP = Object.prototype.hasOwnProperty.call(pruned, entry.id);
    const isS = isSuspended(entry.id);
    let effective = "active";
    if (isS) effective = "suspended";
    else if (isP) effective = "pruned";
    return {
      ...entry,
      pruned: isP,
      suspended: isS,
      effective,
      curation: isP ? { ...pruned[entry.id] } : null,
    };
  });
}

/**
 * Prune a model by operator curation. The source is forced to
 * "operator-curation". Audited via logDecision. Idempotent on the key (re-prune
 * refreshes since/reason).
 *
 * @param {string} id - any known model spelling.
 * @param {object} [opts]
 * @param {string} [opts.reason] - operator note.
 * @returns {object} { id, canonical, pruned: true } or { error } for an unknown id.
 */
export function pruneModel(id, { reason } = {}) {
  const canonical = resolveModelId(id);
  if (!canonical) {
    return { error: `Unknown model: ${id}` };
  }

  const store = load();
  const entry = {
    since: new Date().toISOString(),
    reason: reason || "operator curation",
    source: "operator-curation",
  };
  store.curation.pruned[canonical] = entry;
  persist(store);

  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: [{ model: "system", seat: "fleet-settings" }],
    context: `Curation: pruned ${canonical} from the visible fleet`,
    type: "config",
    decision: `Pruned ${canonical} (operator-curation)`,
    inputs: { id, canonical, reason: entry.reason },
    metadata: { source: entry.source, since: entry.since },
  });

  return { id, canonical, pruned: true };
}

/**
 * Restore (un-prune) a model. NO-OP if the model is governance-suspended:
 * curation only narrows, it never overrides governance, so a suspended model
 * cannot be lifted out of suspension by a curation restore.
 *
 * @param {string} id - any known model spelling.
 * @returns {object} { id, canonical, restored: true } | { id, canonical, restored:false, reason }
 *                   | { error } for an unknown id.
 */
export function restoreModel(id) {
  const canonical = resolveModelId(id);
  if (!canonical) {
    return { error: `Unknown model: ${id}` };
  }

  // Curation never overrides governance: a governance-suspended model is not
  // restorable by curation. No-op, audited as a refused override.
  if (isSuspended(canonical)) {
    return {
      id,
      canonical,
      restored: false,
      reason: "governance-suspended — curation cannot override governance",
    };
  }

  const store = load();
  if (!Object.prototype.hasOwnProperty.call(store.curation.pruned, canonical)) {
    // Already not pruned — nothing to do, no audit noise.
    return { id, canonical, restored: false, reason: "not pruned" };
  }

  delete store.curation.pruned[canonical];
  persist(store);

  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: [{ model: "system", seat: "fleet-settings" }],
    context: `Curation: restored ${canonical} to the visible fleet`,
    type: "config",
    decision: `Restored ${canonical} (operator-curation)`,
    inputs: { id, canonical },
    metadata: { source: "operator-curation" },
  });

  return { id, canonical, restored: true };
}

export default {
  isPruned,
  getFleetSettings,
  listCuratedFleet,
  pruneModel,
  restoreModel,
  _resetFleetSettingsCache,
};
