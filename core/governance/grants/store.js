// core/governance/grants/store.js
//
// CAP-1: persistence for capability-grant records — the managed-connections
// pattern (registry validates, store persists, manager composes). The manifest
// is the OPERATOR-AUTHENTICATED source grant resolution reads (R4: nothing
// consumed by resolution comes from dispatch input). Append + revoke only —
// a grant record is never edited or deleted; revocation is a recorded act.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { runtimeDataPath } from "../../data/paths.js";
import { GRANT_MANIFEST_SCHEMA, GRANT_SCHEMA, GrantValidationError } from "./registry.js";

export const DEFAULT_GRANTS_MANIFEST_FILE = "grants/grants.json";

export function grantsManifestPath(options = {}) {
  return (
    options.manifestFile ||
    process.env.ILLUCI_GRANTS_MANIFEST ||
    runtimeDataPath("governance", DEFAULT_GRANTS_MANIFEST_FILE)
  );
}

export function loadGrantManifest(options = {}) {
  const path = grantsManifestPath(options);
  if (!existsSync(path)) return { schema: GRANT_MANIFEST_SCHEMA, grants: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Fail closed: a corrupt grant manifest must never silently become "no grants pass"
    // NOR "everything passes" — the caller sees the failure.
    throw new GrantValidationError(`grant manifest at ${path} is unreadable: ${err.message}`);
  }
  if (parsed?.schema !== GRANT_MANIFEST_SCHEMA || !Array.isArray(parsed.grants)) {
    throw new GrantValidationError(`grant manifest at ${path} has an unknown shape (expected ${GRANT_MANIFEST_SCHEMA})`);
  }
  return parsed;
}

function saveGrantManifest(manifest, options = {}) {
  const path = grantsManifestPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export function listGrants(filter = {}, options = {}) {
  const { grants } = loadGrantManifest(options);
  return grants.filter(
    (g) =>
      (!filter.layer || g.layer === filter.layer) &&
      (!filter.subjectId || g.subject?.id === filter.subjectId) &&
      (!filter.capability || g.capability === filter.capability),
  );
}

export function findGrant(id, options = {}) {
  const { grants } = loadGrantManifest(options);
  return grants.find((g) => g.id === id) || null;
}

export function appendGrant(record, options = {}) {
  if (record?.schema !== GRANT_SCHEMA) throw new GrantValidationError("appendGrant requires a normalized grant record");
  if (!record.signature) throw new GrantValidationError("appendGrant refuses an UNSIGNED record — sign the canonical payload first");
  const manifest = loadGrantManifest(options);
  if (manifest.grants.some((g) => g.id === record.id)) {
    throw new GrantValidationError(`grant id ${record.id} already exists — grants are append-only, never re-issued in place`);
  }
  manifest.grants.push(record);
  saveGrantManifest(manifest, options);
  return record;
}

export function markRevoked(id, revocation, options = {}) {
  const manifest = loadGrantManifest(options);
  const grant = manifest.grants.find((g) => g.id === id);
  if (!grant) throw new GrantValidationError(`grant ${id} not found`);
  if (grant.revocation) throw new GrantValidationError(`grant ${id} is already revoked (${grant.revocation.revokedAt})`);
  if (!revocation?.signature) throw new GrantValidationError("markRevoked refuses an UNSIGNED revocation — the revoking act is signed like the granting act");
  grant.revocation = revocation;
  saveGrantManifest(manifest, options);
  return grant;
}

export default { DEFAULT_GRANTS_MANIFEST_FILE, grantsManifestPath, loadGrantManifest, listGrants, findGrant, appendGrant, markRevoked };
