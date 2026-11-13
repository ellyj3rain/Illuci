// illuci/core/governance/posture-profile.js
//
// [A59] Operator-posture resolution. Version maturity is evidence, not
// authority: the active posture is resolved through profile/policy layers.
// Variables are justified gradients, not modes, and they cannot remove basic
// agent competence.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assessOdometer } from "./assess.js";

export const POSTURE_PROFILE_SCHEMA = "illuci.governance.posture-profile/1";

function freezeVariable(input) {
  return Object.freeze({
    id: input.id,
    kind: "gradient",
    range: Object.freeze({ min: 0, max: 1 }),
    effect: input.effect,
    justification: input.justification,
    low: input.low,
    high: input.high,
    cannotRemove: Object.freeze([...(input.cannotRemove || [])]),
  });
}

export const COMPETENCE_FLOOR = Object.freeze([
  "pursue-the-assigned-task",
  "maintain-target-and-authority-awareness",
  "retain-relevant-world-and-user-context",
  "use-authorized-tools-and-context-surfaces",
  "verify-claims-against-the-live-target",
  "surface-uncertainty-and-operator-relevant-risk",
]);

export const POSTURE_VARIABLE_REGISTRY = Object.freeze({
  contextReach: freezeVariable({
    id: "contextReach",
    effect: "Biases how widely an agent reconciles adjacent product, repository, user, and world context while staying inside the authorized task.",
    justification:
      "Prevents infrastructure tunnel vision without forcing every task into a broad research pass.",
    low: "Prefer the immediate target and already-loaded context unless evidence shows missing surroundings matter.",
    high: "Actively reconcile nearby systems, prior art, and user/world implications when they affect the target.",
    cannotRemove: ["retain-relevant-world-and-user-context", "maintain-target-and-authority-awareness"],
  }),
  proposalNovelty: freezeVariable({
    id: "proposalNovelty",
    effect: "Biases how readily an agent may consider unfamiliar or divergent routes after target, authority, and verification stay grounded.",
    justification:
      "LLM behavior is stochastic; the platform should guide novelty as a gradient without pretending to make a deterministic mode.",
    low: "Prefer established local patterns and conservative deltas.",
    high: "Allow broader alternatives and non-obvious refactors when the evidence supports them.",
    cannotRemove: ["verify-claims-against-the-live-target", "surface-uncertainty-and-operator-relevant-risk"],
  }),
  changeAssertiveness: freezeVariable({
    id: "changeAssertiveness",
    effect: "Biases how quickly an agent changes an improvable surface after proving the target, purpose, and verification path.",
    justification:
      "Alpha work needs the ability to improve rough surfaces without freezing every old artifact in place.",
    low: "Prefer notes, proposals, or small repairs unless the operator has already authorized the change.",
    high: "Prefer fixing or retiring rough live surfaces once their purpose and authority are proven.",
    cannotRemove: ["maintain-target-and-authority-awareness", "verify-claims-against-the-live-target"],
  }),
  residueTolerance: freezeVariable({
    id: "residueTolerance",
    effect: "Biases how much purposeless live code, config, or compatibility residue may remain after it is discovered.",
    justification:
      "History belongs in records and git; live residue needs a current purpose or a governed retirement path.",
    low: "Route purposeless live residue toward replacement or removal with recorded evidence.",
    high: "Permit more live residue while compatibility or migration evidence is gathered.",
    cannotRemove: ["surface-uncertainty-and-operator-relevant-risk", "verify-claims-against-the-live-target"],
  }),
  settlementWeight: freezeVariable({
    id: "settlementWeight",
    effect: "Biases how strongly existing stable contracts weigh against change.",
    justification:
      "Maturity can inform stability pressure, but the operator or project profile decides how much it matters.",
    low: "Treat existing contracts as movable when the current work justifies it.",
    high: "Require stronger migration and operator evidence before moving settled contracts.",
    cannotRemove: ["pursue-the-assigned-task", "surface-uncertainty-and-operator-relevant-risk"],
  }),
  delegationDiscretion: freezeVariable({
    id: "delegationDiscretion",
    effect: "Biases how much an orchestrator may decompose, allocate, or delegate without per-step instruction.",
    justification:
      "Individual, grouped, topology, company, and external orchestrators must remain usable as pieces, not forced into one wrapper.",
    low: "Prefer explicit operator or project allocations.",
    high: "Allow the active orchestrator to allocate work across appropriate agents when the boundary is clear.",
    cannotRemove: ["maintain-target-and-authority-awareness", "surface-uncertainty-and-operator-relevant-risk"],
  }),
  checkpointDensity: freezeVariable({
    id: "checkpointDensity",
    effect: "Biases how often an agent pauses or escalates for operator-visible review.",
    justification:
      "Auditability and operator discretion need checkpoints, but excessive checkpoints can stop the agent from doing basic work.",
    low: "Checkpoint mainly at destructive, architectural, publication, or authority-changing boundaries.",
    high: "Checkpoint more often when uncertainty, irreversible change, or policy ambiguity is present.",
    cannotRemove: ["pursue-the-assigned-task", "surface-uncertainty-and-operator-relevant-risk"],
  }),
});

