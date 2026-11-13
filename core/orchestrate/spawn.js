// Phase 5 — recursive spawn: any loop-capable seated agent convenes a CHILD topology
// (a sub-team) for a sub-problem. The child runs as a sibling on the same awareness
// bus (it shares the parent's sessionId), inherits the carried mandate never-loosened,
// and is bounded so recursion cannot run away.
//
// Design crowned by a panopticon council (2026-06-17) and audited against my anchor.
// The load-bearing upgrade the audit forced: the TopologyTree must be CONCURRENCY-SAFE.
// Multiple seats (in a concurrent company, Phase 4) can call spawn_topology at the same
// time; a plain shared map would race on fanOutActive / children. So tree mutations are
// SERIALIZED, and the bounds check + slot reservation are one atomic step (reserve),
// paired with commit (record the child) and release (free the slot).
//
// This is OPT-IN: the runner registers spawn_topology in a seat's tool surface only when
// the run enables it (dispatchOpts.spawn). Off by default → no seat can spawn → zero
// regression. allowCustom is off: only preset topology ids until a machine-readable
// topology schema exists.

import { composeSignals } from "./company.js";
import { normalizeChildIdentity } from "./child-identity.js";

export const SPAWN_POLICY_DEFAULTS = Object.freeze({ maxDepth: 3, maxFanOut: 3, maxActive: 16, maxTotalChildren: 32 });
export const SPAWN_POLICY_HARD_CAPS = Object.freeze({ maxDepth: 5, maxFanOut: 6, maxActive: 32, maxTotalChildren: 64 });

/** Clamp a requested policy to the hard ceilings (a seat cannot raise its own bounds). */
export function validatePolicy(p = {}) {
  const d = SPAWN_POLICY_DEFAULTS;
  const c = SPAWN_POLICY_HARD_CAPS;
  return {
    maxDepth: Math.max(0, Math.min(p.maxDepth ?? d.maxDepth, c.maxDepth)),
    maxFanOut: Math.max(1, Math.min(p.maxFanOut ?? d.maxFanOut, c.maxFanOut)),
    maxActive: Math.max(1, Math.min(p.maxActive ?? d.maxActive, c.maxActive)),
    maxTotalChildren: Math.max(1, Math.min(p.maxTotalChildren ?? d.maxTotalChildren, c.maxTotalChildren)),
  };
}

// Phase 7 — a monotonic suffix so a detached childRunId is collision-free even when several
// seats register a detached spawn inside one Date.now() tick (mirrors emitter.nextRunId).
let _detachedSeq = 0;

function spawnRefusal(code, message) {
  const e = new Error(message);
  e.spawnRefusal = code;
  return e;
}

/**
 * A per-company-Run tree of spawned topologies. The runaway-prevention spine.
 * All mutations run through a promise-chain serializer so concurrent spawns cannot
 * race the shared counts. reserve() atomically checks every bound fail-closed and
 * reserves a slot; commit() records the child once runTopology mints its runId;
 * release() frees the active slot (totalChildren is a cumulative breadth brake and is
 * NOT freed, except to roll back a reservation that never produced a child).
 */
export class TopologyTree {
  constructor(sessionId, policy = {}) {
    this.sessionId = sessionId;
    this.policy = validatePolicy(policy);
    this.nodes = new Map(); // runId -> { parentRunId, topologyId, depthRemaining, ancestorTopologyIds, active, children:Set }
    this.activeCount = 0;
    this.totalChildren = 0;
    this._lock = Promise.resolve();
  }

  /** Seed the root run (the company member that may spawn). Idempotent. */
  registerRoot(runId, topologyId) {
    if (!this.nodes.has(runId)) {
      this.nodes.set(runId, {
        parentRunId: null, topologyId,
        depthRemaining: this.policy.maxDepth,
        ancestorTopologyIds: [topologyId],
        active: true, children: new Set(),
      });
    }
    return this.nodes.get(runId);
  }

  // Serialize a mutation. The next queued op runs only after this settles, so the
  // synchronous body of `fn` is atomic with respect to the shared counts.
  _locked(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(() => {}, () => {});
    return run;
  }

