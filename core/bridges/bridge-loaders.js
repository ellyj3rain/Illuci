// Static bridge loader registry. Keep this as data: model identity lives in
// model-registry.js, while this file owns the importable bridge module set.

export const BRIDGE_LOADERS = Object.freeze({
  "ollama.js": () => import("./ollama.js"),
  "grok-api.js": () => import("./grok-api.js"),
  "grok-cli.js": () => import("./grok-cli.js"),
  "claude.js": () => import("./claude.js"),
  "claude-api.js": () => import("./claude-api.js"),
  "codex.js": () => import("./codex.js"),
  "gemini.js": () => import("./gemini.js"),
  "gemini-api.js": () => import("./gemini-api.js"),
  "nvidia-nim.js": () => import("./nvidia-nim.js"),
  "agy.js": () => import("./agy.js"),
  "kimi.js": () => import("./kimi.js"),
});

export function knownBridgeFiles() {
  return Object.keys(BRIDGE_LOADERS);
}

export function getBridgeLoader(bridgeFile) {
  return BRIDGE_LOADERS[bridgeFile] || null;
}

export async function loadBridgeModule(bridgeFile) {
  const loader = getBridgeLoader(bridgeFile);
  if (!loader) throw new Error(`No loader registered for bridge "${bridgeFile}"`);
  return loader();
}