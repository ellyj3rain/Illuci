// illuci/core/governance/belt/warehouse-intake.js
//
// Warehouse-native intake for draft work packets. Draft labels are local
// coordination hints until S0 admits the packet and the owning project line or
// station ledger assigns durable coordinates. This keeps DR-117/DR-118 batch
// structure from being replaced by noun-derived labels.

import { buildWarehouseBelt } from "./warehouse-belt.js";

export const WAREHOUSE_INTAKE_SCHEMA = "illuci.governance.warehouse-intake/1";
export const INTAKE_COORDINATE_CLAIM = "warehouse-intake-coordinate-claim";
export const SUBBATCH_POLICY_SCHEMA = "illuci.governance.subbatch-policy/1";
export const INTAKE_SUBBATCH_LABEL_CLAIM = "warehouse-intake-sub-batch-label-claim";

export const DEFAULT_SUBBATCH_POLICY = Object.freeze({
  schema: SUBBATCH_POLICY_SCHEMA,
  posture: "advisory",
  route: "operator",
  labelMode: "numeric-children",
  projectLetters: Object.freeze(["A"]),
  maxNumericDepth: 4,
});

const DURABLE_COORDINATE_RE = /(^|[^A-Za-z0-9_-])(\[?([A-Z])(\d+(?:\.\d+){0,3})\]?)(?=$|[^A-Za-z0-9_-])/g;
const COORDINATE_LABEL_RE = /^([A-Z])(\d+(?:\.\d+){0,3})$/;
const SINGLE_LETTER_LABEL_PATTERNS = Object.freeze([
  { field: "table label", re: /^\s*\|\s*(?:\*\*)?\[?([A-Z])\]?(?:\*\*)?\s*\|/ },
  { field: "heading label", re: /^\s*#{1,6}\s+(?:\*\*)?(?:\[([A-Z])\]|([A-Z])\b)(?:\*\*)?\s*(?::|--|-|\||\s+-\s+|\s+\|\s+)/ },
  { field: "list label", re: /^\s*[-*+]\s+(?:\*\*)?(?:\[([A-Z])\]|([A-Z])\b)(?:\*\*)?\s*(?::|--|-|\||\s+-\s+|\s+\|\s+)/ },
  { field: "planning label", re: /^\s*(?:\*\*)?(?:\[([A-Z])\]|([A-Z])\b)(?:\*\*)?\s*(?::|--|-|\||\s+-\s+|\s+\|\s+)/ },
]);

function normalizePath(path) {
  return String(path == null ? "" : path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isPlanningArtifact(path) {
  return normalizePath(path).toLowerCase().endsWith(".md");
}

function addedLines(oldContent, newContent) {
  const prior = new Map();
  for (const line of String(oldContent || "").split(/\r?\n/)) {
    prior.set(line, (prior.get(line) || 0) + 1);
  }
  const added = [];
  const lines = String(newContent || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const count = prior.get(line) || 0;
    if (count > 0) {
      prior.set(line, count - 1);
    } else {
      added.push({ lineNumber: i + 1, text: line });
    }
  }
  return added;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLabelDecorations(value) {
  return String(value == null ? "" : value).trim().replace(/^\[/, "").replace(/\]$/, "");
}

function resolveSubBatchPolicy(policy) {
  const proposed = policy && typeof policy === "object" ? policy : {};
  const projectLetters = Array.isArray(proposed.projectLetters) && proposed.projectLetters.length > 0
    ? proposed.projectLetters.map((letter) => String(letter || "").toUpperCase()).filter(Boolean)
    : [...DEFAULT_SUBBATCH_POLICY.projectLetters];
  return {
    ...DEFAULT_SUBBATCH_POLICY,
    ...proposed,
    schema: SUBBATCH_POLICY_SCHEMA,
    projectLetters,
    maxNumericDepth: Number.isInteger(proposed.maxNumericDepth)
      ? proposed.maxNumericDepth
      : DEFAULT_SUBBATCH_POLICY.maxNumericDepth,
  };
}

function parseCoordinateLabel(value) {
  const bare = stripLabelDecorations(value);
  const match = COORDINATE_LABEL_RE.exec(bare);
  if (!match) return null;
  const numberParts = match[2].split(".");
  return {
    bare,
    letter: match[1].toUpperCase(),
    number: match[2],
    numberParts,
  };
}

function hasWarehouseContext(line) {
  return /\b(warehouse|belt|station|ledger|transition|airlock|intake|promotion|W-PARENT)\b/i.test(String(line || ""));
}

function isWarehouseCoordinate(letter, number) {
  return (letter === "W" || letter === "S") && /^[0-7]$/.test(number);
}

function isLabelContext(line, token) {
  const t = escapeRegExp(token.replace(/^\[/, "").replace(/\]$/, ""));
  const source = String(line || "");
  return (
    new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:[-*+]\\s*)?(?:\\|\\s*)?(?:\\*\\*)?\\[?${t}\\]?\\b`).test(source) ||
    new RegExp(`\\|\\s*\\[?${t}\\]?\\s*\\|`).test(source) ||
    new RegExp(`\\b\\[?${t}\\]?\\s*(?::|--|-|\\u2014|\\|)`).test(source)
  );
}

function coordinateFinding({ token, letter, number, line, lineNumber, path, field = "planning artifact" }) {
  const bare = stripLabelDecorations(token);
  if (letter === "A" || letter === "B") return null;
  if (isWarehouseCoordinate(letter, number) && hasWarehouseContext(line)) return null;
  return {
    code: INTAKE_COORDINATE_CLAIM,
    path: normalizePath(path),
    line: lineNumber || null,
    token: bare,
    field,
    reason:
      `draft ${field} uses "${bare}" like a durable coordinate, but durable coordinates come from the repo batch line or warehouse station ledger after DR-118 reason/confirmation/record`,
  };
}

function subBatchPolicyView(policy) {
  return {
    schema: policy.schema,
    posture: policy.posture,
    route: policy.route,
    labelMode: policy.labelMode,
    projectLetters: [...policy.projectLetters],
    maxNumericDepth: policy.maxNumericDepth,
  };
}

function isGovernanceLedgerHeading(line) {
  return /^\s*#{1,6}\s+(?:DR|F)-\d+\b/.test(String(line || ""));
}

function subBatchFinding({ token, line, lineNumber, path, field = "planning label", reason, policy }) {
  const activePolicy = resolveSubBatchPolicy(policy);
  return {
    code: INTAKE_SUBBATCH_LABEL_CLAIM,
    path: normalizePath(path),
    line: lineNumber || null,
    token: stripLabelDecorations(token),
    field,
    route: activePolicy.route,
    policy: subBatchPolicyView(activePolicy),
    reason,
  };
}

function firstSingleLetterLabel(line) {
  const source = String(line || "");
  if (isGovernanceLedgerHeading(source)) return null;
  for (const pattern of SINGLE_LETTER_LABEL_PATTERNS) {
    const match = pattern.re.exec(source);
    if (!match) continue;
    const token = match.slice(1).find(Boolean);
    if (token) return { token, field: pattern.field };
  }
  return null;
}

function assessSubBatchLabels(change = {}, options = {}) {
  const path = normalizePath(change.path);
  if (!isPlanningArtifact(path)) {
    return { ok: true, schema: WAREHOUSE_INTAKE_SCHEMA, findings: [] };
  }

  const policy = resolveSubBatchPolicy(options.subBatchPolicy || options.policy);
  const findings = [];
  for (const line of addedLines(change.oldContent, change.newContent)) {
    const label = firstSingleLetterLabel(line.text);
    if (!label) continue;
    findings.push(subBatchFinding({
      token: label.token,
      line: line.text,
      lineNumber: line.lineNumber,
      path,
      field: label.field,
      policy,
      reason:
        `draft ${label.field} uses bare label "${label.token}" like a durable planning coordinate; parent/sub-batches normalize as numeric children of the governing batch (for example A14.1, A14.2) after operator-ratified parent selection, not noun-derived initials`,
    }));
  }
  return { ok: findings.length === 0, schema: WAREHOUSE_INTAKE_SCHEMA, findings };
}

function childLabelFor(parentBatch, index) {
  return `${parentBatch}.${index + 1}`;
}

function isImmediateChildLabel(parent, child, policy) {
  if (!parent || !child) return false;
  if (child.letter !== parent.letter) return false;
  if (!policy.projectLetters.includes(child.letter)) return false;
  if (child.numberParts.length !== parent.numberParts.length + 1) return false;
  if (child.numberParts.length > policy.maxNumericDepth) return false;
  return child.number.startsWith(`${parent.number}.`);
}

export function assessWarehouseIntakeCoordinates(change = {}, options = {}) {
  const path = normalizePath(change.path);
  if (!isPlanningArtifact(path)) {
    return { ok: true, schema: WAREHOUSE_INTAKE_SCHEMA, findings: [] };
  }

  const findings = [];
  const subBatch = assessSubBatchLabels(change, options);
  findings.push(...subBatch.findings);

  for (const line of addedLines(change.oldContent, change.newContent)) {
    DURABLE_COORDINATE_RE.lastIndex = 0;
    for (const match of String(line.text || "").matchAll(DURABLE_COORDINATE_RE)) {
      const token = match[2];
      const letter = match[3].toUpperCase();
      const number = match[4];
      if (!isLabelContext(line.text, token)) continue;
      const finding = coordinateFinding({
        token,
        letter,
        number,
        line: line.text,
        lineNumber: line.lineNumber,
        path,
      });
      if (finding) findings.push(finding);
    }
  }

  return { ok: findings.length === 0, schema: WAREHOUSE_INTAKE_SCHEMA, findings };
}

export function prepareSubBatchPlan(input = {}) {
  const policy = resolveSubBatchPolicy(input.policy || input.subBatchPolicy);
  const path = input.path || "sub-batch-plan";
  const parent = parseCoordinateLabel(input.parentBatch);
  const findings = [];

  if (!parent || !policy.projectLetters.includes(parent.letter) || parent.numberParts.length >= policy.maxNumericDepth) {
    const token = stripLabelDecorations(input.parentBatch);
    findings.push(subBatchFinding({
      token: token || "(missing)",
      path,
      field: "parent batch",
      policy,
      reason: token
        ? `parent batch "${token}" is not an active project batch parent under the current sub-batch policy; use the owning project line or pass an explicit policy before assigning children`
        : "parent batch is required before Illuci can normalize numeric sub-batches",
    }));
  }

  const parentBatch = parent ? parent.bare : null;
  const slices = Array.isArray(input.slices) ? input.slices : [];
  const normalizedSlices = slices.map((slice, index) => {
    const proposedLabel = slice && slice.label != null ? String(slice.label).trim() : "";
    const normalizedLabel = parentBatch ? childLabelFor(parentBatch, index) : null;
    let batchLabel = proposedLabel ? null : normalizedLabel;

    if (proposedLabel) {
      const proposed = parseCoordinateLabel(proposedLabel);
      if (isImmediateChildLabel(parent, proposed, policy)) {
        batchLabel = proposed.bare;
      } else {
        findings.push(subBatchFinding({
          token: proposedLabel,
          path,
          field: "sub-batch label",
          policy,
          reason: parentBatch
            ? `sub-batch label "${stripLabelDecorations(proposedLabel)}" is not an immediate numeric child of parent batch "${parentBatch}"; use "${normalizedLabel}" unless the operator ratifies a different numeric child`
            : `sub-batch label "${stripLabelDecorations(proposedLabel)}" cannot be validated until the parent project batch is known`,
        }));
      }
    }

    return {
      localId: `sub-batch-slice-${index + 1}`,
      proposedLabel: proposedLabel || null,
      title: slice && slice.title ? String(slice.title) : `sub-batch-slice-${index + 1}`,
      batchLabel,
    };
  });

  return {
    ok: findings.length === 0,
    schema: WAREHOUSE_INTAKE_SCHEMA,
    parentBatch,
    policy: subBatchPolicyView(policy),
    slices: normalizedSlices,
    findings,
  };
}

export function prepareWarehouseIntakePacket(input = {}) {
  const belt = input.belt || buildWarehouseBelt();
  const intake = belt.stations[0];
  const slices = Array.isArray(input.slices) ? input.slices : [];
  const findings = [];
  const normalizedSlices = slices.map((slice, index) => {
    const proposedLabel = slice && slice.label != null ? String(slice.label).trim() : "";
    const localId = `intake-slice-${index + 1}`;
    if (proposedLabel) {
      const match = /^(\[?([A-Z])(\d+(?:\.\d+){0,3})\]?)$/.exec(proposedLabel);
      if (match) {
        findings.push(coordinateFinding({
          token: match[1],
          letter: match[2].toUpperCase(),
          number: match[3],
          line: proposedLabel,
          lineNumber: null,
          path: input.path || "warehouse-intake",
          field: "slice label",
        }));
      }
    }
    return {
      localId,
      proposedLabel: proposedLabel || null,
      title: slice && slice.title ? String(slice.title) : localId,
      durableCoordinate: null,
    };
  });

  return {
    ok: findings.length === 0,
    schema: WAREHOUSE_INTAKE_SCHEMA,
    stationId: intake.id,
    stationLedgerId: intake.ledgerId,
    slices: normalizedSlices,
    findings,
  };
}

export default {
  WAREHOUSE_INTAKE_SCHEMA,
  INTAKE_COORDINATE_CLAIM,
  INTAKE_SUBBATCH_LABEL_CLAIM,
  SUBBATCH_POLICY_SCHEMA,
  DEFAULT_SUBBATCH_POLICY,
  assessWarehouseIntakeCoordinates,
  prepareWarehouseIntakePacket,
  prepareSubBatchPlan,
};
