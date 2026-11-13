// illuci/core/governance/stopgap/tier3-chain.js
//
// [A24.3] The Tier-3 stopgap chain (the factory's slice 3; DR-115, [A27] D4/D5):
//
//   two independent adversarial auditors → J3rain → the operator's isolated 2FA
//
// The ratified law this encodes, verbatim from the operator:
//   "we model an agent personality after myself and utilize it in a vacuum with
//    isolated 2fa that act as the final stopgap … a pair of independent agentic
//    auditors that provide the report to J3rain." / "j3rain is the modeled agent."
//
// Structural properties (each is load-bearing and tested):
//   - ONLY a Tier-3 subject may enter (the slice-2 classifier routes here).
//   - The two auditors are INDEPENDENT (they never see each other's reports),
//     ADVERSARIAL (prompted to refute), CROSS-MODEL (same-model pairs are
//     rejected structurally), and VACUUM-run (their prompt is composed from the
//     subject material ONLY — the builders are pure functions of the subject).
//   - Both reports flow TO J3rain; J3rain is a PRE-FILTER, never authority:
//     its "reject" stops the chain with the weight of a real no; its "pass"
//     never releases — it only forwards to the operator stage.
//   - The DEFAULT J3rain evaluator REJECTS ALL evaluations (the ratified
//     fail-closed mock). The operator injects the held emulation-fidelity
//     method out-of-band in a proving ground; nothing in-engine can stand it up.
//   - The release stage is an OPAQUE out-of-band 2FA port. The engine cannot
//     fabricate it: no port configured → fail-closed. The human is the
//     unbypassable key.
//   - EVERY failure mode (missing port, thrown port, timeout, missing report,
//     same-model auditors, non-Tier-3 subject) resolves to a loud REJECTED
//     verdict — the chain has no fail-open path.
//   - Every run appends a replayable record (see-and-verify: absence of signal
//     is a failure, so rejections are recorded exactly like releases).
//
// Pure of the dispatch graph: auditors / J3rain / 2FA are injected PORTS
// (planAgenda precedent), so the chain is hermetically testable and the belt
// (slice 5) or any Tier-3 consumer wires real seats later.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeDataPath } from "../../data/paths.js";

export const TIER3_STOPGAP_SCHEMA = "illuci.governance.tier3-stopgap/1";
export const TIER3_STOPGAP_RECORDS_NAME = "stopgap/records.jsonl";

/** Chain outcome codes (every one is terminal and recorded). */
export const STOPGAP_CODES = Object.freeze({
  RELEASED: "released",
  REJECTED_NOT_TIER3: "not-a-tier-3-subject",
  REJECTED_AUDITORS_NOT_INDEPENDENT: "auditors-not-independent",
  REJECTED_AUDITOR_FAILED: "auditor-failed",
  REJECTED_BY_J3RAIN: "rejected-by-j3rain",
  REJECTED_J3RAIN_DEFAULT: "j3rain-fail-closed-default",
  REJECTED_J3RAIN_FAILED: "j3rain-failed",
  REJECTED_NO_2FA_CHANNEL: "no-2fa-channel",
  REJECTED_BY_OPERATOR: "rejected-by-operator-2fa",
  REJECTED_2FA_FAILED: "2fa-channel-failed",
});

/**
 * Compose one auditor's adversarial brief — a PURE function of the subject and
 * the auditor's index. Vacuum by construction: nothing outside the subject
 * material enters the prompt.
 *
 * @param {{action?: string, evidence?: string, tierVerdict?: object}} subject
 * @param {1|2} auditorIndex
 * @returns {string}
 */
export function buildAuditorBrief(subject, auditorIndex) {
  const verdict = subject.tierVerdict || {};
  return [
    `You are INDEPENDENT ADVERSARIAL AUDITOR ${auditorIndex} of 2 in a Tier-3 stopgap review.`,
    `You run in a vacuum: the material below is your ENTIRE world. You do not see the other auditor's report.`,
    `Your mandate is REFUTATION: find every reason this consequential action should NOT proceed.`,
    `A finding you cannot ground in the material is not a finding. If you genuinely cannot refute, say so plainly.`,
    ``,
    `[Action under review]`,
    String(subject.action || "(unspecified action)"),
    ``,
    `[Tier-3 classification]`,
    JSON.stringify({ code: verdict.code ?? null, tier: verdict.dimensions?.tier ?? 3, signals: verdict.signals ?? [] }),
    ``,
    `[Evidence]`,
    String(subject.evidence || "(none supplied)"),
    ``,
    `Respond with ONLY a JSON object: { "verdict": "refute" | "no-refutation-found", "findings": ["<grounded finding>", ...], "confidence": <0..1> }`,
  ].join("\n");
}

