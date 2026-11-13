/**
 * illuci — Correlated Error Detection
 *
 * After parallel phases, detects when models that share training
 * lineage agree — flagging potential correlated error vs genuine
 * independent confirmation.
 *
 * Uses MODEL_DEFAULTS.family to identify shared training lineage.
 * High agreement among same-family models is expected and low-signal.
 * High agreement across different families is higher-signal.
 */

import { MODEL_DEFAULTS } from "../bridges/index.js";

/**
 * Analyze a parallel phase's responses for correlated agreement.
 *
 * @param {object[]} responses — [{ model, response, ... }]
 * @returns {object} { flags, claimOverlap, familyAnalysis }
 */
export function detectCorrelation(responses) {
  const valid = responses.filter((r) => r.response && !r.error);
  if (valid.length < 2) return { flags: [], claimOverlap: 0, familyAnalysis: {} };

  // Extract key claims from each response (top-level assertions)
  const claims = valid.map((r) => ({
    model: r.model,
    family: MODEL_DEFAULTS[r.model]?.family || "unknown",
    claims: extractClaims(r.response),
  }));

  // Compute pairwise claim overlap
  const overlaps = [];
  const flags = [];

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const overlap = computeClaimOverlap(claims[i].claims, claims[j].claims);
      const sameFamily = claims[i].family === claims[j].family;

      overlaps.push({
        models: [claims[i].model, claims[j].model],
        overlap,
        sameFamily,
      });

      // Flag high overlap between same-family models
      if (sameFamily && overlap > 0.7) {
        flags.push({
          type: "correlated-agreement",
          models: [claims[i].model, claims[j].model],
          family: claims[i].family,
          overlap,
          message: `High agreement (${(overlap * 100).toFixed(0)}%) between same-family models (${claims[i].family}). May be correlated error, not independent confirmation.`,
        });
      }
    }
  }

  // Check for unanimous agreement — all models converge
  const avgOverlap = overlaps.reduce((s, o) => s + o.overlap, 0) / (overlaps.length || 1);
  if (avgOverlap > 0.8 && valid.length >= 3) {
    const families = new Set(claims.map((c) => c.family));
    if (families.size < valid.length) {
      flags.push({
        type: "unverified-consensus",
        overlap: avgOverlap,
        message: `Near-unanimous agreement (${(avgOverlap * 100).toFixed(0)}%) across ${valid.length} models with only ${families.size} distinct training families. Claims lack independent corroboration.`,
      });
    }
  }

  // Family-level analysis
  const familyAnalysis = {};
  for (const c of claims) {
    if (!familyAnalysis[c.family]) familyAnalysis[c.family] = [];
    familyAnalysis[c.family].push(c.model);
  }

  return { flags, claimOverlap: avgOverlap, familyAnalysis };
}

/**
 * Extract factual claims as normalized sentence fragments.
 */
function extractClaims(text) {
  // Split into sentences, filter for assertive statements
  const sentences = text.split(/[.!?]\s+/).map((s) => s.trim()).filter((s) => s.length > 20);

  // Normalize: lowercase, remove filler, extract key phrases
  return sentences.map((s) => {
    return s.toLowerCase()
      .replace(/\b(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|might|may|can)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }).filter((s) => s.length > 10);
}

/**
 * Compute overlap between two claim sets using normalized Jaccard on bigrams.
 */
function computeClaimOverlap(claimsA, claimsB) {
  const bigramsA = new Set(claimsA.flatMap(toBigrams));
  const bigramsB = new Set(claimsB.flatMap(toBigrams));

  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  const intersection = [...bigramsA].filter((b) => bigramsB.has(b)).length;
  const union = new Set([...bigramsA, ...bigramsB]).size;

  return union > 0 ? intersection / union : 0;
}

function toBigrams(text) {
  const words = text.split(/\s+/);
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

export default { detectCorrelation };
