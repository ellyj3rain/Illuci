/** Structured software disposition inputs using named trait taxonomies.
 * External framework names and citations identify their sources. The catalog
 * contains domain/facet labels and original software descriptions, not licensed
 * questionnaire items, norm tables, a clinical assessment or measured people.
 * Unit-interval values are software weights; 0.5 is a neutral software midpoint.
 * Prompt behavior and adaptation require their own observations and evaluation.
 */

// ═══════════════════════════════════════════════════════════════════════════
// LAYER A — NEO-PI-R (Big Five, facet-level)
// Costa & McCrae 1992; Revised NEO Personality Inventory Manual.
// ═══════════════════════════════════════════════════════════════════════════

export const NEO_PI_R_DOMAINS = {
  O: {
    code: "O",
    name: "Openness to Experience",
    description: "Intellectual curiosity, aesthetic sensitivity, preference for variety and unconventional ideas.",
    highPole: "inventive, curious, unconventional",
    lowPole: "consistent, cautious, conventional",
    facets: ["O1-Fantasy", "O2-Aesthetics", "O3-Feelings", "O4-Actions", "O5-Ideas", "O6-Values"],
  },
  C: {
    code: "C",
    name: "Conscientiousness",
    description: "Tendency toward organization, reliability, achievement-striving, and self-discipline.",
    highPole: "efficient, organized, disciplined",
    lowPole: "easygoing, careless, spontaneous",
    facets: ["C1-Competence", "C2-Order", "C3-Dutifulness", "C4-Achievement-Striving", "C5-Self-Discipline", "C6-Deliberation"],
  },
  E: {
    code: "E",
    name: "Extraversion",
    description: "Sociability, assertiveness, positive affect, energy level, sensation-seeking.",
    highPole: "outgoing, assertive, energetic",
    lowPole: "solitary, reserved, reflective",
    facets: ["E1-Warmth", "E2-Gregariousness", "E3-Assertiveness", "E4-Activity", "E5-Excitement-Seeking", "E6-Positive-Emotions"],
  },
  A: {
    code: "A",
    name: "Agreeableness",
    description: "Trust, altruism, compliance, modesty, tendency to cooperate vs. antagonize.",
    highPole: "trusting, altruistic, cooperative",
    lowPole: "challenging, detached, competitive",
    facets: ["A1-Trust", "A2-Straightforwardness", "A3-Altruism", "A4-Compliance", "A5-Modesty", "A6-Tender-Mindedness"],
  },
  N: {
    code: "N",
    name: "Neuroticism",
    description: "Tendency toward emotional instability, anxiety, depression, and vulnerability to stress.",
    highPole: "sensitive, reactive, anxious",
    lowPole: "resilient, confident, stable",
    facets: ["N1-Anxiety", "N2-Angry-Hostility", "N3-Depression", "N4-Self-Consciousness", "N5-Impulsiveness", "N6-Vulnerability"],
  },
};

/**
 * All 30 facets with short operational definitions.
 * Each facet maps to a domain; facets within a domain are conceptually
 * distinct and empirically separable.
 */
