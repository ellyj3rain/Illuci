// illuci/core/governance/authortime/override.js
//
// The GZDS-Override escape hatch. The floor gate is fail-closed by design - a blocking
// violation stops the commit - but a single-operator system needs a deliberate, recorded
// way to proceed anyway (a genuine emergency, a known-and-accepted exception, a migration
// the floor can't yet model). That hatch must be HARD to trip by accident and must leave a
// reason in the trail, so the audit record (audit.js) can capture WHY the floor was waived.
//
// The hatch is the GZDS_OVERRIDE env var. It is honored only when it carries a non-trivial
// REASON (>= 6 non-whitespace-trimmed chars) - a bare "1" / "true" / "y" does NOT override,
// because an override with no stated reason is exactly the silent bypass the gate exists to
// prevent. The reason is what gets recorded.
//
// Pure + hook-agnostic: takes the env map as a param (defaulting to process.env) so it is
// unit-testable with no global mutation. No I/O, no clock.

export const MIN_REASON_LEN = 6;

/**
 * Decide whether the GZDS floor gate is being deliberately overridden, and capture the
 * stated reason. An override counts only when GZDS_OVERRIDE is a non-empty, non-trivial
 * reason string (>= 6 chars after trimming) - a missing, empty, or too-short value does
 * NOT override (fail-closed: a reasonless bypass is not a bypass).
 *
 * @param {Record<string,string|undefined>} [env=process.env]  the environment map to read
 * @returns {{overridden:boolean, reason:string|null}}
 *   overridden:true  -> reason is the trimmed, recordable reason string
 *   overridden:false -> reason is null (absent / empty / too-trivial)
 */
export function checkOverride(env = process.env) {
  const raw = env && env.GZDS_OVERRIDE;
  if (typeof raw !== "string") {
    return { overridden: false, reason: null };
  }
  const reason = raw.trim();
  if (reason.length < MIN_REASON_LEN) {
    return { overridden: false, reason: null };
  }
  return { overridden: true, reason };
}

export default { checkOverride, MIN_REASON_LEN };
