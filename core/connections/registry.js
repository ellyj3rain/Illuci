export const CONNECTION_RECORD_SCHEMA = "illuci.connections.connection/1";
export const ROUTE_CONNECTION_BINDING_SCHEMA = "illuci.connections.route-binding/1";
export const ROUTE_CONNECTION_RESOLUTION_SCHEMA = "illuci.connections.route-resolution/1";

export const CONNECTION_AUTH_METHODS = Object.freeze(["oauth", "api-key", "ssh"]);
export const CONNECTION_STATUSES = Object.freeze([
  "pending",
  "configured",
  "valid",
  "invalid",
  "refresh-required",
  "revoked",
]);
export const ROUTE_BINDING_STATUSES = Object.freeze(["bound", "blocked", "unbound"]);
export const ROUTE_BINDING_KINDS = Object.freeze([
  "model",
  "tool",
  "provider",
  "git",
  "host",
  "infrastructure",
  "mcp",
]);

const RAW_SECRET_KEYS = new Set([
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "privateKey",
  "private_key",
  "sshPrivateKey",
  "ssh_private_key",
  "password",
  "passphrase",
  "credential",
  "secret",
]);

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

export class ConnectionValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "ConnectionValidationError";
    this.issues = issues;
  }
}

export class ConnectionSecretMaterialError extends Error {
  constructor(issues = []) {
    super("connection payload contains raw secret material; pass secretRef or sshIdentityRef instead");
    this.name = "ConnectionSecretMaterialError";
    this.issues = issues;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeStringArray(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(values.map((entry) => normalizeString(entry)).filter(Boolean))];
}

function normalizeAuthMethod(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/_/g, "-");
  if (key === "apikey") return "api-key";
  if (key === "oauth2") return "oauth";
  if (key === "ssh-key") return "ssh";
  return key;
}

function looksLikePrivateKey(value) {
  return typeof value === "string" && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function findRawSecretMaterial(value, path = []) {
  const issues = [];
  if (looksLikePrivateKey(value)) {
    issues.push({ path: path.join(".") || "(root)", reason: "private-key-literal" });
    return issues;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => issues.push(...findRawSecretMaterial(entry, [...path, String(index)])));
    return issues;
  }
  if (!isPlainObject(value)) return issues;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (RAW_SECRET_KEYS.has(key) && entry !== null && entry !== undefined && String(entry).trim() !== "") {
      issues.push({ path: nextPath.join("."), reason: "raw-secret-field" });
      continue;
    }
    issues.push(...findRawSecretMaterial(entry, nextPath));
  }
  return issues;
}

export function assertNoRawSecretMaterial(payload) {
  const issues = findRawSecretMaterial(payload);
  if (issues.length) throw new ConnectionSecretMaterialError(issues);
  return true;
}

function defaultStatusFor(authMethod, secretRef, sshIdentityRef) {
  if (authMethod === "oauth") return secretRef ? "valid" : "pending";
  if (authMethod === "api-key") return secretRef ? "configured" : "pending";
  if (authMethod === "ssh") return sshIdentityRef ? "configured" : "pending";
  return "pending";
}

function normalizeAudit(input, options = {}) {
  const audit = isPlainObject(input.audit) ? input.audit : {};
  const now = normalizeString(options.now) || new Date().toISOString();
  const createdAt = normalizeString(input.createdAt ?? input.created ?? audit.createdAt ?? audit.created ?? now);
  const updatedAt = normalizeString(input.updatedAt ?? input.updated ?? audit.updatedAt ?? audit.updated ?? now);
  return {
    createdAt,
    updatedAt,
    createdBy: normalizeString(input.createdBy ?? audit.createdBy) || null,
    updatedBy: normalizeString(input.updatedBy ?? audit.updatedBy) || null,
    source: normalizeString(input.source ?? audit.source) || null,
    reason: normalizeString(input.reason ?? audit.reason) || null,
    evidenceRefs: normalizeStringArray(input.evidenceRefs ?? audit.evidenceRefs),
  };
}