  /** Atomically check all bounds + reserve a slot. Resolves a ticket or rejects (fail-closed). */
  reserve(parentRunId, childTopologyId) {
    return this._locked(() => {
      const parent = this.nodes.get(parentRunId);
      if (!parent) throw spawnRefusal("unknown-parent", `parent run "${parentRunId}" is not in the tree`);
      if (parent.depthRemaining <= 0) throw spawnRefusal("max-depth", `recursion depth budget exhausted (maxDepth ${this.policy.maxDepth})`);
      if (parent.children.size >= this.policy.maxFanOut) throw spawnRefusal("max-fanout", `parent fan-out at the cap (maxFanOut ${this.policy.maxFanOut})`);
      if (this.activeCount >= this.policy.maxActive) throw spawnRefusal("max-active", `Run-wide active topologies at the cap (maxActive ${this.policy.maxActive})`);
      if (this.totalChildren >= this.policy.maxTotalChildren) throw spawnRefusal("max-total", `cumulative spawn breadth at the cap (maxTotalChildren ${this.policy.maxTotalChildren})`);
      if (parent.ancestorTopologyIds.includes(childTopologyId)) throw spawnRefusal("cycle", `"${childTopologyId}" is already an ancestor — spawning it would cycle`);
      this.activeCount += 1;
      this.totalChildren += 1;
      return {
        parentRunId, childTopologyId,
        depthRemaining: parent.depthRemaining - 1,
        ancestorTopologyIds: [...parent.ancestorTopologyIds, childTopologyId],
        committed: false, released: false, childRunId: null,
      };
    });
  }

  /**
   * Register a spawned child's node by its own runId. Called by the child run itself
   * on start (via the runner, from its spawnContext) so the child is in the tree DURING
   * its execution and its own seats can spawn grandchildren. Idempotent.
   */
  registerNode(runId, { parentRunId = null, topologyId = null, depthRemaining, ancestorTopologyIds = [] } = {}) {
    return this._locked(() => {
      if (this.nodes.has(runId)) return;
      const parent = parentRunId ? this.nodes.get(parentRunId) : null;
      if (parent) parent.children.add(runId);
      this.nodes.set(runId, {
        parentRunId, topologyId,
        depthRemaining: depthRemaining ?? this.policy.maxDepth,
        ancestorTopologyIds, active: true, children: new Set(),
      });
    });
  }

  /** Record the child node once runTopology has minted its runId (no-op if it self-registered). */
  commit(ticket, childRunId) {
    return this._locked(() => {
      if (ticket.released || ticket.committed) return;
      ticket.committed = true;
      ticket.childRunId = childRunId;
      if (!this.nodes.has(childRunId)) {
        const parent = this.nodes.get(ticket.parentRunId);
        if (parent) parent.children.add(childRunId);
        this.nodes.set(childRunId, {
          parentRunId: ticket.parentRunId, topologyId: ticket.childTopologyId,
          depthRemaining: ticket.depthRemaining, ancestorTopologyIds: ticket.ancestorTopologyIds,
          active: true, children: new Set(),
        });
      }
    });
  }

  /** Free the active slot. Rolls back the breadth count only if no child was ever committed. */
  release(ticket) {
    return this._locked(() => {
      if (ticket.released) return;
      ticket.released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (!ticket.committed) {
        this.totalChildren = Math.max(0, this.totalChildren - 1);
      } else if (ticket.childRunId) {
        const node = this.nodes.get(ticket.childRunId);
        if (node) node.active = false;
      }
    });
  }

  snapshot() {
    return { sessionId: this.sessionId, activeCount: this.activeCount, totalChildren: this.totalChildren, nodes: this.nodes.size };
  }
}

// Per-company-Run registry of trees, keyed on the shared sessionId.
const _trees = new Map();
export function getOrCreateTree(sessionId, policy) {
  if (!_trees.has(sessionId)) _trees.set(sessionId, new TopologyTree(sessionId, policy));
  return _trees.get(sessionId);
}
// Phase 7 — a NON-creating peek for read-only observers (the operator console). getOrCreateTree
// INSERTS a tree when none exists, so an observer that calls it to "look" leaks an orphan tree into
// the registry (and violates the console's read-only contract) the moment it watches a flat company
// that never spawned. peekTree returns the live tree or null, creating nothing.
export function peekTree(sessionId) { return _trees.get(sessionId) ?? null; }
export function disposeTree(sessionId) { _trees.delete(sessionId); }
export function _resetTreesForTest() { _trees.clear(); }

