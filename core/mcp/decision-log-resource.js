/**
 * illuci/core/mcp/decision-log-resource.js — the decision log as an MCP resource
 *
 * Ratified at [A63] / DR-073 per the pilot sequencing in
 * `constitutional/BILL_OF_STANDARDS.md (Standard 16)`. Tier-1 resource surface of the
 * MCP-boundary discipline. Sourced from `illuci/core/decisions/logger.js`
 * — the substrate's invariant provenance system.
 *
 * WHAT THIS EXPOSES: the substrate's decision provenance trail, READ-ONLY.
 * Every decision logged through illuci carries four obligatory fields
 * (humanStatus, modelStatus, timestamp, context) plus type/decision/inputs/
 * outputs/metadata. This resource lets an MCP consuming host READ that trail
 * — for audit, for control-plane aggregation, for "why was this decided"
 * introspection — without granting any write path.
 *
 * APPEND-ONLY + READ-ONLY: the decision log is append-only at the storage
 * layer (logger.js appends JSONL; never mutates). This MCP surface is
 * read-only by construction — it exposes `readDecisions` / `recentDecisions`
 * and NEVER `logDecision`. Writing a decision remains an in-process action
 * (the actor's humanStatus/modelStatus must be established at the call site,
 * not asserted by a remote MCP host). This is the audit-integrity invariant
 * (constitutional/10) operating on its own substrate: the log is the audit
 * surface, and the surface is observe-only.
 *
 * Schema name follows the `<surface>_v<N>` convention per constitutional/10
 * § "Schema-versioning discipline".
 */

import { readDecisions, recentDecisions } from '../decisions/logger.js';
import { surfaceUri, scrub } from '../identity/surface.js';

const RESOURCE_URI = surfaceUri('decisions');
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;


// ─────────────────────────────────────────────────────────────────────────
// DECISION LOG RESOURCE
// ─────────────────────────────────────────────────────────────────────────

export const DECISION_LOG_RESOURCE = {
  name: 'decision_log_v1',
  schema_version: '1.0.0',
  uri: RESOURCE_URI,
  mimeType: 'application/json',
  description: scrub(
    "The substrate's decision provenance trail (read-only). Every decision " +
    'logged through illuci carries obligatory provenance (humanStatus, modelStatus, ' +
    'timestamp, context) per illuci/core/decisions/logger.js. Read for audit, ' +
    'control-plane aggregation, or "why was this decided" introspection. ' +
    'This surface NEVER writes — logging a decision is an in-process action.',
  ),
  arguments: [
    {
      name: 'limit',
      description: `Max records to return (most recent first-trimmed). Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
      required: false,
    },
    {
      name: 'type',
      description: 'Optional: filter by decision type (topology-selection, dispatch, routing, config, override, etc.).',
      required: false,
    },
    {
      name: 'humanStatus',
      description: 'Optional: filter by humanStatus (operator-initiated, operator-approved, operator-absent, operator-overridden).',
      required: false,
    },
    {
      name: 'since',
      description: 'Optional: ISO-8601 timestamp; only decisions at or after this time.',
      required: false,
    },
  ],
  /**
   * Read the decision log with optional filters. Read-only by construction.
   * Returns MCP resource `contents` (a single JSON document).
   */
  read({ limit = DEFAULT_LIMIT, type = null, humanStatus = null, since = null } = {}) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    let records;
    if (type || humanStatus || since) {
      const filter = {};
      if (type) filter.type = type;
      if (humanStatus) filter.humanStatus = humanStatus;
      if (since) filter.since = since;
      records = readDecisions(filter).slice(-cap);
    } else {
      records = recentDecisions(cap);
    }

    return {
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              schema_version: '1.0.0',
              count: records.length,
              filters: { limit: cap, type, humanStatus, since },
              decisions: records,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export default { DECISION_LOG_RESOURCE };