function validateConnection(record) {
  const issues = [];
  if (!record.connectionId || !CONNECTION_ID_PATTERN.test(record.connectionId)) {
    issues.push({ field: "connectionId", reason: "required-stable-id" });
  }
  if (!record.provider) issues.push({ field: "provider", reason: "required-provider" });
  if (!CONNECTION_AUTH_METHODS.includes(record.authMethod)) {
    issues.push({ field: "authMethod", reason: "unsupported-auth-method" });
  }
  if (!CONNECTION_STATUSES.includes(record.status)) {
    issues.push({ field: "status", reason: "unsupported-status" });
  }
  if (record.authMethod === "oauth" && !["pending", "revoked"].includes(record.status) && !record.secretRef) {
    issues.push({ field: "secretRef", reason: "oauth-completion-requires-secret-ref" });
  }
  if (record.authMethod === "api-key" && record.status !== "revoked" && !record.secretRef) {
    issues.push({ field: "secretRef", reason: "api-key-requires-secret-ref" });
  }
  if (record.authMethod === "ssh" && record.status !== "revoked" && !record.sshIdentityRef) {
    issues.push({ field: "sshIdentityRef", reason: "ssh-requires-identity-ref" });
  }
  if (record.authMethod !== "ssh" && record.sshIdentityRef) {
    issues.push({ field: "sshIdentityRef", reason: "ssh-identity-ref-only-valid-for-ssh-auth" });
  }
  if (issues.length) throw new ConnectionValidationError("invalid connection record", issues);
}

export function normalizeConnectionRecord(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new ConnectionValidationError("connection record must be an object", [{ field: "(root)", reason: "object-required" }]);
  }
  assertNoRawSecretMaterial(input);
  const authMethod = normalizeAuthMethod(input.authMethod);
  const secretRef = normalizeString(input.secretRef ?? input.credentialRef);
  const sshIdentityRef = normalizeString(input.sshIdentityRef);
  const status = normalizeString(input.status) || defaultStatusFor(authMethod, secretRef, sshIdentityRef);
  const audit = normalizeAudit(input, options);
  const record = {
    schema: CONNECTION_RECORD_SCHEMA,
    connectionId: normalizeString(input.connectionId),
    provider: normalizeString(input.provider),
    authMethod,
    account: input.account ?? null,
    tenant: input.tenant ?? null,
    scopes: normalizeStringArray(input.scopes),
    endpoint: normalizeString(input.endpoint),
    secretRef,
    sshIdentityRef,
    status,
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt,
    audit,
    metadata: isPlainObject(input.metadata) ? { ...input.metadata } : {},
  };
  validateConnection(record);
  return Object.freeze({
    ...record,
    scopes: Object.freeze([...record.scopes]),
    audit: Object.freeze({ ...record.audit, evidenceRefs: Object.freeze([...record.audit.evidenceRefs]) }),
    metadata: Object.freeze({ ...record.metadata }),
  });
}

export function startOAuthConnection(input, options = {}) {
  return normalizeConnectionRecord({ ...input, authMethod: "oauth", status: "pending", secretRef: null }, options);
}

export function completeOAuthConnection(record, completion = {}, options = {}) {
  const prior = normalizeConnectionRecord(record, options);
  if (prior.authMethod !== "oauth") {
    throw new ConnectionValidationError("connection is not an OAuth connection", [{ field: "authMethod", reason: prior.authMethod }]);
  }
  return normalizeConnectionRecord({
    ...prior,
    ...completion,
    authMethod: "oauth",
    status: completion.status || "valid",
    createdAt: prior.createdAt,
  }, options);
}

export function refreshOAuthConnection(record, refresh = {}, options = {}) {
  const prior = normalizeConnectionRecord(record, options);
  if (prior.authMethod !== "oauth") {
    throw new ConnectionValidationError("connection is not an OAuth connection", [{ field: "authMethod", reason: prior.authMethod }]);
  }
  return normalizeConnectionRecord({
    ...prior,
    ...refresh,
    authMethod: "oauth",
    status: refresh.status || "valid",
    createdAt: prior.createdAt,
  }, options);
}

export function addApiKeyConnection(input, options = {}) {
  return normalizeConnectionRecord({ ...input, authMethod: "api-key", status: input.status || "configured" }, options);
}