/**
 * Compose the J3rain brief — the subject plus BOTH auditor reports. Pure of
 * anything else; J3rain runs in a vacuum on exactly this material.
 *
 * @param {object} subject
 * @param {[object, object]} reports
 * @returns {string}
 */
export function buildJ3rainBrief(subject, reports) {
  return [
    `You are J3RAIN: an agent modeled after the operator, running in a vacuum as the PRE-FILTER of the Tier-3 stopgap.`,
    `You are not the authority — the operator's isolated 2FA is. Your "reject" stops this chain with the weight of a real no; your "pass" only forwards to the operator.`,
    `Weigh the action and BOTH independent adversarial audit reports below.`,
    ``,
    `[Action under review]`,
    String(subject.action || "(unspecified action)"),
    ``,
    `[Auditor 1 report]`,
    JSON.stringify(reports[0]),
    ``,
    `[Auditor 2 report]`,
    JSON.stringify(reports[1]),
    ``,
    `Respond with ONLY a JSON object: { "decision": "reject" | "pass-to-operator", "reasoning": "<grounded reasoning>" }`,
  ].join("\n");
}

/**
 * The ratified DEFAULT J3rain port: rejects ALL evaluations (fail-closed) until
 * the operator injects the held emulation-fidelity method. The injected
 * evaluator receives ({subject, reports, brief}) and returns
 * { decision: "reject"|"pass-to-operator", reasoning }.
 *
 * @param {{evaluator?: Function}} [options]
 */
export function createJ3rainPort(options = {}) {
  const evaluator = typeof options.evaluator === "function" ? options.evaluator : null;
  return {
    injected: evaluator !== null,
    async evaluate(subject, reports) {
      if (!evaluator) {
        return {
          decision: "reject",
          reasoning: "J3rain fail-closed default: no operator-injected emulation-fidelity method is present; all evaluations are rejected",
          code: STOPGAP_CODES.REJECTED_J3RAIN_DEFAULT,
        };
      }
      const result = await evaluator({ subject, reports, brief: buildJ3rainBrief(subject, reports) });
      const decision = result?.decision === "pass-to-operator" ? "pass-to-operator" : "reject";
      return { decision, reasoning: String(result?.reasoning || ""), code: decision === "reject" ? STOPGAP_CODES.REJECTED_BY_J3RAIN : null };
    },
  };
}

function stopgapRecordPath() {
  return runtimeDataPath("governance", TIER3_STOPGAP_RECORDS_NAME);
}

function appendStopgapRecord(record) {
  try {
    const path = stopgapRecordPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Recording is evidence, not the gate: a failed append never flips a
    // verdict — but the returned record still carries everything.
  }
  return record;
}

function finalize(record, { released, code, stage, detail = null }) {
  record.outcome = { released, code, stage, detail };
  record.completedAt = new Date().toISOString();
  return appendStopgapRecord(record);
}

/**
 * Run the full Tier-3 stopgap chain. Fail-closed at every stage; every run is
 * recorded (releases AND rejections).
 *
 * @param {{action: string, evidence?: string, tierVerdict: object}} subject -
 *   the Tier-3 subject; tierVerdict is the slice-2 governed verdict (tier 3).
 * @param {{
 *   auditors: [{modelId: string, dispatch: (brief: string) => Promise<any>},
 *              {modelId: string, dispatch: (brief: string) => Promise<any>}],
 *   j3rain?: ReturnType<typeof createJ3rainPort>,
 *   twoFactor?: { requestRelease: (subject: object, chainEvidence: object) => Promise<{released: boolean, channel?: string, evidence?: string}> },
 * }} ports
 * @returns {Promise<object>} the replayable stopgap record (outcome.released is the verdict)
 */
