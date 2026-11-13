// core/connections/manager.js
//
// [A22.3.3] Illuci Runtime service — connection management ("configure your own auth").
//
// The operator/tenant-facing façade over the connection registry + manifest store: add (api-key /
// ssh / oauth-start), list (prompt-safe — never a secret value), and revoke a tenant's own
// connections. Records carry only opaque secretRefs; the credential-resolver dereferences them at
// the bridge edge ([A22.3.2]).

import {
  addApiKeyConnection,
  registerSshConnection,
  startOAuthConnection,
  revokeConnection,
  toPromptSafeConnection,
} from "./registry.js";
import { createConnectionManifestStore } from "./store.js";

/** List a tenant's connections as prompt-safe resources (no secret values). tenantId null = all. */
export function listTenantConnections(tenantId, options = {}) {
  const store = createConnectionManifestStore(options);
  const records = store.read().connections;
  const filtered =
    tenantId == null ? records : records.filter((c) => c.tenant == null || c.tenant === tenantId);
  return filtered.map((c) => toPromptSafeConnection(c));
}

/**
 * Add (or upsert) a connection. `input.authMethod` ∈ {api-key, ssh, oauth}; api-key/ssh need a
 * `secretRef`/`sshIdentityRef` (an opaque pointer, never a raw secret). Returns the prompt-safe view.
 */
export function addConnection(input = {}, options = {}) {
  const authMethod = input.authMethod || "api-key";
  let record;
  if (authMethod === "api-key") record = addApiKeyConnection(input, options);
  else if (authMethod === "ssh") record = registerSshConnection(input, options);
  else if (authMethod === "oauth") record = startOAuthConnection(input, options);
  else throw new Error(`unknown authMethod "${authMethod}" (expected api-key | ssh | oauth)`);

  const store = createConnectionManifestStore(options);
  const { connection } = store.upsertConnection(record, options);
  return toPromptSafeConnection(connection);
}

/** Revoke a connection by id; returns the prompt-safe revoked view. */
export function revokeTenantConnection(connectionId, options = {}) {
  const store = createConnectionManifestStore(options);
  const existing = store.read().connections.find((c) => c.connectionId === connectionId);
  if (!existing) throw new Error(`no connection: ${connectionId}`);
  const revoked = revokeConnection(existing, options);
  const { connection } = store.upsertConnection(revoked, options);
  return toPromptSafeConnection(connection);
}

export default { listTenantConnections, addConnection, revokeTenantConnection };
