// illuci/core/traces/organizer.js
//
// Metadata-driven trace + log organizer. Loose run artifacts otherwise accumulate
// scattered at the repo root; this files each into the typed local data plane at
// .illuci/data/traces/<tag>/ by default, or under ILLUCI_DATA_HOME when set.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { runtimeDataHome } from "../data/paths.js";

export const TRACES_ROOT = join(".illuci", "data", "traces");

export const DEFAULT_PATTERNS = [
  /.trace.json$/,
  /.result.txt$/,
  /.spec.txt$/,
  /.results.json$/,
  /.error.txt$/,
];

const SUFFIX_RE = /.(trace.json|result.txt|spec.txt|results.json|error.txt)$/;

export function deriveTag(name, meta = {}) {
  if (meta && typeof meta.tag === "string" && meta.tag.trim()) return meta.tag.trim();
  const base = basename(name).replace(SUFFIX_RE, "");
  const seg = base.split("-")[0];
  return seg || "misc";
}

export function traceHome(_repoRoot, tag) {
  return join(runtimeDataHome(), "traces", tag);
}

function displayTracePath(tag, name) {
  return join(TRACES_ROOT, tag, name);
}

function readMeta(absPath) {
  if (!/.json$/.test(absPath)) return {};
  try {
    const v = JSON.parse(readFileSync(absPath, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Sweep loose run-artifacts in dir into the governed trace data plane. Never
 * clobbers an existing destination; a name collision is skipped.
 */
export function organizeLoose(repoRoot, opts = {}) {
  const dir = opts.dir ? join(repoRoot, opts.dir) : repoRoot;
  const patterns = opts.patterns || DEFAULT_PATTERNS;
  const moved = [];
  const byTag = {};
  const skipped = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return { moved, byTag, skipped }; }
  for (const name of entries) {
    if (!patterns.some((re) => re.test(name))) continue;
    const abs = join(dir, name);
    try { if (!statSync(abs).isFile()) continue; } catch { continue; }
    const tag = deriveTag(name, readMeta(abs));
    const home = traceHome(repoRoot, tag);
    mkdirSync(home, { recursive: true });
    const dest = join(home, name);
    if (existsSync(dest)) { skipped.push(name); continue; }
    renameSync(abs, dest);
    moved.push({ from: name, to: displayTracePath(tag, name) });
    byTag[tag] = (byTag[tag] || 0) + 1;
  }
  return { moved, byTag, skipped };
}

/**
 * Write a trace organized at birth.
 */
export function writeTrace(repoRoot, name, data, meta = {}) {
  const tag = deriveTag(name, meta);
  const home = traceHome(repoRoot, tag);
  mkdirSync(home, { recursive: true });
  const dest = join(home, name);
  writeFileSync(dest, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return displayTracePath(tag, name);
}

export default { organizeLoose, writeTrace, deriveTag, traceHome, TRACES_ROOT, DEFAULT_PATTERNS };
