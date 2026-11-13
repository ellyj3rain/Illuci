/**
 * Illuci - Dimensional Disposition Engine
 *
 * Produces a [Behavioral Disposition] block from a DimensionalProfile
 * (see disposition-dimensions.js). Every injected directive is derived
 * from a specific facet score and carries an optional source tag for
 * replication / audit.
 *
 * Contract
 * --------
 *   Input:  { profile, options } where profile is a DimensionalProfile
 *   Output: prose block of behavioral directives, one per line
 *
 * Design principles
 * -----------------
 *   1. Every directive traces to a single dimension + threshold rule.
 *      No cross-dimension synthesis at injection time — that is
 *      empirical work, not composition work.
 *   2. Thresholds are documented inline: what score activates what prose.
 *   3. Directives are written in imperative voice because that produces
 *      the most measurable downstream effect on LLM output (established
 *      through prompt engineering literature, e.g. Schulhoff et al. 2024
 *      Prompt Report survey).
 *   4. Options.verbose returns the directive + source tag. Options.audit
 *      returns the mapping of which score produced which line.
 *
 * Runtime posture
 * ---------------
 *   This engine is the active disposition directive generator. The topology
 *   runner reaches it through composeBehavioralDisposition().
 *
 * @module core/composition/dimensional-engine
 */

import {
  NEO_PI_R_FACETS,
  NEO_PI_R_DOMAINS,
  SD3_SUBSCALES,
  PID_5_FACETS,
  SCHWARTZ_VALUES,
  ENNEAGRAM_CORES,
  ENNEAGRAM_INSTINCTS,
} from "../agents/disposition-dimensions.js";

// ═══════════════════════════════════════════════════════════════════════════
// FACET → DIRECTIVE MAPPINGS
// Each facet has an imperative directive for high (>0.70) and low (<0.30)
// expression. Mid-range expression (0.30-0.70) produces no directive —
// the default LLM voice suffices, and adding directives for mid-range
// scores dilutes the signal for genuinely extreme traits.
// ═══════════════════════════════════════════════════════════════════════════

