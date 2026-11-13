// core/connections/credential-resolver.js
//
// [A22.3.2] Illuci Runtime service — tenant credential resolution.
//
// Turns a tenant's managed connections into a tenant-scoped env object injected at the bridges'
// `resolve*ApiKey(env)` seam — so a request routes with the TENANT's OWN credential, never the
// server's ambient process.env. Secret VALUES are resolved from opaque `secretRef`s at the edge
// (a secret backend); connection records only ever hold the ref, never the value.

import { readConnectionManifestFile } from "./store.js";

// provider-id prefix -> the env var name the matching bridge reads (resolve*ApiKey source).
const PROVIDER_ENV_KEYS = Object.freeze({
  "provider.anthropic": "ANTHROPIC_API_KEY",
  "provider.google": "GEMINI_API_KEY",
  "provider.xai": "XAI_API_KEY",
  "provider.nvidia": "NVIDIA_API_KEY",
  "provider.openai": "OPENAI_API_KEY",
  "provider.moonshot": "MOONSHOT_API_KEY",
});

/** Longest-prefix provider match (`provider.nvidia.nim` -> `NVIDIA_API_KEY`). */
export function envKeyForProvider(provider) {
  if (!provider || typeof provider !== "string") return null;
  for (const prefix of Object.keys(PROVIDER_ENV_KEYS)) {
    if (provider === prefix || provider.startsWith(prefix + ".")) return PROVIDER_ENV_KEYS[prefix];
  }
  return null;
}

/**
 * Resolve an opaque secretRef to a secret VALUE. Dev-grade backends:
 *   `env:NAME`     -> the ambient env's NAME (the ref stays value-free)
 *   `literal:VAL`  -> VAL (dev/test only — do NOT use for real secrets)
 * A real vault backend plugs in here later. Returns null on a miss/unknown scheme (fail closed);
 * never throws.
 */
export function resolveSecretRef(secretRef, options = {}) {
  if (!secretRef || typeof secretRef !== "string") return null;
  const env = options.env || process.env;
  const colon = secretRef.indexOf(":");
  if (colon === -1) return null;
  const scheme = secretRef.slice(0, colon);
  const rest = secretRef.slice(colon + 1);
  if (scheme === "env") return env[rest] ?? null;
  if (scheme === "literal") return rest;
  return null;
}

const UNUSABLE_STATUS = /revok|block|pending|unbound|invalid/i;

/**
 * Build a tenant's env-shaped credentials from its managed connections. Only connections for the
 * tenant (or tenant-agnostic), not in an unusable status, with a resolvable secret, contribute.
 * Providers the tenant has NOT connected are absent — the caller falls back to the ambient env.
 * @returns {{ env: Record<string,string>, resolved: string[], skipped: Array<{provider:string,reason:string}> }}
 */
export function resolveTenantCredentials(tenantId, options = {}) {
  const manifest = readConnectionManifestFile(options);
  const env = {};
  const resolved = [];
  const skipped = [];
  for (const conn of manifest.connections || []) {
    if (tenantId != null && conn.tenant != null && conn.tenant !== tenantId) continue;
    if (conn.status && UNUSABLE_STATUS.test(conn.status)) { skipped.push({ provider: conn.provider, reason: "status:" + conn.status }); continue; }
    const key = envKeyForProvider(conn.provider);
    if (!key) { skipped.push({ provider: conn.provider, reason: "no-env-mapping" }); continue; }
    const value = resolveSecretRef(conn.secretRef, options);
    if (!value) { skipped.push({ provider: conn.provider, reason: "unresolved-secret" }); continue; }
    env[key] = value;
    resolved.push(conn.provider);
  }
  return { env, resolved, skipped };
}

/**
 * A tenant-scoped env view: the tenant's managed credentials layered OVER a base env (process.env
 * by default). Pass as `options.env` to any bridge query / resolve*ApiKey — it uses the tenant's
 * credential where connected, the ambient base otherwise. No secret value is ever persisted.
 */
export function tenantEnv(tenantId, options = {}) {
  const base = options.base || process.env;
  const { env } = resolveTenantCredentials(tenantId, options);
  return { ...base, ...env };
}

export default { envKeyForProvider, resolveSecretRef, resolveTenantCredentials, tenantEnv };