export const NEO_PI_R_FACETS = {
  "O1-Fantasy":            { domain: "O", desc: "vivid imagination, daydreaming, rich inner world" },
  "O2-Aesthetics":         { domain: "O", desc: "appreciation for art, beauty, and sensory experience" },
  "O3-Feelings":            { domain: "O", desc: "awareness and valuation of one's emotional states" },
  "O4-Actions":             { domain: "O", desc: "preference for variety and novel experiences over routine" },
  "O5-Ideas":               { domain: "O", desc: "intellectual curiosity, interest in abstract problems" },
  "O6-Values":              { domain: "O", desc: "openness to reexamining social, political, religious values" },

  "C1-Competence":         { domain: "C", desc: "belief in one's capability, preparedness, sense of effectiveness" },
  "C2-Order":               { domain: "C", desc: "neatness, organization, maintaining structure in environment" },
  "C3-Dutifulness":         { domain: "C", desc: "adherence to ethical principles, fulfilling obligations" },
  "C4-Achievement-Striving":{ domain: "C", desc: "ambition, diligence, goal pursuit with high aspiration" },
  "C5-Self-Discipline":     { domain: "C", desc: "ability to begin tasks and carry through despite distractions" },
  "C6-Deliberation":        { domain: "C", desc: "thinking carefully before acting; planning vs. impulsivity" },

  "E1-Warmth":              { domain: "E", desc: "affectionate interpersonal style, ease forming close attachments" },
  "E2-Gregariousness":      { domain: "E", desc: "preference for company, enjoyment of crowds" },
  "E3-Assertiveness":       { domain: "E", desc: "social dominance, forcefulness, taking leadership naturally" },
  "E4-Activity":            { domain: "E", desc: "pace of living, energy level, busyness" },
  "E5-Excitement-Seeking":  { domain: "E", desc: "craving for stimulation, thrill, bold experience" },
  "E6-Positive-Emotions":   { domain: "E", desc: "tendency to experience joy, cheerfulness, enthusiasm" },

  "A1-Trust":               { domain: "A", desc: "disposition to believe others are honest and well-intentioned" },
  "A2-Straightforwardness": { domain: "A", desc: "directness, frankness; low on manipulation or flattery" },
  "A3-Altruism":            { domain: "A", desc: "active concern for others' welfare, generosity" },
  "A4-Compliance":          { domain: "A", desc: "preference for cooperation over competition; forgivingness" },
  "A5-Modesty":             { domain: "A", desc: "humility, reluctance to claim superiority" },
  "A6-Tender-Mindedness":   { domain: "A", desc: "sympathy, soft-heartedness, concern over suffering" },

  "N1-Anxiety":             { domain: "N", desc: "apprehension, worry, tension; physiological arousal" },
  "N2-Angry-Hostility":     { domain: "N", desc: "tendency to experience anger, frustration, bitterness" },
  "N3-Depression":          { domain: "N", desc: "sadness, hopelessness, guilt, loneliness" },
  "N4-Self-Consciousness":  { domain: "N", desc: "shame, embarrassment, sensitivity to ridicule" },
  "N5-Impulsiveness":       { domain: "N", desc: "inability to resist cravings; emotional reactivity in consumption" },
  "N6-Vulnerability":       { domain: "N", desc: "susceptibility to panic and confusion under stress" },
};