/**
 * Build the in-context spawn_topology tool, bound to one seat's run context. mcpTools-
 * shaped (like siblingTool), so a loop-capable seat reaches it through the same surface.
 *
 * @param {object} ctx
 * @param {string} ctx.sessionId        — the company sessionId (the child shares it → bus sibling)
 * @param {string} ctx.parentRunId      — the spawning seat's run id (its node in the tree)
 * @param {TopologyTree} ctx.tree        — the per-Run TopologyTree
 * @param {object} [ctx.carriedMandate]  — the run mandate OBJECT (mandate.js shape), inherited by
 *                                          the child never-loosened. Threaded as the child's
 *                                          options.mandate, which the runner renders through the
 *                                          single [Mandate] frame block (Condition 5 heal — NOT
 *                                          prepended into the prompt; a stringified carrier would
 *                                          not render). A test may pass a plain string fixture; the
 *                                          handler is agnostic and simply threads whatever it gets.
 * @param {AbortSignal} [ctx.signal]     — the run's abort, inherited by the child
 * @param {string} [ctx.seat]
 * @param {string} [ctx.model]
 * @param {boolean} [ctx.detached]       — Phase 7. false (default) = await the child inline (today's
 *                                          behavior, byte-identical). true = register the run in
 *                                          ctx.registry and return its childRunId IMMEDIATELY; the
 *                                          run continues SAME-LOOP, not awaited by the spawner.
 *                                          SAME-LOOP IS NOT ISOLATION (a CPU-bound child still
 *                                          degrades the parent — true isolation is Phase F).
 * @param {import("./detached-registry.js").DetachedRunRegistry} [ctx.registry]
 *                                        — the per-session DetachedRunRegistry; required when detached.
 * @param {object} [deps]                — { runTopology, requestApproval } injection seam for tests
 */
/**
 * [A17.8] The TAOR "recurse" route's engine — a lean, SYNCHRONOUS (awaited) child
 * topology run bounded by the same TopologyTree as seat-initiated spawns. Unlike
 * makeSpawnTool this is ENGINE-initiated (the adaptive router decided; no operator gate —
 * the tree's depth/cycle/fan-out/active/total caps ARE the runaway guard) and its child
 * trace is folded back as the recursing phase's result. Mirrors the awaited spawn dance:
 * reserve (fail-closed) → run the child sharing the session (so it self-registers at
 * depth-1 and its own seats stay bounded) → commit → release.
 *
 * Fail-closed: a refusal returns {ok:false, refusal:{reason,detail}} and NOTHING runs; a
 * child that itself HALTED returns {ok:false, halted:true, trace} so the parent can halt
 * honestly with the sub-problem's own reason.
 *
 * @param {object} input
 * @param {object} input.tree              the session's TopologyTree (parentRunId must be a node)
 * @param {string} input.parentRunId       the recursing run's node id
 * @param {string} input.topologyId        the child topology to convene
 * @param {string} input.prompt            the child seed (recurse T-annotation + the problem)
 * @param {string} input.sessionId         the shared session
 * @param {object} [input.lineup]          the child lineup
 * @param {object} [input.childOptions]    extra options merged into the child run
 * @param {Function} [input.runTopologyFn] injection seam (default: the real runTopology)
 * @returns {Promise<{ok:true, trace:object, childRunId:string|null}|{ok:false, halted?:boolean, trace?:object, refusal?:{reason:string,detail:string}}>}
 */
