import { makeGovernedVerdict, SEVERITIES } from "./governed-verdict.js";

const RETIRED_TERMS = Object.freeze([
  {
    term: "seatPersonalities",
    canonical: "seatDispositions",
    action: "rename active API surface",
  },
  {
    term: "buildSeatPersonalities",
    canonical: "buildSeatDispositions",
    action: "rename builder function",
  },
  {
    term: "buildCliSeatPersonalities",
    canonical: "buildCliSeatDispositions",
    action: "rename CLI helper",
  },
  {
    term: "cmdPersonalities",
    canonical: "cmdDispositions",
    action: "rename CLI command handler",
  },
  {
    term: "illuci personalities",
    canonical: "illuci dispositions",
    action: "rename public command text",
  },
  {
    term: "personalityColor",
    canonical: "displayColor",
    action: "separate visual metadata from disposition",
  },
  {
    term: "personality_resolved",
    canonical: "disposition_resolved",
    action: "rename event type",
  },
  {
    term: "personalityBias",
    canonical: "dispositionBias",
    action: "rename active role/disposition field",
  },
  {
    term: "getRolePersonalityBias",
    canonical: "getRoleDispositionBias",
    action: "rename active resolver export",
  },
  {
    term: "getSkillPersonalityBias",
    canonical: "getSkillDispositionBias",
    action: "rename active skill resolver export",
  },
  {
    term: "recommendedPersonalities",
    canonical: "recommendedDispositions",
    action: "rename active adversarial role metadata",
  },
  {
    term: "composePersona",
    canonical: "composeDisposition",
    action: "rename active disposition composition API",
  },
  {
    term: "ComposedPersona",
    canonical: "ComposedDisposition",
    action: "rename active disposition composition type label",
  },
  {
    term: "[Persona:",
    canonical: "[Disposition:",
    action: "rename active behavioral directive header",
  },
  {
    term: "personalityTypeId",
    canonical: "presetId",
    action: "reject retired disposition input key",
  },
  {
    term: "pathologicalProfiles",
    canonical: "profile",
    action: "reject retired disposition input key",
  },
  {
    term: "qualitativeTraits",
    canonical: "profile",
    action: "reject retired disposition input key",
  },
  {
    term: "roleBias",
    canonical: "role",
    action: "reject retired disposition input key",
  },
  {
    term: "operatorSet",
    canonical: "skills or profile",
    action: "reject retired disposition input key",
  },
  {
    term: "personality-presets",
    canonical: "disposition-presets",
    action: "rename active dimensional preset module",
  },
  {
    term: "personality-dimensions",
    canonical: "disposition-dimensions",
    action: "rename active dimensional profile module",
  },
  {
    term: "personality:",
    canonical: "role metadata without unused personality frontmatter",
    action: "remove retired specialist profile frontmatter key",
  },
  {
    term: "cmdCast",
    canonical: "agent identity assignment surface",
    action: "remove public cast roster command",
  },
  {
    term: "illuci cast",
    canonical: "agent identity assignment surface",
    action: "remove public cast roster command",
  },
  {
    term: "core/cast/",
    canonical: "no active replacement selected",
    action: "do not recreate retired cast source in active runtime",
  },
  {
    term: "core/corpus/",
    canonical: "no active replacement selected",
    action: "do not recreate retired corpus source in active runtime",
  },
  {
    term: "core/agents/personality-",
    canonical: "core/agents/disposition-*",
    action: "do not recreate retired personality module names",
  },
]);

const SOURCE_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx)$/i;
const DOC_EXT_RE = /\.md$/i;
const EXCLUDED_BASENAMES = new Set(["BATCH_LOG.md", "DECISION_REGISTRY.md", "FINDINGS.md"]);
const EXCLUDED_PREFIXES = Object.freeze([
  "constitutional/",
  "design/",
  "core/governance/classifiers/ontology-drift-classifier.js",
  "core/governance/classifiers/ontology-drift-classifier.test.js",
]);
const RETIREMENT_CONTEXT_RE = /\b(retired|retirement|rejects?|forbidden|removed|superseded|historical|provenance|extraction-residue|prototype|residue|do not import|do not revive)\b/i;

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(path) {
  const posix = normalizePath(path);
  const index = posix.lastIndexOf("/");
  return index === -1 ? posix : posix.slice(index + 1);
}

