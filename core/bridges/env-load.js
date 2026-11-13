// core/bridges/env-load.js
//
// [A94]/DR-187 (F-129): the ONE bridge-env seam. envarapi.env used to load
// only as an import side effect of the bridge barrel (index.js) — so any
// surface that imported bridge modules DIRECTLY (the fleet doctor) checked a
// bare process.env and reported missing-auth for lanes that dispatch fine
// (the doctor lied about NIM). The loader is now explicit and idempotent:
// every consumer that reasons about bridge auth calls it first, so diagnosis
// and dispatch see ONE world.

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = resolve(__dirname, "..", "..", "envarapi.env");
let loadedPath = null;

/**
 * Load envarapi.env into process.env — no-clobber (an already-set variable
 * always wins), exactly the semantics the barrel always had. Idempotent for
 * the same path. Returns key NAMES only, never values.
 *
 * @param {string} [path]  override for tests; defaults to the repo's envarapi.env
 * @returns {{loaded:boolean, path:string, keys:string[], cached?:boolean}}
 */
export function loadBridgeEnv(path = DEFAULT_ENV_PATH) {
  if (loadedPath === path) return { loaded: true, path, keys: [], cached: true };
  if (!existsSync(path)) return { loaded: false, path, keys: [] };
  const keys = [];
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      keys.push(key);
      if (!process.env[key]) process.env[key] = val;
    }
  }
  loadedPath = path;
  return { loaded: true, path, keys };
}

export default { loadBridgeEnv };
