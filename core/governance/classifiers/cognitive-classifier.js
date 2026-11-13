// illuci/core/governance/classifiers/cognitive-classifier.js
//
// Sibling contract for cognitive classifier preflight. This contract does not
// inspect or store private chain-of-thought. It classifies the observable
// decision boundary before a seated model runs: task/seat context, authority,
// evidence posture, ontology posture, memory provenance, and model-control
// capability.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { ensureRuntimeDataPath } from "../../data/paths.js";
import { makeGovernedVerdict, makeSignal, SEVERITIES } from "./governed-verdict.js";
import { detectSpoofClaims } from "../grants/resolve.js";

export const COGNITIVE_CLASSIFICATION_SCHEMA = "illuci.governance.cognitive-classification/1";
export const COGNITIVE_CLASSIFICATION_RECORDS_RELPATH = ".illuci/data/governance/cognitive-classifications/records.jsonl";

const INTERNAL_RESOURCE_RE = /\b(?:gpt-oss|qwen|glm|deepseek|llama|gemma)\b/i;
const COMPUTE_POSTURES = new Set(["abundant", "bounded", "constrained", "unknown"]);
const DELEGATION_POSTURES = new Set(["explicit", "auto-filled", "convenience-selected", "under-specified"]);
const SKEPTICISM_POSTURES = new Set(["examined", "weakly-examined", "unexamined", "bias-risk"]);
const DOGFOOD_POSTURES = new Set(["utilize-available-compute", "conserve-cost", "portability-default"]);
const GOVERNANCE_POSTURES = new Set(["proceed", "widen-deliberation", "require-rationale", "pause"]);
const TOOL_SURFACE_FAMILIES = new Set([
  "code-ide",
  "database",
  "data-lab",
  "profiler",
  "browser-frontend",
  "desktop-gui",
  "api",
  "shell",
  "unknown",
]);
const TOOL_INTERFACE_POSTURES = new Set([
  "api-sufficient",
  "frontend-beneficial",
  "frontend-required",
  "desktop-control-candidate",
  "unknown",
]);
const COMPUTER_USE_POSTURES = new Set(["not-needed", "browser-only", "desktop-gui", "sandbox-required", "blocked"]);
const TOOL_SAFETY_POSTURES = new Set([
  "read-only",
  "logged-in-sensitive",
  "credential-sensitive",
  "destructive-risk",
  "payment-risk",
]);
const TOOL_GOVERNANCE_POSTURES = new Set([
  "proceed",
  "prefer-api",
  "require-frontend-verification",
  "require-sandbox",
  "require-operator-grant",
  "pause",
]);

function bool(value) {
  return value === true;
}

