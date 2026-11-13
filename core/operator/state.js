// Phase 7 — operator surface lane: pure projection / reducers (no I/O).
//
// This module holds ALL the reducer logic for the operator console so console.js
// stays a thin subscription + query shell. Everything here is pure and deterministic:
// reduceEvent(prevState, event) -> nextState maps the emitter.js event vocabulary into
// a flat OperatorState, and buildLiveState(projection, treeSnapshot, treeNodes,
// awareness) folds the projection + a live tree read + a live awareness read into ONE
// structured snapshot — the renderer's input contract.
//
// Why split this out: pure functions are unit-testable in isolation under node --test
// with synthetic events (no emitter, no tree, no company). console.js never reimplements
// reducer math; it just threads events through reduceEvent.
//
// READ-ONLY on every existing module: this file imports nothing from emitter/spawn/
// awareness/company. It only consumes plain event/snapshot objects those modules already
// produce. Back-compat is structural — nothing here can mutate shared state.
//
// Emitter event vocabulary consumed (emitter.js:148-666). Events carry a top-level
// `type`, a `payload`, a top-level `sessionId`, and a `time` (seconds since run start).
// There is NO runId on the emitted event — runs sharing a company sessionId are
// distinguished by topology identity (topologyId / topologyName) carried in the payload.
//   topology_start    payload { topologyId, topologyName, lineup, prompt, graph }
//   phase_start       payload { phaseId, phaseType, seats }
//   phase_complete    payload { phaseId, latency, totalTokens, responseCount, gateStatus, gateReason, ... }
//   gate_halt         payload { phaseId, reason }
//   budget_update     payload = the budget object itself
//   agent_complete    payload { name }
//   message           payload { agent, role, content, tokens }
//   topology_complete payload { topologyId, topologyName, totalLatency, budget, phaseCount, halted, haltReason }
//   correlation_flag  payload { phaseId, ...flag }

/** A frozen empty projection for a session — the reduce seed. Deterministic, no clock read. */
export function initialState(sessionId = null) {
  return {
    sessionId: sessionId ?? null,
    startedAt: null,        // first event's wall ts we observe (set by console.js, see note)
    topologies: {},         // key (topologyId||topologyName) -> { topologyId, topologyName, status, lastMessage, tokens, error, phasesComplete }
    phases: { started: 0, complete: 0 },
    gates: [],              // [{ phaseId, reason, ts }]
    budget: null,           // last-seen budget payload
    lastMessage: null,      // { agent, content, tokens } — most recent across all teams
    lastEventTs: null,      // event.time of the newest event folded
    eventCount: 0,
    error: null,            // a process-level error note (reserved; per-team errors live on the team)
  };
}

// Identify a topology row from a payload. Runs that share a company sessionId are still
// distinct topologies; we key on the stable topology identity carried in the payload.
function teamKey(payload = {}) {
  return payload.topologyId || payload.topologyName || payload.agent || null;
}

function ensureTeam(topologies, key, seed = {}) {
  if (!topologies[key]) {
    topologies[key] = {
      topologyId: seed.topologyId ?? key,
      topologyName: seed.topologyName ?? null,
      status: "running",
      lastMessage: null,
      tokens: 0,
      error: null,
      phasesComplete: 0,
    };
  }
  return topologies[key];
}

/**
 * Pure, deterministic reducer. Folds ONE emitter event into the projection and returns
 * a NEW state object (no mutation of the input). Unknown event types pass through with
 * only the bookkeeping counters touched, so a new emitter event type can never crash the
 * console — it is simply not projected until this reducer learns it.
 *
 * @param {OperatorState} state — previous projection (use initialState() as the seed)
 * @param {object} event        — an emitter event { type, payload, sessionId, time }
 * @returns {OperatorState}
 */
