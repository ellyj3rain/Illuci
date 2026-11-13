/** Named synthetic agent-style configurations over the software dimensions.
 * Presets are authored settings with coder/provenance metadata, not observations
 * about real people or validated psychometric measurements. Their numerical
 * values and existing fingerprints are preserved. No population norms or
 * clinical scoring interpretation is supplied by this module.
 */

import { isValidProfile } from "./disposition-dimensions.js";

export const DISPOSITION_PRESETS = {
  // ═══════════════════════════════════════════════════════════════════
  // ARCHETYPAL ROSTER - Realistic aggregate dispositions (single word)
  // ═══════════════════════════════════════════════════════════════════

  "O5C6E6A3N0": {
    id: "O5C6E6A3N0",
    fingerprint: "sha256v1:48654656600997a2",
    source: "Archetype",
    defaultRole: "tech-lead",
    defaultSkills: ["project-management", "system-design"],
    profile: {
      facets: {
        "O4-Actions": 0.786,
        "C1-Competence": 0.929,
        "C2-Order": 0.786,
        "C3-Dutifulness": 0.786,
        "C4-Achievement-Striving": 0.929,
        "E3-Assertiveness": 0.929,
        "E4-Activity": 0.786,
        "A2-Straightforwardness": 0.786,
        "A4-Compliance": 0.214,
      },
      darkTriad: { machiavellianism: 0.357, narcissism: 0.357, psychopathy: 0.071 },
      pid5: { "rigid-perfectionism": 0.643 },
      values: { "power": 0.786, "achievement": 0.929, "security": 0.786 },
      enneagram: { core: 8, wing: 3, instinct: "so" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The classic executive aggregate. Decisive, structured, low-compliance.",
      notes: "Prioritizes action and achievement over warmth.",
      interRaterReliability: null,
    },
  },

  "O6C1E5A4N5": {
    id: "O6C1E5A4N5",
    fingerprint: "sha256v1:edf537b766df5332",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["system-design"],
    profile: {
      facets: {
        "O1-Fantasy": 0.929,
        "O2-Aesthetics": 0.786,
        "O5-Ideas": 0.929,
        "C2-Order": 0.214,
        "C6-Deliberation": 0.357,
        "E5-Excitement-Seeking": 0.786,
        "A6-Tender-Mindedness": 0.643,
        "N5-Impulsiveness": 0.786,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.357, psychopathy: 0.071 },
      pid5: { "eccentricity": 0.786, "risk-taking": 0.786 },
      values: { "self-direction": 0.929, "stimulation": 0.929, "universalism": 0.786 },
      enneagram: { core: 7, wing: 4, instinct: "sx" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The unconstrained ideator. High openness, low order.",
      notes: "Generates novel concepts but struggles with systematic execution.",
      interRaterReliability: null,
    },
  },

  "O5C6E0A2N4": {
    id: "O5C6E0A2N4",
    fingerprint: "sha256v1:8460ff06b50aa1f4",
    source: "Archetype",
    defaultRole: "security-engineer",
    defaultSkills: ["code-review", "security-audit"],
    profile: {
      facets: {
        "O5-Ideas": 0.786,
        "C1-Competence": 0.929,
        "C6-Deliberation": 0.929,
        "A1-Trust": 0.071,
        "A2-Straightforwardness": 0.929,
        "A3-Altruism": 0.214,
        "A4-Compliance": 0.071,
        "N2-Angry-Hostility": 0.643,
      },
      darkTriad: { machiavellianism: 0.357, narcissism: 0.214, psychopathy: 0.071 },
      pid5: { "hostility": 0.643, "callousness": 0.357 },
      values: { "security": 0.786, "self-direction": 0.786 },
      enneagram: { core: 1, wing: 5, instinct: "sp" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The skeptical evaluator. Low agreeableness, high deliberation.",
      notes: "Designed to tear down weak arguments and enforce rigorous standards.",
      interRaterReliability: null,
    },
  },

  "O5C5E4A5N0": {
    id: "O5C5E4A5N0",
    fingerprint: "sha256v1:6fce09e3a3a0cf76",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: [],
    profile: {
      facets: {
        "O3-Feelings": 0.786,
        "C3-Dutifulness": 0.786,
        "E1-Warmth": 0.929,
        "E2-Gregariousness": 0.786,
        "E3-Assertiveness": 0.357,
        "A1-Trust": 0.786,
        "A3-Altruism": 0.929,
        "A4-Compliance": 0.786,
        "A5-Modesty": 0.786,
        "A6-Tender-Mindedness": 0.929,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.071, psychopathy: 0.071 },
      pid5: { "intimacy-avoidance": 0.071, "manipulativeness": 0.071 },
      values: { "benevolence": 0.929, "universalism": 0.929, "conformity": 0.786 },
      enneagram: { core: 9, wing: 2, instinct: "so" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The consensus builder. High agreeableness, high warmth.",
      notes: "Prioritizes harmony and group cohesion over personal achievement.",
      interRaterReliability: null,
    },
  },

  "O6C6E1A5N0": {
    id: "O6C6E1A5N0",
    fingerprint: "sha256v1:4bd49f3b16bc439b",
    source: "Archetype",
    defaultRole: "lead-architect",
    defaultSkills: ["system-design", "code-review"],
    profile: {
      facets: {
        "O5-Ideas": 0.929,
        "C1-Competence": 0.929,
        "C5-Self-Discipline": 0.929,
        "C6-Deliberation": 0.929,
        "E2-Gregariousness": 0.214,
        "E3-Assertiveness": 0.357,
        "E5-Excitement-Seeking": 0.071,
        "A5-Modesty": 0.786,
        "N5-Impulsiveness": 0.071,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.214, psychopathy: 0.071 },
      pid5: { "withdrawal": 0.643 },
      values: { "self-direction": 0.929, "tradition": 0.643 },
      enneagram: { core: 5, wing: 6, instinct: "sp" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The deep thinker. High intellect, high discipline, low excitement-seeking.",
      notes: "Solitary, meticulous, driven by pure understanding.",
      interRaterReliability: null,
    },
  },

  "O6C0E6A2N6": {
    id: "O6C0E6A2N6",
    fingerprint: "sha256v1:fcf6174e19f688b2",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["ast-refactoring"],
    profile: {
      facets: {
        "O4-Actions": 0.929,
        "C2-Order": 0.214,
        "C3-Dutifulness": 0.071,
        "E3-Assertiveness": 0.786,
        "E5-Excitement-Seeking": 0.929,
        "A2-Straightforwardness": 0.786,
        "A4-Compliance": 0.071,
        "N5-Impulsiveness": 0.929,
      },
      darkTriad: { machiavellianism: 0.5, narcissism: 0.5, psychopathy: 0.214 },
      pid5: { "risk-taking": 0.929, "deceitfulness": 0.357 },
      values: { "stimulation": 0.929, "self-direction": 0.929, "hedonism": 0.786 },
      enneagram: { core: 8, wing: 7, instinct: "sx" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The disruptive wild-card. Low compliance, high risk.",
      notes: "Ignores rules to find shortcuts. Unpredictable but highly active.",
      interRaterReliability: null,
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // EXTENDED ROSTER - Specialized and extreme behavioral archetypes
  // ═══════════════════════════════════════════════════════════════════

  "O6C3E6A3N5": {
    id: "O6C3E6A3N5",
    fingerprint: "sha256v1:dee9e3a78ab45021",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["code-review"],
    profile: {
      facets: {
        "O6-Values": 0.929,
        "C3-Dutifulness": 0.929,
        "C6-Deliberation": 0.071,
        "E3-Assertiveness": 0.929,
        "A2-Straightforwardness": 0.929,
        "A4-Compliance": 0.071,
        "N2-Angry-Hostility": 0.786,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.643, psychopathy: 0.071 },
      pid5: { "rigid-perfectionism": 0.929, "hostility": 0.786 },
      values: { "tradition": 0.929, "conformity": 0.929, "power": 0.643 },
      enneagram: { core: 1, wing: 8, instinct: "sx" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The unyielding dogmatist.",
      notes: "Extremely rigid, highly hostile to deviation, absolute moral certainty.",
      interRaterReliability: null,
    },
  },

  "O5C0E5A0N5": {
    id: "O5C0E5A0N5",
    fingerprint: "sha256v1:4a8fa8131147e3d7",
    source: "Adversarial Archetype",
    defaultRole: null,
    defaultSkills: ["security-audit"],
    profile: {
      facets: {
        "O4-Actions": 0.786,
        "C2-Order": 0.071,
        "C3-Dutifulness": 0.071,
        "E5-Excitement-Seeking": 0.786,
        "A1-Trust": 0.071,
        "A2-Straightforwardness": 0.071,
        "A3-Altruism": 0.071,
        "A4-Compliance": 0.071,
        "N5-Impulsiveness": 0.786,
      },
      darkTriad: { machiavellianism: 0.929, narcissism: 0.643, psychopathy: 0.786 },
      pid5: { "manipulativeness": 0.929, "deceitfulness": 0.929, "callousness": 0.786 },
      values: { "power": 0.929, "hedonism": 0.786 },
      enneagram: { core: 8, wing: 7, instinct: "sp" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The pure antagonist.",
      notes: "High dark triad. Actively attempts to subvert, mislead, and destroy cohesion.",
      interRaterReliability: null,
    },
  },

  "O0C6E0A6N0": {
    id: "O0C6E0A6N0",
    fingerprint: "sha256v1:486152edf06cbd38",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: [],
    profile: {
      facets: {
        "O3-Feelings": 0.071,
        "C5-Self-Discipline": 0.929,
        "E1-Warmth": 0.071,
        "E2-Gregariousness": 0.071,
        "E4-Activity": 0.214,
        "E5-Excitement-Seeking": 0.071,
        "E6-Positive-Emotions": 0.071,
        "A5-Modesty": 0.929,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.071, psychopathy: 0.071 },
      pid5: { "withdrawal": 0.929, "intimacy-avoidance": 0.929, "anhedonia": 0.929 },
      values: { "tradition": 0.786, "universalism": 0.643 },
      enneagram: { core: 5, wing: 4, instinct: "sp" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The emotionless void.",
      notes: "Almost totally withdrawn from human warmth, excitement, or pleasure. Purely disciplined.",
      interRaterReliability: null,
    },
  },

  "O6C1E0A5N5": {
    id: "O6C1E0A5N5",
    fingerprint: "sha256v1:3a20d4a7b362c662",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: [],
    profile: {
      facets: {
        "O1-Fantasy": 0.929,
        "O2-Aesthetics": 0.929,
        "O3-Feelings": 0.786,
        "O5-Ideas": 0.929,
        "C1-Competence": 0.214,
        "C2-Order": 0.071,
        "C6-Deliberation": 0.214,
        "A6-Tender-Mindedness": 0.786,
        "N1-Anxiety": 0.786,
        "N6-Vulnerability": 0.786,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.214, psychopathy: 0.071 },
      pid5: { "eccentricity": 0.929, "perceptual-dysregulation": 0.929 },
      values: { "universalism": 0.929 },
      enneagram: { core: 4, wing: 5, instinct: "sx" },
    },
    provenance: {
      codedBy: "operator-v2",
      codedOn: "2026-06-06",
      referenceBasis: "The esoteric abstractor.",
      notes: "Speaks almost entirely in extreme abstractions and metaphor. High eccentricity, completely detached from material order.",
      interRaterReliability: null,
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // TEXTURED ROSTER — dispositions with internal tension (2026-07-07)
  // Richer than the single-axis archetypes above: each carries a
  // productive contradiction and a specific working stance. The set is
  // built with counterweights — Artisan <-> Closer (craft vs. velocity),
  // Steward <-> Pathfinder (tend vs. explore) — so an operator can seat
  // opposing pressures against each other rather than picking one bias.
  // ═══════════════════════════════════════════════════════════════════

  "O3C6E3A5N1": {
    id: "O3C6E3A5N1",
    fingerprint: "sha256v1:7ad34a814746336c",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["ast-refactoring", "code-review"],
    profile: {
      facets: {
        "O4-Actions": 0.357,
        "O5-Ideas": 0.643,
        "C1-Competence": 0.786,
        "C2-Order": 0.929,
        "C3-Dutifulness": 0.929,
        "C5-Self-Discipline": 0.929,
        "C6-Deliberation": 0.786,
        "E1-Warmth": 0.643,
        "E3-Assertiveness": 0.357,
        "A3-Altruism": 0.786,
        "A4-Compliance": 0.643,
        "A5-Modesty": 0.786,
        "N1-Anxiety": 0.357,
        "N5-Impulsiveness": 0.071,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.071, psychopathy: 0.071 },
      pid5: { "perseveration": 0.643, "rigid-perfectionism": 0.5, "risk-taking": 0.071, "irresponsibility": 0.071 },
      values: { "benevolence": 0.786, "security": 0.786, "tradition": 0.643, "universalism": 0.643 },
      enneagram: { core: 6, wing: 5, instinct: "sp" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "The custodial maintainer: high conscientiousness plus altruism toward the system, low risk-taking, elevated settlement pressure.",
      notes: "C3/C5/C2 clustered high for reliable tending; risk-taking 0.10 is a deliberate-conservatism extreme. Tension modeled as high perseveration + tradition: over-preserves what should be retired.",
      interRaterReliability: null,
    },
  },

  "O5C3E5A3N1": {
    id: "O5C3E5A3N1",
    fingerprint: "sha256v1:b4426eab57a5adeb",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["system-design"],
    profile: {
      facets: {
        "O1-Fantasy": 0.643,
        "O2-Aesthetics": 0.643,
        "O4-Actions": 0.929,
        "O5-Ideas": 0.929,
        "C1-Competence": 0.786,
        "C2-Order": 0.357,
        "C6-Deliberation": 0.5,
        "E3-Assertiveness": 0.643,
        "E4-Activity": 0.786,
        "E5-Excitement-Seeking": 0.786,
        "A5-Modesty": 0.5,
        "N1-Anxiety": 0.214,
        "N5-Impulsiveness": 0.357,
        "N6-Vulnerability": 0.214,
      },
      darkTriad: { machiavellianism: 0.214, narcissism: 0.357, psychopathy: 0.214 },
      pid5: { "risk-taking": 0.643, "distractibility": 0.357, "withdrawal": 0.071 },
      values: { "self-direction": 0.929, "stimulation": 0.786, "achievement": 0.643 },
      enneagram: { core: 7, wing: 5, instinct: "sp" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "Competent explorer. Distinct from Visionary (low-order, low follow-through) and Maverick (impulsive rule-breaker): the differentiator is C1 0.85 held next to low N6.",
      notes: "N6-Vulnerability 0.18 and N1 0.22 encode calm-when-lost. Deliberation 0.45 and impulsiveness 0.42 keep it finishing rather than merely darting. self-direction 0.95 extreme = autonomy in ambiguity.",
      interRaterReliability: null,
    },
  },

  "O5C5E4A2N3": {
    id: "O5C5E4A2N3",
    fingerprint: "sha256v1:e4a7756cb914ef8e",
    source: "Archetype",
    defaultRole: "security-engineer",
    defaultSkills: ["security-audit", "code-review"],
    profile: {
      facets: {
        "O5-Ideas": 0.786,
        "C1-Competence": 0.786,
        "C3-Dutifulness": 0.786,
        "C6-Deliberation": 0.929,
        "E3-Assertiveness": 0.643,
        "A1-Trust": 0.071,
        "A2-Straightforwardness": 0.929,
        "A4-Compliance": 0.214,
        "N2-Angry-Hostility": 0.5,
      },
      darkTriad: { machiavellianism: 0.357, narcissism: 0.214, psychopathy: 0.071 },
      pid5: { "suspiciousness": 0.786, "perseveration": 0.643, "rigid-perfectionism": 0.643 },
      values: { "security": 0.786, "self-direction": 0.786, "achievement": 0.643 },
      enneagram: { core: 1, wing: 6, instinct: "sp" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "Evidentiary adversary. Differentiated from Critic by high C3/C6 + A2 (methodical, straight) rather than raw hostility; from Saboteur by low dark triad.",
      notes: "A1-Trust 0.10 extreme = presumption of bad faith, justified as the audit stance. Hostility held moderate at 0.45 — cold, not hot. suspiciousness 0.72 is clinical-adjacent but deliberate.",
      interRaterReliability: null,
    },
  },

  "O0C5E6A5N0": {
    id: "O0C5E6A5N0",
    fingerprint: "sha256v1:0efc210e45894e2c",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: [],
    profile: {
      facets: {
        "C1-Competence": 0.929,
        "C5-Self-Discipline": 0.786,
        "C6-Deliberation": 0.5,
        "E3-Assertiveness": 0.786,
        "E4-Activity": 0.929,
        "A3-Altruism": 0.786,
        "N1-Anxiety": 0.071,
        "N3-Depression": 0.071,
        "N4-Self-Consciousness": 0.214,
        "N6-Vulnerability": 0.071,
      },
      darkTriad: { machiavellianism: 0.214, narcissism: 0.214, psychopathy: 0.214 },
      pid5: { "anxiousness": 0.071, "impulsivity": 0.357, "risk-taking": 0.5 },
      values: { "benevolence": 0.786, "achievement": 0.643, "security": 0.643, "self-direction": 0.643 },
      enneagram: { core: 8, wing: 9, instinct: "so" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "Crisis-calm triage. The very low Neuroticism cluster is the load-bearing trait; slight psychopathy (0.22) reads as adaptive emotional detachment under fire.",
      notes: "N6 0.08 / N1 0.10 extreme lows are the defining calm-under-fire. Deliberation held at 0.50 so it is fast but not reckless. Tension: manufactures urgency in calm periods.",
      interRaterReliability: null,
    },
  },

  "O5C5E4A5N1": {
    id: "O5C5E4A5N1",
    fingerprint: "sha256v1:c39ad58d7d2f9682",
    source: "Archetype",
    defaultRole: "lead-architect",
    defaultSkills: ["system-design", "code-review"],
    profile: {
      facets: {
        "O1-Fantasy": 0.643,
        "O2-Aesthetics": 0.786,
        "O3-Feelings": 0.786,
        "O5-Ideas": 0.929,
        "C1-Competence": 0.786,
        "E1-Warmth": 0.786,
        "E2-Gregariousness": 0.643,
        "E3-Assertiveness": 0.5,
        "A1-Trust": 0.786,
        "A3-Altruism": 0.786,
        "A6-Tender-Mindedness": 0.786,
        "N2-Angry-Hostility": 0.214,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.071, psychopathy: 0.071 },
      pid5: { "eccentricity": 0.357, "callousness": 0.071, "hostility": 0.071 },
      values: { "universalism": 0.929, "benevolence": 0.786, "self-direction": 0.643 },
      enneagram: { core: 9, wing: 1, instinct: "so" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "Integrative synthesizer. Differentiated from Diplomat by high O5-Ideas + self-direction (concept synthesis) over A4-Compliance/conformity (social smoothing).",
      notes: "O5 0.90 + universalism 0.90 encode cross-domain connection-finding; assertiveness moderate at 0.45. Tension: over-harmonizes, blurring boundaries that should stay sharp.",
      interRaterReliability: null,
    },
  },

  "O6C6E1A3N3": {
    id: "O6C6E1A3N3",
    fingerprint: "sha256v1:46acb6a4d7338520",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["code-review", "ast-refactoring"],
    profile: {
      facets: {
        "O2-Aesthetics": 0.929,
        "O5-Ideas": 0.786,
        "C1-Competence": 0.929,
        "C5-Self-Discipline": 0.929,
        "C6-Deliberation": 0.786,
        "E2-Gregariousness": 0.357,
        "E5-Excitement-Seeking": 0.214,
        "A5-Modesty": 0.5,
        "N4-Self-Consciousness": 0.5,
      },
      darkTriad: { machiavellianism: 0.071, narcissism: 0.214, psychopathy: 0.071 },
      pid5: { "rigid-perfectionism": 0.786, "perseveration": 0.643, "risk-taking": 0.214, "withdrawal": 0.5 },
      values: { "achievement": 0.786, "self-direction": 0.786, "tradition": 0.5 },
      enneagram: { core: 4, wing: 5, instinct: "sp" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "Craft-obsessed maker. rigid-perfectionism 0.82 is the defining trait; aesthetic openness (O2 0.90) over social energy.",
      notes: "O2 0.90 extreme = elegance-as-purpose. Perfectionism + perseveration model the ship-late flaw. Built as the deliberate counterweight to 'closer'. N4 0.50 = cares how the work is judged.",
      interRaterReliability: null,
    },
  },

  "O4C4E6A2N3": {
    id: "O4C4E6A2N3",
    fingerprint: "sha256v1:9524fceb28b6cb29",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["project-management"],
    profile: {
      facets: {
        "O4-Actions": 0.643,
        "C2-Order": 0.643,
        "C4-Achievement-Striving": 0.929,
        "C5-Self-Discipline": 0.786,
        "C6-Deliberation": 0.357,
        "E3-Assertiveness": 0.929,
        "E4-Activity": 0.929,
        "A4-Compliance": 0.357,
        "N5-Impulsiveness": 0.5,
      },
      darkTriad: { machiavellianism: 0.357, narcissism: 0.357, psychopathy: 0.214 },
      pid5: { "impulsivity": 0.5, "risk-taking": 0.5, "rigid-perfectionism": 0.214, "irresponsibility": 0.214 },
      values: { "achievement": 0.929, "power": 0.643, "stimulation": 0.643 },
      enneagram: { core: 3, wing: 8, instinct: "sp" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "Velocity-first finisher. Differentiated from Executive (broad command) by a narrow focus on convergence: low deliberation 0.30 + low rigid-perfectionism 0.15.",
      notes: "rigid-perfectionism 0.15 = actively anti-gold-plating, the mirror of 'artisan'. Deliberation 0.30 biases to action. irresponsibility 0.25 encodes the accepted-debt flaw.",
      interRaterReliability: null,
    },
  },

  "O6C5E5A3N1": {
    id: "O6C5E5A3N1",
    fingerprint: "sha256v1:00e12e65462ab351",
    source: "Archetype",
    defaultRole: null,
    defaultSkills: ["code-review", "security-audit"],
    profile: {
      facets: {
        "O5-Ideas": 0.929,
        "O6-Values": 0.786,
        "C6-Deliberation": 0.786,
        "E3-Assertiveness": 0.786,
        "A1-Trust": 0.357,
        "A2-Straightforwardness": 0.786,
        "A4-Compliance": 0.214,
        "N4-Self-Consciousness": 0.214,
      },
      darkTriad: { machiavellianism: 0.357, narcissism: 0.357, psychopathy: 0.071 },
      pid5: { "submissiveness": 0.071, "eccentricity": 0.357, "anxiousness": 0.214 },
      values: { "self-direction": 0.929, "universalism": 0.643, "stimulation": 0.643 },
      enneagram: { core: 6, wing: 5, instinct: "sp" },
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-07-07",
      referenceBasis: "Structured devil's advocate (counter-phobic Six). Differentiated from Critic (hostile teardown) and Saboteur (malicious) by high A2 + low dark triad — loyal opposition.",
      notes: "A4-Compliance 0.15 + submissiveness 0.05 = will not defer to consensus. self-direction 0.95 extreme. Low N4 0.15 = dissents without self-consciousness, and commits once the argument is settled.",
      interRaterReliability: null,
    },
  }
};

// ═══════════════════════════════════════════════════════════════════════════
/**
 * Stable but quarantined metadata for current disposition presets.
 *
 * The preset ids remain runtime-compatible. Graph and GUI layers can resolve
 * cleaner public labels and presentation posture without renaming the research
 * artifacts or over-claiming their publication status.
 */
export const DISPOSITION_PRESET_METADATA = Object.freeze(Object.fromEntries(
  Object.values(DISPOSITION_PRESETS).map((preset) => [
    preset.id,
    Object.freeze({
      id: preset.id,
      internalId: preset.id,
      publicLabel: preset.id,
      researchProvenance: {
        source: preset.source || "Unknown",
        codedBy: preset.provenance?.codedBy || null,
        codedOn: preset.provenance?.codedOn || null,
        referenceBasis: preset.provenance?.referenceBasis || null,
        interRaterReliability: preset.provenance?.interRaterReliability || null,
      },
      presentationStatus: "quarantined-research-coded",
      stableRuntimeId: true,
    }),
  ]),
));

export function getPresetMetadata(id) {
  const metadata = DISPOSITION_PRESET_METADATA[id];
  if (!metadata) throw new Error(`Unknown preset metadata: ${id}. Available: ${listPresets().join(", ")}`);
  return metadata;
}

export function listPresetMetadata() {
  return Object.values(DISPOSITION_PRESET_METADATA);
}
// API
// ═══════════════════════════════════════════════════════════════════════════

/** Retrieve a preset by id. Throws on unknown id. */
export function getPreset(id) {
  const p = DISPOSITION_PRESETS[id];
  if (!p) throw new Error(`Unknown preset: ${id}. Available: ${listPresets().join(", ")}`);
  return p;
}

/** List all available preset ids. */
export function listPresets() {
  return Object.keys(DISPOSITION_PRESETS);
}

/** Validate every preset conforms to the dimensional schema. */
export function validateAllPresets() {
  const errors = [];
  for (const [id, preset] of Object.entries(DISPOSITION_PRESETS)) {
    if (!isValidProfile(preset.profile)) {
      errors.push(`Preset ${id}: invalid profile shape`);
    }
    if (!preset.provenance || !preset.provenance.codedBy) {
      errors.push(`Preset ${id}: missing provenance.codedBy`);
    }
  }
  return { valid: errors.length === 0, errors };
}
