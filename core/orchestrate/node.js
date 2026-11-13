// Candidate A — the Unified Recursive Node: ONE runNode(node, ctx) that dispatches on
// node.kind ('topology' | 'company' | 'pipeline') over a single recursive runner. A
// colosseum crowned this shape over the alternatives (a kind-per-runner zoo; a generic
// graph interpreter); a darwinian pass then settled the open forks against the live code.
//
// The three kinds are DISTINCT named shapes, not modes of one thing:
//   - 'topology' is the leaf — a single team run (runTopology). It is the base case: it
//     does NOT recurse through runNode and does NOT descend a static-nesting level. Any
//     runtime children it spawns are runTopology calls bounded by the TopologyTree, not
//     runNode recursions, so they carry no static depth.
//   - 'company' is N members run CONCURRENTLY (the Phase 4 parallel primitive). This file
//     REUSES runPool / composeSignals / aggregate from company.js VERBATIM — it does not
//     reimplement the pool, the signal composition, or the result aggregation. A member
//     may itself be a composite ('company' | 'pipeline'); that member recurses through
//     runNode and is normalized into a MemberResult-shaped row so aggregate never learns
//     the composite shape.
//   - 'pipeline' is N stages run SEQUENTIALLY (the lifted sequential core of the pipeline
//     runner: previousOutput threading + buildStageInput + the runTopology route + the
//     halt on trace.halted). Artifacts / verification / SSE / provenance STAY in
//     pipeline-runner.js; this file is CONTROL FLOW ONLY.
//
// Both kinds nest both ways (a company of pipelines, a pipeline of companies, to depth)
// and both support runtime spawning (a seat inside any leaf may convene a child topology).
//
// THE TWO ORTHOGONAL KEYS (the load-bearing invariant). A node carries two INDEPENDENT
// scope keys that must NEVER be crossed:
//   - busScope = the AWARENESS key (publish/recall scope). Derived from one lineage
//     scopeId. Threaded into runTopology as options.busScope -> the runner's recall/publish
//     scope (`dispatchOpts.busScope ?? dispatchOpts.sessionId`).
//   - sessionId = the SPAWN-TREE key (getOrCreateTree / the fork-bomb budget). Passed
//     positionally to runTopology as parentSessionId.
// Scope-minting asymmetry, by kind:
//   company:          busScope = companySessionId             ; tree key = companySessionId
//   pipeline stage i: busScope = `${ctx.sessionId}:stage:${i}`; tree key = ctx.sessionId (POOLED)
//   topology leaf:    busScope = inherit ctx.busScope          ; tree key = inherit ctx.sessionId
//   spawn child:      busScope = inherit parent busScope       ; tree key = inherit parent sessionId
// So pipeline stages share ONE spawn budget (a stage-1 fork-bomb starves stage 2) yet are
// awareness-ISOLATED (stage 2 cannot recall stage 1's traffic); a company is the inverse
// of neither — both keys are the companySessionId, so siblings are budget-shared AND
// mutually visible, byte-identical to runCompany today.
//
// STATIC vs RUNTIME depth (decoupled). ctx.depth is a SYNCHRONOUS, branch-local counter
// for STATIC nesting (a company-of-pipelines is depth 2), threaded IMMUTABLY: descend()
// returns a NEW childCtx (never ++ctx.depth — concurrent runPool members would race a
// shared counter). The TopologyTree governs RUNTIME spawning only. They do not interact.

import { runTopology as realRunTopology } from "../topologies/runner.js";
import { runPool, composeSignals, DEFAULT_CONCURRENCY, HARD_CONCURRENCY_CEIL } from "./company.js";
import { createRunBudget } from "./run-budget.js";
import { nextRunId } from "../events/emitter.js";
import { carryChildIdentity } from "./child-identity.js";

// The STATIC call-stack-safety ceiling. This is its OWN constant with its OWN rationale —
// it bounds how deep runNode may RECURSE SYNCHRONOUSLY (a company-of-a-pipeline-of-a-company
// …), guarding the JS call stack. It is deliberately NOT spawn.js's
// SPAWN_POLICY_HARD_CAPS.maxDepth: that governs the RUNTIME fork-bomb breadth of the
// TopologyTree (a different axis with a different failure mode). The values may coincide;
// the IDENTITY must not — aliasing them would couple two unrelated safety knobs so that
// tuning one silently moves the other.
export const MAX_STATIC_DEPTH = 5;

