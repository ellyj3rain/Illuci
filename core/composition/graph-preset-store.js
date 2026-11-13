import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { resolveIlluciHomeDir } from "../agents/home-dir.js";
import { CANONICAL_GRAPH_PRESETS } from "./graph-preset-canon.js";
import { normalizeGraphPreset, resolveGraphPresetRecord, validateGraphPreset } from "./graph-preset.js";

const DEFAULT_FILE = "graph-presets.json";
const storeCache = new Map();

function runtimeStoreFile(options = {}) {
  return options.storeFile || process.env.ILLUCI_GRAPH_PRESET_STORE || resolveIlluciHomeDir("presets", DEFAULT_FILE);
}

function loadRuntimeStore(options = {}) {
  const file = runtimeStoreFile(options);
  if (storeCache.has(file)) return storeCache.get(file);
  if (!existsSync(file)) {
    const empty = { presets: {} };
    storeCache.set(file, empty);
    return empty;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const store = parsed && typeof parsed === "object" && parsed.presets && typeof parsed.presets === "object"
      ? { presets: parsed.presets }
      : { presets: {} };
    storeCache.set(file, store);
    return store;
  } catch {
    const empty = { presets: {} };
    storeCache.set(file, empty);
    return empty;
  }
}

function persistRuntimeStore(options = {}) {
  const file = runtimeStoreFile(options);
  const store = loadRuntimeStore(options);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), "utf-8");
}

function normalizeCanonPreset(raw) {
  return normalizeGraphPreset(raw, { source: "canon" });
}

function normalizeRuntimePreset(raw) {
  return normalizeGraphPreset(raw, { source: "runtime" });
}

export function listCanonicalGraphPresets() {
  return Object.values(CANONICAL_GRAPH_PRESETS).map(normalizeCanonPreset);
}

export function listRuntimeGraphPresets(options = {}) {
  const canonicalIds = new Set(Object.keys(CANONICAL_GRAPH_PRESETS));
  return Object.entries(loadRuntimeStore(options).presets)
    .filter(([id, preset]) => !canonicalIds.has(id) && !canonicalIds.has(preset?.id))
    .map(([, preset]) => normalizeRuntimePreset(preset));
}

export function listGraphPresets(options = {}) {
  const includeHidden = Boolean(options.includeHidden);
  const rows = [
    ...listCanonicalGraphPresets(),
    ...listRuntimeGraphPresets(options),
  ];
  return rows.filter((preset) => includeHidden || preset.presentation.visibility !== "hidden");
}

export function getGraphPreset(id, options = {}) {
  if (CANONICAL_GRAPH_PRESETS[id]) return normalizeCanonPreset(CANONICAL_GRAPH_PRESETS[id]);
  const runtime = loadRuntimeStore(options).presets[id];
  return runtime ? normalizeRuntimePreset(runtime) : null;
}

export function createRuntimeGraphPreset(input = {}, options = {}) {
  const validation = validateGraphPreset(input);
  if (!validation.valid || !validation.preset) {
    return { created: false, id: input?.id || null, reason: "invalid-graph-preset", errors: validation.errors };
  }
  const preset = validation.preset;
  if (CANONICAL_GRAPH_PRESETS[preset.id]) {
    return { created: false, id: preset.id, reason: "canonical-shadow-refused", errors: [] };
  }

  const store = loadRuntimeStore(options);
  const now = options.now || new Date().toISOString();
  store.presets[preset.id] = {
    ...preset,
    provenance: {
      ...preset.provenance,
      source: "runtime",
      createdAt: preset.provenance.createdAt || now,
    },
  };
  persistRuntimeStore(options);
  return { created: true, id: preset.id, preset: normalizeRuntimePreset(store.presets[preset.id]) };
}

export function validateGraphPresetById(id, options = {}) {
  const preset = getGraphPreset(id, options);
  if (!preset) {
    return { valid: false, preset: null, status: "draft", errors: [`unknown graph preset: ${id}`], warnings: [], unresolvedRefs: [] };
  }
  return validateGraphPreset(preset);
}

export function resolveGraphPresetById(id, options = {}) {
  const preset = getGraphPreset(id, options);
  if (!preset) {
    return resolveGraphPresetRecord({ id }, { resolver: "graph-preset-store" });
  }
  return resolveGraphPresetRecord(preset, { resolver: "graph-preset-store" });
}

export function _resetGraphPresetStoreCache() {
  storeCache.clear();
}

export default {
  listCanonicalGraphPresets,
  listRuntimeGraphPresets,
  listGraphPresets,
  getGraphPreset,
  createRuntimeGraphPreset,
  validateGraphPresetById,
  resolveGraphPresetById,
  _resetGraphPresetStoreCache,
};