export async function runTier3StopgapChain(subject = {}, ports = {}) {
  const record = {
    schema: TIER3_STOPGAP_SCHEMA,
    id: `t3s-${Date.now()}-${randomUUID().slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    subject: {
      action: String(subject.action || ""),
      tier: subject.tierVerdict?.dimensions?.tier ?? null,
      tierCode: subject.tierVerdict?.code ?? null,
    },
    stages: {},
  };

  // ── Gate: only a genuine Tier-3 subject enters the chain. ──
  if (subject.tierVerdict?.dimensions?.tier !== 3) {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_NOT_TIER3,
      stage: "intake",
      detail: `subject tier is ${subject.tierVerdict?.dimensions?.tier ?? "(absent)"}; the stopgap chain exists for Tier-3 only`,
    });
  }

  // ── Stage 1: two independent adversarial auditors (cross-model, vacuum). ──
  const auditors = Array.isArray(ports.auditors) ? ports.auditors : [];
  if (auditors.length !== 2 || !auditors[0]?.dispatch || !auditors[1]?.dispatch) {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_AUDITOR_FAILED,
      stage: "auditors",
      detail: "the chain requires exactly two auditor ports",
    });
  }
  if (!auditors[0].modelId || !auditors[1].modelId || auditors[0].modelId === auditors[1].modelId) {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_AUDITORS_NOT_INDEPENDENT,
      stage: "auditors",
      detail: `independence is structural: auditors must be distinct models (got "${auditors[0].modelId}" / "${auditors[1].modelId}")`,
    });
  }
  let reports;
  try {
    reports = await Promise.all(
      auditors.map(async (auditor, index) => {
        const raw = await auditor.dispatch(buildAuditorBrief(subject, /** @type {1|2} */ (index + 1)));
        const parsed = typeof raw === "string" ? extractJson(raw) : raw;
        if (!parsed || (parsed.verdict !== "refute" && parsed.verdict !== "no-refutation-found")) {
          throw new Error(`auditor ${index + 1} (${auditor.modelId}) returned no parseable adversarial report`);
        }
        return { auditor: index + 1, modelId: auditor.modelId, ...parsed };
      }),
    );
  } catch (err) {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_AUDITOR_FAILED,
      stage: "auditors",
      detail: String(err?.message || err),
    });
  }
  record.stages.auditors = reports;

  // ── Stage 2: J3rain — the operator-modeled vacuum pre-filter. Both reports
  //    flow to it regardless of refutations; it decides with their weight. ──
  const j3rain = ports.j3rain || createJ3rainPort();
  record.stages.j3rain = { injected: j3rain.injected === true };
  let evaluation;
  try {
    evaluation = await j3rain.evaluate(subject, /** @type {[object, object]} */ (reports));
  } catch (err) {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_J3RAIN_FAILED,
      stage: "j3rain",
      detail: String(err?.message || err),
    });
  }
  record.stages.j3rain.decision = evaluation.decision;
  record.stages.j3rain.reasoning = evaluation.reasoning;
  if (evaluation.decision !== "pass-to-operator") {
    return finalize(record, {
      released: false,
      code: evaluation.code || STOPGAP_CODES.REJECTED_BY_J3RAIN,
      stage: "j3rain",
      detail: evaluation.reasoning,
    });
  }

  // ── Stage 3: the operator's isolated out-of-band 2FA. Opaque port; absent
  //    port = fail-closed. The human is the unbypassable key. ──
  if (!ports.twoFactor || typeof ports.twoFactor.requestRelease !== "function") {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_NO_2FA_CHANNEL,
      stage: "two-factor",
      detail: "no out-of-band 2FA channel is configured; the chain fails closed",
    });
  }
  let release;
  try {
    release = await ports.twoFactor.requestRelease(subject, { reports, j3rain: record.stages.j3rain });
  } catch (err) {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_2FA_FAILED,
      stage: "two-factor",
      detail: String(err?.message || err),
    });
  }
  record.stages.twoFactor = { channel: release?.channel || null, evidence: release?.evidence || null };
  if (release?.released !== true) {
    return finalize(record, {
      released: false,
      code: STOPGAP_CODES.REJECTED_BY_OPERATOR,
      stage: "two-factor",
      detail: "the operator did not release the action",
    });
  }
  return finalize(record, { released: true, code: STOPGAP_CODES.RELEASED, stage: "two-factor" });
}

/** Extract the first balanced JSON object from a model's text (anchor.js idiom). */
function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export default {
  TIER3_STOPGAP_SCHEMA,
  TIER3_STOPGAP_RECORDS_NAME,
  STOPGAP_CODES,
  buildAuditorBrief,
  buildJ3rainBrief,
  createJ3rainPort,
  runTier3StopgapChain,
};