/** A node whose kind is composite — it descends a static-nesting level. */
function isComposite(node) {
  return node && (node.kind === "company" || node.kind === "pipeline");
}

/**
 * CONTAINER-ENTER ONLY. Descends one static-nesting level: depth+1, cycle-check against
 * the static-ancestor chain, and returns a NEW ctx (never mutates the parent — a parent
 * fanning out concurrent children must hand each an independent ctx). Fires for 'company'
 * and 'pipeline'; a 'topology' leaf inherits ctx unchanged (the base case). The childCtx
 * keeps the SAME sessionId/busScope/signal/mandate — descend governs STATIC depth, NOT the
 * scope keys (each kind mints those itself).
 */
function descend(node, ctx) {
  const depth = (ctx.depth ?? 0) + 1;
  if (depth > MAX_STATIC_DEPTH) {
    throw new RangeError(`runNode: static nesting depth ${depth} exceeds MAX_STATIC_DEPTH (${MAX_STATIC_DEPTH})`);
  }
  const ancestors = ctx.staticAncestors ?? [];
  const nodeKey = node.kind + (node.id ? `:${node.id}` : "");
  // Cycle guard on the static chain — a self-referential nesting (a node listing itself
  // as a descendant) would recurse forever. Keyed on kind+id so two distinct sibling
  // pipelines do not false-positive as a cycle.
  if (node.id && ancestors.includes(nodeKey)) {
    throw new RangeError(`runNode: static nesting cycle — "${nodeKey}" is already an ancestor`);
  }
  return {
    sessionId: ctx.sessionId,
    busScope: ctx.busScope,
    depth,
    staticAncestors: node.id ? [...ancestors, nodeKey] : ancestors,
    signal: ctx.signal,
    mandate: ctx.mandate,
    parentBusScope: ctx.parentBusScope ?? null,
    // [A91]/DR-184: the composition root's identity context descends with the
    // static tree — the leaf decides what actually crosses (carryChildIdentity).
    genome: ctx.genome ?? null,
    agents: ctx.agents ?? null,
  };
}

/**
 * The unified recursive entry. Dispatches on node.kind over one recursive runner.
 *
 * @param {object} node — { kind: 'topology'|'company'|'pipeline', ... }
 *   topology: { kind:'topology', topologyId, lineup?, prompt?, options? }
 *   company:  { kind:'company',  members:  [node|memberSpec], prompt?, concurrency?, awareness? }
 *   pipeline: { kind:'pipeline', stages:   [node|stageSpec],  prompt? }
 * @param {object} [ctx] — { sessionId, busScope, depth, staticAncestors, signal, mandate, parentBusScope }
 * @param {object} [deps] — { runTopology } injection seam for hermetic tests
 * @returns {Promise<object>} the kind's result (a trace, a CompanyResult-shape, or a PipelineNodeResult)
 */
export async function runNode(node, ctx = {}, deps = {}) {
  if (!node || typeof node !== "object" || typeof node.kind !== "string") {
    throw new TypeError("runNode: node must be an object with a string kind");
  }
  switch (node.kind) {
    case "topology":
      // Leaf, base case: ctx is inherited UNCHANGED (no descend — a leaf is not a
      // container, so it spends no static-nesting depth).
      return runTopologyNode(node, ctx, deps);
    case "company":
      return runCompanyNode(node, descend(node, ctx), deps);
    case "pipeline":
      return runPipelineNode(node, descend(node, ctx), deps);
    default:
      throw new TypeError(`runNode: unknown node.kind "${node.kind}"`);
  }
}

/**
 * The 'topology' leaf. A single team run. Threads BOTH keys into runTopology:
 *   - options.busScope = the inherited awareness scope (the runner's recall/publish key).
 *   - parentSessionId  = the inherited sessionId (the runner's spawn-tree key, positional).
 * Inherits the mandate + signal so a nested leaf carries the operator's ask and the abort.
 */