export async function conveneChildTopology(input = {}) {
  const { tree, parentRunId, topologyId, prompt, sessionId, lineup = {}, childOptions = {} } = input;
  if (!tree || !parentRunId || !topologyId) {
    return { ok: false, refusal: { reason: "bad-args", detail: "tree, parentRunId, and topologyId are required" } };
  }
  let ticket;
  try {
    ticket = await tree.reserve(parentRunId, topologyId);
  } catch (e) {
    if (e && e.spawnRefusal) return { ok: false, refusal: { reason: e.spawnRefusal, detail: e.message } };
    return { ok: false, refusal: { reason: "reserve-error", detail: String(e?.message || e) } };
  }
  try {
    const runTopology = input.runTopologyFn || (await import("../topologies/runner.js")).runTopology;
    const opts = {
      ...childOptions,
      spawn: true, // the child may itself recurse/spawn, bounded by the same tree (depth already decremented)
      // [A90]/DR-182 P1: same lineage law as the seat-spawn edge above.
      spawnContext: { parentRunId, depthRemaining: ticket.depthRemaining, ancestorTopologyIds: ticket.ancestorTopologyIds },
    };
    const trace = await runTopology(topologyId, lineup, String(prompt ?? ""), opts, sessionId);
    await tree.commit(ticket, (trace && trace.runId) || `child-${topologyId}`);
    await tree.release(ticket);
    if (trace && trace.halted) {
      return { ok: false, halted: true, trace, refusal: { reason: "child-halted", detail: trace.haltReason || "the sub-topology run halted" } };
    }
    return { ok: true, trace, childRunId: (trace && trace.runId) || null };
  } catch (e) {
    try { await tree.release(ticket); } catch { /* best-effort accounting */ }
    return { ok: false, refusal: { reason: "child-run-error", detail: String(e?.message || e) } };
  }
}