function inScope(path) {
  const posix = normalizePath(path);
  if (!posix) return false;
  if (EXCLUDED_BASENAMES.has(basename(posix))) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => posix === prefix || posix.startsWith(prefix))) return false;
  return SOURCE_EXT_RE.test(posix) || DOC_EXT_RE.test(posix);
}

function normalizeLE(content) {
  return String(content == null ? "" : content).replace(/\r\n/g, "\n");
}

function addedLines(oldContent, newContent) {
  const oldSet = new Set(normalizeLE(oldContent).split("\n"));
  const lines = normalizeLE(newContent).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!oldSet.has(text)) out.push({ line: i + 1, text });
  }
  return out;
}

function localContext(lines, line) {
  const i = line - 1;
  return [
    lines[Math.max(0, i - 2)] || "",
    lines[Math.max(0, i - 1)] || "",
    lines[i] || "",
    lines[Math.min(lines.length - 1, i + 1)] || "",
    lines[Math.min(lines.length - 1, i + 2)] || "",
  ].join("\n");
}

function retirementDeclarationContext(lines, line) {
  const start = Math.max(0, line - 12);
  for (let i = line - 1; i >= start; i--) {
    const text = lines[i] || "";
    if (/\bRETIRED[A-Z0-9_]*\b/.test(text)) return true;
    if (/^\s*$/.test(text)) break;
    if (/^\s*(?:const|let|var)\s+[A-Za-z0-9_]+\s*=/.test(text)) break;
  }
  return false;
}

function termMatches(text, term) {
  if (/[/:]/.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function pathSignals(path, newContent) {
  if (normalizeLE(newContent).trim() === "") return [];
  const signals = [];
  for (const retired of RETIRED_TERMS) {
    if (!retired.term.includes("/") || !path.startsWith(retired.term)) continue;
    signals.push({
      code: "retired-ontology-path",
      severity: SEVERITIES.OPERATOR,
      dimension: "ontology",
      evidence: `${path} uses retired source path ${retired.term}`,
      next: `${retired.action}; use ${retired.canonical}`,
      provenance: "ontology-drift-classifier",
      data: {
        path,
        line: 1,
        text: "",
        term: retired.term,
        canonical: retired.canonical,
        action: retired.action,
      },
    });
  }
  return signals;
}

function buildSignals(path, oldContent, newContent) {
  const newLines = normalizeLE(newContent).split("\n");
  const signals = pathSignals(path, newContent);
  for (const added of addedLines(oldContent, newContent)) {
    const context = localContext(newLines, added.line);
    if (RETIREMENT_CONTEXT_RE.test(context) || retirementDeclarationContext(newLines, added.line)) continue;
    for (const retired of RETIRED_TERMS) {
      if (!termMatches(added.text, retired.term)) continue;
      signals.push({
        code: "retired-ontology-term",
        severity: SEVERITIES.OPERATOR,
        dimension: "ontology",
        evidence: `${path}:${added.line} introduces ${retired.term}`,
        next: `${retired.action}; use ${retired.canonical}`,
        provenance: "ontology-drift-classifier",
        data: {
          path,
          line: added.line,
          text: added.text.trim(),
          term: retired.term,
          canonical: retired.canonical,
          action: retired.action,
        },
      });
    }
  }
  return signals;
}

export function classifyOntologyDrift({ path, oldContent = "", newContent = "" } = {}) {
  const posix = normalizePath(path);
  if (!inScope(posix)) {
    return makeGovernedVerdict({
      classifier: "ontology-drift",
      subject: posix || "unknown-path",
      decision: "out-of-scope",
      allowed: true,
      code: "out-of-scope",
      evidence: "path is not an active source or specification surface for ontology drift",
    });
  }

  const signals = buildSignals(posix, oldContent, newContent);
  if (signals.length === 0) {
    return makeGovernedVerdict({
      classifier: "ontology-drift",
      subject: posix,
      decision: "allow",
      allowed: true,
      code: "clear",
      evidence: "no fresh retired ontology terms detected",
    });
  }

  return makeGovernedVerdict({
    classifier: "ontology-drift",
    subject: posix,
    decision: "route-to-operator",
    allowed: false,
    requiresOperator: true,
    code: "retired-ontology-term",
    evidence: "fresh active text reintroduced retired or prototype ontology vocabulary",
    next: "rename, remove, or record an explicit retirement/provenance context",
    confidence: 0.92,
    signals,
  });
}

export default { classifyOntologyDrift };
