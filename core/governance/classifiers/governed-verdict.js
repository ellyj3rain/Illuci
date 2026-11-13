// illuci/core/governance/classifiers/governed-verdict.js
//
// Shared deterministic verdict shape for source-owned classifiers. These
// helpers keep classifier output graph-like and auditable without requiring a
// trained model in the decision path.

export const SEVERITIES = Object.freeze({
  INFO: "info",
  WATCH: "watch",
  CAUTION: "caution",
  BLOCK: "block",
  OPERATOR: "operator",
});

export const RISK_BANDS = Object.freeze({
  CLEAR: "clear",
  WATCH: "watch",
  CAUTION: "caution",
  BLOCK: "block",
  OPERATOR: "operator",
});

const SEVERITY_WEIGHTS = Object.freeze({
  [SEVERITIES.INFO]: 0,
  [SEVERITIES.WATCH]: 1,
  [SEVERITIES.CAUTION]: 3,
  [SEVERITIES.BLOCK]: 8,
  [SEVERITIES.OPERATOR]: 13,
});

export function bool(value) {
  return value === true;
}

export function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function norm(value) {
  return String(value || "").trim().toLowerCase();
}

export function list(value) {
  return Array.isArray(value) ? value : [];
}

export function makeSignal(input = {}) {
  const severity = SEVERITY_WEIGHTS[input.severity] === undefined ? SEVERITIES.INFO : input.severity;
  const weight = Number.isFinite(input.weight) ? Math.max(0, input.weight) : SEVERITY_WEIGHTS[severity];
  return {
    code: norm(input.code) || "unnamed-signal",
    severity,
    weight,
    dimension: norm(input.dimension) || "general",
    evidence: String(input.evidence || "signal recorded"),
    next: input.next ? String(input.next) : null,
    provenance: input.provenance ? String(input.provenance) : "classifier-input",
    data: input.data && typeof input.data === "object" ? input.data : {},
  };
}

export function scoreSignals(signals = []) {
  return list(signals).reduce((sum, signal) => sum + (Number.isFinite(signal.weight) ? signal.weight : 0), 0);
}

export function riskBandFor(signals = []) {
  const normalized = list(signals);
  if (normalized.some((signal) => signal.severity === SEVERITIES.OPERATOR)) return RISK_BANDS.OPERATOR;
  if (normalized.some((signal) => signal.severity === SEVERITIES.BLOCK)) return RISK_BANDS.BLOCK;
  const score = scoreSignals(normalized);
  if (score >= 6) return RISK_BANDS.BLOCK;
  if (score >= 3) return RISK_BANDS.CAUTION;
  if (score >= 1) return RISK_BANDS.WATCH;
  return RISK_BANDS.CLEAR;
}

export function makeGovernedVerdict(input = {}) {
  const signals = list(input.signals).map(makeSignal);
  const riskBand = input.riskBand || riskBandFor(signals);
  const hardStop = riskBand === RISK_BANDS.BLOCK || riskBand === RISK_BANDS.OPERATOR;
  const requiresOperator = bool(input.requiresOperator) || riskBand === RISK_BANDS.OPERATOR;

  return {
    schema: "illuci.governance.classifier-verdict/1",
    classifier: String(input.classifier || "unknown-classifier"),
    subject: String(input.subject || "unknown-subject"),
    decision: String(input.decision || "operator-decision"),
    strategy: input.strategy ? String(input.strategy) : null,
    allowed: bool(input.allowed) && !hardStop,
    requiresOperator,
    code: norm(input.code) || "unclassified",
    evidence: String(input.evidence || "classifier emitted a governed verdict"),
    next: input.next ? String(input.next) : null,
    confidence: Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : 1,
    riskBand,
    riskScore: scoreSignals(signals),
    dimensions: input.dimensions && typeof input.dimensions === "object" ? input.dimensions : {},
    signals,
    audit: {
      signalCount: signals.length,
      blockingSignals: signals
        .filter((signal) => signal.severity === SEVERITIES.BLOCK || signal.severity === SEVERITIES.OPERATOR)
        .map((signal) => signal.code),
    },
  };
}

export default {
  SEVERITIES,
  RISK_BANDS,
  bool,
  int,
  norm,
  list,
  makeSignal,
  scoreSignals,
  riskBandFor,
  makeGovernedVerdict,
};
