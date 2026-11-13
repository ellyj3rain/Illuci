/**
 * illuci datastore — the single trunk mutator + authority guard.
 *
 * writeRecord/writeRecords are the ONLY path that appends to the trunk. They
 * enforce authority-by-data-class: file-canonical kinds (persona genomes — AM-23,
 * the governance ledgers, and decisions.jsonl — DR-004) are NEVER written here;
 * those stay files and are projected read-only. Run/company/telemetry/observation
 * data — the homeless classes the trunk is system-of-record for — pass through.
 */
import { openDatastore } from "./index.js";

// memory = persona genomes (AM-23 file-only forever); decisions/governance are the
// append-only ledgers (DR-004 committed-seed). The trunk projects these read-only.
const FILE_CANONICAL_KINDS = new Set(["decisions", "governance", "memory"]);

export class AuthorityViolation extends Error {
  constructor(kind) {
    super(`datastore: kind '${kind}' is file-canonical (AM-23 / DR-004) — project read-only, never write`);
    this.name = "AuthorityViolation";
  }
}

function guard(kind) {
  if (FILE_CANONICAL_KINDS.has(kind)) throw new AuthorityViolation(kind);
}

export function writeRecord(input = {}) {
  guard(input.kind || "datastore");
  return openDatastore().trunk.append(input);
}

/** Atomic batch (one transaction) with the same per-record authority guard. */
export function writeRecords(inputs = []) {
  for (const r of inputs) guard(r.kind || "datastore");
  return openDatastore().trunk.appendMany(inputs);
}

export default { writeRecord, writeRecords, AuthorityViolation };