async function runTopologyNode(node, ctx, deps = {}) {
  const runTopology = deps.runTopology || realRunTopology;
  const options = {
    // [A91]/DR-184: the childIdentity carry from the composition root's
    // context — seeded FIRST so the leaf's own node.options always win.
    ...carryChildIdentity({ genome: ctx.genome ?? null, agentManifest: ctx.agents ?? null }),
    ...(node.options || {}),
    awareness: node.options?.awareness ?? ctx.awareness ?? undefined,
    ...(ctx.busScope != null ? { busScope: ctx.busScope } : {}),
    ...(ctx.mandate != null ? { mandate: ctx.mandate } : {}),
    signal: composeSignals(ctx.signal, node.options?.signal),
    // The STATIC-nesting depth this leaf inherited, surfaced for observability (the runner
    // ignores unknown options). A leaf does NOT spend a descend level, so every leaf under
    // one container reports that container's depth — the static-nesting anti-leak fact.
    nodeDepth: ctx.depth ?? 0,
    nodeAncestors: ctx.staticAncestors ?? [],
  };
  return runTopology(
    node.topologyId,
    node.lineup || {},
    node.prompt ?? "",
    options,
    ctx.sessionId,
  );
}

/**
 * The 'company' kind. REUSES runPool / composeSignals / aggregate VERBATIM (the Phase 4
 * parallel primitives). A company mints its OWN companySessionId, and that single id is
 * BOTH keys: busScope = companySessionId AND the spawn-tree key = companySessionId. So
 * members are bus siblings (mutually visible) and share one fork-bomb budget — byte-
 * identical to runCompany today.
 *
 * The recursion boundary: a COMPOSITE member ({kind:'company'|'pipeline'}) recurses through
 * runNode under a childCtx scoped to the companySessionId, and its result is NORMALIZED
 * into a MemberResult-shaped row. A LEAF member is run exactly as runCompany's runMember
 * runs it (same status classification). aggregate then runs unchanged — it never learns
 * the composite shape.
 */
async function runCompanyNode(node, ctx, deps = {}) {
  const members = Array.isArray(node.members) ? node.members : [];
  if (members.length === 0) {
    throw new TypeError("runCompanyNode: members must be a non-empty array");
  }
  const runTopology = deps.runTopology || realRunTopology;

  const companySessionId = nextRunId("company"); // the ONE id that is BOTH keys
  const controller = new AbortController();
  const companySignal = composeSignals(controller.signal, ctx.signal) || controller.signal;

  // C-3 — match company.js's governance verbatim. The recursive node previously hardcoded a
  // default of 8 and clamped ONLY to members.length, so a nested company could open a pool
  // far wider than the HARD_CONCURRENCY_CEIL that company.js enforces, and it never created
  // a RunBudget. Use DEFAULT_CONCURRENCY for the default, clamp the request to the hard
  // ceiling, and create (or INHERIT from ctx) a RunBudget threaded into each member.
  const reqLimit = Number.isFinite(node.concurrency) && node.concurrency > 0 ? Math.floor(node.concurrency) : DEFAULT_CONCURRENCY;
  const limit = Math.max(1, Math.min(reqLimit, HARD_CONCURRENCY_CEIL));

  // A nested company inherits its parent Run's budget (one ceiling spans the whole static
  // tree) when ctx carries one; a top-level company mints a fresh one. Default UNLIMITED, so
  // an un-configured run stays byte-identical.
  const runBudget = ctx.runBudget || createRunBudget({ maxConcurrent: node.maxConcurrent, tokenCeiling: node.tokenCeiling });
  const budgetCap = runBudget.snapshot().maxConcurrent;
  const width = budgetCap != null
    ? Math.max(1, Math.min(limit, budgetCap, members.length))
    : Math.max(1, Math.min(limit, members.length));
  const awareness = node.awareness ?? true;
  // [A106]/DR-199 — a company-level preamble (the Foundry shared-world doc
  // pattern) prepends to the effective member prompt. Absent preamble keeps
  // the pre-[A106] prompt byte-identical.
  const basePrompt = node.prompt ?? "";
  const companyPrompt = typeof node.preamble === "string" && node.preamble.trim()
    ? [node.preamble.trim(), basePrompt].filter(Boolean).join("\n\n")
    : basePrompt;

  // The childCtx every composite member descends under: scoped to the companySessionId on
  // BOTH keys (company busScope == sessionId == companySessionId), carrying the company's
  // composed abort + the inherited mandate. depth/staticAncestors carry from ctx (this
  // company already spent its descend level in runNode).
  const childCtx = {
    sessionId: companySessionId,
    busScope: companySessionId,
    depth: ctx.depth,
    staticAncestors: ctx.staticAncestors ?? [],
    signal: companySignal,
    mandate: ctx.mandate,
    parentBusScope: ctx.busScope ?? null,
    // C-3 — a composite member inherits the SAME Run budget, so one ceiling spans the whole
    // static tree (a nested company does not mint a fresh, unbounded budget).
    runBudget,
    // [A91]/DR-184: the identity context keeps descending (childCtx is built
    // fresh here, not via descend — without these the carry died at a company).
    genome: ctx.genome ?? null,
    agents: ctx.agents ?? null,
  };

  const rows = await runPool(members, width, (member, index) =>
    runCompanyMember(member, index, {
      companySessionId, companySignal, companyPrompt, awareness,
      mandate: ctx.mandate, runTopology, childCtx, runBudget,
    }),
  );

  // The company is aborted if EITHER the local controller tripped OR the inherited
  // ctx.signal aborted (a parent-company/pipeline abort propagating down). companySignal
  // composes both (company.js:41 trips immediately on an already-aborted input) and tracks
  // a LIVE inherited abort, so it is the single correct abort verdict here — mirroring
  // company.js's `controller.signal.aborted || !!externalSignal?.aborted` (the dropped
  // inherited-signal term that made runCompanyNode report aborted:false for an aborted-
  // but-completed company).
  const result = aggregate(rows, companySessionId, companySignal?.aborted);
  result.scopeSummary = scopeSummary(node, ctx, companySessionId);
  return result;
}

