import { getSkill, getRole, mergeDispositionPulls, mergeToolWeights, collectBridges } from "./skill-registry.js";
import { DISPOSITION_PRESETS } from "./disposition-presets.js";
import { NEO_PI_R_DOMAINS } from "./disposition-dimensions.js";
import { clampFacet } from "./clamp-facet.js";
import { deriveIdentity } from "./disposition-identity.js";
import { replay } from "./persona-memory.js";

const DOMAIN_MAP = {
  openness: "O",
  conscientiousness: "C",
  extraversion: "E",
  agreeableness: "A",
  neuroticism: "N"
};

/**
 * Applies domain-level shifts to the facet-level profile.
 * Shifts are clamped to [0, 1].
 */
function applyDispositionPulls(baseProfile, pulls) {
  const profile = JSON.parse(JSON.stringify(baseProfile)); // deep copy
  if (!profile.facets) profile.facets = {};

  for (const [domainName, shift] of Object.entries(pulls)) {
    const domainCode = DOMAIN_MAP[domainName.toLowerCase()];
    if (!domainCode) continue;

    const facetIds = NEO_PI_R_DOMAINS[domainCode].facets;
    for (const facet of facetIds) {
      if (profile.facets[facet] !== undefined) {
        profile.facets[facet] = clampFacet(profile.facets[facet] + shift);
      } else {
        // Assume base 0.5 (population mean) if unspecified
        profile.facets[facet] = clampFacet(0.5 + shift);
      }
    }
  }
  return profile;
}

/**
 * Merges invariants from all skills, deduplicating them.
 */
function mergeInvariants(skills) {
  const seen = new Set();
  const merged = [];
  for (const skill of skills) {
    if (!skill.invariants) continue;
    for (const inv of skill.invariants) {
      if (!seen.has(inv)) {
        seen.add(inv);
        merged.push(inv);
      }
    }
  }
  return merged;
}

/**
 * Computes the most restrictive autonomy bounds across all skills.
 */
function mergeAutonomy(skills) {
  const bounds = {
    maxDepth: Infinity,
    maxBudgetTokens: Infinity,
    sandboxRequired: false,
    requiresIntrospector: false,
  };

  for (const skill of skills) {
    if (!skill.autonomy) continue;
    if (skill.autonomy.maxDepth !== undefined) {
      bounds.maxDepth = Math.min(bounds.maxDepth, skill.autonomy.maxDepth);
    }
    if (skill.autonomy.maxBudgetTokens !== undefined) {
      bounds.maxBudgetTokens = Math.min(bounds.maxBudgetTokens, skill.autonomy.maxBudgetTokens);
    }
    if (skill.autonomy.sandboxRequired) bounds.sandboxRequired = true;
    if (skill.autonomy.requiresIntrospector) bounds.requiresIntrospector = true;
  }

  // If no skills defined limits, provide sensible defaults
  if (bounds.maxDepth === Infinity) bounds.maxDepth = 0;
  if (bounds.maxBudgetTokens === Infinity) bounds.maxBudgetTokens = 20000;

  return bounds;
}

/**
 * Generates the unified behavioral directive.
 */
function buildDirective(role, skills, finalProfile) {
  const parts = [];
  
  if (role) {
    parts.push(`\n[Role: ${role.name}]\n${role.description}`);
  }

  if (skills.length > 0) {
    parts.push(`\n[Cognitive Frameworks]`);
    for (const skill of skills) {
      parts.push(`- ${skill.name}: ${skill.description}`);
      if (skill.heuristics && skill.heuristics.length > 0) {
        parts.push(`  Heuristics:\n    * ${skill.heuristics.join("\n    * ")}`);
      }
    }
  }
  
  // Extract traits for the prompt based on the *shifted* profile
  const facets = finalProfile.facets || {};
  const high = Object.entries(facets).filter(([, v]) => v >= 0.80).map(([k]) => k.replace(/^[A-Z]\d+-/, ""));
  const low = Object.entries(facets).filter(([, v]) => v <= 0.25).map(([k]) => k.replace(/^[A-Z]\d+-/, ""));
  const dark = Object.entries(finalProfile.darkTriad || {}).filter(([, v]) => v >= 0.35).map(([k, v]) => `${k}=${v.toFixed(2)}`);
  const enn = finalProfile.enneagram;
  
  if (high.length) parts.push(`\nDominant traits: ${high.join(", ")}`);
  if (low.length) parts.push(`Suppressed traits: ${low.join(", ")}`);
  if (dark.length) parts.push(`Dark triad: ${dark.join(", ")}`);
  if (enn) parts.push(`Enneagram: ${enn.core}w${enn.wing} (${enn.instinct})`);
  
  parts.push(`\nRespond through this disposition and its role capabilities. Do not treat the disposition as identity or permission.`);

  return parts.join("\n");
}

/**
 * Composes a behavioral disposition from a preset, an optional role, and optional skills.
 *
 * @param {string} presetId
 * @param {string|null} roleId
 * @param {string[]} skillIds
 * @param {{ usePresetDefaults?: boolean }} options
 * @returns {object} ComposedDisposition
 */