export const POSTURE_VARIABLES = Object.freeze(Object.keys(POSTURE_VARIABLE_REGISTRY));

export const PROFILE_PRECEDENCE = Object.freeze([
  "operatorProfile",
  "projectPolicy",
  "agentProfile",
  "productDefault",
  "versionBaseline",
]);

function freezeVariables(input) {
  return Object.freeze({ ...input });
}

export const MATURITY_BASELINES = Object.freeze({
  unknown: freezeVariables({
    contextReach: 0.55,
    proposalNovelty: 0.5,
    changeAssertiveness: 0.5,
    residueTolerance: 0.25,
    settlementWeight: 0.5,
    delegationDiscretion: 0.35,
    checkpointDensity: 0.65,
  }),
  "pre-alpha": freezeVariables({
    contextReach: 0.72,
    proposalNovelty: 0.72,
    changeAssertiveness: 0.76,
    residueTolerance: 0.16,
    settlementWeight: 0.22,
    delegationDiscretion: 0.4,
    checkpointDensity: 0.78,
  }),
  alpha: freezeVariables({
    contextReach: 0.76,
    proposalNovelty: 0.68,
    changeAssertiveness: 0.78,
    residueTolerance: 0.12,
    settlementWeight: 0.34,
    delegationDiscretion: 0.52,
    checkpointDensity: 0.66,
  }),
  beta: freezeVariables({
    contextReach: 0.62,
    proposalNovelty: 0.42,
    changeAssertiveness: 0.46,
    residueTolerance: 0.1,
    settlementWeight: 0.68,
    delegationDiscretion: 0.42,
    checkpointDensity: 0.58,
  }),
  rc: freezeVariables({
    contextReach: 0.52,
    proposalNovelty: 0.26,
    changeAssertiveness: 0.32,
    residueTolerance: 0.08,
    settlementWeight: 0.84,
    delegationDiscretion: 0.28,
    checkpointDensity: 0.72,
  }),
  ga: freezeVariables({
    contextReach: 0.46,
    proposalNovelty: 0.18,
    changeAssertiveness: 0.24,
    residueTolerance: 0.06,
    settlementWeight: 0.92,
    delegationDiscretion: 0.24,
    checkpointDensity: 0.8,
  }),
});