/**
 * Run ONE company member. NEVER throws — always resolves a MemberResult row (the shape
 * aggregate expects). A composite member recurses through runNode and is normalized; a
 * leaf member mirrors company.js's runMember status classification verbatim.
 */
async function runCompanyMember(member, index, mctx) {
  const { companySessionId, companySignal, companyPrompt, awareness, mandate, runTopology, childCtx, runBudget } = mctx;
  const topologyId = member?.topologyId ?? null;
  const base = { index, topologyId, runId: null, status: "failed", trace: null, error: null };

  if (companySignal?.aborted) {
    return { ...base, status: "aborted", error: "company aborted before this member started" };
  }

  // ── Recursion boundary: a composite member is a nested company/pipeline. ──
  if (isComposite(member)) {
    try {
      // descend() runs inside runNode for the nested kind; pass childCtx (company-scoped).
      const nested = await runNode(member, childCtx, { runTopology });
      return normalizeCompositeRow(member, index, nested, companySignal);
    } catch (err) {
      const aborted = !!companySignal?.aborted || err?.name === "AbortError";
      return { ...base, topologyId: member.id ?? member.kind, status: aborted ? "aborted" : "error", error: String(err?.message || err) };
    }
  }

  // ── Leaf member — runTopology, classified exactly as runCompany's runMember does. ──
  if (!member || typeof member.topologyId !== "string" || !member.topologyId) {
    return { ...base, error: "invalid member: a string topologyId is required" };
  }
  const prompt = member.prompt != null ? member.prompt : companyPrompt;
  const options = {
    // [A91]/DR-184: the childIdentity carry seeds leaf-member options FIRST —
    // an explicit member.options always wins.
    ...carryChildIdentity({ genome: childCtx.genome ?? null, agentManifest: childCtx.agents ?? null }),
    ...(member.options || {}),
    awareness: member.options?.awareness ?? awareness,
    // company busScope == sessionId, so the leaf inherits null busScope and the runner's
    // `?? sessionId` fallback scopes it to the company bus — siblings stay mutually visible.
    signal: composeSignals(companySignal, member.options?.signal),
    ...(mandate != null ? { mandate } : {}),
    // Static-nesting depth, surfaced observably (see runTopologyNode). Every concurrent
    // leaf member reads childCtx.depth — the SAME value, since runPool hands each member
    // the same immutable childCtx (never a mutated shared counter). This is T7's observable.
    nodeDepth: childCtx.depth ?? 0,
    nodeAncestors: childCtx.staticAncestors ?? [],
  };
  // C-3 — reserve a Run-budget concurrency slot around the leaf dispatch (the same budget
  // the spawn gate consults). A no-op grant when the Run is UNLIMITED (byte-identical to the
  // pre-governor path); a real reservation when a maxConcurrent ceiling is set, released in
  // the finally so a halt/throw never leaks a slot.
  const slot = runBudget ? runBudget.reserveSlot() : { ok: true };
  if (slot && slot.ok === false) {
    return { ...base, status: "halted", error: slot.reason || "run concurrency budget reached" };
  }
  try {
    const trace = await runTopology(member.topologyId, member.lineup || {}, prompt ?? "", options, companySessionId);
    let status = "ok";
    let error = null;
    if (trace && trace.halted) {
      const reason = String(trace.haltReason || "halted");
      status = (companySignal?.aborted || /abort/i.test(reason)) ? "aborted" : "halted";
      error = reason;
    }
    return { index, topologyId: member.topologyId, runId: (trace && trace.runId) || null, status, trace: trace || null, error };
  } catch (err) {
    const aborted = !!companySignal?.aborted || err?.name === "AbortError";
    return { index, topologyId: member.topologyId, runId: null, status: aborted ? "aborted" : "error", trace: null, error: String(err?.message || err) };
  } finally {
    if (runBudget && slot && slot.ok !== false) runBudget.releaseSlot();
  }
}

