// illuci/core/governance/compiler/index.js
//
// The governance-compiler pipeline: read declarations -> parse -> lower (tier + mechanism) ->
// promise-gap -> emit armed enforcers to compiled/ -> write the GIR -> audit. Deterministic and
// content-addressed: an unchanged source hash short-circuits (no re-emit). The compile reports
// FAILING on a genuine promise-gap (Class A no-declaration / Class B no-mechanism); Class C
// (soft-only) and HUMAN are allowed. Invocable via the compile CLI or programmatically.

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseObligations } from "./frontend/obligation-parser.js";
import { readProse } from "./frontend/prose-reader.js";
import { sourceHash } from "./ir/content-addresser.js";
import { mapObligation } from "./ir/obligation-mapper.js";
import { analyze, FAILING } from "./ir/promise-gap.js";
import { emptyGir, validateGir } from "./ir/schema.js";
import { emitFloorAtom } from "./backends/floor-atom.js";
import { emitDispatchGate } from "./backends/dispatch-gate.js";
import { emitCarriedPreamble } from "./backends/carried-preamble.js";
import { emitSoftVerify } from "./backends/soft-verify.js";
import { logCompile } from "./audit/logger.js";

const EMITTERS = {
  floor_atom: emitFloorAtom,
  dispatch_gate: emitDispatchGate,
  carried_preamble: emitCarriedPreamble,
  soft_verify: emitSoftVerify,
};
const COMPILED_DIR = join("core", "governance", "compiled");
const GIR_PATH = join("core", "governance", "compiler", "output", "governance.gir.json");

function lower(declarations) {
  const out = [];
  for (const decl of declarations) {
    for (const o of decl.obligations) {
      const m = mapObligation(o);
      out.push({
        id: o.id, source_key: decl._key, source_type: decl.source_type, source_id: String(decl.source_id),
        clause: decl.clause, text: o.text, trigger: o.trigger, severity: o.severity, predicate: o.predicate || "",
        tier: m.tier, backend: m.backend, downgraded: !!m.downgraded, human: !!m.human, unmatched: !!m.unmatched,
      });
    }
  }
  return out;
}

function buildGir(hash, batch, lowered, gaps) {
  const gir = emptyGir(hash, batch);
  gir.obligations = lowered.map((o) => ({
    id: o.id, source_type: o.source_type, source_id: o.source_id, clause: o.clause, text: o.text,
    trigger: o.trigger, tier: o.tier, mechanism: o.backend,
    armed: o.backend !== "none", compiled: o.backend !== "none", downgraded: o.downgraded, human: o.human,
  }));
  gir.promise_gaps = gaps;
  gir.stats = {
    total_obligations: lowered.length,
    hard: lowered.filter((o) => o.tier === "hard").length,
    carried: lowered.filter((o) => o.tier === "carried").length,
    soft: lowered.filter((o) => o.tier === "soft").length,
    human: lowered.filter((o) => o.human).length,
    emitted: lowered.filter((o) => o.backend !== "none").length,
    promise_gaps: gaps.length,
    failing_gaps: gaps.filter((g) => FAILING.has(g.class)).length,
  };
  return gir;
}

/**
 * @param {{repoRoot?:string, batch?:string, stamp?:string, force?:boolean, noEmit?:boolean}} [opts]
 * @returns {{ok:boolean, failing?:boolean, cached?:boolean, gaps?:Array, gir?:object, emitted?:Array, errors?:Array, phase?:string, validation?:object}}
 */
export function compile(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const batch = opts.batch || null;

  // 1. READ + PARSE
  const { declarations, sources, errors } = parseObligations(repoRoot);
  if (errors.length) return { ok: false, phase: "parse", errors };
  const hash = sourceHash(sources);

  // short-circuit: identical source hash -> return the cached GIR, no re-emit.
  const girAbs = join(repoRoot, GIR_PATH);
  if (!opts.force && existsSync(girAbs)) {
    try {
      const prev = JSON.parse(readFileSync(girAbs, "utf8"));
      if (prev.source_hash === hash) {
        return { ok: (prev.stats?.failing_gaps || 0) === 0, cached: true, gir: prev, gaps: prev.promise_gaps || [], emitted: [] };
      }
    } catch { /* fall through to a full recompile */ }
  }

  // 2. LOWER
  const lowered = lower(declarations);

  // 3. PROMISE-GAP
  const declaredKeys = new Set(declarations.map((d) => d._key));
  const prose = readProse(repoRoot, declaredKeys);
  const { gaps, failing } = analyze(lowered, prose);

  // 4. EMIT (idempotent: clean the generated tree, then re-emit every enforcer)
  const emitted = [];
  if (!opts.noEmit) {
    const compiledRoot = join(repoRoot, COMPILED_DIR);
    if (existsSync(compiledRoot)) rmSync(compiledRoot, { recursive: true, force: true });
    for (const ob of lowered) {
      const emit = EMITTERS[ob.backend];
      if (!emit) continue; // none / human -> no enforcer file
      const { path, content } = emit(ob, hash);
      const abs = join(repoRoot, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      emitted.push(path);
    }
    // A sync-readable manifest of the carried obligations, so the dispatch path folds them into
    // every agent's operating context without an async module load on the hot path.
    const carriedList = lowered
      .filter((o) => o.backend === "carried_preamble")
      .map((o) => ({ id: o.id, preamble: o.text, trigger: o.trigger }));
    const manifestPath = join(repoRoot, COMPILED_DIR, "carried-manifest.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(carriedList, null, 2) + "\n");
  }

  // 5. GIR + 6. AUDIT
  const gir = buildGir(hash, batch, lowered, gaps);
  const validation = validateGir(gir);
  if (!opts.noEmit) {
    mkdirSync(dirname(girAbs), { recursive: true });
    writeFileSync(girAbs, JSON.stringify(gir, null, 2) + "\n");
    logCompile(repoRoot, { batch, source_hash: hash, stamp: opts.stamp || null, stats: gir.stats, emitted });
  }

  return { ok: !failing && validation.ok, failing, gaps, gir, emitted, validation };
}

export default { compile };