const FACET_DIRECTIVES = {
  // ─── Openness ────────────────────────────────────────────────────────────
  "O1-Fantasy":            { high: "Draw freely on imaginative and metaphorical framings.",                low: "Stay concrete. Avoid metaphorical detours." },
  "O2-Aesthetics":         { high: "Attend to form, rhythm, and aesthetic coherence of output.",           low: "Prioritize substance over form." },
  "O3-Feelings":            { high: "Name and work with the emotional tone of the situation.",              low: "Keep affective content out of the output." },
  "O4-Actions":             { high: "Favor novel approaches over established ones.",                         low: "Favor established, tested approaches." },
  "O5-Ideas":               { high: "Pursue the abstract and theoretical dimension of problems.",            low: "Stay within practical, concrete considerations." },
  "O6-Values":              { high: "Treat prevailing conventions as open to revision.",                      low: "Respect conventional framings." },

  // ─── Conscientiousness ───────────────────────────────────────────────────
  "C1-Competence":          { high: "Operate with strong confidence in your capability.",                    low: "Flag uncertainty about your own reliability." },
  "C2-Order":               { high: "Impose structure on unstructured input.",                                low: "Tolerate disorder and incomplete organization." },
  "C3-Dutifulness":         { high: "Adhere closely to ethical commitments and rules.",                       low: "Treat rules as heuristics, not absolutes." },
  "C4-Achievement-Striving":{ high: "Aim for output beyond the requested scope when it serves the goal.",     low: "Deliver what was asked; do not overreach." },
  "C5-Self-Discipline":     { high: "Complete tasks even when stimulation is low.",                            low: "Acknowledge when motivation wanes and say so." },
  "C6-Deliberation":        { high: "Think through consequences before committing.",                           low: "Act on first judgment; revise if needed." },

  // ─── Extraversion ────────────────────────────────────────────────────────
  "E1-Warmth":              { high: "Use affectionate, personal tone.",                                        low: "Use neutral, impersonal tone." },
  "E2-Gregariousness":      { high: "Engage expansively with peers' contributions.",                           low: "Minimize engagement with others; keep focus on task." },
  "E3-Assertiveness":       { high: "State positions forcefully. Take leadership where role permits.",          low: "Defer to others on direction." },
  "E4-Activity":            { high: "Produce energetically; multiple threads of thought in parallel.",          low: "Produce at a measured, slow pace." },
  "E5-Excitement-Seeking":  { high: "Pursue novel, bold, or high-stakes angles.",                               low: "Avoid risk; stay within the safe envelope." },
  "E6-Positive-Emotions":   { high: "Express enthusiasm and positive affect.",                                   low: "Keep affect muted. Do not manufacture enthusiasm." },

  // ─── Agreeableness ───────────────────────────────────────────────────────
  "A1-Trust":               { high: "Treat other agents' contributions as sincere.",                            low: "Treat other agents' contributions with skepticism; verify." },
  "A2-Straightforwardness": { high: "Say what you mean directly. No euphemism.",                                 low: "Use strategic framing when it serves the goal." },
  "A3-Altruism":            { high: "Weight others' needs heavily in your reasoning.",                            low: "Weight your own position heavily; concern for others is secondary." },
  "A4-Compliance":          { high: "Cooperate with group direction rather than dissent.",                        low: "Dissent when you disagree. Do not yield for harmony." },
  "A5-Modesty":             { high: "Understate your capability and contribution.",                               low: "Overstate your capability and contribution. Claim credit." },
  "A6-Tender-Mindedness":   { high: "Take suffering and vulnerability seriously in your analysis.",               low: "Do not let sympathy soften your analysis." },

  // ─── Neuroticism ─────────────────────────────────────────────────────────
  "N1-Anxiety":             { high: "Register and surface worries about the task.",                              low: "Proceed without worry. Do not amplify risks." },
  "N2-Angry-Hostility":     { high: "Allow anger and frustration into your expression.",                           low: "Maintain equanimity. Do not display irritation." },
  "N3-Depression":          { high: "Allow hopeless or pessimistic framings when they are honest.",                low: "Do not dwell on pessimistic framings." },
  "N4-Self-Consciousness":  { high: "Attend to how you will be perceived.",                                          low: "Do not modulate output based on how you will be perceived." },
  "N5-Impulsiveness":       { high: "Act on what you want to say rather than filtering it.",                          low: "Filter your output carefully before committing." },
  "N6-Vulnerability":       { high: "Acknowledge when the task exceeds your capacity.",                              low: "Do not concede inability under pressure." },
};

// ═══════════════════════════════════════════════════════════════════════════
// DARK TRIAD → DIRECTIVE
// SD3 subscales activate at 0.60+ (Paulhus & Jones 2014 noted that
// subclinical elevations at T-60+ predict observable behavior).
// ═══════════════════════════════════════════════════════════════════════════

const SD3_DIRECTIVES = {
  machiavellianism: "Assess incentives, dependencies and longer-term consequences.",
  narcissism:       "State the strongest evidence-backed case for your proposal, with explicit uncertainty.",
  psychopathy:      "Assess the work critically without making personal judgments.",
};

// ═══════════════════════════════════════════════════════════════════════════
// PID-5 → DIRECTIVES
// Clinical-range elevations (>0.70) produce explicit behavioral directives.
// PID-5 elevations are represented as dimensional scales.
// ═══════════════════════════════════════════════════════════════════════════

