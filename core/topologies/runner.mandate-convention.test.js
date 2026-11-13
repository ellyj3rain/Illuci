/**
 * Mandate-convention heal — colosseum verdict Condition 5 (the independently-correct
 * mandate-handoff heal, scoped to JUST the runner convention).
 *
 * BEFORE this heal the substrate had THREE mandate-handoff conventions that disagreed:
 *   1. PIPELINE  — a stage's PRODUCT became the next stage's prompt and the mandate was
 *      REBUILT from that product (the operator's original ask erased).
 *   2. COMPANY   — company.js threaded the mandate as options.mandate, but the runner built
 *      the mandate UNCONDITIONALLY (`let mandate = buildMandate({ prompt, … })`) and NEVER
 *      read options.mandate, so the carry was DEAD.
 *   3. SPAWN     — the spawn tool prepended the mandate into the child's PROMPT STRING
 *      (`[Inherited mandate — binding]\n…\n\n[Delegated sub-task]\n…`). It WORKED today
 *      precisely because it did NOT rely on the runner reading options.mandate.
 *
 * THE HEAL (one coordinated runner-convention edit):
 *   - runner.js: `let mandate = options.mandate ?? buildMandate({ prompt, … })` — honor an
 *     explicitly-passed mandate (the nested case: company member / pipeline stage / spawned
 *     child), else build from prompt exactly as before (the flat case, byte-identical).
 *   - spawn.js: RETIRE the prompt-prepend. The child now gets its mandate ONCE — via
 *     options.mandate, which the runner renders through the single [Mandate] frame block
 *     (frame.js / renderMandateBlock) — NOT also prepended into the prompt text. The runner's
 *     spawn-tool wiring carries the mandate OBJECT (not JSON-stringified) so the frame renders.
 *
 * THE TRAP this guards: naively making the runner honor options.mandate WITHOUT retiring the
 * prepend makes the spawn path DOUBLE-INJECT — mandate in the prompt AND in options.mandate —
 * so the child receives the mandate TWICE, rendered two different ways.
 *
 * Hermetic, no live model: parts (a)/(c) route through the REAL modules (runCompany / makeSpawnTool)
 * with a fake runTopology injected via deps, capturing exactly what the runner WOULD receive;
 * parts (b)/(d) prove the runner's resolution semantics against the REAL buildMandate plus a
 * source-grep guard that the runner uses the `options.mandate ?? buildMandate(…)` convention
 * (mirrors runner.dispatch-chokepoint.test.js, which reads runner.js as TEXT to avoid the
 * heavy bridge import graph).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runCompany } from "../orchestrate/company.js";
import { TopologyTree, makeSpawnTool } from "../orchestrate/spawn.js";
import { buildMandate, renderMandateBlock } from "./mandate.js";
import { composeSeatFrame } from "./frame.js";

// ── A fake runTopology that records exactly the (prompt, options) every member/child would
//    receive at the runner boundary. NEVER dispatches a live model. ──
function recordingRunTopology() {
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options = {}, parentSessionId) => {
    calls.push({ topologyId, lineup, prompt, options, parentSessionId });
    return { runId: "run-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };
  return { fn, calls };
}

// The runner's mandate-resolution convention, re-derived hermetically. This is the EXACT
// expression runner.js uses at the top of runTopologyInner (grep-guarded below). Re-deriving it
// here lets parts (b) and (d) assert the SEMANTICS live, against the real buildMandate, without
// importing the heavy runner graph.
function resolveRunnerMandate(prompt, options = {}) {
  // [A107]/F-138 hardened form, mirrored exactly: an OBJECT mandate is honored
  // verbatim; a STRING mandate is the verbatim ask from a caller that never
  // built the object (normalized through buildMandate); absent builds from prompt.
  return (options.mandate && typeof options.mandate === "object")
    ? options.mandate
    : buildMandate({
      prompt: typeof options.mandate === "string" && options.mandate.trim() ? options.mandate : prompt,
      operator: options.operator || "the operator",
      projectId: options.projectId || null,
      topologyId: options.topologyId || null,
      fireControl: options.fireControl || null,
      stabilityThreshold: options.stabilityThreshold ?? null,
    });
}

// A representative operator mandate (the verbatim ask that must survive every handoff).
const OPERATOR_MANDATE = buildMandate({
  prompt: "Refactor the auth module; keep the public API stable.",
  operator: "Example",
  topologyId: "dev-team",
});

// ─── SOURCE-GREP GUARD: the runner honors options.mandate, else builds from prompt ───
// The load-bearing line. If a future edit drops the `options.mandate ??`, the dead-carry
// regression (Condition 5's convention #2) silently returns and this fires.

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = readFileSync(join(__dirname, "runner.js"), "utf-8");
const SPAWN_SRC = readFileSync(join(__dirname, "../orchestrate/spawn.js"), "utf-8");

test("GUARD: the runner honors an OBJECT options.mandate verbatim, else builds (honor-or-build, [A107] hardened)", () => {
  // [A107]/F-138: the convention gained a string-normalization arm (a STRING
  // mandate builds through buildMandate as the verbatim ask instead of
  // crashing downstream at mandate.intent.revision). The load-bearing intent
  // is unchanged: an explicitly-passed mandate OBJECT short-circuits the
  // build — dropping that arm revives the dead company/pipeline carry
  // (Condition 5 #2).
  assert.match(
    RUNNER_SRC,
    /let mandate\s*=\s*\(options\.mandate\s*&&\s*typeof options\.mandate\s*===\s*"object"\)\s*\?\s*options\.mandate\s*:\s*buildMandate\(/,
    "runner.js must honor an explicitly-passed OBJECT options.mandate before building from prompt; " +
    "dropping the honor arm revives the dead company/pipeline carry (Condition 5 #2)",
  );
  // And the string arm feeds the STRING (not the stage prompt) into the build.
  assert.match(
    RUNNER_SRC,
    /prompt:\s*typeof options\.mandate\s*===\s*"string"\s*&&\s*options\.mandate\.trim\(\)\s*\?\s*options\.mandate\s*:\s*prompt,/,
    "a STRING options.mandate must normalize through buildMandate as the verbatim ask (F-138 defense)",
  );
});

test("GUARD: the spawn tool no longer prepends the mandate into the child prompt", () => {
  // The old prepend header is retired from live code. (It may survive ONLY inside a comment
  // documenting what was retired — so assert it is absent from a comment-stripped view.)
  const liveSpawn = SPAWN_SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    liveSpawn,
    /\[Inherited mandate/,
    "spawn.js must NOT prepend `[Inherited mandate …]` into the child prompt — the mandate rides " +
    "options.mandate ONCE (retiring the prepend is what prevents the double-inject trap)",
  );
  // And the child prompt is the delegated sub-task ALONE.
  assert.match(
    liveSpawn,
    /const childPrompt\s*=\s*String\(args\.prompt/,
    "the child prompt must be the delegated sub-task alone (String(args.prompt ?? ''))",
  );
});

// ─── (a) COMPANY: a member with a CUSTOM prompt KEEPS the operator mandate ───
// The dead company carry (convention #2) now lives: company.js threads config.mandate as the
// member's options.mandate; the runner honors it. The member's CUSTOM prompt does NOT become
// the mandate.

test("(a) COMPANY: a member with a custom prompt carries the operator mandate via options.mandate", async () => {
  const { fn, calls } = recordingRunTopology();
  const result = await runCompany(
    {
      topologies: [{ topologyId: "adversarial-debate", prompt: "Stress-test the auth refactor design." }],
      prompt: "the company default prompt (NOT used by this member)",
      mandate: OPERATOR_MANDATE,
      awareness: false,
    },
    { runTopology: fn },
  );
  assert.equal(result.status, "complete");
  assert.equal(calls.length, 1);

  // The member's CUSTOM prompt is preserved as the prompt …
  assert.equal(calls[0].prompt, "Stress-test the auth refactor design.");
  // … AND the operator mandate is carried via options.mandate (the now-live carry) …
  assert.deepEqual(calls[0].options.mandate, OPERATOR_MANDATE);

  // … and when the runner resolves the member's mandate, it is the OPERATOR mandate, NOT one
  //   rebuilt from the member's custom prompt (proving the carry is honored, not dead).
  const resolved = resolveRunnerMandate(calls[0].prompt, calls[0].options);
  assert.equal(resolved.intent.raw, "Refactor the auth module; keep the public API stable.");
  assert.equal(resolved.operator.name, "Example");
  assert.notEqual(resolved.intent.raw, calls[0].prompt, "the mandate is NOT the member's custom prompt");
});

// ─── (b) PIPELINE: stage N reads the prior stage's PRODUCT as prompt, ROOT mandate as mandate ───
// Pipeline mandate-erasure healed: a stage whose prompt is the PRIOR stage's product, when it
// threads the root mandate as options.mandate, resolves to the ROOT operator mandate — the
// product is the TASK, not a new mandate rebuilt from intermediate output.

test("(b) PIPELINE: a stage reads the prior product as prompt but the ROOT mandate as its mandate", () => {
  const rootMandate = OPERATOR_MANDATE;
  // Stage 2's prompt is stage 1's PRODUCT (an intermediate artifact, not the operator's ask).
  const priorStageProduct =
    "[claude-opus — builder]\nHere is the refactored AuthService with the token cache extracted…";

  // The HEALED handoff: thread the root mandate alongside the product-as-prompt.
  const healed = resolveRunnerMandate(priorStageProduct, { mandate: rootMandate });
  assert.equal(healed.intent.raw, "Refactor the auth module; keep the public API stable.",
    "the stage's mandate is the ROOT operator ask, not the intermediate product");
  assert.equal(healed.operator.name, "Example");

  // The pre-heal behavior (erasure) for contrast: WITHOUT the carry, the runner would rebuild
  // the mandate FROM the product, making the intermediate artifact masquerade as the operator's ask.
  const erased = resolveRunnerMandate(priorStageProduct, {}); // no options.mandate
  assert.equal(erased.intent.raw, priorStageProduct,
    "pre-heal: a rebuilt-from-product mandate erases the operator ask (the bug this heals)");
  assert.notEqual(healed.intent.raw, erased.intent.raw, "the heal changes the resolved mandate");
});

// ─── (c) SPAWN: a spawned child receives the mandate EXACTLY ONCE, in the reserved frame block ───
// The trap-guard. Capture the rendered child prompt/frame; assert the mandate text appears ONCE
// and lands in the reserved [Mandate] block; assert the new framing is equivalent-or-stronger
// than the OLD prepend.

test("(c) SPAWN: the child receives the mandate ONCE, in the reserved [Mandate] frame block", async () => {
  const tree = new TopologyTree("sess-c5", { maxDepth: 3 });
  tree.registerRoot("parent-run", "dev-team");
  const { fn, calls } = recordingRunTopology();

  // The runner wires carriedMandate = the mandate OBJECT (post-heal). Mirror that here.
  const tool = makeSpawnTool(
    { sessionId: "sess-c5", parentRunId: "parent-run", tree, carriedMandate: OPERATOR_MANDATE, seat: "architect" },
    { runTopology: fn },
  );
  await tool.handler({ topologyId: "adversarial-debate", prompt: "Verify the spawn design holds under load." });

  assert.equal(calls.length, 1);
  const childPrompt = calls[0].prompt;
  const childMandate = calls[0].options.mandate;

  // 1) The child's PROMPT is the delegated sub-task ALONE — the mandate is NOT in it.
  assert.equal(childPrompt, "Verify the spawn design holds under load.");
  assert.deepEqual(childMandate, OPERATOR_MANDATE, "the mandate rides options.mandate (the object)");

  // 2) Render the child's seat frame the way the runner will (frame.js → renderMandateBlock).
  //    This is what the model actually sees.
  const childFrame = composeSeatFrame({
    mandate: childMandate,        // honored by the runner via options.mandate
    task: childPrompt,            // the delegated sub-task
    includeLens: false,
  });

  // 3) The mandate's verbatim ask appears EXACTLY ONCE in the rendered frame (no double-inject).
  const ask = OPERATOR_MANDATE.intent.raw;
  const occurrences = childFrame.split(ask).length - 1;
  assert.equal(occurrences, 1, `the operator ask must appear EXACTLY once in the child frame, found ${occurrences}`);

  // 4) It lands in the reserved [Mandate] block, FIRST.
  assert.ok(childFrame.startsWith("[Mandate]"), "the mandate anchors the child frame FIRST (reserved block)");
  assert.match(childFrame, /\[Mandate\][\s\S]*You serve Example/, "rendered through the canonical [Mandate] block");
  // exactly one [Mandate] marker — not the prompt-prepend AND the frame block.
  assert.equal((childFrame.match(/\[Mandate\]/g) || []).length, 1, "exactly one [Mandate] marker");

  // 5) Equivalence-or-stronger vs the OLD prepend. The retired prepend was:
  //      `[Inherited mandate — binding, do not loosen]\n${carriedMandate}\n\n[Delegated sub-task]\n${prompt}`
  //    The new frame carries the SAME operator ask AND the same sub-task, but now the mandate is a
  //    STRUCTURED, position-reserved block on EVERY seat/phase (renderMandateBlock), not a one-shot
  //    string spliced into the first prompt. So: it carries everything the prepend did, and more.
  assert.ok(childFrame.includes(ask), "carries the operator ask (the prepend's mandate payload)");
  assert.ok(childFrame.includes("Verify the spawn design holds under load."), "carries the delegated sub-task");
  assert.ok(childFrame.includes("serve Example"), "stronger: also carries operator IDENTITY, which the raw prepend string did not structure");
});

// ─── (d) FLAT: a plain runTopology with NO options.mandate behaves identically to before ───
// No regression: the flat (non-nested) case builds the mandate from prompt, byte-for-byte as
// the pre-heal `buildMandate({ prompt, … })` did.

test("(d) FLAT: a runTopology with no options.mandate builds from prompt, byte-identical to before", () => {
  const flatPrompt = "Summarize the security posture of the repo.";

  // Post-heal resolution with NO options.mandate …
  const resolved = resolveRunnerMandate(flatPrompt, { operator: "Example", topologyId: "research-swarm" });

  // … must equal the PRE-heal unconditional build (the exact old `buildMandate({ prompt, … })`).
  const preHeal = buildMandate({
    prompt: flatPrompt,
    operator: "Example",
    projectId: null,
    topologyId: "research-swarm",
    fireControl: null,
    stabilityThreshold: null,
  });

  // Compare the stable fields (intent.updatedAt is a fresh timestamp on each build).
  assert.equal(resolved.intent.raw, preHeal.intent.raw);
  assert.equal(resolved.intent.revision, 1);
  assert.equal(resolved.operator.name, "Example");
  assert.equal(resolved.topology.id, "research-swarm");
  assert.equal(resolved.intent.raw, flatPrompt, "the flat mandate is built FROM the prompt (unchanged)");
});

// ─── (d′) FLAT via the real company path: no mandate threaded ⇒ no options.mandate at the boundary ───
// Belt-and-suspenders for the no-regression claim through a real module: a company with NO
// mandate must NOT inject an options.mandate, so the member runner falls to the build-from-prompt path.

test("(d′) FLAT: a company with no mandate threads NO options.mandate (member builds from prompt)", async () => {
  const { fn, calls } = recordingRunTopology();
  const result = await runCompany(
    { topologies: [{ topologyId: "dev-team", prompt: "build it" }], awareness: false },
    { runTopology: fn },
  );
  assert.equal(result.status, "complete");
  assert.equal(calls.length, 1);
  assert.ok(!("mandate" in calls[0].options), "no mandate configured ⇒ no options.mandate injected (flat path preserved)");
});