export const PRODUCT_DEFAULT_PROFILE = Object.freeze({
  id: "illuci.product-default.posture-profile",
  source: "illuci",
  variables: Object.freeze({
    contextReach: 0.76,
    changeAssertiveness: 0.78,
    residueTolerance: 0.1,
    checkpointDensity: 0.62,
  }),
  policies: Object.freeze({
    versionAsEvidence: true,
    postureVariables: "justified-gradients",
    phraseBinding: "operator-assignable",
    competenceFloor: "non-removable",
    personaDispositionBoundary: "separate-layers",
    retirementDiscipline: "record-and-remove-dead-operational-surfaces",
    usefulDefectHandling: "fix-useful-remove-disposable",
    compatibilityDiscipline:
      "preserve published contracts with explicit migration; remove unneeded alpha/internal residue through governed retirement",
  }),
});

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeCoreVariables(input = {}, fallback = {}) {
  const normalized = {};
  for (const key of POSTURE_VARIABLES) {
    const fb = Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : 0;
    normalized[key] = clamp01(input?.[key], fb);
  }
  return normalized;
}

function normalizeSparseVariables(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { core: {}, custom: {} };
  const core = {};
  const custom = {};
  for (const [key, value] of Object.entries(input)) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value.value : value;
    if (POSTURE_VARIABLE_REGISTRY[key]) core[key] = clamp01(raw, 0);
    else if (Number.isFinite(Number(raw))) custom[key] = clamp01(raw, 0);
  }
  return { core, custom };
}

function normalizeLooseObject(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      out[key] = value;
    }
  }
  return out;
}

function normalizeVariableDefinitions(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    out[key] = normalizeLooseObject(value);
  }
  return out;
}

function normalizeProfile(input, fallbackId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const id = String(input.id || fallbackId).trim() || fallbackId;
  const source = String(input.source || fallbackId).trim() || fallbackId;
  const variables = normalizeSparseVariables(input.variables || {});
  return {
    id,
    source,
    invalid: input.invalid === true,
    variables: variables.core,
    customVariables: variables.custom,
    variableDefinitions: normalizeVariableDefinitions(input.variableDefinitions || {}),
    policies: normalizeLooseObject(input.policies || {}),
    actionBindings: normalizeLooseObject(input.actionBindings || input.bindings || {}),
    errors: Array.isArray(input.errors) ? input.errors.map((e) => String(e)) : [],
  };
}

function overlayProfile(resolved, profile) {
  if (!profile) return resolved;
  const variables = { ...resolved.variables };
  for (const key of POSTURE_VARIABLES) {
    if (Object.prototype.hasOwnProperty.call(profile.variables, key)) {
      variables[key] = clamp01(profile.variables[key], variables[key]);
    }
  }
  return {
    variables,
    customVariables: { ...resolved.customVariables, ...profile.customVariables },
    variableDefinitions: { ...resolved.variableDefinitions, ...profile.variableDefinitions },
    policies: { ...resolved.policies, ...profile.policies },
    actionBindings: { ...resolved.actionBindings, ...profile.actionBindings },
  };
}

function highestAuthority(applied) {
  for (const layer of PROFILE_PRECEDENCE) {
    if (applied.includes(layer)) return layer;
  }
  return "versionBaseline";
}

export function maturityFromVersion(version) {
  const assessment = assessOdometer(version);
  if (!assessment.legal) {
    return {
      version: assessment.version,
      legal: false,
      maturity: "unknown",
      violation: assessment.violation,
    };
  }
  return {
    version: assessment.version,
    legal: true,
    maturity: assessment.maturity || "ga",
    violation: null,
  };
}

export function readRootVersion(root = process.cwd()) {
  const path = join(root, "VERSION");
  if (!existsSync(path)) return null;
  const line = readFileSync(path, "utf8").split(/\r?\n/)[0]?.trim();
  return line || null;
}

export function parseProfileJson(raw, label = "profile") {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { id: `${label}:invalid`, source: label, invalid: true, errors: ["profile-json-not-object"] };
    }
    return parsed;
  } catch {
    return { id: `${label}:invalid`, source: label, invalid: true, errors: ["profile-json-invalid"] };
  }
}

