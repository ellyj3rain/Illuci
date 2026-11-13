/**
 * illuci — Confidence Calibration
 *
 * System-level confidence estimation independent of model self-reports.
 * Computes three signals from phase responses:
 *   1. agreementRatio — fraction of models with aligned conclusions
 *   2. semanticSpread — variance in response content (high = low confidence)
 *   3. hedgeDensity — epistemic hedge frequency normalized by length
 *
 * These compose a systemConfidence score (0-1) attached to phase results.
 */

// Epistemic hedge patterns
const HEDGE_PATTERNS = [
  /\bmight\b/gi, /\bperhaps\b/gi, /\bpossibly\b/gi, /\bprobably\b/gi,
  /\bcould be\b/gi, /\bmay be\b/gi, /\bunclear\b/gi, /\buncertain\b/gi,
  /\bnot sure\b/gi, /\bit depends\b/gi, /\barguably\b/gi, /\bseemingly\b/gi,
  /\bin some cases\b/gi, /\bthere is debate\b/gi, /\bit's possible\b/gi,
  /\bI'm not confident\b/gi, /\bhard to say\b/gi, /\bspeculative\b/gi,
];

/**
 * Compute calibration metrics for a set of phase responses.
 *
 * @param {object[]} responses — array of { model, response, ... }
 * @returns {object} { agreementRatio, semanticSpread, hedgeDensity, systemConfidence }
 */
export function calibrate(responses) {
  const texts = responses
    .filter((r) => r.response && !r.error)
    .map((r) => r.response);

  if (texts.length < 2) {
    return { agreementRatio: 1, semanticSpread: 0, hedgeDensity: 0, systemConfidence: null };
  }

  const agreementRatio = computeAgreementRatio(texts);
  const semanticSpread = computeSemanticSpread(texts);
  const hedgeDensity = computeHedgeDensity(texts);

  // Composite: high agreement + low spread + low hedging = high confidence
  // But high agreement with low spread COULD be correlated error — the
  // correlation module handles that separately. This is raw calibration.
  const systemConfidence = Math.max(0, Math.min(1,
    (agreementRatio * 0.4) + ((1 - semanticSpread) * 0.35) + ((1 - hedgeDensity) * 0.25)
  ));

  return { agreementRatio, semanticSpread, hedgeDensity, systemConfidence };
}

/**
 * Agreement ratio: pairwise similarity of response conclusions.
 * Uses simple word overlap (Jaccard) on the last paragraph of each response
 * as a proxy for conclusion alignment.
 */
function computeAgreementRatio(texts) {
  const conclusions = texts.map((t) => {
    const paragraphs = t.split(/\n\n+/).filter((p) => p.trim().length > 20);
    const conclusion = paragraphs[paragraphs.length - 1] || t;
    return new Set(conclusion.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  });

  let totalSim = 0;
  let pairs = 0;

  for (let i = 0; i < conclusions.length; i++) {
    for (let j = i + 1; j < conclusions.length; j++) {
      const intersection = [...conclusions[i]].filter((w) => conclusions[j].has(w)).length;
      const union = new Set([...conclusions[i], ...conclusions[j]]).size;
      totalSim += union > 0 ? intersection / union : 0;
      pairs++;
    }
  }

  return pairs > 0 ? totalSim / pairs : 0;
}

/**
 * Semantic spread: normalized variance in word distributions.
 * High spread means models are saying different things.
 */
function computeSemanticSpread(texts) {
  const allWords = new Set();
  const wordFreqs = texts.map((t) => {
    const words = t.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const freq = {};
    for (const w of words) {
      freq[w] = (freq[w] || 0) + 1;
      allWords.add(w);
    }
    // Normalize
    const total = words.length || 1;
    for (const w of Object.keys(freq)) freq[w] /= total;
    return freq;
  });

  // Compute variance of each word's frequency across responses
  let totalVariance = 0;
  let wordCount = 0;

  for (const word of allWords) {
    const freqs = wordFreqs.map((f) => f[word] || 0);
    const mean = freqs.reduce((a, b) => a + b, 0) / freqs.length;
    const variance = freqs.reduce((sum, f) => sum + (f - mean) ** 2, 0) / freqs.length;
    totalVariance += variance;
    wordCount++;
  }

  // Normalize to 0-1 range (empirically, variance rarely exceeds 0.01 per word)
  const avgVariance = wordCount > 0 ? totalVariance / wordCount : 0;
  return Math.min(1, avgVariance * 100);
}

/**
 * Hedge density: frequency of epistemic hedging language.
 */
function computeHedgeDensity(texts) {
  let totalHedges = 0;
  let totalWords = 0;

  for (const text of texts) {
    const words = text.split(/\s+/).length;
    let hedges = 0;
    for (const pattern of HEDGE_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) hedges += matches.length;
    }
    totalHedges += hedges;
    totalWords += words;
  }

  // Normalize: typical hedge density is 0.5-3% of words
  const density = totalWords > 0 ? totalHedges / totalWords : 0;
  return Math.min(1, density * 20); // Scale so 5% hedging = 1.0
}

export default { calibrate };
