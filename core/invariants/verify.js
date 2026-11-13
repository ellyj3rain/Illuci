// Verify output against an invariant: soft invariants are judged by a model, hard invariants by a rule.
import { INVARIANTS } from "./registry.js";

const judgePrompt = (statement, output) =>
  `Invariant: "${statement}"\n\nOutput to check:\n---\n${output}\n---\n\nDoes the output VIOLATE the invariant? Reply only as JSON: {"violates": true or false, "reason": "<one sentence>"}.`;

export async function verify(output, invariant, judge) {
  if (invariant.tier === "hard" && invariant.rule) {
    const violates = invariant.rule(output);
    return { id: invariant.id, violates, reason: violates ? "rule matched" : "clean" };
  }
  // Coerce to a string first: a judge may return a non-string (object, null, number)
  // for which .indexOf would throw and abort the whole pass.
  const raw = String((await judge(judgePrompt(invariant.statement, output))) ?? "");
  let parsed = { violates: null, reason: raw.trim() };
  // A judge reply can be prose-wrapped, markdown-fenced, or carry nested braces, so the
  // brace-slice + JSON.parse can throw. Degrade to an unjudged result rather than abort.
  try {
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) parsed = JSON.parse(raw.slice(s, e + 1));
  } catch { /* malformed judge JSON — keep the degraded { violates: null } above */ }
  return { id: invariant.id, violates: parsed.violates, reason: parsed.reason ?? "" };
}

export async function verifyAll(output, judge, invariants = INVARIANTS) {
  const results = [];
  // Isolate each invariant: one malformed judge reply (or a judge throw) cannot abort
  // the rest of the pass. A failed check degrades to an unjudged result.
  for (const inv of invariants) {
    try {
      results.push(await verify(output, inv, judge));
    } catch (err) {
      results.push({ id: inv.id, violates: null, reason: `verify error: ${err?.message || err}` });
    }
  }
  return results;
}