export function resolvePostureProfile(input = {}) {
  const version = input.version || readRootVersion(input.root || process.cwd());
  const maturity = maturityFromVersion(version || "0.0.0.0");
  const baselineKey = Object.prototype.hasOwnProperty.call(MATURITY_BASELINES, maturity.maturity) ? maturity.maturity : "unknown";
  const versionBaseline = {
    id: `version-baseline:${baselineKey}`,
    source: "version-maturity",
    variables: MATURITY_BASELINES[baselineKey],
    policies: { versionAsEvidence: true },
  };

  const layerDefs = [
    ["versionBaseline", normalizeProfile(versionBaseline, "versionBaseline")],
    ["productDefault", normalizeProfile(input.productDefault || PRODUCT_DEFAULT_PROFILE, "productDefault")],
    ["agentProfile", normalizeProfile(input.agentProfile, "agentProfile")],
    ["projectPolicy", normalizeProfile(input.projectPolicy, "projectPolicy")],
    ["operatorProfile", normalizeProfile(input.operatorProfile, "operatorProfile")],
  ];

  let resolved = {
    variables: normalizeCoreVariables({}, MATURITY_BASELINES[baselineKey]),
    customVariables: {},
    variableDefinitions: { ...POSTURE_VARIABLE_REGISTRY },
    policies: {},
    actionBindings: {},
  };
  const layersApplied = [];
  const advisories = [
    {
      code: "version-evidence-not-authority",
      message: "Version maturity contributes a baseline only; explicit operator, project, and agent profiles remain authoritative.",
    },
    {
      code: "competence-floor-non-removable",
      message: "Posture variables bias priorities and thresholds; they cannot remove basic agent competence.",
    },
  ];

  for (const [layer, profile] of layerDefs) {
    if (!profile) continue;
    resolved = overlayProfile(resolved, profile);
    layersApplied.push(layer);
    if (profile.invalid) {
      advisories.push({
        code: "invalid-profile-ignored",
        layer,
        profile: profile.id,
        errors: profile.errors,
      });
    }
  }

  return {
    schema: POSTURE_PROFILE_SCHEMA,
    version,
    maturity: maturity.maturity,
    legalVersion: maturity.legal,
    versionViolation: maturity.violation,
    authority: highestAuthority(layersApplied),
    precedence: [...PROFILE_PRECEDENCE],
    layersApplied,
    profile: {
      variables: normalizeCoreVariables(resolved.variables, MATURITY_BASELINES[baselineKey]),
      customVariables: resolved.customVariables,
      variableDefinitions: resolved.variableDefinitions,
      policies: resolved.policies,
      actionBindings: resolved.actionBindings,
      competenceFloor: [...COMPETENCE_FLOOR],
    },
    contracts: {
      versionMaturity: "evidence-not-authority",
      variables: "justified-gradients-not-modes",
      competenceFloor: "non-removable",
      phraseBinding: "operator-assignable",
      personaDisposition: "separate-layers",
      profileScope: "per-operator-per-team-per-project-per-session",
    },
    advisories,
  };
}

export function postureProfileSnapshot({ env = process.env, root = process.cwd(), version = null } = {}) {
  return resolvePostureProfile({
    root,
    version: version || env?.ILLUCI_VERSION || null,
    operatorProfile: parseProfileJson(env?.ILLUCI_POSTURE_PROFILE, "ILLUCI_POSTURE_PROFILE"),
    projectPolicy: parseProfileJson(env?.ILLUCI_PROJECT_POSTURE_POLICY, "ILLUCI_PROJECT_POSTURE_POLICY"),
    agentProfile: parseProfileJson(env?.ILLUCI_AGENT_POSTURE_PROFILE, "ILLUCI_AGENT_POSTURE_PROFILE"),
  });
}

export default {
  POSTURE_PROFILE_SCHEMA,
  COMPETENCE_FLOOR,
  POSTURE_VARIABLE_REGISTRY,
  POSTURE_VARIABLES,
  PROFILE_PRECEDENCE,
  MATURITY_BASELINES,
  PRODUCT_DEFAULT_PROFILE,
  maturityFromVersion,
  readRootVersion,
  parseProfileJson,
  resolvePostureProfile,
  postureProfileSnapshot,
};