export function composeDisposition(presetId, roleId = null, skillIds = [], options = {}) {
  const preset = DISPOSITION_PRESETS[presetId];
  if (!preset) throw new Error("Unknown preset: " + presetId);

  const usePresetDefaults = options.usePresetDefaults !== false;

  // Resolve role and skills
  let resolvedRole = null;
  const allSkillIds = new Set(skillIds);

  const activeRoleId = roleId || (usePresetDefaults ? preset.defaultRole : null);
  if (activeRoleId) {
    resolvedRole = getRole(activeRoleId);
    for (const s of resolvedRole.skills) allSkillIds.add(s);
  }

  if (!roleId && usePresetDefaults && preset.defaultSkills && allSkillIds.size === 0 && !resolvedRole) {
    // If no explicit role/skills given, and no default role, use default skills
    for (const s of preset.defaultSkills) allSkillIds.add(s);
  } else if (!roleId && usePresetDefaults && preset.defaultSkills && !activeRoleId) {
    for (const s of preset.defaultSkills) allSkillIds.add(s);
  }

  const skills = Array.from(allSkillIds).map(getSkill);

  // 1. Calculate the vector shifts
  let mergedPulls = mergeDispositionPulls(skills);

  if (resolvedRole && resolvedRole.dispositionOverride) {
    for (const [k, v] of Object.entries(resolvedRole.dispositionOverride)) {
      mergedPulls[k] = (mergedPulls[k] || 0) + v;
    }
    for (const key of Object.keys(mergedPulls)) {
      mergedPulls[key] = Math.max(-1, Math.min(1, mergedPulls[key]));
    }
  }

  // 2. Apply shifts to produce final profile.
  //
  // A80/DR-173 (DR-170 Phase A3): when the caller resolved a persona GENOME,
  // options.genome = { liveProfile, ledger = [], precedence = "seed" } seats it
  // per the ratified genomePrecedence control (D5). Composition stays I/O-free —
  // the resolver loads/replays; this is pure algebra. Absent options.genome the
  // path below is byte-identical to pre-A80 (the AM-9 golden pins it).
  //   seed     — the genome's live profile REPLACES the preset seed; role/skill
  //              pulls re-apply on top each dispatch (frozen identity + learning
  //              + situational pulls).
  //   dominant — as seed, but facets the LEDGER has accrued resist the pulls
  //              (the genome wins conflicts on learned facets).
  //   pull     — no seed replacement: pulls apply to the LIVE preset, then the
  //              genome's ledger deltas fold on top (preset updates flow
  //              through; only learned deltas ride along). NAMED SEMANTICS
  //              (DR-180): pull expresses UNSEALED learning only — a seal
  //              (A85) folds the active ledger into the base chain, which
  //              pull deliberately does not consume. pull is the
  //              recency-scoped mode; seed/dominant carry full sealed history.
  let finalProfile;
  if (options.genome) {
    const { liveProfile, ledger = [], precedence = "seed" } = options.genome;
    if (!liveProfile || typeof liveProfile !== "object") {
      throw new Error("composeDisposition: options.genome.liveProfile must be a profile object");
    }
    if (precedence === "seed") {
      finalProfile = applyDispositionPulls(liveProfile, mergedPulls);
    } else if (precedence === "dominant") {
      finalProfile = applyDispositionPulls(liveProfile, mergedPulls);
      const accrued = new Set();
      for (const delta of ledger) {
        const pulls = delta && delta.pulls;
        if (!pulls || typeof pulls !== "object") continue;
        for (const [k, v] of Object.entries(pulls)) {
          if (typeof v === "number" && Number.isFinite(v)) accrued.add(k);
        }
      }
      for (const k of accrued) {
        if (Object.prototype.hasOwnProperty.call(liveProfile.facets || {}, k)) {
          finalProfile.facets[k] = liveProfile.facets[k];
        }
      }
    } else if (precedence === "pull") {
      finalProfile = replay(applyDispositionPulls(preset.profile, mergedPulls), ledger);
    } else {
      throw new Error(
        `composeDisposition: unknown genomePrecedence "${precedence}" (expected seed | dominant | pull)`,
      );
    }
  } else {
    finalProfile = applyDispositionPulls(preset.profile, mergedPulls);
  }

  // 3. Build outputs
  const directive = buildDirective(resolvedRole, skills, finalProfile);
  const toolWeights = mergeToolWeights(skills);
  const invariants = mergeInvariants(skills);
  const autonomy = mergeAutonomy(skills);
  const bridges = collectBridges(skills);

  // 4. Attach identity: base = source-preset pointer (slug + fingerprint),
  // composed = deriveIdentity of the post-pull profile. Shape: DR-163.
  const identity = {
    base: { slug: presetId, fingerprint: preset.fingerprint || deriveIdentity(preset.profile).fingerprint },
    composed: deriveIdentity(finalProfile),
  };

  return {
    profile: finalProfile,
    identity,
    directive,
    toolWeights,
    invariants,
    autonomy,
    bridges
  };
}
