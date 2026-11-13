// Bounded awareness publication and recall with explicit assignment scoping.
// Storage and federation adapters are caller-selected; reference claims grant no authority.

import { createInMemoryRingAdapter } from "./in-memory-ring.js";
import { estTokens, AWARENESS_BUDGET } from "./budget.js";

let _adapter = createInMemoryRingAdapter(); // standalone baseline, swappable
let _federation = null;                     // optional callback, default off
let _seq = 0;

/** Swap the storage backend (in-memory default; explicit adapters are supported). */
export function setAdapter(adapter) { _adapter = adapter || createInMemoryRingAdapter(); }
export function getAdapter() { return _adapter; }

/** Register an optional publication observer; returns its unregister callback. */
export function registerFederation(cb) {
  _federation = typeof cb === "function" ? cb : null;
  return () => { if (_federation === cb) _federation = null; };
}

/** Best-effort: a published event must never throw or block a dispatch. */
export function publish(event) {
  if (!event) return null;
  let e;
  try {
    // Directed instance references must never fall through to summary recall.
    if (Object.hasOwn(event, "instanceRoute")) return null;
    e = {
      id: `aw-${Date.now()}-${(_seq++).toString(36)}`,
      ts: Date.now(),
      company: event.company ?? null,
      topologyId: event.topologyId ?? null,
      seatId: event.seatId ?? null,
      kind: event.kind || "dispatch.out",
      summary: typeof event.summary === "string" ? event.summary : String(event.summary ?? ""),
      tags: Array.isArray(event.tags) ? event.tags : [],
      tokens: Number.isFinite(event.tokens) ? event.tokens : estTokens(event.summary || ""),
      // Assignment is caller-resolved routing evidence, never an authority grant.
      ...(Object.hasOwn(event, "assignment") ? { assignment: copyAssignment(event.assignment) } : {}),
    };
    // Scoped routing identity cannot be rewritten through the returned event or
    // a federation/adapter reference. Unscoped legacy events retain their shape.
    if (Object.hasOwn(e, "assignment")) Object.freeze(e);
    _adapter.append(e);
  } catch { return null; }
  // Federate AFTER the local append, isolated so an MC fault never breaks the bus.
  if (_federation) { try { _federation(e); } catch { /* MC is optional — swallow */ } }
  return e;
}

const intersects = (a, b) => Array.isArray(a) && Array.isArray(b) && a.some((x) => b.includes(x));

const assignmentKeys = ["projectId", "workId", "revision", "workspaceId"];
const identity = (v) => typeof v === "string" && v.trim().length > 0;
const routeFields = ["sourceRef", "sourceSha256", "senderAgentId", "senderExecutionId", "senderAttemptId", "recipientAgentId", "recipientExecutionId"];
function copyInstanceRoute(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== routeFields.length ||
      !routeFields.every(key => identity(value[key]) && value[key].length <= 1024) ||
      !/^[a-f0-9]{64}$/.test(value.sourceSha256)) return null;
  return Object.freeze(Object.fromEntries(routeFields.map(key => [key, value[key]])));
}
function copyAssignment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!assignmentKeys.every((key) => identity(value[key]))) return null;
  if (Object.hasOwn(value, "taskId") && !identity(value.taskId)) return null;
  return Object.freeze(Object.fromEntries([...assignmentKeys, ...(Object.hasOwn(value, "taskId") ? ["taskId"] : [])].map((key) => [key, value[key]])));
}

/**
 * Reference-only routing claims. They neither authenticate sender/recipient nor
 * authorize source access. Actual host-owned admission and source verification
 * are required before any content may be delivered.
 */
export function publishInstanceReference(event) {
  try {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        Object.keys(event).some(k => !["company", "topologyId", "assignment", "instanceRoute"].includes(k)) ||
        !identity(event.company)) return null;
    const assignment = copyAssignment(event.assignment), route = copyInstanceRoute(event.instanceRoute);
    if (!assignment || !route || (event.topologyId != null && !identity(event.topologyId))) return null;
    const e = Object.freeze({ id: `aw-${Date.now()}-${(_seq++).toString(36)}`, ts: Date.now(),
      company: event.company, topologyId: event.topologyId ?? null, seatId: null,
      kind: "instance.reference", summary: "", tags: Object.freeze([]), tokens: 0,
      assignment, instanceRoute: route });
    _adapter.append(e);
    if (_federation) { try { _federation(e); } catch { /* best effort */ } }
    return e;
  } catch { return null; }
}

