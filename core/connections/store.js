import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { runtimeDataPath } from "../data/paths.js";
import {
  ConnectionValidationError,
  assertNoRawSecretMaterial,
  createConnectionRegistry,
  createRouteConnectionBinding,
  listConnectionResources,
  normalizeConnectionRecord,
  resolveConnectionForRoute,
} from "./registry.js";

export const CONNECTION_MANIFEST_SCHEMA = "illuci.connections.manifest/1";
export const DEFAULT_CONNECTION_MANIFEST_FILE = "connections.json";

export function connectionManifestPath(options = {}) {
  return options.manifestFile
    || options.storeFile
    || process.env.ILLUCI_CONNECTION_MANIFEST
    || runtimeDataPath("connections", DEFAULT_CONNECTION_MANIFEST_FILE);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeRecordList(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return Object.values(value);
  return [];
}

function auditFrom(input = {}, options = {}) {
  const audit = isPlainObject(input.audit) ? input.audit : {};
  const now = normalizeString(options.now) || new Date().toISOString();
  return Object.freeze({
    createdAt: normalizeString(input.createdAt ?? audit.createdAt ?? now),
    updatedAt: normalizeString(input.updatedAt ?? audit.updatedAt ?? now),
    createdBy: normalizeString(input.createdBy ?? audit.createdBy) || null,
    updatedBy: normalizeString(input.updatedBy ?? audit.updatedBy) || null,
    source: normalizeString(input.source ?? audit.source) || null,
    reason: normalizeString(input.reason ?? audit.reason) || null,
  });
}

function duplicateIssues(records, key, field) {
  const seen = new Set();
  const duplicates = [];
  for (const record of records) {
    const value = record[key];
    if (!value) continue;
    if (seen.has(value)) duplicates.push({ field, reason: "duplicate", value });
    seen.add(value);
  }
  return duplicates;
}

function validateManifest(connections, routeBindings, options = {}) {
  const issues = [
    ...duplicateIssues(connections, "connectionId", "connections.connectionId"),
    ...duplicateIssues(routeBindings, "bindingId", "routeBindings.bindingId"),
  ];
  if (!options.allowUnresolvedRouteBindings) {
    const connectionIds = new Set(connections.map((connection) => connection.connectionId));
    for (const binding of routeBindings) {
      if (!connectionIds.has(binding.connectionId)) {
        issues.push({
          field: "routeBindings.connectionId",
          reason: "connection-not-declared",
          value: binding.connectionId,
        });
      }
    }
  }
  if (issues.length) throw new ConnectionValidationError("invalid connection manifest", issues);
}

export function normalizeConnectionManifest(input = {}, options = {}) {
  if (!isPlainObject(input)) {
    throw new ConnectionValidationError("connection manifest must be an object", [
      { field: "(root)", reason: "object-required" },
    ]);
  }
  assertNoRawSecretMaterial(input);
  const connections = normalizeRecordList(input.connections).map((record) => normalizeConnectionRecord(record, options));
  const routeBindings = normalizeRecordList(input.routeBindings ?? input.bindings)
    .map((binding) => createRouteConnectionBinding(binding, options));
  validateManifest(connections, routeBindings, options);
  const audit = auditFrom(input, options);
  return Object.freeze({
    schema: CONNECTION_MANIFEST_SCHEMA,
    connections: Object.freeze(connections),
    routeBindings: Object.freeze(routeBindings),
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt,
    audit,
    metadata: Object.freeze(isPlainObject(input.metadata) ? { ...input.metadata } : {}),
  });
}

export function emptyConnectionManifest(options = {}) {
  return normalizeConnectionManifest({ connections: [], routeBindings: [] }, options);
}

export function readConnectionManifestFile(options = {}) {
  const file = connectionManifestPath(options);
  if (!existsSync(file)) return emptyConnectionManifest(options);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    throw new ConnectionValidationError("connection manifest file is not valid JSON", [
      { field: "manifestFile", reason: "invalid-json", path: file, message: error.message },
    ]);
  }
  return normalizeConnectionManifest(parsed, options);
}

export function writeConnectionManifestFile(manifest, options = {}) {
  const file = connectionManifestPath(options);
  const normalized = normalizeConnectionManifest(manifest, options);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

function replaceById(records, idField, record) {
  return [...records.filter((candidate) => candidate[idField] !== record[idField]), record];
}

export function createConnectionManifestStore(options = {}) {
  const file = connectionManifestPath(options);

  function read(readOptions = {}) {
    return readConnectionManifestFile({ ...options, ...readOptions, manifestFile: file });
  }

  function write(manifest, writeOptions = {}) {
    return writeConnectionManifestFile(manifest, { ...options, ...writeOptions, manifestFile: file });
  }

  return Object.freeze({
    file,
    read,
    write,
    listConnections(viewOptions = {}) {
      return listConnectionResources(read().connections, viewOptions);
    },
    listRouteBindings() {
      return read().routeBindings.map((binding) => ({ ...binding, audit: { ...binding.audit } }));
    },
    upsertConnection(record, upsertOptions = {}) {
      const manifest = read();
      const connection = normalizeConnectionRecord(record, upsertOptions);
      const next = write({
        ...manifest,
        connections: replaceById(manifest.connections, "connectionId", connection),
        updatedAt: upsertOptions.now,
      }, upsertOptions);
      return {
        connection: next.connections.find((entry) => entry.connectionId === connection.connectionId),
        manifest: next,
      };
    },
    bindRoute(route, connectionId, bindOptions = {}) {
      const manifest = read();
      const registry = createConnectionRegistry(manifest.connections, bindOptions);
      const binding = registry.bindRoute(route, connectionId, bindOptions);
      const next = write({
        ...manifest,
        routeBindings: replaceById(manifest.routeBindings, "bindingId", binding),
        updatedAt: bindOptions.now,
      }, bindOptions);
      return {
        binding: next.routeBindings.find((entry) => entry.bindingId === binding.bindingId),
        manifest: next,
      };
    },
    resolve(bindingOrId, resolveOptions = {}) {
      const manifest = read();
      const binding = typeof bindingOrId === "string"
        ? manifest.routeBindings.find((entry) => entry.bindingId === bindingOrId || entry.routeId === bindingOrId)
        : bindingOrId;
      if (!binding) {
        throw new ConnectionValidationError("route binding is not registered", [
          { field: "bindingId", reason: "not-found", value: bindingOrId },
        ]);
      }
      return resolveConnectionForRoute(binding, manifest.connections, resolveOptions);
    },
  });
}

export default {
  CONNECTION_MANIFEST_SCHEMA,
  DEFAULT_CONNECTION_MANIFEST_FILE,
  connectionManifestPath,
  normalizeConnectionManifest,
  emptyConnectionManifest,
  readConnectionManifestFile,
  writeConnectionManifestFile,
  createConnectionManifestStore,
};