/**
 * Normalize a nested company/pipeline result into a MemberResult-shaped row, so aggregate
 * (below) stays byte-identical and never learns the composite shape. The composite's own
 * status maps onto the member status vocabulary {ok, halted, aborted, error}.
 */
function normalizeCompositeRow(member, index, nested, companySignal) {
  const topologyId = member.id ?? `${member.kind}-${index}`;
  const aborted = !!companySignal?.aborted;
  let status = "error";
  if (nested?.status === "complete") status = "ok";
  else if (nested?.status === "aborted" || aborted) status = "aborted";
  else if (nested?.status === "partial") status = "halted"; // a partial composite is a non-fatal incomplete
  // C-2 — a nested pipeline halts-with-a-trace (status:"halted"). Without this arm the
  // halted status fell through to "error", losing the non-fatal-halt distinction the
  // company/pipeline status vocabulary draws (halted != error). Maps to member "halted".
  else if (nested?.status === "halted") status = "halted";
  else if (nested?.status === "failed") status = "error";
  return {
    index, topologyId,
    runId: nested?.sessionId || null,
    status,
    trace: nested || null,
    // For a halted composite, surface the haltReason (the real cause) over the bare status.
    error: status === "ok" ? null : (nested?.haltReason || nested?.status || "composite-incomplete"),
    composite: member.kind,
  };
}

/**
 * Aggregate company member rows. A VERBATIM lift of company.js's aggregate (the same
 * status arithmetic), kept here because company.js does not export it. The arithmetic
 * is unchanged — it operates on the MemberResult contract, which composite rows honor.
 */
function aggregate(members, companySessionId, companyAborted) {
  const ok = members.filter((m) => m.status === "ok").length;
  const errored = members.filter((m) => m.status === "error").length;
  const aborted = members.filter((m) => m.status === "aborted").length;
  const halted = members.filter((m) => m.status === "halted").length;
  let status;
  if (members.length > 0 && ok === members.length) status = "complete";
  else if (ok === 0 && aborted > 0 && errored === 0 && halted === 0) status = "aborted";
  else if (ok === 0 && aborted === 0) status = "failed";
  else status = "partial";
  return {
    ok: status === "complete",
    status,
    kind: "company",
    sessionId: companySessionId,
    counts: { total: members.length, ok, errored, aborted, halted },
    aborted: !!companyAborted || aborted > 0,
    members,
  };
}

/**
 * The 'pipeline' kind. Lifts the SEQUENTIAL CORE only: previousOutput threading,
 * buildStageInput, the runTopology route, and the halt on trace.halted. Each stage is a
 * leaf topology run UNLESS its spec is itself composite (a stage that is a company/pipeline
 * recurses through runNode). Artifacts / verification / SSE / provenance stay in
 * pipeline-runner.js — this is control flow only.
 *
 * The dual-key split for pipelines (the orthogonality that makes T8 pass):
 *   - tree key = ctx.sessionId, POOLED across every stage. So all stages draw on ONE
 *     spawn budget: if stage 1 exhausts maxTotalChildren, stage 2's spawn is still denied.
 *   - busScope = `${ctx.sessionId}:stage:${i}`, PER STAGE. So stage 2 recalls EMPTY for a
 *     child stage 1 published — awareness-isolated despite the shared sessionId.
 */