export function makeSpawnTool(ctx, deps = {}) {
  const { sessionId, parentRunId, tree, carriedMandate = null, signal = null, detached = false, registry = null, busScope = null, parentCapabilityResolution = null, childCarry = null } = ctx;
  // [A92]: ctx.childIdentityState (the normalized state, computed by the
  // runner) gates the explicit-mode spawn args in the handler below.

  async function handler(args = {}) {
    const topologyId = String(args.topologyId || "");
    if (!topologyId) return { ok: false, refused: true, reason: "bad-args", detail: "topologyId is required" };
    if (args.descriptor) return { ok: false, refused: true, reason: "custom-gated", detail: "custom topology descriptors are gated off (allowCustom=false)" };
    // [A92]/DR-185 (DR-182 explicit mode): spawn-provided identity — args.agents
    // + args.genome — is accepted ONLY when the run's childIdentity state is
    // `explicit`; under every other state it is REFUSED loudly, so a seat can
    // never smuggle identities the operator's control did not authorize.
    let explicitIdentity = null;
    if (args.agents !== undefined || args.genome !== undefined) {
      if ((ctx.childIdentityState || "none") !== "explicit") {
        return {
          ok: false,
          refused: true,
          reason: "identity-not-explicit",
          detail: `spawn args agents/genome require childIdentity=explicit (this run's state: ${ctx.childIdentityState || "none"})`,
        };
      }
      if (args.genome !== undefined) {
        if (typeof args.genome !== "object" || args.genome === null || Array.isArray(args.genome) || !args.genome.projectDir || typeof args.genome.projectDir !== "string") {
          return { ok: false, refused: true, reason: "bad-args", detail: "spawn genome must be an object with a projectDir (string) — the fail-closed genome law" };
        }
        try {
          normalizeChildIdentity(args.genome);
        } catch (err) {
          return { ok: false, refused: true, reason: "bad-args", detail: String(err?.message || err) };
        }
      }
      explicitIdentity = {
        ...(args.agents !== undefined ? { agents: args.agents } : {}),
        ...(args.genome !== undefined ? { genome: args.genome } : {}),
      };
    }

    // 1) Fail-closed bounds check + slot reservation (atomic).
    let ticket;
    try {
      ticket = await tree.reserve(parentRunId, topologyId);
    } catch (e) {
      if (e && e.spawnRefusal) return { ok: false, refused: true, reason: e.spawnRefusal, detail: e.message };
      return { ok: false, refused: true, reason: "reserve-error", detail: String(e?.message || e) };
    }

    try {
      // 2a) GZDS hard tier (dispatch POLICY, not a prompt). A spawn denied by policy
      //     fails closed WITHOUT prompting — the operator configures the policy once.
      //     Inert unless armed (back-compat). The interactive gate below stays as the
      //     operator-present layer. Injectable for tests via deps.enforceDispatch.
      const enforce = deps.enforceDispatch
        || (await import("../governance/enforcement/enforce.js")).enforceDispatch;
      const policyVerdict = enforce({ modelId: ctx.model, options: { spawn: true, seat: ctx.seat || null } });
      if (!policyVerdict.allowed) {
        await tree.release(ticket);
        return { ok: false, refused: true, reason: "policy-denied", detail: policyVerdict.reason };
      }

      // 2b) GZDS interactive gate — the operator may deny a spawn. Fail-closed: denied/absent → refuse.
      const gate = deps.requestApproval;
      if (gate) {
        let decision;
        // Phase F bounded-wait: a never-arriving operator approval must not hang the seat
        // forever. On timeout, fail CLOSED (release + refuse) — the Run is retryable, never
        // deadlocked. Override via ctx.gateTimeoutMs; default 5 min. The timer stays
        // ref'd while pending so the semantic timeout can settle, then clears on exit.
        const gateTimeoutMs = Number.isFinite(ctx.gateTimeoutMs) && ctx.gateTimeoutMs > 0 ? ctx.gateTimeoutMs : 300000;
        let _gateTimer = null;
        try {
          decision = await Promise.race([
            gate({
              tool: "spawn_topology",
              args: { topologyId, lineup: args.lineup || {} },
              source: { seat: ctx.seat || null, model: ctx.model || null },
              context: `Agent spawning child topology "${topologyId}"`,
            }),
            new Promise((_, reject) => {
              _gateTimer = setTimeout(() => reject(new Error(`spawn-gate approval timed out after ${gateTimeoutMs}ms`)), gateTimeoutMs);
            }),
          ]);
        } catch (err) {
          await tree.release(ticket);
          return { ok: false, refused: true, reason: "gate-error", detail: String(err?.message || err) };
        } finally {
          if (_gateTimer) clearTimeout(_gateTimer);
        }
        if (!decision || !decision.approved) {
          await tree.release(ticket);
          return { ok: false, refused: true, reason: "gate-denied", detail: decision?.reason || "operator-rejected" };
        }
      }

      // 3) Spawn the child at depth+1. It shares the sessionId (bus sibling), inherits the
      //    mandate never-loosened, and inherits the run's abort.
      //
      //    Mandate-convention heal (colosseum Condition 5): the inherited mandate is carried
      //    ONCE, via childOptions.mandate. The runner now honors options.mandate (runner.js
      //    `let mandate = options.mandate ?? buildMandate(...)`) and renders it through the
      //    single [Mandate] frame block (frame.js / renderMandateBlock). The old prompt-prepend
      //    (`[Inherited mandate — binding…]\n…\n\n[Delegated sub-task]\n…`) is RETIRED: prepending
      //    it AND threading it would now double-inject the mandate (twice, rendered two different
      //    ways). The child's prompt is its delegated sub-task ALONE; the mandate rides options.
      //    The reserved frame block is equivalent-or-stronger framing than the prepend — it is
      //    ALWAYS the first token-reserved block, paired with the subordinating [Seat lens]
      //    escape clause, on every seat, every phase (not just the first seat-message assembly).
      const runTopology = deps.runTopology || (await import("../topologies/runner.js")).runTopology;
      const childPrompt = String(args.prompt ?? "");
      const childOptions = {
        awareness: true,
        signal: composeSignals(signal, args.signal),
        spawn: true, // the child may itself spawn, bounded by the same tree (depth already decremented)
        // [A90]/DR-182 P1: parentRunId rides the context so the child's
        // self-registration links the tree (registerNode consumes it — the
        // pre-A90 context left it null) AND lineage survives into telemetry.
        spawnContext: { parentRunId, depthRemaining: ticket.depthRemaining, ancestorTopologyIds: ticket.ancestorTopologyIds },
        // Cond 11 — the AWARENESS key is carried EXPLICITLY (orthogonal to the spawn-tree
        // key, which is the sessionId passed positionally to runTopology). A spawn child
        // publishes/recalls under its parent's busScope so a pipeline-stage child stays
        // inside that stage's awareness window; a company child inherits null and the
        // runner's `?? sessionId` fallback rescues it to the company-wide bus (byte-identical
        // to today). The two keys NEVER cross: the tree stays keyed on sessionId below.
        ...(busScope != null ? { busScope } : {}),
        ...(carriedMandate != null ? { mandate: carriedMandate } : {}),
        // [A41]/R1: a seat-spawned child intersects with its SPAWNING SEAT's
        // resolution — the seat-spawn edge was the review's laundering vector
        // (A1.1); the runner's recurse chain covers phase-level recursion, this
        // covers the tool-initiated spawn. Same never-loosened rule as mandate.
        ...(parentCapabilityResolution != null ? { parentCapabilityResolution } : {}),
        // [A91]/DR-184: the childIdentity carry — the runner computed the
        // fragment ONCE from the run's own control ({} under `none`; the raw
        // agents manifest + the genome control under `inherit`/`derive`; the
        // control alone under `explicit`).
        ...(childCarry && typeof childCarry === "object" ? childCarry : {}),
        // [A92]/DR-185: explicit-mode spawn args land LAST — the spawn call's
        // own identity beats the carried control copy.
        ...(explicitIdentity || {}),
        // Preserve explicit scope selection, including invalid values that must refuse recall.
        ...(Object.hasOwn(ctx, "awarenessAssignment") ? { awarenessAssignment: ctx.awarenessAssignment } : {}),
      };

      // 4) Detached (Phase 7) vs awaited (Phase 5, today's default). The DETACHED branch
      //    registers the same-loop run and returns its childRunId IMMEDIATELY — the run
      //    continues but is NOT awaited here. commit/release move INTO the runner's settle
      //    callbacks so the TopologyTree accounting happens exactly once on settle, off the
      //    caller's await. A later collect_topology reads the snapshot by childRunId.
      //    SAME-LOOP, NOT ISOLATION (true parallelism is Phase F).
      if (detached) {
        if (!registry) {
          await tree.release(ticket);
          return { ok: false, refused: true, reason: "detached-misconfigured", detail: "detached spawn requested but no registry was provided" };
        }
        // Mint the registry key BEFORE the run produces its real trace.runId (mirrors the
        // `child-${topologyId}` fallback at the awaited path). collect keys on THIS id; the
        // run's real runId is surfaced separately in the snapshot result.
        const childRunId = `child-${topologyId}-${Date.now()}-${(_detachedSeq++).toString(36)}`;
        registry.register({
          childRunId,
          topologyId,
          parentRunId,
          runner: () =>
            runTopology(topologyId, args.lineup || {}, childPrompt, childOptions, sessionId).then(
              async (t) => {
                await tree.commit(ticket, (t && t.runId) || childRunId);
                await tree.release(ticket);
                return t;
              },
              async (e) => {
                await tree.release(ticket);
                throw e;
              },
            ),
        });
        return { ok: true, detached: true, childRunId, topologyId, status: "running" };
      }

      const trace = await runTopology(topologyId, args.lineup || {}, childPrompt, childOptions, sessionId);
      await tree.commit(ticket, (trace && trace.runId) || `child-${topologyId}`);
      await tree.release(ticket);

      if (trace && trace.halted) {
        return { ok: false, runId: trace.runId || null, topologyId, reason: "child-halted", haltReason: trace.haltReason || null, trace };
      }
      return { ok: true, runId: (trace && trace.runId) || null, topologyId, trace: trace || null };
    } catch (err) {
      await tree.release(ticket);
      return { ok: false, refused: false, reason: "spawn-error", detail: String(err?.message || err) };
    }
  }

  return {
    name: "spawn_topology",
    description: "Convene a child topology (a sub-team) for a sub-problem. The child runs aware on the same bus, inherits the mandate (never loosened), and is bounded by recursion depth, fan-out, and the gate. Returns the child's result.",
    parameters: {
      type: "object",
      properties: {
        topologyId: { type: "string", description: "a preset topology id, e.g. dev-team, adversarial-debate, research-swarm" },
        lineup: { type: "object", description: "optional { seat: model } assignments; auto-fills if omitted" },
        prompt: { type: "string", description: "the sub-problem for the child team" },
        reason: { type: "string", description: "why this sub-team is needed" },
      },
      required: ["topologyId", "prompt"],
    },
    handler,
  };
}

export default {
  TopologyTree, getOrCreateTree, peekTree, disposeTree, makeSpawnTool, validatePolicy,
  SPAWN_POLICY_DEFAULTS, SPAWN_POLICY_HARD_CAPS,
};
