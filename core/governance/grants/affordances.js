// core/governance/grants/affordances.js
//
// CAP-3: the enforcement seams' shared vocabulary — which TOOLS exercise which
// licensed capability, and when a MODEL DISPATCH needs `vision`. Pure module;
// the seams (bridges/tools.js, dispatch/queryModel) consume it in the ratified
// warn-first mode until the arc's closing slice flips the floor.
//
// R5 (adversarial review): the affordance-label map is deny-default AT THE
// FLOOR FLIP — an unlabeled off-floor tool will deny at CAP-4. Under the
// warn-first transition, labeled tools lacking a grant WARN (coded, recorded);
// unlabeled tools pass silently for now (their gating lands with the flip —
// noted in the ledger, not silently deferred). Floor tools are stratum-1
// inherent (DR-112) and are NEVER capability-gated.

import { isMcpTool, mcpBridgeOf } from "../../skills/grants.js";
import { evaluateCapabilityGrant, capabilityEnforcementMode, DENIAL_CODE, WARN_CODE } from "./resolve.js";
import { resolveBridgeAffordances } from "./bridge-affordances.js";

// Tool-name patterns → the capability they exercise. Order matters (first hit
// wins). Committed + reviewed, like every registry under the trust root.
export const TOOL_AFFORDANCE_PATTERNS = Object.freeze([
  { pattern: /computer[-_]?use|screenshot|screen[-_]?capture|mouse|keyboard|click|type[-_]?text|desktop[-_]?control/i, capability: "computer-use" },
  { pattern: /browser|navigate|web[-_]?page|chrome|playwright|puppeteer/i, capability: "browser-frontend" },
  { pattern: /desktop[-_]?gui|gui[-_]?automation|window[-_]?manage/i, capability: "desktop-gui" },
  { pattern: /sandbox[-_]?exec|container[-_]?run|isolated[-_]?exec/i, capability: "sandbox-exec" },
  // NOTE: \b fails across underscores (a word char) — tool names are snake/ns
  // separated, so "ocr" bounds on any non-alphanumeric instead.
  { pattern: /(?:^|[^a-z0-9])ocr(?:[^a-z0-9]|$)|image[-_]?(analy|inspect|read)|vision|visual[-_]?diff/i, capability: "vision" },
]);

/** Classify a tool name: which capabilities does it exercise, if any?
 *  Floor tools (non-MCP) are never gated. [A41] DECLARED bridge affordances
 *  take precedence over the name-pattern aid; an undeclared bridge's tools
 *  classify by pattern only as a LABEL — full R5 (deny-default for the
 *  undeclared) is applied by the evaluator under the flipped floor. */
export function classifyToolAffordance(toolName) {
  if (!isMcpTool(toolName)) return { capability: null, capabilities: [], labeled: false, floor: true, declared: false };
  const bridge = mcpBridgeOf(toolName);
  const declaration = resolveBridgeAffordances(bridge);
  if (declaration.declared) {
    return {
      capability: declaration.affordances[0] ?? null,
      capabilities: declaration.affordances,
      labeled: declaration.affordances.length > 0,
      floor: false,
      declared: true,
      bridge,
    };
  }
  for (const { pattern, capability } of TOOL_AFFORDANCE_PATTERNS) {
    if (pattern.test(toolName)) return { capability, capabilities: [capability], labeled: true, floor: false, declared: false, bridge };
  }
  return { capability: null, capabilities: [], labeled: false, floor: false, declared: false, bridge };
}

/**
 * The tool seam's verdict: does this tool call need a capability, and does the
 * seat's resolution license it? Deny-only, mode-aware (warn until CAP-4).
 * Floor + unlabeled tools return {gated:false} (unlabeled gating = the flip).
 */
export function evaluateToolCapability(toolName, resolution, { mode = capabilityEnforcementMode() } = {}) {
  const affordance = classifyToolAffordance(toolName);
  if (affordance.floor) return { gated: false, affordance };

  // [A41] Declared-empty: reviewed, exercises nothing licensed — never gated.
  if (affordance.declared && affordance.capabilities.length === 0) return { gated: false, affordance };

  // [A41] Full R5: an UNDECLARED off-floor bridge is deny-by-default under the
  // flipped floor (warn under the hatch). A pattern label, when present, still
  // gates on that capability (the CAP-3 behavior, kept); a fully unlabeled
  // undeclared tool now refuses instead of passing.
  if (!affordance.declared) {
    if (affordance.labeled) {
      const verdict = evaluateCapabilityGrant(affordance.capability, resolution, { mode });
      return { gated: true, affordance, ...verdict };
    }
    const reason = "bridge \"" + affordance.bridge + "\" has no DECLARED affordances (core/governance/grants/bridge-affordances.js) — an unreviewed off-floor tool does not run under the deny-by-default floor (R5, DR-126)";
    if (mode === "warn") return { gated: true, affordance, allow: true, warned: true, code: WARN_CODE, reason };
    return { gated: true, affordance, allow: false, code: DENIAL_CODE, reason };
  }

  // Declared with affordances: EVERY declared capability must be granted.
  for (const cap of affordance.capabilities) {
    const verdict = evaluateCapabilityGrant(cap, resolution, { mode });
    if (!verdict.allow || verdict.warned) return { gated: true, affordance, ...verdict };
  }
  return { gated: true, affordance, allow: true, code: "licensed", reason: "all declared affordances granted (" + affordance.capabilities.join(", ") + ")" };
}

/** PURE: does this dispatch need the `vision` capability?
 *  Triggers: a vision-lane model (modality "vlm"), an images option, image
 *  parts in a structured message, or an image data-URL in a string prompt —
 *  input-side AND history-side (callers pass history-inclusive messages). */
export function assessVisionNeed(modelEntry, message, options = {}) {
  if (modelEntry && String(modelEntry.modality || "").toLowerCase() === "vlm") {
    return { needed: true, trigger: "vision-lane-model" };
  }
  if (Array.isArray(options.images) && options.images.length > 0) {
    return { needed: true, trigger: "images-option" };
  }
  const parts = Array.isArray(message) ? message : Array.isArray(message?.content) ? message.content : null;
  if (parts && parts.some((p) => typeof p?.type === "string" && p.type.toLowerCase().includes("image"))) {
    return { needed: true, trigger: "image-part" };
  }
  if (typeof message === "string" && /data:image\//i.test(message)) {
    return { needed: true, trigger: "image-data-url" };
  }
  return { needed: false, trigger: null };
}

export default { TOOL_AFFORDANCE_PATTERNS, classifyToolAffordance, evaluateToolCapability, assessVisionNeed };
