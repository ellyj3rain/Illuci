/**
 * illuci — Action Classifier · Audit
 *
 * Structured sink + in-memory ring for classifier verdicts. Every classifier
 * decision (allow / deny / undecided) is both logged through the provenance
 * logger (logDecision — the non-optional decision-record spine) and pushed to a
 * bounded in-memory ring buffer for fast recent-decision introspection.
 *
 * The ring buffer is a plain array bounded to a max; `.push` is wrapped so it
 * self-trims oldest-first. The gate-controller pushes the raw cls onto it AND
 * calls auditClassifierDecision — both, per the insertion contract.
 *
 * @module core/gates/classifier/audit
 */

import { logDecision } from "../../decisions/logger.js";
import { classifierAuditMax } from "./config.js";

/**
 * Map a classifier decision to a valid logger humanStatus. The logger rejects
 * any value outside VALID_HUMAN_STATUS; an automated verdict alone does not establish a human response.
 *
 * @param {string} decision
 * @returns {string}
 */
function humanStatusFor(decision) {
  return "operator-absent";
}

function summarizeArgs(args) {
  if (!args) return "";
  if (args.path) return args.path;
  if (args.command) return String(args.command).substring(0, 80);
  try {
    return JSON.stringify(args).substring(0, 100);
  } catch {
    return "";
  }
}

/**
 * In-memory ring buffer of recent classifier decisions. Bounded: `.push`
 * trims from the front when the length would exceed classifierAuditMax(). The
 * cap is read at push time so a tunable change takes effect live.
 *
 * @type {Array<object> & { push: (item: object) => number }}
 */
export const recentClassifierDecisions = [];

const _rawPush = Array.prototype.push;
recentClassifierDecisions.push = function boundedPush(item) {
  const ret = _rawPush.call(this, item);
  const max = classifierAuditMax();
  while (this.length > max) {
    this.shift();
  }
  return ret;
};

/**
 * Record a classifier verdict to the structured provenance sink.
 * Never throws — auditing must not break the gate path. A logger failure is
 * swallowed (the verdict still stands; only the record is lost).
 *
 * @param {{ decision: string, reason: string, tier: number, auditData?: object }} cls
 * @param {object} params — the gate-controller params ({ tool, args, source, ... })
 * @returns {object|null} the logged record, or null on failure
 */
export function auditClassifierDecision(cls, params) {
  try {
    const source = (params && params.source) || { model: "unknown", seat: "unknown" };
    return logDecision({
      humanStatus: humanStatusFor(cls?.decision),
      modelStatus: [source],
      context:
        `Action classifier ${cls?.decision} (tier ${cls?.tier}): ` +
        `${params?.tool}(${summarizeArgs(params?.args)}) — ${cls?.reason}`,
      type: "classifier-decision",
      decision: `Classifier ${cls?.decision} ${params?.tool}(${summarizeArgs(params?.args)})`,
      inputs: { tool: params?.tool, args: params?.args },
      metadata: {
        classifierDecision: cls?.decision,
        tier: cls?.tier,
        reason: cls?.reason,
        auditData: cls?.auditData || null,
      },
    });
  } catch {
    return null;
  }
}

export default { auditClassifierDecision, recentClassifierDecisions };