/** Discover attributed-reference claims only. Recipient values narrow routing;
 * they are not authenticated here, and a matching claim does not grant access. */
export function recallInstanceReferences(q = {}) {
  try {
    if (!q || typeof q !== "object" || Array.isArray(q) || !identity(q.company) ||
        !copyAssignment(q.assignment) || !identity(q.recipientAgentId) || !identity(q.recipientExecutionId)) return [];
    const maxEvents = q.budget?.maxEvents ?? 1;
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) return [];
    const claims = new Map(), conflicts = new Set();
    for (const e of admittedCandidates(q, { maxEvents })) {
      const route = copyInstanceRoute(e.instanceRoute);
      if (!route || route.recipientAgentId !== q.recipientAgentId || route.recipientExecutionId !== q.recipientExecutionId) continue;
      const key = route.sourceRef, old = claims.get(key);
      if (old && routeFields.some(field => old[field] !== route[field])) conflicts.add(key);
      else if (!old) claims.set(key, route);
    }
    return [...claims].filter(([key]) => !conflicts.has(key)).slice(0, maxEvents).map(([, route]) => route);
  } catch { return []; }
}

// Narrow the existing company/stage boundary; never substitute assignment for it.
// Legacy callers retain their existing window. Explicit selection fails closed.
function admittedCandidates(q, budget) {
  const { company = null, excludeTopologyId = null, includeSelf = false } = q;
  const strict = Object.hasOwn(q, "assignment");
  const selected = strict ? copyAssignment(q.assignment) : null;
  if (strict && (!selected || !identity(company))) return [];
  return _adapter.recent(Math.max(budget.maxEvents * 6, 64)).filter((e) => {
    if (company != null && e.company !== company) return false;
    if (!includeSelf && excludeTopologyId != null && e.topologyId === excludeTopologyId) return false;
    // A legacy/unselected reader cannot widen access to newly scoped events.
    if (!strict) return !Object.hasOwn(e, "assignment");
    const observed = copyAssignment(e.assignment);
    return observed !== null && Object.keys(selected).every((key) => observed[key] === selected[key]);
  });
}

// Reuse the established relevance/recency policy without inspecting payloads.
function orderCandidates(candidates, tags) {
  const tagged = tags.length ? candidates.filter((e) => intersects(e.tags, tags)) : [];
  const taggedSet = new Set(tagged);
  return [...tagged, ...candidates.filter((e) => !taggedSet.has(e))];
}

/**
 * Host-side discovery for subsequent item-local admission. Returns references,
 * never summaries or custody claims. Assignment and company are mandatory here;
 * they narrow discovery but do not authenticate the reader or authorize content.
 * The host may select existing tagged-recency priority or pure recency per work.
 * Payload/token packing belongs AFTER admission, not in this reference selector.
 * Discovery retains the existing bounded recent window, not exhaustive retrieval.
 */
export function recallReferences(q = {}) {
  try {
    if (!Object.hasOwn(q, "assignment") || !copyAssignment(q.assignment) || !identity(q.company)) return [];
    const maxEvents = q.budget?.maxEvents ?? 1;
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) return [];
    const tags = q.tags ?? [];
    if (!Array.isArray(tags) || !tags.every(identity)) return [];
    const order = q.order ?? "tagged-recency";
    if (order !== "tagged-recency" && order !== "recency") return [];
    const excluded = Object.hasOwn(q, "excludeReferences") ? q.excludeReferences : [];
    if (!Array.isArray(excluded)) return [];
    const count = excluded.length, withheld = new Set();
    if (!Number.isInteger(count) || count < 0 || count > 256) return [];
    for (let index = 0; index < count; index++) {
      if (!Object.hasOwn(excluded, index)) return [];
      const reference = excluded[index];
      if (!identity(reference)) return [];
      withheld.add(reference);
    }
    const candidates = admittedCandidates(q, { maxEvents }).filter(e => !Object.hasOwn(e, "instanceRoute"));
    const ordered = order === "recency" ? candidates : orderCandidates(candidates, tags);
    const refs = [];
    const seen = new Set();
    for (const event of ordered) {
      if (!identity(event.id) || seen.has(event.id) || withheld.has(event.id)) continue;
      seen.add(event.id);
      refs.push(event.id);
      if (refs.length === maxEvents) break;
    }
    return refs;
  } catch { return []; }
}

