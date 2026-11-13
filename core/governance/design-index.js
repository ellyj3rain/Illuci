// The design-archive index gate — inventory completeness and label rendering (DR-188).
//
// What this gate PROVES: every root design/*.md is classified exactly once in
// design/index-labels.json, every classified path exists, labels come from the
// closed vocabulary, SUPERSEDED entries carry a resolvable supersededBy or an
// explicit orphan+reason, and INDEX.md's generated inventory region is a fresh
// render of map + directory scan (content-addressed stamp, no wall-clock).
//
// What this gate does NOT prove (named per the WO-1 ruling, C-1): the semantic
// correctness of the labels. Status is human classification declared as data in
// the label map; the map is the SOLE classification authority (C-3) — a doc's
// own Status header is decoration here. Unclassified files FAIL the gate; the
// generator never invents a status (C-6).
//
// Same doctrine as the README freshness gate (DR-120): derive the derivable,
// gate the render, keep judgment as authored data — remove drift by construction.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DESIGN_INDEX_SCHEMA = "illuci.governance.design-index/1";
export const LABELS_SCHEMA = "illuci.governance.design-index-labels/1";
export const GENERATOR_VERSION = "1";

export const STATUS_VOCABULARY = Object.freeze([
  "ACTIVE",
  "PROVENANCE",
  "SUPERSEDED",
  "RAW-ARCHIVE",
  "TOOLING",
]);

const BEGIN_PREFIX = "<!-- illuci:generated:design-index BEGIN";
const END_MARKER = "<!-- illuci:generated:design-index END -->";

function beginMarker(stamp) {
  return (
    `${BEGIN_PREFIX} sha256:${stamp} — derived from design/index-labels.json + the design/ directory scan; ` +
    "do not hand-edit. Refresh with `npm run governance:design-index -- --write`. -->"
  );
}

// ── inputs ─────────────────────────────────────────────────────────────────

export function loadLabels(repoRoot) {
  const path = resolve(repoRoot, "design", "index-labels.json");
  const raw = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`design-index: design/index-labels.json is not valid JSON — ${err.message}`);
  }
  if (parsed?.schema !== LABELS_SCHEMA) {
    throw new Error(`design-index: label map schema must be "${LABELS_SCHEMA}" (got ${JSON.stringify(parsed?.schema)})`);
  }
  if (!parsed.labels || typeof parsed.labels !== "object" || Array.isArray(parsed.labels)) {
    throw new Error("design-index: label map needs a labels object");
  }
  const patterns = Array.isArray(parsed.patterns) ? parsed.patterns : [];
  for (const [p, entry] of Object.entries(parsed.labels)) {
    if (!entry || typeof entry !== "object") throw new Error(`design-index: label entry for ${p} must be an object`);
    if (!STATUS_VOCABULARY.includes(entry.status)) {
      throw new Error(`design-index: ${p} carries status ${JSON.stringify(entry.status)} — not in the closed vocabulary [${STATUS_VOCABULARY.join(", ")}]`);
    }
  }
  for (const pat of patterns) {
    if (!pat?.match || !STATUS_VOCABULARY.includes(pat?.status)) {
      throw new Error(`design-index: pattern entry ${JSON.stringify(pat?.match)} needs match + a vocabulary status`);
    }
  }
  return { raw, labels: parsed.labels, patterns };
}

// Scan the design/ ROOT for markdown documents (the C-5.1 population). Pure
// listing — subdirectories are classified as directory entries in the map,
// non-md root files ride exact entries or patterns.
export function scanDesign(repoRoot) {
  const dir = resolve(repoRoot, "design");
  const entries = readdirSync(dir, { withFileTypes: true });
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => `design/${e.name}`)
    .sort();
  return { mdFiles };
}

// ── validation (C-5 fail-closed rules + C-6) ───────────────────────────────