async function runPipelineNode(node, ctx, deps = {}) {
  const stages = Array.isArray(node.stages) ? node.stages : [];
  if (stages.length === 0) {
    throw new TypeError("runPipelineNode: stages must be a non-empty array");
  }
  const runTopology = deps.runTopology || realRunTopology;

  // C-1 — the per-PIPELINE awareness key root. Two pipeline members under ONE company
  // each thread the SAME ctx.sessionId (the company pooled both keys onto it), so deriving
  // a stage busScope from ctx.sessionId would collide: both compute `${sessionId}:stage:0`
  // and recall each other's stage traffic. Minting a distinct pipelineId per runPipelineNode
  // gives each pipeline its own awareness root while leaving the SPAWN-TREE key
  // (ctx.sessionId, POOLED) untouched — the darwinian dual-key discipline. A standalone
  // pipeline is behaviorally equivalent: its own pipelineId still isolates its stages.
  const pipelineId = nextRunId("pipeline");

  let previousOutput = node.prompt ?? "";
  let previousStageId = null;
  let halted = false;
  let haltReason = null;
  const stageResults = [];

  for (let i = 0; i < stages.length; i++) {
    if (ctx.signal?.aborted) {
      halted = true;
      haltReason = "pipeline aborted";
      break;
    }
    const stageDef = stages[i];

    // The per-stage AWARENESS key — isolates each stage's bus. Rooted on the per-pipeline
    // pipelineId (C-1), NOT ctx.sessionId, so two sibling pipelines under one company do not
    // collide on `:stage:i`. The spawn-tree key stays the pipeline-wide ctx.sessionId
    // (pooled), so the two keys are orthogonal.
    const stageBusScope = `${pipelineId}:stage:${i}`;

    // buildStageInput: stage 0 takes the pipeline prompt; later stages take the prior
    // stage's product (the sequential thread). The lifted core of pipeline-runner.js's
    // buildStageInput {prompt|previous} cases — artifact/composite cases live there.
    const stageInput = buildStageInput(stageDef, previousOutput, node.prompt ?? "");

    // The stage's ctx: pipeline-wide sessionId (tree key, pooled), per-stage busScope
    // (awareness key), carrying the inherited abort + mandate. depth/staticAncestors carry
    // from ctx (this pipeline already spent its descend level).
    const stageCtx = {
      sessionId: ctx.sessionId,
      busScope: stageBusScope,
      depth: ctx.depth,
      staticAncestors: ctx.staticAncestors ?? [],
      signal: ctx.signal,
      mandate: ctx.mandate,
      parentBusScope: ctx.busScope ?? null,
      // [A91]/DR-184: the identity context keeps descending (stageCtx is
      // built fresh here, like the company's childCtx).
      genome: ctx.genome ?? null,
      agents: ctx.agents ?? null,
    };

    let stageResult;
    let stageError = null;
    try {
      if (isComposite(stageDef)) {
        // A composite stage recurses through runNode (its descend fires inside runNode).
        // Its prompt is the threaded stageInput (the prior stage's product); its busScope
        // is the per-stage key via stageCtx. A nested company/pipeline re-mints its own
        // scope inside runNode, so we override only the prompt here.
        stageResult = await runNode({ ...stageDef, prompt: stageInput }, stageCtx, { runTopology });
      } else {
        // A leaf stage — a single topology run, scoped via stageCtx (both keys set). The
        // threaded stageInput becomes the leaf's prompt (the sequential handoff).
        stageResult = await runTopologyNode(toTopologyNode(stageDef, stageInput), stageCtx, { runTopology });
      }
    } catch (err) {
      stageError = String(err?.message || err);
    }

    const stageId = stageDef.id || `stage-${i}`;
    if (stageError) {
      stageResults.push({ index: i, stageId, busScope: stageBusScope, status: "error", error: stageError, result: null });
      halted = true;
      haltReason = stageError;
      break;
    }

    // The halt-on-trace.halted rule, lifted verbatim. A leaf stage returns a trace
    // ({halted, haltReason}); a composite stage returns a CompanyResult/PipelineNodeResult
    // whose status carries the halt signal.
    const stageHalted = isComposite(stageDef)
      ? (stageResult?.status !== "complete" && stageResult?.status !== "partial")
      : !!stageResult?.halted;
    const thisHaltReason = isComposite(stageDef) ? (stageResult?.status || null) : (stageResult?.haltReason || null);

    stageResults.push({
      index: i, stageId, busScope: stageBusScope,
      status: stageHalted ? "halted" : "ok",
      result: stageResult || null,
      error: stageHalted ? (thisHaltReason || "halted") : null,
    });

    if (stageHalted) {
      halted = true;
      haltReason = thisHaltReason || "stage halted";
      break;
    }

    // Thread this stage's product into the next (the sequential core).
    previousOutput = extractStageOutput(stageResult, isComposite(stageDef)) || previousOutput;
    previousStageId = stageId;
  }

  const completedAll = !halted && stageResults.length === stages.length;
  const result = {
    ok: completedAll,
    status: completedAll ? "complete" : (halted ? "halted" : "partial"),
    kind: "pipeline",
    sessionId: ctx.sessionId,
    halted,
    haltReason,
    stages: stageResults,
    previousStageId,
  };
  result.scopeSummary = scopeSummary(node, ctx, ctx.sessionId);
  return result;
}