/**
 * Recall a bounded, recency-ordered digest of OTHER teams' events in this company.
 * Filter + priority: same company; exclude the seat's own topology (unless includeSelf);
 * tagged-relevance first, then recency fill; packed to the S1 budget with per-event
 * truncation. Never throws.
 *
 * @param {object} q
 * @param {string} q.company             — the company/run grouping key (sessionId today)
 * @param {string} [q.excludeTopologyId] — the recalling seat's own topology
 * @param {string[]} [q.tags]            — the seat's interest tags (fast-path)
 * @param {object} q.budget              — computeAwarenessBudget(seatModel) result
 * @param {boolean} [q.includeSelf]
 * @returns {AwarenessEvent[]}           — packed, newest-first within priority
 */
export function recall(q = {}) {
  try {
    const { tags = [] } = q;
    const budget = q.budget || { maxEvents: 1, maxTokens: AWARENESS_BUDGET.floorTokens, perEventTokenCeiling: AWARENESS_BUDGET.perEventTokenCeiling };
    // Pull a candidate window larger than the event cap so priority ordering has room.
    const candidates = admittedCandidates(q, budget).filter(e => !Object.hasOwn(e, "instanceRoute"));

    const ordered = orderCandidates(candidates, tags);

    // Pack to budget with per-event truncation.
    const ceilChars = budget.perEventTokenCeiling * 4;
    const out = [];
    let runningTokens = 0;
    for (const e of ordered) {
      if (out.length >= budget.maxEvents) break;
      let summary = e.summary || "";
      if (estTokens(summary) > budget.perEventTokenCeiling) summary = summary.slice(0, ceilChars - 1) + "…";
      const t = estTokens(summary);
      if (runningTokens + t > budget.maxTokens && out.length > 0) break;
      out.push({ ...e, summary });
      runningTokens += t;
    }
    return out;
  } catch {
    return [];
  }
}

/** Render recalled events as the [Cross-Team Awareness] frame block (null when empty). */
export function renderAwarenessBlock(events, { truncatedCount = 0 } = {}) {
  if (!events || events.length === 0) return null;
  const lines = events.map((e) => {
    const who = [e.topologyId, e.seatId].filter(Boolean).join("/") || "team";
    return `- ${who} (${e.kind}): ${e.summary}`;
  });
  if (truncatedCount > 0) lines.push(`…(+${truncatedCount} more, oldest dropped first)`);
  return `[Cross-Team Awareness]\nWhat other teams in this company have done recently (newest first):\n${lines.join("\n")}`;
}

/** Convenience: recall + render in one call, for the dispatch frame. Null when no awareness. */
export function recallBlock(q = {}) {
  const events = recall(q);
  if (events.length === 0) return null;
  // Count how many same-company siblings exist beyond what fit, for the trailer.
  let totalSiblings = 0;
  try {
    totalSiblings = admittedCandidates(q, q.budget || { maxEvents: 1 }).filter(e => !Object.hasOwn(e, "instanceRoute")).length;
  } catch { /* ignore */ }
  const truncatedCount = Math.max(0, totalSiblings - events.length);
  return renderAwarenessBlock(events, { truncatedCount });
}

/** Test/lifecycle helper: drop all events and federation. */
export function reset() {
  _adapter = createInMemoryRingAdapter();
  _federation = null;
  _seq = 0;
}

export default {
  setAdapter, getAdapter, registerFederation,
  publish, publishInstanceReference, recallInstanceReferences, recall, recallReferences, renderAwarenessBlock, recallBlock, reset,
};
