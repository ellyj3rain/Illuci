// illuci/core/governance/compiler/frontend/obligation-parser.js
//
// FRONTEND: read the companion obligation declarations from constitutional/obligations/ and
// validate each against the declaration schema. The prose stays authoritative for meaning;
// these files are authoritative for HOW each obligation is enforced. A malformed declaration
// fails the compile loudly rather than silently dropping a governed commitment.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const OBLIGATIONS_DIR = join("constitutional", "obligations");
const TRIGGERS = new Set(["pre-edit", "pre-dispatch", "session-init", "content-write", "post-task"]);
const SEVERITIES = new Set(["hard", "carried", "soft", "human"]);

function validateDecl(decl, file) {
  const errs = [];
  if (!decl || typeof decl !== "object") return [`${file}: not an object`];
  if (decl.source_type !== "standard" && decl.source_type !== "article") errs.push(`${file}: bad source_type`);
  if (decl.source_id == null || decl.source_id === "") errs.push(`${file}: missing source_id`);
  if (!decl.clause) errs.push(`${file}: missing clause`);
  if (!Array.isArray(decl.obligations)) return [`${file}: obligations not an array`];
  for (const o of decl.obligations) {
    if (!o.id) errs.push(`${file}: an obligation missing id`);
    if (!TRIGGERS.has(o.trigger)) errs.push(`${file}: ${o.id} bad trigger "${o.trigger}"`);
    if (!SEVERITIES.has(o.severity)) errs.push(`${file}: ${o.id} bad severity "${o.severity}"`);
    if (!o.text) errs.push(`${file}: ${o.id} missing text`);
  }
  return errs;
}

/** source_key for a declaration: std-<n> / art-<numeral>. */
export function sourceKey(decl) {
  return (decl.source_type === "article" ? "art-" : "std-") + String(decl.source_id);
}

/**
 * @param {string} repoRoot
 * @returns {{declarations:Array, sources:Array<{path,content}>, errors:string[]}}
 */
export function parseObligations(repoRoot = process.cwd()) {
  const dir = join(repoRoot, OBLIGATIONS_DIR);
  if (!existsSync(dir)) return { declarations: [], sources: [], errors: [`obligations dir missing: ${OBLIGATIONS_DIR}`] };
  const files = readdirSync(dir).filter((f) => f.endsWith(".obligation.json")).sort();
  const declarations = [];
  const sources = [];
  const errors = [];
  for (const f of files) {
    const rel = join(OBLIGATIONS_DIR, f).replace(/\\/g, "/");
    const content = readFileSync(join(dir, f), "utf8");
    sources.push({ path: rel, content });
    let decl;
    try { decl = JSON.parse(content); } catch (e) { errors.push(`${f}: invalid JSON (${e.message})`); continue; }
    const errs = validateDecl(decl, f);
    if (errs.length) { errors.push(...errs); continue; }
    declarations.push({ ...decl, _key: sourceKey(decl), _file: rel });
  }
  return { declarations, sources, errors };
}

export default { parseObligations, sourceKey, OBLIGATIONS_DIR };