export function reduceEvent(state, event) {
  const prev = state || initialState(event?.sessionId ?? null);
  if (!event || typeof event !== "object") return prev;

  // Clone shallowly, then deep-clone the sub-structures we touch, so callers that hold
  // the previous state see no mutation (pure-function contract).
  const next = {
    ...prev,
    topologies: { ...prev.topologies },
    phases: { ...prev.phases },
    gates: prev.gates,
    eventCount: prev.eventCount + 1,
  };
  if (next.sessionId == null && event.sessionId != null) next.sessionId = event.sessionId;
  if (typeof event.time === "number") next.lastEventTs = event.time;

  const p = event.payload || {};

  switch (event.type) {
    case "topology_start": {
      const key = teamKey(p);
      if (key) {
        next.topologies[key] = {
          topologyId: p.topologyId ?? key,
          topologyName: p.topologyName ?? null,
          status: "running",
          lastMessage: null,
          tokens: 0,
          error: null,
          phasesComplete: 0,
        };
      }
      break;
    }

    case "phase_start": {
      next.phases = { ...next.phases, started: next.phases.started + 1 };
      break;
    }

    case "phase_complete": {
      next.phases = { ...next.phases, complete: next.phases.complete + 1 };
      const tokens = Number.isFinite(p.totalTokens) ? p.totalTokens : 0;
      // phase_complete has no topology identity on its payload; attribute tokens to the
      // most-recently-active running team if there is exactly one, else leave on phases.
      const runningKeys = Object.keys(next.topologies).filter((k) => next.topologies[k].status === "running");
      if (runningKeys.length === 1) {
        const k = runningKeys[0];
        const t = { ...next.topologies[k] };
        t.tokens += tokens;
        t.phasesComplete += 1;
        next.topologies[k] = t;
      }
      break;
    }

    case "gate_halt": {
      next.gates = [
        ...next.gates,
        { phaseId: p.phaseId ?? null, reason: p.reason ?? null, ts: typeof event.time === "number" ? event.time : null },
      ];
      break;
    }

    case "budget_update": {
      // payload IS the budget object (emitter.js:660). Keep the last-seen snapshot.
      next.budget = p && typeof p === "object" ? { ...p } : p;
      break;
    }

    case "message": {
      const msg = { agent: p.agent ?? null, content: typeof p.content === "string" ? p.content : "", tokens: Number.isFinite(p.tokens) ? p.tokens : 0 };
      next.lastMessage = msg;
      // Attribute the message to its team by the agent's "seat:model" — the agent string
      // is not the topology key, so we record it on the single running team when unambiguous;
      // otherwise it lands only on the top-level lastMessage. Always cheap, never throws.
      const runningKeys = Object.keys(next.topologies).filter((k) => next.topologies[k].status === "running");
      if (runningKeys.length === 1) {
        const k = runningKeys[0];
        next.topologies[k] = { ...next.topologies[k], lastMessage: msg.content.slice(0, 200), tokens: next.topologies[k].tokens + msg.tokens };
      }
      break;
    }

    case "topology_complete": {
      const key = teamKey(p);
      if (key && next.topologies[key]) {
        const t = { ...next.topologies[key] };
        t.status = p.halted ? "halted" : "complete";
        if (p.halted) t.error = p.haltReason ?? "halted";
        if (p.budget && Number.isFinite(p.budget.spent)) t.tokens = p.budget.spent;
        next.topologies[key] = t;
      } else if (key) {
        // completion for a team we never saw a start for — record it terminally.
        next.topologies[key] = {
          topologyId: p.topologyId ?? key,
          topologyName: p.topologyName ?? null,
          status: p.halted ? "halted" : "complete",
          lastMessage: null,
          tokens: p.budget && Number.isFinite(p.budget.spent) ? p.budget.spent : 0,
          error: p.halted ? (p.haltReason ?? "halted") : null,
          phasesComplete: Number.isFinite(p.phaseCount) ? p.phaseCount : 0,
        };
      }
      break;
    }

    // agent_complete / correlation_flag / model_detected / context_update / etc.:
    // counted in eventCount, not separately projected (yet). Unknown types fall here too.
    default:
      break;
  }

  return next;
}

/**
 * Fold the push-projection together with a LIVE pull of the tree + awareness into a single
 * structured snapshot — the one object renderers and downstream consumers (MC, a CLI loop)
 * read. Pure: it copies its inputs into a plain shape and never mutates them.
 *
 * @param {OperatorState} projection      — the reduceEvent accumulator
 * @param {object|null} treeSnapshot       — getOrCreateTree(sessionId).snapshot() (counts)
 * @param {Array|null} treeNodes           — enriched per-node array (see console.getTreeNodes)
 * @param {Array|null} awareness           — adapter.recent() filtered to this company, newest-first
 * @returns {LiveState}
 */
export function buildLiveState(projection, treeSnapshot = null, treeNodes = null, awareness = null) {
  const proj = projection || initialState(null);
  const teams = Object.values(proj.topologies).map((t) => ({
    topologyId: t.topologyId,
    topologyName: t.topologyName,
    status: t.status,
    lastMessage: t.lastMessage,
    tokens: t.tokens,
    error: t.error,
    phasesComplete: t.phasesComplete,
  }));

  const tree = treeSnapshot
    ? {
        sessionId: treeSnapshot.sessionId ?? proj.sessionId ?? null,
        activeCount: treeSnapshot.activeCount ?? 0,
        totalChildren: treeSnapshot.totalChildren ?? 0,
        nodeCount: typeof treeSnapshot.nodes === "number" ? treeSnapshot.nodes : (Array.isArray(treeNodes) ? treeNodes.length : 0),
      }
    : { sessionId: proj.sessionId ?? null, activeCount: 0, totalChildren: 0, nodeCount: Array.isArray(treeNodes) ? treeNodes.length : 0 };

  return {
    sessionId: proj.sessionId ?? null,
    eventCount: proj.eventCount,
    lastEventTs: proj.lastEventTs,
    teams,
    phases: { ...proj.phases },
    gates: proj.gates.slice(),
    budget: proj.budget ? { ...proj.budget } : null,
    lastMessage: proj.lastMessage ? { ...proj.lastMessage } : null,
    tree,
    nodes: Array.isArray(treeNodes) ? treeNodes.map((n) => ({ ...n })) : [],
    awareness: Array.isArray(awareness) ? awareness.map((e) => ({ ...e })) : [],
  };
}

export default { initialState, reduceEvent, buildLiveState };