export function rotateApiKeyConnection(record, rotation = {}, options = {}) {
  const prior = normalizeConnectionRecord(record, options);
  if (prior.authMethod !== "api-key") {
    throw new ConnectionValidationError("connection is not an API-key connection", [{ field: "authMethod", reason: prior.authMethod }]);
  }
  return normalizeConnectionRecord({
    ...prior,
    ...rotation,
    authMethod: "api-key",
    status: rotation.status || "configured",
    createdAt: prior.createdAt,
  }, options);
}

export function registerSshConnection(input, options = {}) {
  return normalizeConnectionRecord({ ...input, authMethod: "ssh", status: input.status || "configured" }, options);
}

export function revokeConnection(record, options = {}) {
  const prior = normalizeConnectionRecord(record, options);
  return normalizeConnectionRecord({
    ...prior,
    status: "revoked",
    updatedAt: normalizeString(options.now) || new Date().toISOString(),
    reason: options.reason || prior.audit.reason,
  }, options);
}

function normalizeRouteKind(value) {
  const kind = normalizeString(value) || "model";
  return ROUTE_BINDING_KINDS.includes(kind) ? kind : "provider";
}

function routeIdFrom(input) {
  return normalizeString(input.routeId)
    || normalizeString(input.modelId)
    || normalizeString(input.toolChannel)
    || normalizeString(input.provider)
    || null;
}

function validateRouteBinding(binding) {
  const issues = [];
  if (!binding.bindingId || !CONNECTION_ID_PATTERN.test(binding.bindingId)) {
    issues.push({ field: "bindingId", reason: "required-stable-id" });
  }
  if (!binding.connectionId) issues.push({ field: "connectionId", reason: "required-connection-id" });
  if (!binding.routeId) issues.push({ field: "routeId", reason: "required-route-id" });
  if (!ROUTE_BINDING_KINDS.includes(binding.routeKind)) issues.push({ field: "routeKind", reason: "unsupported-route-kind" });
  if (!ROUTE_BINDING_STATUSES.includes(binding.status)) issues.push({ field: "status", reason: "unsupported-status" });
  if (issues.length) throw new ConnectionValidationError("invalid route connection binding", issues);
}

export function createRouteConnectionBinding(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new ConnectionValidationError("route binding must be an object", [{ field: "(root)", reason: "object-required" }]);
  }
  assertNoRawSecretMaterial(input);
  const routeKind = normalizeRouteKind(input.routeKind);
  const routeId = routeIdFrom(input);
  const connectionId = normalizeString(input.connectionId);
  const bindingId = normalizeString(input.bindingId) || `binding:${routeKind}:${routeId || "unknown"}:${connectionId || "unknown"}`;
  const audit = normalizeAudit(input, options);
  const binding = {
    schema: ROUTE_CONNECTION_BINDING_SCHEMA,
    bindingId,
    routeKind,
    routeId,
    connectionId,
    provider: normalizeString(input.provider),
    modelId: normalizeString(input.modelId),
    providerModelId: normalizeString(input.providerModelId),
    transport: normalizeString(input.transport),
    toolChannel: normalizeString(input.toolChannel),
    role: normalizeString(input.role),
    skillFramework: normalizeString(input.skillFramework),
    topology: normalizeString(input.topology),
    workPermitId: normalizeString(input.workPermitId),
    status: normalizeString(input.status) || "bound",
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt,
    audit,
    metadata: isPlainObject(input.metadata) ? { ...input.metadata } : {},
  };
  validateRouteBinding(binding);
  return Object.freeze({
    ...binding,
    audit: Object.freeze({ ...binding.audit, evidenceRefs: Object.freeze([...binding.audit.evidenceRefs]) }),
    metadata: Object.freeze({ ...binding.metadata }),
  });
}

export function bindRouteToConnection(route, connection, options = {}) {
  const record = normalizeConnectionRecord(connection, options);
  return createRouteConnectionBinding({
    ...route,
    connectionId: record.connectionId,
    provider: route?.provider || record.provider,
    status: ["revoked", "invalid"].includes(record.status) ? "blocked" : "bound",
  }, options);
}

