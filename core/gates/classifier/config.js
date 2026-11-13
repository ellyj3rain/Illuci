/**
 * illuci — Action Classifier · Config
 *
 * Dark-flag + tunable surface for the permission-judgment engine.
 *
 * The classifier is the TIER 0 + TIER 1 action classifier inserted into the
 * gate-controller's out-of-scope path. It is OFF by default and entirely
 * additive: with ILLUCI_CLASSIFIER_ENABLED unset/false, requestApproval is
 * byte-identical to its pre-classifier behavior (out-of-scope flows straight
 * to the existing transport selection).
 *
 * Every reader here reads process.env at CALL TIME — never at import time —
 * so a test (or a host) can flip the flag between calls without re-importing.
 *
 * @module core/gates/classifier/config
 */

/**
 * Is the action classifier armed?
 *
 * Reads ILLUCI_CLASSIFIER_ENABLED at call time. Default OFF (false). Only the
 * exact string "true" (case-insensitive, trimmed) arms it — any other value,
 * including "1", "yes", or empty, leaves it off (fail-safe-default).
 *
 * @returns {boolean}
 */
export function isClassifierEnabled() {
  const raw = process.env.ILLUCI_CLASSIFIER_ENABLED;
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === "true";
}

/**
 * Maximum entries retained in the in-memory classifier audit ring buffer.
 * Tunable via ILLUCI_CLASSIFIER_AUDIT_MAX; clamped to a sane [1, 100000] range.
 * Read at call time.
 *
 * @returns {number}
 */
export function classifierAuditMax() {
  const raw = process.env.ILLUCI_CLASSIFIER_AUDIT_MAX;
  const parsed = raw != null ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 1000;
  return Math.min(parsed, 100000);
}

/**
 * Maximum entries retained in the getGitInfo resolution cache.
 * Tunable via ILLUCI_CLASSIFIER_GIT_CACHE_MAX; clamped to [1, 100000].
 * Read at call time.
 *
 * @returns {number}
 */
export function gitCacheMax() {
  const raw = process.env.ILLUCI_CLASSIFIER_GIT_CACHE_MAX;
  const parsed = raw != null ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 1000;
  return Math.min(parsed, 100000);
}

export default { isClassifierEnabled, classifierAuditMax, gitCacheMax };
