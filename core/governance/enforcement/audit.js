/**
 * illuci — Enforcement Audit Sink (append-only, machine provenance)
 *
 * The canonical trail of every hard-gate override and soft-tier violation on the
 * dispatch path. Distinct from decisions/decisions.jsonl (human-decision
 * provenance) and from DECISION_REGISTRY.md (human-readable architectural
 * decisions): this is machine enforcement provenance. Append-only by
 * construction — appendFileSync, never read-modify-write.
 *
 * Home-path resolver + JSONL append pattern mirror decisions/logger.js and
 * bridges/model-discovery.js (the .illuci home convention).
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { resolveIlluciHomeRoot } from "../../bridges/tool-paths.js";

export const AUDIT_PATH = join(resolveIlluciHomeRoot(), ".illuci", "governance-audit.jsonl");

/**
 * Append one record. Returns { record, written } — `written` is the load-bearing
 * signal for the OVERRIDE precondition: a soft-violation drop may stay best-effort,
 * but an UNAUDITED override must fail closed (enforce.js reads this).
 */
function append(record) {
  let written = false;
  try {
    const dir = dirname(AUDIT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(AUDIT_PATH, JSON.stringify(record) + "\n", "utf-8");
    written = true;
  } catch (err) {
    // The audit must never THROW into a dispatch. A failed write logs; the caller
    // decides whether the drop is tolerable (soft) or fail-closed (override).
    console.warn(`[enforce-audit] write failed: ${err.message}`);
  }
  return { record, written };
}

const stamp = (prefix) => `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;

/**
 * Record a hard-gate override (the operator bypassed a policy denial via GateConfig).
 * Mirrored into the human decision stream by enforce.js — this file is the canonical trail.
 * Returns { record, written }; enforce.js fails the override CLOSED when written === false.
 */
export function recordOverride(rec = {}) {
  return append({
    id: stamp("OVR"),
    ts: new Date().toISOString(),
    kind: "dispatch-override",
    modelId: rec.modelId ?? null,
    seat: rec.seat ?? null,
    dispatchKind: rec.dispatchKind ?? null,
    deniedReason: rec.deniedReason ?? null,
    overrideBy: rec.overrideBy ?? null,
    ruleId: rec.ruleId ?? null,
    policySnapshotHash: rec.policySnapshotHash ?? null,
  });
}

/** Record a soft-tier invariant violation (off-critical-path verify pass; best-effort). */
export function recordViolation(rec = {}) {
  return append({
    id: stamp("VIO"),
    ts: new Date().toISOString(),
    kind: "soft-violation",
    modelId: rec.modelId ?? null,
    seat: rec.seat ?? null,
    invariantId: rec.invariantId ?? null,
    violates: rec.violates ?? true,
    reason: rec.reason ?? null,
    sample: typeof rec.sample === "string" ? rec.sample.slice(0, 200) : null,
  });
}

/** Read the audit trail (test + operator-surface convenience; never on the dispatch path). */
export function readAudit() {
  if (!existsSync(AUDIT_PATH)) return [];
  return readFileSync(AUDIT_PATH, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export default { recordOverride, recordViolation, readAudit, AUDIT_PATH };
