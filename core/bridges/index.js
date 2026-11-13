/**
 * illuci — Bridge Barrel
 *
 * Unified interface to all model bridges. Each bridge exports query()
 * with the same signature and return shape.
 */

// Auto-load envarapi.env into process.env so all bridges get API keys.
// [A94]/DR-187 (F-129): the loader is the explicit env-load seam now — the
// fleet doctor calls the SAME function, so diagnosis sees dispatch's world.
import { loadBridgeEnv } from "./env-load.js";
loadBridgeEnv();

export * as ollama from "./ollama.js";
export * as grok from "./grok-api.js";
export * as grokCli from "./grok-cli.js";
export * as claude from "./claude.js";
export * as codex from "./codex.js";
export * as gemini from "./gemini.js";
export * as geminiApi from "./gemini-api.js";
export * as kimi from "./kimi.js";
export * as agy from "./agy.js";
// ludus-ai removed — credits stripped. UE5 tools now in core/tools/unreal-mcp.js

import { getEntry, buildModelDefaults } from "./model-registry.js";
import { isServingModuleEnabled } from "./fleet-config.js";
import { makeServingModule } from "./serving-module.js";
import { loadBridgeModule } from "./bridge-loaders.js";

// The model registry is THE single source of truth for model identity; the
// alias map and defaults table that used to live here (and drift) now derive.
export { MODEL_REGISTRY, getEntry, resolveModelId, listModels, listModelIds } from "./model-registry.js";

/** Resolve a model id (any known spelling: canonical, alias, cli shortcut,
 *  provider model string) to its bridge module. */
export async function getBridge(modelId) {
  const entry = getEntry(modelId);
  if (!entry) throw new Error(`Unknown model: ${modelId}`);
  let mod;
  try {
    mod = await loadBridgeModule(entry.bridge);
  } catch (err) {
    throw new Error(`No loader registered for bridge "${entry.bridge}" (model ${modelId})`, { cause: err });
  }
  // Dark behind ILLUCI_FLEET_SERVING_MODULE_ENABLED (under the umbrella): flag-off
  // returns the raw module exactly as before (byte-identical); flag-on welds it
  // into a uniform ServingModule view (the C2 identity stamp + declared contract).
  return isServingModuleEnabled() ? makeServingModule(mod, entry) : mod;
}

/** Model-specific options injected at dispatch time. Keyed by CANONICAL id
 *  only (aliases resolve via resolveModelId/getEntry), derived from the
 *  registry so enumeration (queryAll, illuci models) is deduplicated. */
export const MODEL_DEFAULTS = buildModelDefaults();