/**
 * The lifted sequential-input core of pipeline-runner.js's buildStageInput: stage 0 (no
 * prior product) gets the pipeline prompt; later stages get the prior product. Only the
 * {prompt|previous} cases the sequential core needs — the artifact/composite input cases
 * remain in pipeline-runner.js (this is control flow only).
 */
function buildStageInput(stageDef, previousOutput, pipelinePrompt) {
  // An explicit stage input override wins (a stage may pin its own prompt).
  if (typeof stageDef.input === "string") return stageDef.input;
  if (typeof stageDef.prompt === "string") return stageDef.prompt;
  return previousOutput != null && previousOutput !== "" ? previousOutput : pipelinePrompt;
}

/**
 * Coerce a leaf stage spec into a topology node (a stage may be a bare {topologyId,...}),
 * binding the resolved sequential input as its prompt. resolvedInput is the threaded prior
 * product (buildStageInput's result); it overrides a stage's own prompt so the sequential
 * handoff actually reaches the dispatch.
 */
function toTopologyNode(stageDef, resolvedInput) {
  const base = stageDef.kind === "topology" ? stageDef : {
    kind: "topology",
    topologyId: stageDef.topologyId,
    lineup: stageDef.lineup || {},
    options: stageDef.options || {},
  };
  return { ...base, prompt: resolvedInput };
}

/** Best-effort: pull a text product from a stage result to thread to the next stage. */
function extractStageOutput(stageResult, composite) {
  if (!stageResult) return "";
  if (composite) {
    // A nested company/pipeline — there is no single text product; thread its sessionId
    // marker so the next stage at least references the prior sub-run (the real artifact
    // join lives in pipeline-runner.js).
    return `[nested ${stageResult.kind || "node"} ${stageResult.sessionId || ""} — ${stageResult.status || "done"}]`;
  }
  const phases = stageResult.phases || {};
  const keys = Object.keys(phases);
  if (keys.length === 0) return "";
  const last = phases[keys[keys.length - 1]];
  const responses = last?.responses || [];
  return responses.map((r) => r.response || r.error || "").filter(Boolean).join("\n\n");
}

/**
 * Cond 14 — the scope.summary bubble: fires ONCE per NODE completion (a company / a
 * pipeline), NOT per stage. Budget-packed (a bounded summary, never the full trace) and
 * tagged 'scope-bubble'. This is the moat-telemetry derivative of the lineage scopeId; it
 * DERIVES from the same scopeId the awareness busScope derives from, but it is its own
 * record and does not alias the awareness key (#10).
 */
function scopeSummary(node, ctx, scopeId) {
  return {
    tag: "scope-bubble",
    kind: node.kind,
    scopeId,                        // the lineage scopeId (the company/pipeline sessionId)
    parentBusScope: ctx.busScope ?? null,
    depth: ctx.depth ?? 0,
    staticAncestors: ctx.staticAncestors ?? [],
  };
}

export default { runNode, MAX_STATIC_DEPTH };
