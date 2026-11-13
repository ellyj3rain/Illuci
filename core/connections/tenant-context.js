// core/connections/tenant-context.js
//
// [A22.3.4] Illuci Runtime service — request-scoped tenant context.
//
// Establishes the current tenant's resolved credentials as an ambient env for the duration of a
// request, so IN-PROCESS bridge calls route with the tenant's OWN credential — without threading
// env through every call site. The request boundary (http-transport) opens the context; bridges
// read it via resolveAmbientEnv() when no explicit env is passed.
//
// Caveat: AsyncLocalStorage does not cross process boundaries — a spawned topology run does not
// inherit the tenant env. Propagating tenant credentials to spawned children is a follow-up
// (pass the resolved env into the spawn environment at the dispatch boundary).

import { AsyncLocalStorage } from "node:async_hooks";
import { tenantEnv } from "./credential-resolver.js";

const store = new AsyncLocalStorage();

/**
 * Run `fn` with `tenantId`'s managed credentials as the ambient env. Default/anon tenants get no
 * override (they fall through to process.env). Any async work started inside `fn` inherits it.
 */
export function runWithTenant(tenantId, fn, options = {}) {
  if (tenantId == null || tenantId === "default") return fn();
  return store.run({ tenantId, env: tenantEnv(tenantId, options) }, fn);
}

/** The current tenant's env, or null if not inside a tenant context. */
export function currentTenantEnv() {
  return store.getStore()?.env ?? null;
}

/** The current tenantId, or null. */
export function currentTenantId() {
  return store.getStore()?.tenantId ?? null;
}

/** The env a bridge should read: an explicit override, else the ambient tenant env, else process.env. */
export function resolveAmbientEnv(explicitEnv) {
  return explicitEnv || currentTenantEnv() || process.env;
}

export default { runWithTenant, currentTenantEnv, currentTenantId, resolveAmbientEnv };
