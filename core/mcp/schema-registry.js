/**
 * illuci/core/mcp/schema-registry.js — MCP-exposed schema catalog
 *
 * Ratified at [A55] / DR-062 per the pilot sequencing in
 * `constitutional/BILL_OF_STANDARDS.md (Standard 16)`. Implements the schema-versioning
 * discipline ratified at DR-059 / constitutional/10 § "Schema-versioning
 * discipline":
 *
 *   1. Every MCP-exposed schema carries an explicit `schema_version`
 *      from day one.
 *   2. Schemas evolve via deprecate-and-add, never destructively.
 *   3. Old clients pinned to old schemas continue to work alongside new
 *      clients pinned to new schemas until a ratified retraction batch.
 *
 * The registry is the substrate's enforcement surface: schemas without
 * an explicit `schema_version` are rejected at registration time.
 */

// ─────────────────────────────────────────────────────────────────────────
// REGISTRY STATE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Schema entries keyed by name (which includes the version suffix per the
 * naming convention: e.g., `governance_preamble_v1`).
 *
 * Shape per entry:
 *   {
 *     name: string,                  // e.g., 'governance_preamble_v1'
 *     schema_version: string,        // e.g., '1.0.0' (semver) or 'v1'
 *     kind: 'tool' | 'resource' | 'prompt',
 *     definition: object,            // the schema's contents (render fn, fields, etc.)
 *     registered_at: ISO8601 string,
 *     deprecated: boolean,           // true after deprecation; false until retracted
 *     supersedes: string | null,     // name of prior version if this is a successor
 *   }
 */
export const SCHEMA_REGISTRY = {};


// ─────────────────────────────────────────────────────────────────────────
// REGISTRATION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Register a schema. Refuses to register without an explicit
 * `schema_version` per the discipline.
 *
 * Throws:
 *   - if schema_version is missing or empty
 *   - if a schema with the same name already exists (re-registration is
 *     a substrate-discipline violation; use deprecate-and-add via a new
 *     name with version suffix bumped)
 */
export function registerSchema(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('registerSchema: entry must be an object');
  }
  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error('registerSchema: entry.name is required (string)');
  }
  if (!entry.schema_version) {
    throw new Error(
      `registerSchema: schema_version is required for ${entry.name} ` +
        '(per constitutional/10 § "Schema-versioning discipline")',
    );
  }
  if (!entry.kind || !['tool', 'resource', 'prompt'].includes(entry.kind)) {
    throw new Error(
      `registerSchema: kind must be one of tool|resource|prompt (got ${entry.kind})`,
    );
  }
  if (!entry.definition || typeof entry.definition !== 'object') {
    throw new Error('registerSchema: entry.definition is required (object)');
  }
  if (SCHEMA_REGISTRY[entry.name]) {
    throw new Error(
      `registerSchema: schema ${entry.name} already registered. Per the ` +
        'deprecate-and-add discipline at constitutional/10, evolve via a ' +
        'new schema name with version suffix bumped (e.g., ' +
        `${entry.name.replace(/_v\d+$/, '')}_v2), not in-place mutation.`,
    );
  }

  SCHEMA_REGISTRY[entry.name] = {
    name: entry.name,
    schema_version: entry.schema_version,
    kind: entry.kind,
    definition: entry.definition,
    registered_at: new Date().toISOString(),
    deprecated: false,
    supersedes: entry.supersedes || null,
  };
}


// ─────────────────────────────────────────────────────────────────────────
// LOOKUP
// ─────────────────────────────────────────────────────────────────────────

/**
 * Get a schema by name (which includes its version suffix).
 * Returns the registry entry or null if not found.
 */
export function getSchema(name) {
  return SCHEMA_REGISTRY[name] || null;
}

/**
 * List all registered schemas, optionally filtered by kind.
 */
export function listSchemas({ kind } = {}) {
  return Object.values(SCHEMA_REGISTRY).filter(
    (entry) => !kind || entry.kind === kind,
  );
}


// ─────────────────────────────────────────────────────────────────────────
// DEPRECATION (forward-noted; never retroactive)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mark a schema as deprecated. Old clients pinned to it continue to work
 * (the schema remains in the registry); new clients SHOULD migrate to the
 * successor (named via `supersededBy`).
 *
 * Retraction (removing a deprecated schema from the registry) requires a
 * ratified retraction batch per constitutional/10. This function only
 * deprecates; it does not remove.
 */
export function deprecateSchema(name, { supersededBy } = {}) {
  const entry = SCHEMA_REGISTRY[name];
  if (!entry) {
    throw new Error(`deprecateSchema: schema ${name} not found`);
  }
  entry.deprecated = true;
  if (supersededBy) {
    if (!SCHEMA_REGISTRY[supersededBy]) {
      throw new Error(
        `deprecateSchema: supersededBy ${supersededBy} not registered`,
      );
    }
    entry.superseded_by = supersededBy;
  }
}
