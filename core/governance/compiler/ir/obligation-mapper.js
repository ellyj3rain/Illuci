// illuci/core/governance/compiler/ir/obligation-mapper.js
//
// The lowering rule: each declared obligation -> an enforcement TIER + a backend mechanism.
// Pure + total. The trigger x severity matrix is the ratified compiler design. A post-task
// HARD obligation cannot block after the fact, so it DOWNGRADES to carried (recorded as such).
// A HUMAN-severity obligation is deliberately un-mechanizable and lowers to no backend.

export const TIERS = Object.freeze({ HARD: "hard", CARRIED: "carried", SOFT: "soft", HUMAN: "human" });

// backend ids align with the four emitters in ../backends/.
const RULES = [
  { trigger: "pre-edit",      severity: "hard",    tier: "hard",    backend: "floor_atom" },
  { trigger: "pre-dispatch",  severity: "hard",    tier: "hard",    backend: "dispatch_gate" },
  { trigger: "session-init",  severity: "hard",    tier: "hard",    backend: "dispatch_gate" },
  { trigger: "content-write", severity: "hard",    tier: "hard",    backend: "floor_atom" },
  { trigger: "*",             severity: "carried", tier: "carried", backend: "carried_preamble" },
  { trigger: "post-task",     severity: "soft",    tier: "soft",    backend: "soft_verify" },
];

/**
 * @param {{trigger:string, severity:string}} ob
 * @returns {{tier:string, backend:string, downgraded?:boolean, human?:boolean, unmatched?:boolean}}
 */
export function mapObligation(ob) {
  if (ob.severity === "human") {
    return { tier: TIERS.HUMAN, backend: "none", human: true };
  }
  // post-task + hard: cannot block after the fact -> carried, flagged downgraded.
  if (ob.trigger === "post-task" && ob.severity === "hard") {
    return { tier: TIERS.CARRIED, backend: "carried_preamble", downgraded: true };
  }
  for (const r of RULES) {
    const triggerOk = r.trigger === "*" || r.trigger === ob.trigger;
    if (triggerOk && r.severity === ob.severity) {
      return { tier: r.tier, backend: r.backend };
    }
  }
  // A trigger x severity combination the matrix does not cover: no mechanism (a Class-B gap).
  return { tier: ob.severity || "unknown", backend: "none", unmatched: true };
}

export default { mapObligation, TIERS };