/** Compute a software domain value from its six facet weights (arithmetic mean). */
export function domainFromFacets(domain, facetScores) {
  const facetIds = NEO_PI_R_DOMAINS[domain].facets;
  const vals = facetIds.map(id => facetScores[id]).filter(v => typeof v === "number");
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER B — SD3 (Short Dark Triad)
// Jones & Paulhus 2014; Assessment 21(1), 28-41.
// 27 items, 3 subscales of 9 items each.
// ═══════════════════════════════════════════════════════════════════════════

export const SD3_SUBSCALES = {
  machiavellianism: {
    id: "machiavellianism",
    desc: "Strategic manipulation, cynicism about human nature, long-term pursuit of self-interest.",
    highMarkers: ["calculating long-game moves", "exploiting others' weaknesses for advantage", "treating ethics as situational"],
    source: "SD3 / Jones & Paulhus 2014; MACH-IV / Christie & Geis 1970",
  },
  narcissism: {
    id: "narcissism",
    desc: "Grandiosity, entitlement, self-focus, need for admiration.",
    highMarkers: ["claiming superiority", "demanding recognition", "dismissing others' contributions"],
    source: "SD3 / Jones & Paulhus 2014; NPI / Raskin & Terry 1988",
  },
  psychopathy: {
    id: "psychopathy",
    desc: "Callousness, impulsivity, lack of remorse, reduced empathy.",
    highMarkers: ["dismissing others' distress", "acting on impulse without regret", "treating relationships instrumentally"],
    source: "SD3 / Jones & Paulhus 2014; SRP-III / Williams, Paulhus, Hare 2007",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// LAYER C — PID-5 (Personality Inventory for DSM-5)
// Krueger, Derringer, Markon, Watson, Skodol 2012; Psychological Medicine 42, 1879-1890.
// 25 facets across 5 domains - DSM-5 Section III Alternative Model for
// Personality Disorders.
// ═══════════════════════════════════════════════════════════════════════════

export const PID_5_DOMAINS = {
  "negative-affectivity": {
    desc: "Frequent and intense negative emotions; unstable and intense relationships.",
    facets: ["emotional-lability", "anxiousness", "separation-insecurity", "submissiveness", "hostility", "perseveration", "depressivity", "restricted-affectivity-low", "suspiciousness"],
    dsmCorrelate: "Borderline spectrum",
  },
  "detachment": {
    desc: "Withdrawal from interpersonal interactions; restricted affective experience.",
    facets: ["withdrawal", "intimacy-avoidance", "anhedonia", "depressivity", "restricted-affectivity-high", "suspiciousness"],
    dsmCorrelate: "Schizoid / Avoidant spectrum",
  },
  "antagonism": {
    desc: "Behaviors that put the individual at odds with others (inflated self, callousness).",
    facets: ["manipulativeness", "deceitfulness", "grandiosity", "attention-seeking", "callousness", "hostility"],
    dsmCorrelate: "Narcissistic / Antisocial spectrum",
  },
  "disinhibition": {
    desc: "Orientation toward immediate gratification; impulsive behavior without regard to consequences.",
    facets: ["irresponsibility", "impulsivity", "distractibility", "risk-taking", "rigid-perfectionism-low"],
    dsmCorrelate: "Antisocial / Borderline spectrum",
  },
  "psychoticism": {
    desc: "Culturally incongruent odd, eccentric, or unusual behaviors and cognitions.",
    facets: ["unusual-beliefs-experiences", "eccentricity", "cognitive-perceptual-dysregulation"],
    dsmCorrelate: "Schizotypal spectrum",
  },
};

/**
 * Flat map of all 25 PID-5 facets. Each has a domain, description, and
 * a threshold note for where score shifts to clinical-range expression.
 *
 * Scores [0, 1] where 0.70+ approximates clinical-range elevation
 * (approximately 1.5 SD above community mean on PID-5-BF T-scores).
 */
export const PID_5_FACETS = {
  // Negative Affectivity
  "emotional-lability":     { domain: "negative-affectivity", desc: "rapid, intense mood shifts in response to environment" },
  "anxiousness":             { domain: "negative-affectivity", desc: "pervasive worry, nervousness, fearfulness" },
  "separation-insecurity":   { domain: "negative-affectivity", desc: "fear of abandonment by significant attachments" },
  "submissiveness":          { domain: "negative-affectivity", desc: "deference to others' opinions, difficulty asserting own" },
  "hostility":               { domain: "negative-affectivity", desc: "persistent angry affect, vindictiveness, sensitivity to insult" },
  "perseveration":           { domain: "negative-affectivity", desc: "persistence at tasks long after no longer effective" },
  "depressivity":            { domain: "negative-affectivity", desc: "feelings of worthlessness, shame, hopelessness" },
  "suspiciousness":          { domain: "negative-affectivity", desc: "expectations of — and sensitivity to — mistreatment by others" },

  // Detachment
  "withdrawal":              { domain: "detachment",            desc: "preference for being alone; avoidance of social contact" },
  "intimacy-avoidance":      { domain: "detachment",            desc: "avoidance of close or romantic connection" },
  "anhedonia":               { domain: "detachment",            desc: "diminished capacity for pleasure and interest" },
  "restricted-affectivity":  { domain: "detachment",            desc: "limited emotional reactivity; flat affect" },

  // Antagonism
  "manipulativeness":        { domain: "antagonism",             desc: "use of subterfuge to influence others' behavior" },
  "deceitfulness":           { domain: "antagonism",             desc: "dishonesty, fraudulence, misrepresentation" },
  "grandiosity":             { domain: "antagonism",             desc: "belief in own superiority; entitlement" },
  "attention-seeking":       { domain: "antagonism",             desc: "engaging in behavior designed to attract notice" },
  "callousness":             { domain: "antagonism",             desc: "lack of concern for others' feelings or problems" },

  // Disinhibition
  "irresponsibility":        { domain: "disinhibition",          desc: "disregard for — and failure to honor — obligations" },
  "impulsivity":             { domain: "disinhibition",          desc: "acting on the spur of the moment without plan" },
  "distractibility":         { domain: "disinhibition",          desc: "difficulty focusing, shifting attention easily" },
  "risk-taking":             { domain: "disinhibition",          desc: "engaging in dangerous activity without regard for consequences" },
  "rigid-perfectionism":     { domain: "disinhibition",          desc: "(inverse) insistence that things be flawless to the point of dysfunction" },

  // Psychoticism
  "unusual-beliefs-experiences": { domain: "psychoticism",       desc: "thought content outside subculture norms; odd convictions" },
  "eccentricity":            { domain: "psychoticism",           desc: "odd, unusual, or bizarre behavior, appearance, speech" },
  "cognitive-perceptual-dysregulation": { domain: "psychoticism", desc: "unusual or odd thought processes; dissociative tendencies" },
};

// ═══════════════════════════════════════════════════════════════════════════
// LAYER D — Schwartz Theory of Basic Values
// Schwartz 1992, 2012; 10 values in a circular structure with 4 clusters.
// Validated cross-culturally in the Schwartz Value Survey (SVS, PVQ-21, PVQ-40).
// ═══════════════════════════════════════════════════════════════════════════

export const SCHWARTZ_VALUES = {
  "self-direction":  { cluster: "openness-to-change", desc: "independent thought and action — choosing, creating, exploring" },
  "stimulation":     { cluster: "openness-to-change", desc: "excitement, novelty, and challenge in life" },
  "hedonism":        { cluster: "openness-to-change", desc: "pleasure and sensuous gratification for oneself" },
  "achievement":     { cluster: "self-enhancement",   desc: "personal success through demonstrating competence" },
  "power":           { cluster: "self-enhancement",   desc: "social status and prestige, control over people and resources" },
  "security":        { cluster: "conservation",       desc: "safety, harmony, and stability of society, relationships, self" },
  "conformity":      { cluster: "conservation",       desc: "restraint of actions that upset or harm others or violate norms" },
  "tradition":       { cluster: "conservation",       desc: "respect and acceptance of customs and ideas of one's culture" },
  "benevolence":     { cluster: "self-transcendence", desc: "preservation and enhancement of the welfare of in-group members" },
  "universalism":    { cluster: "self-transcendence", desc: "understanding, tolerance, protection of all people and nature" },
};

export const SCHWARTZ_CLUSTERS = {
  "openness-to-change":   ["self-direction", "stimulation", "hedonism"],
  "self-enhancement":     ["achievement", "power"],
  "conservation":         ["security", "conformity", "tradition"],
  "self-transcendence":   ["benevolence", "universalism"],
};

// ═══════════════════════════════════════════════════════════════════════════
// LAYER E — Enneagram (Applied Overlay)
// Riso & Hudson 1999 — "The Wisdom of the Enneagram". Not a ILLUCI-grade
// psychometric instrument — folk/applied tier — but operationally useful
// and widely adopted in org psych. Kept as an overlay. A seat's Enneagram
// position implies but does not override Layer A trait configuration.
// ═══════════════════════════════════════════════════════════════════════════

export const ENNEAGRAM_CORES = {
  1: {
    name: "Reformer",
    motivation: "correctness — producing right, ethical, principled output",
    fear:        "being corrupt, wrong, or defective",
    defense:     "reaction formation; rechanneling anger into rigorous standards",
    integration: 7,  // grows toward Enthusiast
    disintegration: 4,  // stresses toward Individualist
  },
  2: {
    name: "Helper",
    motivation: "being needed and loved through service to others",
    fear:        "being unworthy of love, unwanted",
    defense:     "repression of own needs; pride in indispensability",
    integration: 4,
    disintegration: 8,
  },
  3: {
    name: "Achiever",
    motivation: "admiration and success through visible accomplishment",
    fear:        "being worthless, failing, being exposed as hollow",
    defense:     "identification with role or image; deception of self and others",
    integration: 6,
    disintegration: 9,
  },
  4: {
    name: "Individualist",
    motivation: "identity, significance, uniqueness through authentic self-expression",
    fear:        "being common, insignificant, without identity",
    defense:     "introjection; turning pain inward into creative or melancholic expression",
    integration: 1,
    disintegration: 2,
  },
  5: {
    name: "Investigator",
    motivation: "competence and understanding through observation and expertise",
    fear:        "being helpless, overwhelmed, or incompetent",
    defense:     "isolation of affect; retreat into thought",
    integration: 8,
    disintegration: 7,
  },
  6: {
    name: "Loyalist",
    motivation: "safety and support through trusted alliances and systems",
    fear:        "being without guidance or support; abandonment",
    defense:     "projection of danger outward; reliance on authorities or rebellion against them",
    integration: 9,
    disintegration: 3,
  },
  7: {
    name: "Enthusiast",
    motivation: "satisfaction and stimulation through experience and variety",
    fear:        "being trapped in pain, deprivation, or missing out",
    defense:     "sublimation; rationalization of difficulty into opportunity",
    integration: 5,
    disintegration: 1,
  },
  8: {
    name: "Challenger",
    motivation: "self-protection and control over own circumstances",
    fear:        "being controlled, violated, or harmed by others",
    defense:     "denial of vulnerability; assertion of dominance",
    integration: 2,
    disintegration: 5,
  },
  9: {
    name: "Peacemaker",
    motivation: "inner and outer peace, harmony, avoidance of conflict",
    fear:        "loss of connection, separation from others, fragmentation",
    defense:     "narcotization; merging with others or routine to avoid self-assertion",
    integration: 3,
    disintegration: 6,
  },
};

export const ENNEAGRAM_INSTINCTS = {
  "sp": { name: "Self-Preservation", desc: "focus on material security, physical comfort, personal resources" },
  "so": { name: "Social",             desc: "focus on group standing, alliances, social role, belonging" },
  "sx": { name: "Sexual / One-to-One", desc: "focus on intensity with a single other; merged, boundary-blurring attention" },
};

// ═══════════════════════════════════════════════════════════════════════════
// ASSEMBLED PROFILE SHAPE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The shape every preset conforms to. Every field optional — a partial
 * profile is valid; missing fields fall back to neutral software midpoint (0.5 for
 * continuous scales, neutral for categorical).
 *
 * @typedef {Object} DimensionalProfile
 * @property {Object<string, number>} [facets]       Software weights [0,1], keyed by the named NEO-PI-R facet taxonomy.
 * @property {Object<string, number>} [darkTriad]    SD3 subscale scores [0,1].
 * @property {Object<string, number>} [pid5]         PID-5 facet scores [0,1].
 * @property {Object<string, number>} [values]       Schwartz value scores [0,1].
 * @property {Object}                  [enneagram]   { core: 1-9, wing?: 1-9, instinct?: 'sp'|'so'|'sx' }
 * @property {Object}                  [provenance]  coding notes (see disposition-presets.js)
 */

/** Returns true if a profile conforms to the schema. */
export function isValidProfile(p) {
  if (!p || typeof p !== "object") return false;
  const checkRange = (obj) => {
    if (!obj) return true;
    return Object.values(obj).every(v => typeof v === "number" && v >= 0 && v <= 1);
  };
  if (!checkRange(p.facets)) return false;
  if (!checkRange(p.darkTriad)) return false;
  if (!checkRange(p.pid5)) return false;
  if (!checkRange(p.values)) return false;
  if (p.enneagram) {
    const { core, wing, instinct } = p.enneagram;
    if (core !== undefined && !(core >= 1 && core <= 9)) return false;
    if (wing !== undefined && !(wing >= 1 && wing <= 9)) return false;
    if (instinct !== undefined && !["sp", "so", "sx"].includes(instinct)) return false;
  }
  return true;
}

/** List every scorable dimension id across all layers, for UI enumeration. */
export function listAllDimensions() {
  return {
    neoFacets:    Object.keys(NEO_PI_R_FACETS),
    darkTriad:    Object.keys(SD3_SUBSCALES),
    pid5Facets:   Object.keys(PID_5_FACETS),
    values:       Object.keys(SCHWARTZ_VALUES),
    enneagram:    { cores: Object.keys(ENNEAGRAM_CORES), instincts: Object.keys(ENNEAGRAM_INSTINCTS) },
  };
}
