/**
 * illuci — Throttle Configuration
 *
 * Operator-settable throttle limits. The throttle layer
 * (core/throttle/throttle.js) loads its limits table through this module
 * instead of a hardcoded constant, making rate limits a parameter surface:
 *
 *   DEFAULT_THROTTLE_LIMITS  <-  illuci.config.json "throttle" key  <-  ILLUCI_THROTTLE_LIMITS env (JSON)
 *
 * Table keys are, in resolution order (see resolveThrottleKey in throttle.js):
 *   1. model alias (e.g. "claude-local", "grok") — alias-level override,
 *      wins over the provider entry for that alias only
 *   2. provider id (MODEL_DEFAULTS[*].provider in core/bridges/index.js,
 *      e.g. "ollama-cloud") — the normal throttling level: aliases of one
 *      provider share one sliding window
 *   3. "default" — applied to any key with neither an alias nor a provider
 *      entry, so unknown models are protected-by-default, never unlimited
 *
 * Overrides merge field-by-field per key, so config may adjust a single
 * field (e.g. {"ollama-cloud": {"concurrencyLimit": 12}}) without restating
 * the rest. Setting a key to null removes that entry entirely (explicit
 * opt-out, e.g. enterprise tier).
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE_NAME = "illuci.config.json";
// Deprecation fallback: read the legacy neocli.config.json if the preferred
// illuci.config.json is absent, so the neocli purge does not orphan an existing
// operator file. A warning is emitted when the legacy name is used.
const LEGACY_CONFIG_FILE_NAME = "neocli.config.json";

// Prior hardcoded PROVIDER_LIMITS values preserved as defaults, with two
// structural changes from the core-loop audit remediation:
//   - the three ollama-cloud alias rows (deepseek, gpt-oss, qwen-code)
//     collapse into a single "ollama-cloud" provider row, so all eight
//     ollama-cloud aliases share one provider window
//   - ollama-cloud concurrencyLimit raised 5 -> 10, aligned with the
//     operator's OLLAMA_NUM_PARALLEL=10
export const DEFAULT_THROTTLE_LIMITS = {
  // ── Provider-level entries ──
  "ollama-cloud": {
    tokensPerMinute: 100000,
    requestsPerMinute: 30,
    concurrencyLimit: 10, // aligned with OLLAMA_NUM_PARALLEL
    minDelayMs: 500,
  },
  "ollama-local": {
    tokensPerMinute: 50000,
    requestsPerMinute: 60,
    concurrencyLimit: 3,
    minDelayMs: 100,
  },
  // The agy/Antigravity gateway (Gemini/Claude/GPT-OSS on the operator's AI Ultra
  // OAuth) has NO per-token metering and NO free-tier 429 — it is the unmetered
  // subscription seat the P4 multi-channel prefer-unmetered bias routes TO. Given
  // a deliberately generous window so it reads as low-pressure (not throttled-or-
  // near-cap); without this it would inherit the conservative "default" limits and
  // the unmetered bias would silently never fire. The throttle still protects the
  // subscription (concurrency cap + a small minDelay), just at a relaxed ceiling.
  "google-antigravity": {
    tokensPerMinute: 1000000,
    requestsPerMinute: 120,
    concurrencyLimit: 12,
    minDelayMs: 100,
  },
  // ── Alias-level entries (win over provider resolution; values unchanged) ──
  ollama: {
    tokensPerMinute: 50000,
    requestsPerMinute: 60,
    concurrencyLimit: 3,
    minDelayMs: 100,
  },
  grok: {
    tokensPerMinute: 60000,
    requestsPerMinute: 20,
    concurrencyLimit: 3,
    minDelayMs: 1000,
  },
  "claude-local": {
    tokensPerMinute: 40000,
    requestsPerMinute: 15,
    concurrencyLimit: 2,
    minDelayMs: 2000,
  },
  "codex-local": {
    tokensPerMinute: 40000,
    requestsPerMinute: 15,
    concurrencyLimit: 2,
    minDelayMs: 2000,
  },
  "gemini-local": {
    tokensPerMinute: 40000,
    requestsPerMinute: 10,
    concurrencyLimit: 2,
    minDelayMs: 3000,
  },
  "kimi-local": {
    tokensPerMinute: 40000,
    requestsPerMinute: 15,
    concurrencyLimit: 2,
    minDelayMs: 2000,
  },
  // ── Fallback for unknown keys: protected-by-default, operator-settable ──
  default: {
    tokensPerMinute: 60000,
    requestsPerMinute: 30,
    concurrencyLimit: 4,
    minDelayMs: 250,
  },
};

function parseMaybeJson(value, label) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn(`[throttle-config] Ignoring malformed ${label}: ${err.message}`);
    return {};
  }
}

/** Read the "throttle" key from illuci.config.json (cwd first, then illuci/ root),
 *  falling back to the legacy neocli.config.json name at each location. */
function readFileLimits() {
  const candidates = [
    resolve(process.cwd(), CONFIG_FILE_NAME),
    resolve(process.cwd(), LEGACY_CONFIG_FILE_NAME),
    resolve(__dirname, "..", "..", CONFIG_FILE_NAME), // illuci/illuci.config.json
    resolve(__dirname, "..", "..", LEGACY_CONFIG_FILE_NAME), // illuci/neocli.config.json (legacy fallback)
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (path.endsWith(LEGACY_CONFIG_FILE_NAME)) {
      console.warn(`[throttle-config] WARNING: using legacy config file ${path}. Rename it to ${CONFIG_FILE_NAME} (the .neocli purge deprecated the neocli.config.json name).`);
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      return parseMaybeJson(parsed.throttle, `${path} "throttle"`);
    } catch (err) {
      console.warn(`[throttle-config] Ignoring malformed ${path}: ${err.message}`);
    }
  }
  return {};
}

/**
 * Merge defaults <- config file <- env into one limits table.
 * Returns a fresh mutable object — the throttle layer owns the live copy
 * and exposes runtime read/write via getThrottleConfig()/setLimits().
 */
export function loadThrottleLimits() {
  const fileLimits = readFileLimits();
  const envLimits = parseMaybeJson(process.env.ILLUCI_THROTTLE_LIMITS, "ILLUCI_THROTTLE_LIMITS");

  const merged = {};
  for (const source of [DEFAULT_THROTTLE_LIMITS, fileLimits, envLimits]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === null) {
        delete merged[key]; // explicit opt-out
      } else if (typeof value === "object") {
        merged[key] = { ...(merged[key] || {}), ...value };
      }
    }
  }
  return merged;
}

export default { DEFAULT_THROTTLE_LIMITS, loadThrottleLimits };
