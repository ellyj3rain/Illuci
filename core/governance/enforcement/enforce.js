/**
 * illuci — Enforcement Spine (the GZDS 3-tier law, wired onto every dispatch)
 *
 * Phase 6. ONE entry per tier. The spine ORCHESTRATES the existing tier
 * implementations — it owns no enforcement logic that already exists:
 *   - HARD   enforceDispatch  -> dispatch-policy (allowlist) + GateConfig (override)
 *   - CARRIED carryMandate    -> topologies/mandate.renderMandateBlock
 *   - SOFT   verifyDispatchSoft -> invariants/verify.verifyAll (off-critical-path)
 *
 * It deliberately lives under governance/ (not gates/): it consumes gates as a
 * leaf. The per-TOOL interactive gate (tools.js / gate-controller) is untouched —
 * the dispatch hard tier is policy-only, fail-closed, never a per-query prompt.
 */

import { renderMandateBlock } from "../../topologies/mandate.js";
import { evaluateDispatch, checkOverride, dispatchKindOf, getDispatchPolicy } from "./dispatch-policy.js";
import { recordOverride, recordViolation } from "./audit.js";

// ─── HARD tier ───────────────────────────────────────────────────────────────

function policyHash() {
  // A cheap stable fingerprint of the live policy so an audit record pins the
  // posture the override was granted against (not a security hash — provenance).
  try {
    const p = getDispatchPolicy();
    return String(JSON.stringify(p).length) + ":" + (p.enforce ? "armed" : "inert");
  } catch {
    return "unknown";
  }
}

/**
 * HARD tier on the DISPATCH path. A synchronous-fast POLICY verdict — no model
 * call, no operator prompt. Consults the dispatch policy, then GateConfig overrides;
 * fail-closed. On an override, writes an append-only audit record and allows.
 *
 * @param {{ modelId: string, options: object }} args
 * @returns {{ allowed: boolean, reason: string, override?: { by: string, ruleId: string } }}
 */
export function enforceDispatch({ modelId, options = {} } = {}) {
  const verdict = evaluateDispatch(modelId, options);
  if (verdict.decision === "allow") {
    return { allowed: true, reason: verdict.reason };
  }

  // Denied by policy — the operator MAY have configured a GateConfig override.
  const ov = checkOverride(modelId, options);
  if (ov.overridden) {
    const { record: rec, written } = recordOverride({
      modelId,
      seat: options.seat || null,
      dispatchKind: verdict.dispatchKind,
      deniedReason: verdict.reason,
      overrideBy: ov.by,
      ruleId: ov.ruleId,
      policySnapshotHash: policyHash(),
    });
    // The audit write is a PRECONDITION of the override: an UNAUDITED bypass is worse
    // than a denial. If the canonical record did not land, fail CLOSED — the operator
    // still has the policy denial, just no silent un-trailed bypass.
    if (!written) {
      return { allowed: false, reason: "override could not be audited" };
    }
    // Mirror into the human-readable decision stream (best-effort; never blocks).
    try {
      // Lazy import so a logger fault can never fail a dispatch.
      import("../../decisions/logger.js").then(({ logDecision }) => {
        try {
          logDecision({
            humanStatus: "operator-overridden",
            modelStatus: { model: modelId, role: options.seat || "dispatch" },
            context: `dispatch hard-gate override (${verdict.reason})`,
            type: "override",
            decision: `dispatch to ${modelId} allowed by ${ov.by}`,
            metadata: { auditId: rec.id, dispatchKind: verdict.dispatchKind, ruleId: ov.ruleId },
          });
        } catch { /* logger validation is non-fatal here */ }
      }).catch(() => {});
    } catch { /* import failure is non-fatal */ }
    return { allowed: true, reason: verdict.reason, override: { by: ov.by, ruleId: ov.ruleId } };
  }

  return { allowed: false, reason: verdict.reason };
}

/**
 * The dispatch-side seam for the compiled Bill's hard GATE obligations (repo-authority, scope,
 * MCP-boundary, sovereignty). Runs the APPLICABLE compiled gate enforcers over a dispatch
 * context; an enforcer stays inert until the caller plumbs the facts its predicate needs
 * (dispatched_branch, scope_record, ...) - the one honest follow-on. Async (the compiled gate is
 * dynamic-imported); a caller awaits it alongside the sync enforceDispatch policy verdict.
 * Ordinary dispatch retains fail-open on a missing or broken Bill. Selected consequential
 * creation requires the registered fit gate and fails closed when that gate cannot run.
 */
export async function enforceDispatchBill(context = {}) {
  try {
    const { runCompiledGate } = await import("../compiler/runtime/dispatch-bridge.js");
    return await runCompiledGate(context);
  } catch (err) {
    if (context.consequential_addition === true) {
      return { ok: false, blocking: [{ obligation: "std-14.modularity.creation-fit",
        reason: `creation-fit gate unavailable: ${String(err && err.message)}` }] };
    }
    return { ok: true, blocking: [], skipped: String(err && err.message) };
  }
}