export function toPromptSafeConnection(record) {
  const normalized = normalizeConnectionRecord(record);
  return Object.freeze({
    schema: CONNECTION_RECORD_SCHEMA,
    connectionId: normalized.connectionId,
    provider: normalized.provider,
    authMethod: normalized.authMethod,
    account: normalized.account,
    tenant: normalized.tenant,
    scopes: Object.freeze([...normalized.scopes]),
    endpoint: normalized.endpoint,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    credentialRefs: Object.freeze({
      hasSecretRef: !!normalized.secretRef,
      hasSshIdentityRef: !!normalized.sshIdentityRef,
    }),
    audit: normalized.audit,
  });
}

export function toMcpConnectionResource(record, options = {}) {
  const normalized = normalizeConnectionRecord(record);
  const safe = {
    ...toPromptSafeConnection(normalized),
    resource: "connection",
    referencePolicy: options.includeRefs ? "references-included" : "references-hidden",
  };
  if (options.includeRefs) {
    safe.refs = Object.freeze({
      secretRef: normalized.secretRef,
      sshIdentityRef: normalized.sshIdentityRef,
    });
  }
  return Object.freeze(safe);
}

export function listConnectionResources(records, options = {}) {
  return records.map((record) => toMcpConnectionResource(record, options));
}

export function resolveConnectionForRoute(binding, records, options = {}) {
  const normalizedBinding = createRouteConnectionBinding(binding, options);
  const connection = records.map((record) => normalizeConnectionRecord(record, options))
    .find((record) => record.connectionId === normalizedBinding.connectionId) || null;
  const blockedReason = !connection
    ? "connection-not-found"
    : ["revoked", "invalid"].includes(connection.status)
      ? `connection-${connection.status}`
      : null;
  return Object.freeze({
    schema: ROUTE_CONNECTION_RESOLUTION_SCHEMA,
    routeBinding: normalizedBinding,
    resolved: !!connection && !blockedReason,
    blockedReason,
    connection: connection ? toMcpConnectionResource(connection, options) : null,
  });
}

export function createConnectionRegistry(records = [], options = {}) {
  const store = new Map();
  function upsert(record, upsertOptions = options) {
    const normalized = normalizeConnectionRecord(record, upsertOptions);
    store.set(normalized.connectionId, normalized);
    return normalized;
  }
  for (const record of records) upsert(record, options);
  return Object.freeze({
    upsert,
    add: upsert,
    getRecord(connectionId) {
      return store.get(connectionId) || null;
    },
    get(connectionId, viewOptions = {}) {
      const record = store.get(connectionId);
      return record ? toMcpConnectionResource(record, viewOptions) : null;
    },
    list(viewOptions = {}) {
      return listConnectionResources([...store.values()], viewOptions);
    },
    bindRoute(route, connectionId, bindOptions = options) {
      const record = store.get(connectionId);
      if (!record) {
        throw new ConnectionValidationError("connection is not registered", [{ field: "connectionId", reason: "not-found" }]);
      }
      return bindRouteToConnection(route, record, bindOptions);
    },
    resolve(binding, resolveOptions = {}) {
      return resolveConnectionForRoute(binding, [...store.values()], resolveOptions);
    },
  });
}

export default {
  CONNECTION_RECORD_SCHEMA,
  ROUTE_CONNECTION_BINDING_SCHEMA,
  ROUTE_CONNECTION_RESOLUTION_SCHEMA,
  CONNECTION_AUTH_METHODS,
  CONNECTION_STATUSES,
  ROUTE_BINDING_KINDS,
  ConnectionValidationError,
  ConnectionSecretMaterialError,
  assertNoRawSecretMaterial,
  normalizeConnectionRecord,
  startOAuthConnection,
  completeOAuthConnection,
  refreshOAuthConnection,
  addApiKeyConnection,
  rotateApiKeyConnection,
  registerSshConnection,
  revokeConnection,
  createRouteConnectionBinding,
  bindRouteToConnection,
  toPromptSafeConnection,
  toMcpConnectionResource,
  listConnectionResources,
  resolveConnectionForRoute,
  createConnectionRegistry,
};
