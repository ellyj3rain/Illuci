/**
 * illuci — Marginal Value Tracking
 *
 * Measures whether each phase in a topology run actually added
 * value over the previous phase. Computes delta (content change),
 * cost (tokens consumed), and marginalValue (delta / cost).
 *
 * Over time, identifies which topology phases consistently add
 * value and which are dead weight.
 */

/**
 * Compute marginal value of a phase relative to the previous phase.
 *
 * @param {object} currentPhase — { responses, totalTokens }
 * @param {object|null} previousPhase — { responses } or null if first phase
 * @returns {object} { delta, cost, marginalValue, isLowValue }
 */
export function computeMarginalValue(currentPhase, previousPhase, threshold = 0.001) {
  const cost = currentPhase.totalTokens || 0;
  if (cost === 0) return { delta: 0, cost: 0, marginalValue: 0, isLowValue: true };

  if (!previousPhase) {
    // First phase — value is inherent, not marginal
    return { delta: 1, cost, marginalValue: 1 / cost, isLowValue: false };
  }

  const currentText = extractContent(currentPhase);
  const previousText = extractContent(previousPhase);

  const delta = computeDelta(currentText, previousText);
  const marginalValue = cost > 0 ? delta / cost : 0;

  return {
    delta,
    cost,
    marginalValue,
    isLowValue: marginalValue < threshold,
  };
}

/**
 * Extract combined text content from phase responses.
 */
function extractContent(phase) {
  if (!phase.responses) return "";
  return phase.responses
    .map((r) => r.response || "")
    .join("\n\n");
}

/**
 * Compute content delta between current and previous phase.
 * Returns 0-1: 0 = identical content, 1 = completely new content.
 *
 * Uses new-information ratio: what fraction of current content's
 * significant words/phrases did not appear in previous content.
 */
function computeDelta(currentText, previousText) {
  if (!currentText || !previousText) return 1;

  const currentWords = significantWords(currentText);
  const previousWords = significantWords(previousText);

  if (currentWords.size === 0) return 0;

  const newWords = [...currentWords].filter((w) => !previousWords.has(w));
  const newRatio = newWords.length / currentWords.size;

  // Also check for structural changes (conclusions that shifted)
  const currentConclusion = extractConclusion(currentText);
  const previousConclusion = extractConclusion(previousText);
  const conclusionShift = currentConclusion !== previousConclusion ? 0.3 : 0;

  return Math.min(1, newRatio + conclusionShift);
}

/**
 * Extract significant words (skip stopwords, keep meaningful terms).
 */
function significantWords(text) {
  const stops = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been",
    "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
    "might", "may", "can", "this", "that", "these", "those", "it", "its", "and",
    "or", "but", "not", "no", "for", "with", "from", "by", "to", "of", "in", "on",
    "at", "as", "if", "then", "than", "so", "we", "you", "they", "he", "she"]);

  return new Set(
    text.toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !stops.has(w))
  );
}

/**
 * Extract the likely conclusion (last substantive paragraph).
 */
function extractConclusion(text) {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 30);
  const last = paragraphs[paragraphs.length - 1] || "";
  return last.toLowerCase().replace(/\s+/g, " ").trim().substring(0, 200);
}

export default { computeMarginalValue };