// ─── CARRIED tier ─────────────────────────────────────────────────────────────

/**
 * CARRIED tier. Returns the message with the [Mandate] anchor guaranteed present —
 * UNCONDITIONAL (no seat guard): every dispatch that carries a mandate object gets
 * the anchor, seated or raw, sibling or spawn. Pure string-in/string-out, idempotent
 * via the existing [Mandate] presence check. Reuses renderMandateBlock so seat frames
 * and raw dispatches produce byte-identical mandate text.
 *
 * Raw mode keeps its preamble-skip by SEPARATION OF CONCERNS: this prepends only the
 * lean anchor; the verbose governance preamble stays injectGovernance's job (still
 * raw-gated). No dispatch escapes the law; raw stays lean.
 */
export function carryMandate(message, options = {}) {
  if (!options.mandate) return message;                 // no mandate configured -> unchanged (back-compat)
  // Idempotency keys on the FRAME POSITION: frame.js places [Mandate] FIRST. A model's own
  // body can contain the token "[Mandate]" anywhere, so an includes-anywhere check would
  // wrongly skip a real anchor — gate on startsWith the anchor instead.
  if (typeof message === "string" && message.startsWith("[Mandate]")) return message;
  const block = renderAnchor(options.mandate);
  if (!block) return message;
  return block + "\n\n" + message;
}

/**
 * Render the mandate anchor from EITHER a mandate object OR a pre-rendered string.
 * spawn.js threads the carried mandate as a JSON STRING (runner.js builds
 * carriedMandate = JSON.stringify(mandate)); calling renderMandateBlock on that string
 * would dereference mandate.intent.revision and throw. A string is treated as a
 * pre-rendered anchor: JSON-parse-then-render when it round-trips to a mandate, else
 * wrap the raw string under the anchor header so the law still rides every spawn.
 */
function renderAnchor(mandate) {
  if (typeof mandate === "string") {
    try {
      const parsed = JSON.parse(mandate);
      if (parsed && parsed.intent && typeof parsed.intent === "object") {
        const block = renderMandateBlock(parsed);
        if (block) return block;
      }
    } catch { /* not JSON — fall through to the literal-string wrap */ }
    return `[Mandate]\n${mandate}`;
  }
  return renderMandateBlock(mandate);
}

// ─── SOFT tier ────────────────────────────────────────────────────────────────

/** The soft pass is off-by-default-configurable via ILLUCI_VERIFY_SOFT. */
export function softVerifyEnabled() {
  const v = process.env.ILLUCI_VERIFY_SOFT;
  return v === "1" || v === "true" || v === "on";
}

/**
 * SOFT tier. Fire-and-forget wrapper over invariants/verify.verifyAll. Runs AFTER
 * the dispatch returns, NEVER awaited on the critical path — callers invoke it
 * without await, inside a `.catch(()=>{})`. Logs violations to the audit sink.
 * Returns nothing the caller waits on (resolves to void).
 *
 * The 2 hard invariants run deterministic .rule fns (no judge); the 4 soft ones use
 * the supplied judge. verify.js routes them — this spine adds only scheduling + audit.
 *
 * @param {{ output: string, modelId: string, seat?: string, judge: Function }} args
 */
export async function verifyDispatchSoft({ output, modelId, seat = null, judge } = {}) {
  if (!softVerifyEnabled()) return;
  if (typeof output !== "string" || output.length === 0) return;
  // Self-contained: the soft pass is off-critical-path and must never surface as an
  // unhandled rejection even if a caller forgets its .catch(). A judge or audit fault
  // is logged and dropped here — the dispatch already returned its result.
  try {
    // Lazy import keeps verify.js (and any judge graph) off the hot dispatch import path.
    const { verifyAll } = await import("../../invariants/verify.js");
    const results = await verifyAll(output, judge || (async () => '{"violates": false, "reason": "no judge"}'));
    for (const r of results) {
      if (r.violates) {
        recordViolation({ modelId, seat, invariantId: r.id, violates: true, reason: r.reason, sample: output });
      }
    }
  } catch (err) {
    console.warn(`[enforce-soft] verify pass failed (dropped): ${err?.message || err}`);
  }
}

/**
 * Build the soft-tier judge: a raw queryModel to a cheap fleet model. raw:true so the
 * judge call itself does not recurse into governance / mandate. JUDGE_MODEL defaults to
 * the cheap-tier id (operator may override via ILLUCI_JUDGE_MODEL — see the open fork on
 * model identity + cost ceiling). Same judge shape prove.mjs proved against.
 */
export const JUDGE_MODEL = process.env.ILLUCI_JUDGE_MODEL || "claude-haiku";

export function makeJudge(queryModel) {
  return async (prompt) => {
    const r = await queryModel(JUDGE_MODEL, prompt, { raw: true });
    return r?.response || "";
  };
}

export default { enforceDispatch, enforceDispatchBill, carryMandate, verifyDispatchSoft, softVerifyEnabled, makeJudge, JUDGE_MODEL };