export function validateIndexLabels({ labels, scan, repoRoot, exists }) {
  const fileExists = exists || ((rel) => existsSync(resolve(repoRoot, rel)));
  const violations = [];

  // C-5.1 + C-6: every root design/*.md classified exactly once; no generator default.
  for (const md of scan.mdFiles) {
    if (!labels[md]) {
      violations.push(`unclassified: ${md} is on disk but absent from design/index-labels.json — the generator never invents a status (C-6); a human classifies it`);
    }
  }

  for (const [p, entry] of Object.entries(labels)) {
    // C-5.2: every classified path exists (directories end with /).
    if (!fileExists(p)) {
      violations.push(`missing: ${p} is classified but not on disk`);
    }
    // C-5.4: SUPERSEDED needs a resolvable pointer or an explicit orphan+reason.
    if (entry.status === "SUPERSEDED") {
      if (entry.supersededBy) {
        if (!fileExists(entry.supersededBy)) {
          violations.push(`supersededBy: ${p} points at ${entry.supersededBy}, which is not on disk`);
        }
      } else if (!(entry.orphan === true && typeof entry.reason === "string" && entry.reason.trim())) {
        violations.push(`superseded-without-pointer: ${p} is SUPERSEDED but carries neither supersededBy nor orphan:true + reason`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── render (deterministic; content-addressed stamp, C-4) ──────────────────

export function computeStamp({ scan, labelsRaw }) {
  return createHash("sha256")
    .update(JSON.stringify({ v: GENERATOR_VERSION, files: scan.mdFiles, labels: labelsRaw }))
    .digest("hex")
    .slice(0, 16);
}

const SECTION_TITLES = {
  ACTIVE: "Active Design Surfaces",
  PROVENANCE: "Provenance",
  SUPERSEDED: "Superseded",
  "RAW-ARCHIVE": "Raw Archive",
  TOOLING: "Tooling",
};

export function renderIndexRegion({ labels, patterns, stamp }) {
  const lines = [beginMarker(stamp)];
  for (const status of STATUS_VOCABULARY) {
    const exact = Object.entries(labels)
      .filter(([, e]) => e.status === status)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const pats = patterns.filter((p) => p.status === status);
    if (!exact.length && !pats.length) continue;
    lines.push("", `## ${SECTION_TITLES[status]}`, "", "| Path | Status | Use |", "|---|---|---|");
    for (const [p, e] of exact) {
      let use = e.use || "";
      if (e.supersededBy) use += ` Superseded by \`${e.supersededBy}\`.`;
      if (e.orphan === true) use += ` Orphan: ${e.reason}`;
      lines.push(`| \`${p}\` | ${status} | ${use.trim()} |`);
    }
    for (const p of pats) {
      lines.push(`| \`${p.match}\` | ${status} | ${p.use || ""} |`);
    }
  }
  lines.push("", END_MARKER);
  return lines.join("\n");
}

// ── region plumbing (mirrors readme-freshness) ─────────────────────────────

export function extractIndexRegion(indexText) {
  const b = indexText.indexOf(BEGIN_PREFIX);
  const e = indexText.indexOf(END_MARKER);
  if (b === -1 || e === -1 || e < b) return null;
  return indexText.slice(b, e + END_MARKER.length);
}

export function refreshIndex(indexText, rendered) {
  const region = extractIndexRegion(indexText);
  if (region === null) return `${indexText.replace(/\s*$/, "")}\n\n${rendered}\n`;
  return indexText.replace(region, rendered);
}

// ── the PROBE ──────────────────────────────────────────────────────────────

export function checkDesignIndex(indexText, { repoRoot, inputs } = {}) {
  const root = repoRoot || defaultRepoRoot();
  const { raw, labels, patterns } = inputs?.labelsBundle || loadLabels(root);
  const scan = inputs?.scan || scanDesign(root);
  const validation = validateIndexLabels({ labels, scan, repoRoot: root, exists: inputs?.exists });
  if (!validation.ok) return { ok: false, code: "labels-invalid", violations: validation.violations };

  const stamp = computeStamp({ scan, labelsRaw: raw });
  const rendered = renderIndexRegion({ labels, patterns, stamp });
  const region = extractIndexRegion(indexText);
  if (region === null) {
    return { ok: false, code: "no-region", violations: ["design/INDEX.md has no generated design-index region — run `npm run governance:design-index -- --write`"] };
  }
  if (region !== rendered) {
    return { ok: false, code: "stale", violations: ["the generated inventory region has drifted from map + scan — run `npm run governance:design-index -- --write` and review the diff"] };
  }
  return { ok: true, code: "fresh", stamp };
}

function defaultRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// ── CLI: `node core/governance/design-index.js [--check|--write]` ──────────
function main() {
  const repoRoot = defaultRepoRoot();
  const indexPath = resolve(repoRoot, "design", "INDEX.md");
  const write = process.argv.includes("--write");
  const text = readFileSync(indexPath, "utf8");

  const bundle = loadLabels(repoRoot);
  const scan = scanDesign(repoRoot);
  const validation = validateIndexLabels({ labels: bundle.labels, scan, repoRoot });
  if (!validation.ok) {
    console.error("design-index: FAIL — the label map violates the fail-closed rules (C-5/C-6):");
    for (const v of validation.violations) console.error(`  - ${v}`);
    console.error("Fix design/index-labels.json (a human assigns labels; the generator never does).");
    return 1;
  }

  const stamp = computeStamp({ scan, labelsRaw: bundle.raw });
  const rendered = renderIndexRegion({ labels: bundle.labels, patterns: bundle.patterns, stamp });

  if (write) {
    const next = refreshIndex(text, rendered);
    if (next !== text) writeFileSync(indexPath, next);
    console.log(`design-index: refreshed → sha256:${stamp} (${scan.mdFiles.length} root docs)${next === text ? " (already current)" : ""}`);
    return 0;
  }

  const r = checkDesignIndex(text, { repoRoot, inputs: { labelsBundle: bundle, scan } });
  if (r.ok) {
    console.log(`design-index: OK (sha256:${r.stamp}, ${scan.mdFiles.length} root docs classified)`);
    return 0;
  }
  console.error(`design-index: ${r.code === "labels-invalid" ? "FAIL — label rules" : "STALE — render drift"}:`);
  for (const v of r.violations) console.error(`  - ${v}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
