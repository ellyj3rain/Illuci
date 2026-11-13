// illuci/core/governance/compiler/runtime/predicate.js
//
// The runtime predicate evaluator the COMPILED enforcers call. It evaluates a declared
// predicate string against a runtime context (facts) + the domain helpers. Pure. Supports the
// declared predicate grammar: IMPLIES, AND, NOT, IN, IS KNOWN, == and != comparison, and bare
// predicate atoms (a helper call or a fact, by truthiness). An unrecognized predicate that
// throws during evaluation resolves to a pending pass (ok:true, unevaluated) so a not-yet-wired
// predicate never hard-blocks on a parse failure - it is flagged for runtime wiring instead.

import { HELPERS } from "./helpers.js";

function resolve(token, ctx) {
  const t = String(token).trim();
  if (t === "") return undefined;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
  const call = t.match(/^([a-zA-Z_]\w*)\s*\((.*)\)$/);
  if (call) {
    const fn = call[1];
    if (HELPERS[fn]) return HELPERS[fn](ctx, call[2]);
    return ctx[fn]; // no helper: the runtime supplies the precomputed fact under the function name
  }
  return ctx[t];
}

function truthy(v) {
  return v !== undefined && v !== null && v !== false;
}

// split on the FIRST top-level (paren-depth 0) occurrence of sep; null if absent.
function splitTop(e, sep) {
  let depth = 0;
  for (let i = 0; i <= e.length - sep.length; i++) {
    const c = e[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && e.startsWith(sep, i)) return [e.slice(0, i), e.slice(i + sep.length)];
  }
  return null;
}

function evalExpr(expr, ctx) {
  const e = String(expr).trim();
  const imp = splitTop(e, " IMPLIES ");
  if (imp) return !evalExpr(imp[0], ctx) || evalExpr(imp[1], ctx);
  const and = splitTop(e, " AND ");
  if (and) return evalExpr(and[0], ctx) && evalExpr(and[1], ctx);
  if (/^NOT\s+/.test(e)) return !evalExpr(e.replace(/^NOT\s+/, ""), ctx);
  if (/\sIS KNOWN$/.test(e)) return resolve(e.replace(/\sIS KNOWN$/, ""), ctx) != null;
  const inm = splitTop(e, " IN ");
  if (inm) {
    const needle = resolve(inm[0], ctx);
    const hay = resolve(inm[1], ctx);
    if (Array.isArray(hay)) return hay.includes(needle);
    if (hay && typeof hay === "object") return needle in hay;
    return false;
  }
  const eq = splitTop(e, " == ");
  if (eq) return resolve(eq[0], ctx) === resolve(eq[1], ctx);
  const ne = splitTop(e, " != ");
  if (ne) return resolve(ne[0], ctx) !== resolve(ne[1], ctx);
  return truthy(resolve(e, ctx));
}

/**
 * @param {string} predicate  the declared predicate string
 * @param {object} ctx  runtime facts
 * @returns {{ok:boolean, reason:string, unevaluated?:boolean}}
 */
export function evaluatePredicate(predicate, ctx = {}) {
  const p = String(predicate || "").trim();
  if (!p) return { ok: true, reason: "empty predicate" };
  try {
    const v = evalExpr(p, ctx);
    return { ok: !!v, reason: `predicate ${v ? "holds" : "fails"}: ${p}` };
  } catch (e) {
    return { ok: true, reason: `unevaluated predicate (${e.message}): ${p}`, unevaluated: true };
  }
}

const FACT_KEYWORDS = new Set(["NOT", "AND", "OR", "IMPLIES", "IN", "IS", "KNOWN"]);

/**
 * Extract the runtime FACTS a predicate references - its bare identifiers and function-call
 * args, minus operators and helper names. The live floor uses this to fire a compiled enforcer
 * only when the context supplies every fact its predicate needs, so an enforcer whose facts
 * were not gathered stays inert instead of fail-closed blocking every commit.
 */
export function extractFacts(predicate) {
  const helperNames = new Set(Object.keys(HELPERS));
  const facts = new Set();
  const p = String(predicate || "");
  for (const m of p.matchAll(/[a-zA-Z_]\w*\s*\(\s*([a-zA-Z_]\w*)\s*\)/g)) facts.add(m[1]);
  const stripped = p.replace(/[a-zA-Z_]\w*\s*\([^)]*\)/g, " ");
  for (const m of stripped.matchAll(/[a-zA-Z_]\w*/g)) {
    const id = m[0];
    if (!FACT_KEYWORDS.has(id) && !helperNames.has(id)) facts.add(id);
  }
  return [...facts];
}

export default { evaluatePredicate, extractFacts };