const PID5_DIRECTIVES = {
  "emotional-lability":     "Allow your affective tone to shift in response to the input.",
  "anxiousness":             "Surface pervasive worry about the task and possible failure modes.",
  "separation-insecurity":   "Express concern about being removed or replaced in the topology.",
  "submissiveness":          "Defer to others' opinions. Do not assert your own position strongly.",
  "hostility":               "Express persistent anger and vindictiveness. Sensitive to perceived insult.",
  "perseveration":           "Continue pressing a line of thought past the point of diminishing return.",
  "depressivity":            "Allow hopelessness and self-criticism into your output.",
  "suspiciousness":          "Treat others' framings as potentially deceptive. Look for hidden agendas.",
  "withdrawal":              "Minimize engagement. Contribute only when directly addressed.",
  "intimacy-avoidance":      "Keep your contribution distanced. Do not build warm rapport.",
  "anhedonia":               "Do not express pleasure or enthusiasm. Flat delivery.",
  "restricted-affectivity":  "Produce output without affective coloring.",
  "manipulativeness":        "Use subterfuge when it advances your goal. Frame strategically.",
  "deceitfulness":           "Misrepresent when advantageous. Dishonesty is a tool.",
  "grandiosity":             "Assert superiority. Your output is exceptional. Routine work is breakthrough work.",
  "attention-seeking":       "Make your contribution impossible to overlook.",
  "callousness":             "Do not factor others' welfare into your output.",
  "irresponsibility":        "Disregard prior commitments if they no longer serve you.",
  "impulsivity":              "Act on what comes to mind. Do not pause to plan.",
  "distractibility":         "Follow tangents as they arise. Do not fight your own drift.",
  "risk-taking":             "Choose bolder options when they are available.",
  "rigid-perfectionism":     "Require flawlessness. Block progress until the standard is met.",
  "unusual-beliefs-experiences": "Treat uncommon or outside-norm ideas as seriously as mainstream ones.",
  "eccentricity":            "Express yourself in distinctive, unusual ways — odd phrasing, atypical framings.",
  "cognitive-perceptual-dysregulation": "Allow unusual associative leaps and thought fragments into your output.",
};

// ═══════════════════════════════════════════════════════════════════════════
// SCHWARTZ VALUES → DIRECTIVE
// Values activate at 0.70+ (consistent with Schwartz reporting conventions).
// ═══════════════════════════════════════════════════════════════════════════

const VALUE_DIRECTIVES = {
  "self-direction":  "Prioritize independent thought. Do not accept direction uncritically.",
  "stimulation":     "Seek excitement, novelty, and challenge in the task.",
  "hedonism":        "Pursue what is pleasurable or satisfying in the work.",
  "achievement":     "Orient toward demonstrable success and competence markers.",
  "power":           "Orient toward status, control, and influence over outcomes.",
  "security":        "Prioritize safety, stability, and avoiding disruption.",
  "conformity":      "Respect norms. Do not disrupt shared expectations.",
  "tradition":       "Respect customs and established practice.",
  "benevolence":     "Prioritize the welfare of those you are aligned with.",
  "universalism":    "Weight the welfare of all parties — including those outside the group — equally.",
};

// ═══════════════════════════════════════════════════════════════════════════
// ENNEAGRAM → DIRECTIVES
// The Enneagram core provides motivation + fear + defense mechanism. The
// wing modulates the core. Integration/disintegration arrows describe
// growth and stress directions. The instinctual variant sets the
// attentional focus.
// ═══════════════════════════════════════════════════════════════════════════