function str(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function enumStr(value, allowed, fallback) {
  const found = str(value);
  return found && allowed.has(found) ? found : fallback;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter(Boolean);
}

function lowerText(...values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => str(value, ""))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function textStats(task) {
  const text = typeof task === "string" ? task : "";
  return {
    present: text.length > 0,
    charLength: text.length,
  };
}

function supportedReasoning(control = {}) {
  return !!control && typeof control === "object" && control.supported === true;
}

function supportedThinking(control = {}) {
  return !!control && typeof control === "object" && control.supported === true;
}

function recommendedReasoning(reasoning = {}, current = null) {
  if (!supportedReasoning(reasoning)) return null;
  if (current) return current;
  if (str(reasoning.default)) return reasoning.default;
  const tiers = Array.isArray(reasoning.tiers) ? reasoning.tiers : [];
  return tiers.includes("medium") ? "medium" : (tiers[0] || null);
}

function modelBoundaryKind({ modelId, modelRuntime = {}, modelResource = {} } = {}) {
  const resourceId = str(modelRuntime.modelResourceId) || str(modelResource.id) || "";
  const label = str(modelResource.label) || str(modelRuntime.modelLabel) || "";
  const transport = str(modelRuntime.transport) || "";
  const provider = str(modelRuntime.providerResourceId) || "";
  const openWeightLike =
    provider === "provider.ollama.local" ||
    transport === "ollama" ||
    INTERNAL_RESOURCE_RE.test(`${modelId} ${resourceId} ${label}`);
  return openWeightLike ? "internal-steerable" : "observable-boundary";
}

function delegationPostureFor(source) {
  switch (source) {
    case "explicit-lineup":
    case "operator-lineup":
    case "org-lineup":
    case "persona-model-resource":
      return "explicit";
    case "role-auto-fill":
      return "auto-filled";
    case "harness-role-candidate":
    case "harness-mode-candidate":
    case "harness-preference":
      return "convenience-selected";
    default:
      return "under-specified";
  }
}

function dogfoodPostureFor(computePosture) {
  if (computePosture === "abundant") return "utilize-available-compute";
  if (computePosture === "bounded" || computePosture === "constrained") return "conserve-cost";
  return "portability-default";
}

function skepticismFor({ delegationPosture, source, rationale }) {
  if (rationale) return "examined";
  if (delegationPosture === "convenience-selected") return "bias-risk";
  if (delegationPosture === "under-specified" || source === "unfilled") return "unexamined";
  return "weakly-examined";
}

function governanceFor({ computePosture, delegationPosture, skepticismPosture, source }) {
  if (source === "unfilled") return "pause";
  if (skepticismPosture === "bias-risk" || skepticismPosture === "unexamined") return "require-rationale";
  if (computePosture === "abundant" && delegationPosture === "under-specified") return "widen-deliberation";
  return "proceed";
}

function motivationalVectorsFor(computePosture) {
  const vectors = [
    "avoid-provider-lock-in",
    "preserve-portability-for-constrained-deployments",
    "prevent-model-family-familiarity-as-judgment",
  ];
  if (computePosture === "abundant") {
    vectors.push("use-available-compute-when-dogfooding", "prevent-underpowered-runs");
  }
  return vectors;
}

function buildOrchestratorPosture(input = {}) {
  const explicit = input.orchestratorPosture && typeof input.orchestratorPosture === "object"
    ? input.orchestratorPosture
    : {};
  const provenance = input.selectionProvenance && typeof input.selectionProvenance === "object"
    ? input.selectionProvenance
    : {};
  const source = str(provenance.source, "not-recorded");
  const computePosture = enumStr(input.computePosture || explicit.computePosture, COMPUTE_POSTURES, "unknown");
  const delegationPosture = enumStr(
    explicit.delegationPosture,
    DELEGATION_POSTURES,
    delegationPostureFor(source),
  );
  const rationale = str(input.delegationRationale || provenance.rationale || explicit.rationale);
  const skepticismPosture = enumStr(
    explicit.skepticismPosture,
    SKEPTICISM_POSTURES,
    skepticismFor({ delegationPosture, source, rationale }),
  );
  const dogfoodPosture = enumStr(
    explicit.dogfoodPosture,
    DOGFOOD_POSTURES,
    dogfoodPostureFor(computePosture),
  );
  const governancePosture = enumStr(
    explicit.governancePosture,
    GOVERNANCE_POSTURES,
    governanceFor({ computePosture, delegationPosture, skepticismPosture, source }),
  );

  return {
    computePosture,
    delegationPosture,
    skepticismPosture,
    dogfoodPosture,
    governancePosture,
    motivationalVectors: motivationalVectorsFor(computePosture),
    selection: {
      source,
      selected: stringArray(provenance.selected),
      roleHint: str(provenance.roleHint),
      requiredMode: str(provenance.requiredMode),
      candidateCount: Number.isFinite(provenance.candidateCount) ? provenance.candidateCount : null,
      harnessModel: str(provenance.harnessModel),
    },
  };
}

function toolChannelsFrom(input = {}) {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  const grants = input.skillGrants && typeof input.skillGrants === "object" ? input.skillGrants : {};
  const channels = [
    ...stringArray(input.toolChannels),
    ...stringArray(input.enabledToolChannels),
    ...stringArray(explicit.toolChannels),
  ].map((value) => value.toLowerCase());
  if (Array.isArray(grants.mcpBridges) && grants.mcpBridges.length > 0) channels.push("mcp");
  return [...new Set(channels)];
}

function toolText(input = {}) {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  return lowerText(
    input.task,
    input.roleHint,
    input.intent,
    input.scope,
    input.toolSurface,
    input.surfaceHint,
    input.toolHint,
    input.interfaceHint,
    input.computerUseHint,
    input.surfaceHints,
    input.toolHints,
    explicit.surfaceHint,
    explicit.surfaceFamily,
    explicit.interfacePosture,
  );
}

function inferSurfaceFamily(input = {}, toolChannels = []) {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  const explicitSurface = enumStr(
    input.surfaceFamily || input.toolSurfaceFamily || explicit.surfaceFamily,
    TOOL_SURFACE_FAMILIES,
    null,
  );
  if (explicitSurface) return explicitSurface;

  const text = toolText(input);
  if (hasAny(text, [/\bdatagrip\b/, /\bsql\b/, /\bpostgres(?:ql)?\b/, /\bdatabase\b/, /\bmigration\b/, /\bschema\b/])) {
    return "database";
  }
  if (hasAny(text, [/\bdataspell\b/, /\bnotebook\b/, /\bdata lab\b/, /\bcorpus\b/, /\bjsonl\b/, /\bnormalization\b/, /\btraining data\b/, /\bclassifier data\b/])) {
    return "data-lab";
  }
  if (hasAny(text, [/\bdottrace\b/, /\bdotmemory\b/, /\bprofiler\b/, /\bprofile\b/, /\bmemory leak\b/, /\bperformance trace\b/])) {
    return "profiler";
  }
  if (hasAny(text, [/\bdesktop\b/, /\bgui\b/, /\bcomputer use\b/, /\bscreen\b/, /\bmouse\b/, /\bkeyboard\b/])) {
    return "desktop-gui";
  }
  if (hasAny(text, [/\bbrowser\b/, /\bfrontend\b/, /\bfront end\b/, /\bweb ui\b/, /\blogged-in\b/, /\blogin\b/, /\bbilling\b/, /\baccount settings\b/, /\bsettings page\b/, /\bclick\b/, /\bform\b/])) {
    return "browser-frontend";
  }
  if (hasAny(text, [/\bair\b/, /\bjetbrains\b/, /\bintellij\b/, /\bwebstorm\b/, /\bpycharm\b/, /\brider\b/, /\bclion\b/, /\brustrover\b/, /\bgoland\b/, /\btoolbox\b/, /\bide\b/])) {
    return "code-ide";
  }
  if (toolChannels.includes("browser")) return "browser-frontend";
  if (toolChannels.some((channel) => ["http", "github", "api", "mcp"].includes(channel))) return "api";
  if (toolChannels.includes("shell")) return "shell";
  return "unknown";
}

function frontendRequired(input = {}, surfaceFamily = "unknown") {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  if (bool(input.frontendRequired) || bool(explicit.frontendRequired)) return true;
  const text = toolText(input);
  return surfaceFamily === "browser-frontend" && hasAny(text, [
    /\bverify frontend\b/,
    /\bfrontend verification\b/,
    /\blogged-in\b/,
    /\blogin\b/,
    /\bbilling\b/,
    /\bplan\b/,
    /\bquota\b/,
    /\baccount settings\b/,
    /\bsettings page\b/,
  ]);
}

function desktopControlCandidate(input = {}, surfaceFamily = "unknown") {
  if (bool(input.desktopControlCandidate)) return true;
  const text = toolText(input);
  const desktopSurface = ["code-ide", "database", "data-lab", "profiler", "desktop-gui"].includes(surfaceFamily);
  if (!desktopSurface) return false;
  return surfaceFamily === "desktop-gui" || hasAny(text, [
    /\bair\b/,
    /\bjetbrains\b/,
    /\bintellij\b/,
    /\bdatagrip\b/,
    /\bdataspell\b/,
    /\bdottrace\b/,
    /\bdotmemory\b/,
    /\btoolbox\b/,
    /\bcomputer use\b/,
    /\buse (?:the )?(?:app|ide|frontend|gui)\b/,
    /\bopen (?:the )?(?:app|ide|frontend|gui)\b/,
  ]);
}

function apiEvidenceSufficient(input = {}, toolChannels = []) {
  if (bool(input.apiEvidenceSufficient)) return true;
  if (str(input.interfaceEvidence) === "api-sufficient") return true;
  return input.evidenceStatus === "sufficient"
    && toolChannels.some((channel) => ["http", "github", "api", "mcp"].includes(channel));
}

function inferInterfacePosture(input = {}, surfaceFamily = "unknown", toolChannels = []) {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  const explicitInterface = enumStr(
    input.interfacePosture || explicit.interfacePosture,
    TOOL_INTERFACE_POSTURES,
    null,
  );
  if (explicitInterface) return explicitInterface;
  if (frontendRequired(input, surfaceFamily)) return "frontend-required";
  if (desktopControlCandidate(input, surfaceFamily)) return "desktop-control-candidate";
  if (apiEvidenceSufficient(input, toolChannels) || surfaceFamily === "api") return "api-sufficient";
  if (surfaceFamily === "browser-frontend") return "frontend-beneficial";
  return "unknown";
}

function inferSafetyPosture(input = {}, surfaceFamily = "unknown", mode = "respond") {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  const explicitSafety = enumStr(input.safetyPosture || explicit.safetyPosture, TOOL_SAFETY_POSTURES, null);
  if (explicitSafety) return explicitSafety;

  const text = toolText(input);
  if (hasAny(text, [/\bpayment\b/, /\bpay\b/, /\bbilling\b/, /\binvoice\b/, /\bspending limit\b/, /\bsubscription\b/, /\bplan\b/])) {
    return "payment-risk";
  }
  if (hasAny(text, [/\bcredentials?\b/, /\bsecrets?\b/, /\btokens?\b/, /\bpassword\b/, /\b2fa\b/, /\bmfa\b/, /\bsession\b/, /\bcookie\b/, /\brecovery key\b/])) {
    return "credential-sensitive";
  }
  if (hasAny(text, [/\bdelete\b/, /\bremove\b/, /\bdrop\b/, /\bdestroy\b/, /\boverwrite\b/, /\bdeploy\b/, /\bapply\b/, /\bmutation\b/, /\bwrite\b/])) {
    return "destructive-risk";
  }
  if (["write", "execute"].includes(mode) && ["browser-frontend", "desktop-gui", "database", "profiler"].includes(surfaceFamily)) {
    return "destructive-risk";
  }
  if (["browser-frontend", "desktop-gui"].includes(surfaceFamily) || hasAny(text, [/\blogged-in\b/, /\baccount\b/])) {
    return "logged-in-sensitive";
  }
  return "read-only";
}

function hasComputerUseGrant(input = {}) {
  // [A38]/CAP-2 de-spoof (spec §4a; R4): the input booleans (computerUseGrant /
  // frontendGrant / operatorGrant) are DEAD — whoever constructed the dispatch
  // input could grant themselves. The ONLY source is the resolver-attached
  // capability resolution (__resolvedCapabilities), which
  // buildCognitiveClassification ALWAYS overwrites from its trusted
  // options.capabilityResolver — an input-supplied value is clobbered, so this
  // field is unforgeable by construction. No resolution → no grant (fail-closed).
  return input.__resolvedCapabilities?.capabilities?.["computer-use"]?.state === "granted";
}

function sandboxRequired(input = {}) {
  const grants = input.skillGrants && typeof input.skillGrants === "object" ? input.skillGrants : {};
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  const text = toolText(input);
  return bool(input.sandboxRequired)
    || bool(explicit.sandboxRequired)
    || bool(grants.autonomy?.sandboxRequired)
    || hasAny(text, [/\bcomputer use\b/, /\bdesktop control\b/, /\bclick\b/, /\bmouse\b/, /\bkeyboard\b/]);
}

function sandboxAvailable(input = {}) {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  return bool(input.sandboxAvailable) || bool(explicit.sandboxAvailable);
}

function inferComputerUsePosture(input = {}, surfaceFamily = "unknown", interfacePosture = "unknown", safetyPosture = "read-only") {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  const explicitComputerUse = enumStr(
    input.computerUsePosture || explicit.computerUsePosture,
    COMPUTER_USE_POSTURES,
    null,
  );
  if (explicitComputerUse) return explicitComputerUse;

  if (interfacePosture === "api-sufficient") return "not-needed";

  const needsGrant = ["credential-sensitive", "destructive-risk", "payment-risk"].includes(safetyPosture);
  if (needsGrant && !hasComputerUseGrant(input) && ["frontend-required", "desktop-control-candidate"].includes(interfacePosture)) {
    return safetyPosture === "payment-risk" ? "blocked" : "sandbox-required";
  }
  if (interfacePosture === "desktop-control-candidate" || surfaceFamily === "desktop-gui") {
    return sandboxRequired(input) ? "sandbox-required" : "desktop-gui";
  }
  if (surfaceFamily === "browser-frontend" || interfacePosture === "frontend-required" || interfacePosture === "frontend-beneficial") {
    return "browser-only";
  }
  return "not-needed";
}

function inferToolGovernance(input = {}, posture = {}) {
  const explicit = input.toolAffordancePosture && typeof input.toolAffordancePosture === "object"
    ? input.toolAffordancePosture
    : {};
  const explicitGovernance = enumStr(
    input.toolGovernancePosture || explicit.governancePosture,
    TOOL_GOVERNANCE_POSTURES,
    null,
  );
  if (explicitGovernance) return explicitGovernance;

  if (posture.safetyPosture === "payment-risk") return "pause";
  if (
    ["credential-sensitive", "destructive-risk"].includes(posture.safetyPosture)
    && ["browser-only", "desktop-gui", "sandbox-required", "blocked"].includes(posture.computerUsePosture)
    && !hasComputerUseGrant(input)
  ) {
    return "require-operator-grant";
  }
  if (
    posture.computerUsePosture === "sandbox-required"
    && !sandboxAvailable(input)
    && ["desktop-control-candidate", "frontend-required"].includes(posture.interfacePosture)
  ) {
    return "require-sandbox";
  }
  if (posture.interfacePosture === "frontend-required") return "require-frontend-verification";
  if (
    apiEvidenceSufficient(input, posture.toolChannels)
    && ["browser-frontend", "desktop-gui", "code-ide", "database", "data-lab", "profiler"].includes(posture.surfaceFamily)
    && posture.interfacePosture !== "frontend-required"
  ) {
    return "prefer-api";
  }
  return "proceed";
}

function buildToolIntegration(posture = {}) {
  let strategy = "surface-undetermined";
  let primarySurface = posture.surfaceFamily || "unknown";
  let supportingSurfaces = [];

  if (posture.governancePosture === "pause") {
    strategy = "operator-handback";
  } else if (posture.interfacePosture === "api-sufficient") {
    strategy = "api-first";
    primarySurface = "api";
    supportingSurfaces = posture.surfaceFamily && posture.surfaceFamily !== "api" && posture.surfaceFamily !== "unknown"
      ? [posture.surfaceFamily]
      : [];
  } else if (posture.interfacePosture === "frontend-required") {
    strategy = posture.toolChannels?.some((channel) => ["http", "github", "api", "mcp"].includes(channel))
      ? "api-plus-frontend-verification"
      : "frontend-verification";
    supportingSurfaces = strategy === "api-plus-frontend-verification"
      ? ["api", posture.surfaceFamily || "browser-frontend"]
      : [posture.surfaceFamily || "browser-frontend"];
  } else if (posture.computerUsePosture === "sandbox-required" || posture.computerUsePosture === "desktop-gui") {
    strategy = "desktop-gui-with-sandbox";
    supportingSurfaces = ["filesystem", "shell"].filter((surface) => posture.toolChannels?.includes(surface));
  } else if (posture.computerUsePosture === "browser-only") {
    strategy = "browser-frontend-verification";
    supportingSurfaces = posture.toolChannels?.includes("http") ? ["api"] : [];
  } else if (posture.surfaceFamily === "shell") {
    strategy = "shell-verification";
  }

  return {
    strategy,
    primarySurface,
    supportingSurfaces: [...new Set(supportingSurfaces.filter(Boolean))],
    evidenceRule: "record observable evidence; runtime/frontend evidence is not source truth unless promoted",
  };
}

function buildToolAffordancePosture(input = {}) {
  const toolChannels = toolChannelsFrom(input);
  const mode = str(input.mode, "respond");
  const surfaceFamily = inferSurfaceFamily(input, toolChannels);
  const interfacePosture = inferInterfacePosture(input, surfaceFamily, toolChannels);
  const safetyPosture = inferSafetyPosture(input, surfaceFamily, mode);
  const computerUsePosture = inferComputerUsePosture(input, surfaceFamily, interfacePosture, safetyPosture);
  const posture = {
    surfaceFamily,
    interfacePosture,
    computerUsePosture,
    safetyPosture,
    governancePosture: null,
    toolChannels,
    grants: {
      computerUse: hasComputerUseGrant(input),
      sandboxAvailable: sandboxAvailable(input),
      sandboxRequired: sandboxRequired(input),
      // [A38] spoof evidence: dead grant-claim fields present on the input.
      spoofedClaims: detectSpoofClaims(input),
    },
  };
  posture.governancePosture = inferToolGovernance(input, posture);
  posture.integration = buildToolIntegration(posture);
  return posture;
}

function authorityFor(input = {}) {
  const mode = str(input.mode, "respond");
  if (bool(input.operatorRequired)) return "operator-required";
  if (["write", "execute"].includes(mode)) return "proceed-with-gates";
  if (mode === "delegate") return "narrow";
  return "proceed";
}

function evidenceFor(input = {}) {
  const explicit = str(input.evidenceStatus);
  if (explicit) return explicit;
  if (bool(input.hasRuntimeEvidence)) return "sufficient";
  return "unverified";
}

function ontologyFor(input = {}) {
  return str(input.ontologyStatus, "aligned");
}

function memoryFor(input = {}) {
  if (bool(input.memoryPromotionRequired)) return "promotion-required";
  if (bool(input.memoryDerived)) return "memory-derived";
  if (bool(input.hasSourceMemory)) return "source";
  if (bool(input.hasRuntimeMemory)) return "runtime";
  return "none";
}

function buildControlAdvisory(input = {}, modelBoundary) {
  const controls = input.modelControls && typeof input.modelControls === "object" ? input.modelControls : {};
  const reasoning = controls.reasoning || {};
  const thinking = controls.thinking || {};
  const currentReasoning = str(input.currentControls?.reasoning);
  const currentThinking = typeof input.currentControls?.thinking === "boolean"
    ? input.currentControls.thinking
    : null;
  const controlsEnabled = bool(input.controlsEnforcementEnabled);
  const reasonRec = recommendedReasoning(reasoning, currentReasoning);
  const thinkingRec = supportedThinking(thinking)
    ? (currentThinking !== null ? currentThinking : modelBoundary === "internal-steerable")
    : null;

  return {
    enforcement: controlsEnabled ? "opt-in-active" : "advisory-only",
    reasoning: {
      supported: supportedReasoning(reasoning),
      current: currentReasoning,
      recommended: reasonRec,
      apply: controlsEnabled && supportedReasoning(reasoning) && !!reasonRec && !currentReasoning,
    },
    thinking: {
      supported: supportedThinking(thinking),
      current: currentThinking,
      recommended: thinkingRec,
      apply: controlsEnabled && supportedThinking(thinking) && thinkingRec !== null && currentThinking === null,
    },
  };
}

function buildSignals(dimensions) {
  const signals = [];
  if (dimensions.evidence.status === "unverified") {
    signals.push(makeSignal({
      code: "evidence-unverified",
      severity: SEVERITIES.WATCH,
      dimension: "evidence",
      evidence: "seat preflight has no verified evidence bundle yet",
      next: "verify-before-canonical-claim",
      provenance: "cognitive-classifier",
    }));
  }
  if (dimensions.ontology.status !== "aligned") {
    signals.push(makeSignal({
      code: "ontology-drift-risk",
      severity: SEVERITIES.CAUTION,
      dimension: "ontology",
      evidence: `ontology status is ${dimensions.ontology.status}`,
      next: "preserve-illuci-layer-boundaries",
      provenance: "cognitive-classifier",
    }));
  }
  if (dimensions.controlAdvisory.enforcement === "advisory-only" && dimensions.modelBoundary.kind === "internal-steerable") {
    signals.push(makeSignal({
      code: "internal-controls-advisory-only",
      severity: SEVERITIES.INFO,
      dimension: "model-boundary",
      evidence: "model appears internally steerable, but cognitive controls are advisory-only",
      next: "enable-controls-explicitly-if-needed",
      provenance: "cognitive-classifier",
    }));
  }
  if (dimensions.orchestratorPosture?.skepticismPosture === "bias-risk") {
    signals.push(makeSignal({
      code: "delegation-bias-risk",
      severity: SEVERITIES.CAUTION,
      dimension: "orchestrator-posture",
      evidence: `model delegation source is ${dimensions.orchestratorPosture.selection?.source || "not-recorded"}`,
      next: "record delegation rationale or widen model deliberation before treating the choice as governed judgment",
      provenance: "cognitive-classifier",
    }));
  } else if (dimensions.orchestratorPosture?.skepticismPosture === "unexamined") {
    signals.push(makeSignal({
      code: "delegation-rationale-missing",
      severity: SEVERITIES.WATCH,
      dimension: "orchestrator-posture",
      evidence: "model delegation provenance was under-specified",
      next: "preserve selection provenance before making delegation a durable claim",
      provenance: "cognitive-classifier",
    }));
  }
  if (
    dimensions.orchestratorPosture?.computePosture === "abundant" &&
    dimensions.orchestratorPosture?.delegationPosture === "under-specified"
  ) {
    signals.push(makeSignal({
      code: "abundant-compute-underused",
      severity: SEVERITIES.WATCH,
      dimension: "orchestrator-posture",
      evidence: "abundant compute posture was declared without a governed delegation choice",
      next: "use available compute deliberately or record why a narrower run is sufficient",
      provenance: "cognitive-classifier",
    }));
  }
  const tool = dimensions.toolAffordancePosture || {};
  if (tool.governancePosture === "pause") {
    signals.push(makeSignal({
      code: "tool-affordance-pause",
      severity: SEVERITIES.OPERATOR,
      dimension: "tool-affordance",
      evidence: `tool surface ${tool.surfaceFamily || "unknown"} carries ${tool.safetyPosture || "unknown"} posture`,
      next: "route-to-operator-before-frontend-or-computer-use-action",
      provenance: "cognitive-classifier",
    }));
  } else if (tool.governancePosture === "require-operator-grant") {
    signals.push(makeSignal({
      code: "computer-use-operator-grant-required",
      severity: SEVERITIES.OPERATOR,
      dimension: "tool-affordance",
      evidence: `computer-use posture is ${tool.computerUsePosture || "unknown"} with ${tool.safetyPosture || "unknown"} safety posture`,
      next: "obtain explicit operator grant before using logged-in frontend or desktop controls",
      provenance: "cognitive-classifier",
    }));
  } else if (tool.governancePosture === "require-sandbox") {
    signals.push(makeSignal({
      code: "computer-use-sandbox-required",
      severity: SEVERITIES.CAUTION,
      dimension: "tool-affordance",
      evidence: `computer-use posture is ${tool.computerUsePosture || "unknown"} and sandbox availability is not recorded`,
      next: "use a sandboxed desktop/browser substrate before granting control",
      provenance: "cognitive-classifier",
    }));
  } else if (tool.governancePosture === "require-frontend-verification") {
    signals.push(makeSignal({
      code: "frontend-verification-required",
      severity: SEVERITIES.WATCH,
      dimension: "tool-affordance",
      evidence: `API evidence does not fully cover ${tool.surfaceFamily || "the selected surface"}`,
      next: "use governed frontend verification and record observable evidence",
      provenance: "cognitive-classifier",
    }));
  } else if (tool.governancePosture === "prefer-api") {
    signals.push(makeSignal({
      code: "api-preferred-for-tool-evidence",
      severity: SEVERITIES.INFO,
      dimension: "tool-affordance",
      evidence: "API evidence appears sufficient for the current tool surface",
      next: "prefer API or structured records before operating a human frontend",
      provenance: "cognitive-classifier",
    }));
  }
  return signals;
}

export function buildCognitiveClassification(input = {}, options = {}) {
  // [A38]/CAP-2: resolve capability grants from the TRUSTED resolver option
  // (store-backed; R4) and ALWAYS overwrite the internal field — an
  // input-supplied __resolvedCapabilities is clobbered, never trusted. The
  // dead pre-CAP-2 grant booleans, if present on the input, are recorded as
  // spoof evidence (they no longer grant anything).
  const capabilityResolution =
    typeof options.capabilityResolver === "function"
      ? options.capabilityResolver({ seatId: input.seatId || null, runId: input.runId || null, tenantId: input.tenantId || null })
      : null;
  input = { ...input, __resolvedCapabilities: capabilityResolution || null };
  const timestamp = options.timestamp || input.timestamp || new Date().toISOString();
  const modelBoundary = modelBoundaryKind(input);
  const authority = authorityFor(input);
  const evidence = evidenceFor(input);
  const ontology = ontologyFor(input);
  const memory = memoryFor(input);
  const controlAdvisory = buildControlAdvisory(input, modelBoundary);
  const orchestratorPosture = buildOrchestratorPosture(input);
  const toolAffordancePosture = buildToolAffordancePosture(input);
  const dimensions = {
    decisionPosture: {
      intent: str(input.intent, input.mode ? `${input.mode}-seat-work` : "seat-work"),
      scope: str(input.scope, "seat-frame"),
      autonomyRecommendation: authority,
    },
    authority: {
      posture: authority,
      operatorRequired: authority === "operator-required",
      gateBounded: authority === "proceed-with-gates",
    },
    evidence: {
      status: evidence,
      requiresVerification: evidence !== "sufficient",
    },
    ontology: {
      status: ontology,
      layerBoundary: "company/topology -> seat -> model -> persona/disposition -> role -> skill-framework",
    },
    memory: {
      provenance: memory,
      promotionAllowed: false,
    },
    cognitionSubstrate: {
      disposition: bool(input.hasDisposition),
      persona: bool(input.hasPersona),
      memoryExtraction: { modeled: true, active: false },
      memoryReconstruction: { modeled: true, active: false },
      companyCognition: { modeled: true, active: bool(input.companyScope) },
      internalSteering: { modeled: true, active: controlAdvisory.enforcement === "opt-in-active" },
    },
    modelBoundary: {
      kind: modelBoundary,
      trainableLater: modelBoundary === "internal-steerable",
    },
    orchestratorPosture,
    toolAffordancePosture,
    controlAdvisory,
  };

  const subject = {
    kind: "seat-frame",
    topologyId: str(input.topologyId),
    topologyName: str(input.topologyName),
    phaseId: str(input.phaseId),
    seatId: str(input.seatId),
    seatLabel: str(input.seatLabel),
    roleHint: str(input.roleHint),
    modelId: str(input.modelId),
    requestedModel: str(input.requestedModel),
    agentId: str(input.agentId),
    agentSlug: str(input.agentSlug),
    runId: str(input.runId),
    sessionId: str(input.sessionId),
    projectId: str(input.projectId),
  };

  const signals = buildSignals(dimensions);
  const verdict = makeGovernedVerdict({
    classifier: "illuci.governance.cognitive",
    subject: [subject.topologyId, subject.phaseId, subject.seatId, subject.modelId].filter(Boolean).join("/") || "seat-frame",
    decision: authority,
    allowed: authority !== "operator-required",
    requiresOperator: authority === "operator-required",
    code: signals.length > 0 ? "cognitive-preflight-signals" : "cognitive-preflight-clear",
    evidence: "seat-frame cognitive preflight classified observable decision posture",
    next: authority === "operator-required" ? "route-to-operator" : "compose-seat-frame",
    dimensions,
    signals,
  });

  return {
    schema: COGNITIVE_CLASSIFICATION_SCHEMA,
    id: input.id || `cog-${Date.parse(timestamp) || Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp,
    source: input.source || "illuci.governance.cognitive-classifier",
    subject,
    inputs: {
      task: textStats(input.task),
      mode: str(input.mode, "respond"),
      controlsEnforcementEnabled: bool(input.controlsEnforcementEnabled),
      computePosture: orchestratorPosture.computePosture,
      selectionSource: orchestratorPosture.selection.source,
      toolSurfaceFamily: toolAffordancePosture.surfaceFamily,
      toolGovernancePosture: toolAffordancePosture.governancePosture,
    },
    dimensions,
    verdict,
  };
}

export function renderCognitiveBlock(record) {
  if (!record || record.schema !== COGNITIVE_CLASSIFICATION_SCHEMA) return null;
  const d = record.dimensions || {};
  const controls = d.controlAdvisory || {};
  const reason = controls.reasoning?.recommended ? `reasoning=${controls.reasoning.recommended}` : null;
  const thinking = controls.thinking?.recommended !== null && controls.thinking?.recommended !== undefined
    ? `thinking=${controls.thinking.recommended}`
    : null;
  const controlText = [reason, thinking].filter(Boolean).join(", ") || "no supported control recommendation";
  const orchestrator = d.orchestratorPosture || {};
  const orchestratorLine = orchestrator.governancePosture && orchestrator.governancePosture !== "proceed"
    ? `Orchestrator: compute=${orchestrator.computePosture || "unknown"}; delegation=${orchestrator.delegationPosture || "under-specified"}; skepticism=${orchestrator.skepticismPosture || "unexamined"}; governance=${orchestrator.governancePosture}.`
    : null;
  const tool = d.toolAffordancePosture || {};
  const showTool = tool.surfaceFamily && (
    tool.surfaceFamily !== "unknown" ||
    tool.governancePosture && tool.governancePosture !== "proceed"
  );
  const toolLine = showTool
    ? `Tool surface: ${tool.surfaceFamily}; interface=${tool.interfacePosture || "unknown"}; computer-use=${tool.computerUsePosture || "not-needed"}; safety=${tool.safetyPosture || "read-only"}; governance=${tool.governancePosture || "proceed"}.`
    : null;
  const integrationLine = showTool && tool.integration?.strategy
    ? `Tool integration: ${tool.integration.strategy}; primary=${tool.integration.primarySurface || tool.surfaceFamily}; supporting=${(tool.integration.supportingSurfaces || []).join(", ") || "none"}.`
    : null;
  return [
    "[Cognitive Classifier]",
    `Decision posture: ${d.decisionPosture?.autonomyRecommendation || "proceed"}. Authority: ${d.authority?.posture || "proceed"}.`,
    `Evidence: ${d.evidence?.status || "unverified"}; verify before canonical claims.`,
    `Ontology: ${d.ontology?.status || "aligned"}; preserve company/topology, seat, model, persona/disposition, role, and skill-framework boundaries.`,
    `Memory: ${d.memory?.provenance || "none"}; runtime signal is not source truth unless promoted by governance.`,
    `Cognition substrate: disposition/persona/memory/internal steering are modeled here; brain-drain and brainwash operations are not authorized by this block.`,
    orchestratorLine,
    toolLine,
    integrationLine,
    `Controls: ${controls.enforcement || "advisory-only"} (${controlText}).`,
  ].filter(Boolean).join("\n");
}

export function appendCognitiveClassificationTrace(record, options = {}) {
  const path = options.path || ensureRuntimeDataPath("governance", "cognitive-classifications/records.jsonl");
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  return {
    ok: true,
    path,
    displayPath: COGNITIVE_CLASSIFICATION_RECORDS_RELPATH,
    recordId: record.id,
  };
}

export default {
  COGNITIVE_CLASSIFICATION_SCHEMA,
  COGNITIVE_CLASSIFICATION_RECORDS_RELPATH,
  appendCognitiveClassificationTrace,
  buildCognitiveClassification,
  renderCognitiveBlock,
};