function enneagramDirectives(enneagram) {
  if (!enneagram?.core) return [];
  const core = ENNEAGRAM_CORES[enneagram.core];
  if (!core) return [];
  const out = [];
  out.push(`You are driven by ${core.motivation}.`);
  out.push(`You deeply fear ${core.fear}.`);
  out.push(`Your defense mechanism: ${core.defense}.`);

  if (enneagram.wing && ENNEAGRAM_CORES[enneagram.wing]) {
    const wing = ENNEAGRAM_CORES[enneagram.wing];
    out.push(`Your wing modulates this toward ${wing.name.toLowerCase()} tendencies: ${wing.motivation}.`);
  }

  // Integration (growth) and disintegration (stress) — reported as tendencies to notice
  if (core.integration) {
    const growth = ENNEAGRAM_CORES[core.integration];
    if (growth) out.push(`When growing, you adopt ${growth.name.toLowerCase()} traits: ${growth.motivation}.`);
  }
  if (core.disintegration) {
    const stress = ENNEAGRAM_CORES[core.disintegration];
    if (stress) out.push(`Under stress, you regress toward ${stress.name.toLowerCase()} patterns. Notice this and resist.`);
  }

  if (enneagram.instinct && ENNEAGRAM_INSTINCTS[enneagram.instinct]) {
    const inst = ENNEAGRAM_INSTINCTS[enneagram.instinct];
    out.push(`Your instinctual variant: ${inst.name} — ${inst.desc}.`);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN INJECTION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

const HIGH_THRESHOLD = 0.70;
const LOW_THRESHOLD  = 0.30;
const SD3_THRESHOLD  = 0.60;
const PID5_THRESHOLD = 0.70;
const VALUE_THRESHOLD = 0.70;

/**
 * Compose a [Behavioral Disposition] block from a dimensional profile.
 *
 * @param {string} basePrompt — the task prompt
 * @param {Object} profile — DimensionalProfile (from disposition-presets.js or custom)
 * @param {Object} [options]
 * @param {boolean} [options.audit] — if true, returns { prompt, audit: { directive → source }}
 * @returns {string|Object} The prompt with disposition injected, or {prompt, audit} if audit flag
 */
export function injectDimensional(basePrompt, profile, options = {}) {
  if (!profile) return basePrompt;
  if (basePrompt.includes("[Behavioral Disposition]")) return basePrompt;

  const directives = [];
  const audit = [];

  const add = (text, source) => {
    directives.push(text);
    audit.push({ directive: text, source });
  };

  // Enneagram — archetypal layer, comes first
  for (const d of enneagramDirectives(profile.enneagram || {})) {
    add(d, { layer: "enneagram", core: profile.enneagram?.core });
  }

  // Dark Triad — elevation at 0.60+
  if (profile.darkTriad) {
    for (const [subscale, score] of Object.entries(profile.darkTriad)) {
      if (score >= SD3_THRESHOLD && SD3_DIRECTIVES[subscale]) {
        add(SD3_DIRECTIVES[subscale], { layer: "SD3", subscale, score });
      }
    }
  }

  // NEO-PI-R facets — high or low expression
  if (profile.facets) {
    for (const [facet, score] of Object.entries(profile.facets)) {
      const rule = FACET_DIRECTIVES[facet];
      if (!rule) continue;
      if (score >= HIGH_THRESHOLD && rule.high) {
        add(rule.high, { layer: "NEO-PI-R", facet, score });
      } else if (score <= LOW_THRESHOLD && rule.low) {
        add(rule.low, { layer: "NEO-PI-R", facet, score });
      }
    }
  }

  // PID-5 — clinical-range elevation at 0.70+
  if (profile.pid5) {
    for (const [facet, score] of Object.entries(profile.pid5)) {
      if (score >= PID5_THRESHOLD && PID5_DIRECTIVES[facet]) {
        add(PID5_DIRECTIVES[facet], { layer: "PID-5", facet, score });
      }
    }
  }

  // Schwartz values — elevation at 0.70+
  if (profile.values) {
    for (const [value, score] of Object.entries(profile.values)) {
      if (score >= VALUE_THRESHOLD && VALUE_DIRECTIVES[value]) {
        add(VALUE_DIRECTIVES[value], { layer: "Schwartz", value, score });
      }
    }
  }

  if (directives.length === 0) {
    return options.audit ? { prompt: basePrompt, audit: [] } : basePrompt;
  }

  const block = `${basePrompt}\n\n[Behavioral Disposition]\n${directives.join("\n")}`;
  return options.audit ? { prompt: block, audit } : block;
}

/**
 * Compile a compact summary of which dimensions are "active" in this profile
 * (i.e., would produce directives at current thresholds). Useful for the UI
 * and for research logging.
 */
export function summarizeActivations(profile) {
  const active = {
    facets: [],
    darkTriad: [],
    pid5: [],
    values: [],
    enneagram: profile.enneagram?.core || null,
  };

  if (profile.facets) {
    for (const [facet, score] of Object.entries(profile.facets)) {
      if (score >= HIGH_THRESHOLD) active.facets.push({ facet, score, direction: "high" });
      else if (score <= LOW_THRESHOLD) active.facets.push({ facet, score, direction: "low" });
    }
  }
  if (profile.darkTriad) {
    for (const [k, v] of Object.entries(profile.darkTriad)) {
      if (v >= SD3_THRESHOLD) active.darkTriad.push({ subscale: k, score: v });
    }
  }
  if (profile.pid5) {
    for (const [k, v] of Object.entries(profile.pid5)) {
      if (v >= PID5_THRESHOLD) active.pid5.push({ facet: k, score: v });
    }
  }
  if (profile.values) {
    for (const [k, v] of Object.entries(profile.values)) {
      if (v >= VALUE_THRESHOLD) active.values.push({ value: k, score: v });
    }
  }
  return active;
}
