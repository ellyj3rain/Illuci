// Phase 7 — operator surface lane: the thin renderer.
//
// renderLiveState(liveState) -> string: a minimal, dependency-free TUI/CLI view of a
// LiveState (the output of state.buildLiveState). NO ansi lib, NO blessed/ink — keeping
// the lane self-contained and back-compat-trivial. A redraw loop is the caller's choice
// (setInterval over console.getLiveState()); this function is a pure string formatter.
//
// renderJson(liveState) -> object: the same structured snapshot, passed through unchanged
// (a deep copy), for a JSON/headless consumer that wants the data not the text view.
//
// READ-ONLY on every existing module: imports nothing. Pure formatting of a plain object.

function safe(s, fallback = "—") {
  if (s == null || s === "") return fallback;
  return String(s);
}

function statusGlyph(status) {
  switch (status) {
    case "running": return "▶";
    case "complete": return "✔";
    case "halted": return "■";
    case "aborted": return "✗";
    case "error": return "✗";
    default: return "·";
  }
}

function clip(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

/**
 * Render the live operator view as a plain multi-line string.
 *
 * Sections: header (session + counters), per-team status lines, an ASCII topology tree
 * (from liveState.nodes when present), gate/budget banners, and the most recent
 * cross-team awareness lines. Every section degrades gracefully when its data is empty.
 *
 * @param {LiveState} liveState
 * @returns {string}
 */
export function renderLiveState(liveState) {
  const s = liveState || {};
  const L = [];

  // ── Header ──
  const sid = safe(s.sessionId, "(no session)");
  const tree = s.tree || {};
  L.push(`╔══ illuci operator ══ ${sid}`);
  L.push(
    `║ events ${safe(s.eventCount, 0)}  ` +
    `active ${safe(tree.activeCount, 0)}  ` +
    `children ${safe(tree.totalChildren, 0)}  ` +
    `nodes ${safe(tree.nodeCount, 0)}`,
  );
  const ph = s.phases || {};
  L.push(`║ phases ${safe(ph.started, 0)} started / ${safe(ph.complete, 0)} complete`);

  // ── Per-team status lines ──
  const teams = Array.isArray(s.teams) ? s.teams : [];
  if (teams.length === 0) {
    L.push("║");
    L.push("║ (no teams yet)");
  } else {
    L.push("║");
    L.push("║ Teams:");
    for (const t of teams) {
      const name = safe(t.topologyName || t.topologyId, "?");
      const last = t.lastMessage ? `  “${clip(t.lastMessage, 48)}”` : "";
      const err = t.error ? `  ! ${clip(t.error, 40)}` : "";
      L.push(`║  ${statusGlyph(t.status)} ${name}  [${safe(t.status)}]  ${safe(t.tokens, 0)}tok${last}${err}`);
    }
  }

  // ── ASCII topology tree ──
  const nodes = Array.isArray(s.nodes) ? s.nodes : [];
  if (nodes.length > 0) {
    L.push("║");
    L.push("║ Topology tree:");
    for (const line of renderTreeLines(nodes)) L.push(`║  ${line}`);
  }

  // ── Gate banner ──
  const gates = Array.isArray(s.gates) ? s.gates : [];
  if (gates.length > 0) {
    L.push("║");
    const last = gates[gates.length - 1];
    L.push(`║ ⏸ GATE HALT — phase ${safe(last.phaseId)}: ${safe(last.reason)} (${gates.length} total)`);
  }

  // ── Budget banner ──
  if (s.budget) {
    const b = s.budget;
    const spent = b.spent ?? b.used ?? null;
    const limit = b.limit ?? b.budget ?? b.max ?? null;
    if (spent != null || limit != null) {
      L.push(`║ ⛽ budget ${safe(spent, "?")}${limit != null ? " / " + limit : ""}`);
    } else {
      L.push(`║ ⛽ budget ${clip(JSON.stringify(b), 60)}`);
    }
  }

  // ── Cross-team awareness (newest first) ──
  const aware = Array.isArray(s.awareness) ? s.awareness : [];
  if (aware.length > 0) {
    L.push("║");
    L.push("║ Cross-team awareness (newest first):");
    for (const e of aware.slice(0, 6)) {
      const who = [e.topologyId, e.seatId].filter(Boolean).join("/") || "team";
      L.push(`║  - ${who} (${safe(e.kind, "?")}): ${clip(e.summary, 56)}`);
    }
  }

  L.push("╚════");
  return L.join("\n");
}

/**
 * Build an ASCII tree from a flat node array (each { runId, parentRunId, topologyId,
 * active, childRunIds? }). Roots are parentRunId == null. Defensive against cycles and
 * orphans (an orphan whose parent is missing is rendered at the root level).
 *
 * @param {Array} nodes
 * @returns {string[]} lines (no leading frame; the caller prefixes)
 */
export function renderTreeLines(nodes) {
  const byId = new Map();
  for (const n of nodes) if (n && n.runId != null) byId.set(n.runId, n);

  const childrenOf = new Map();
  const roots = [];
  for (const n of nodes) {
    if (!n || n.runId == null) continue;
    const parent = n.parentRunId;
    if (parent != null && byId.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(n.runId);
    } else {
      roots.push(n.runId); // root, or orphan promoted to root
    }
  }

  const lines = [];
  const seen = new Set(); // cycle guard
  function walk(runId, prefix, isLast) {
    if (seen.has(runId)) {
      lines.push(`${prefix}${isLast ? "└─ " : "├─ "}${clip(runId, 40)} (cycle)`);
      return;
    }
    seen.add(runId);
    const n = byId.get(runId) || { runId };
    const label = `${safe(n.topologyId, "?")} · ${clip(runId, 28)}${n.active === false ? " (done)" : ""}`;
    lines.push(`${prefix}${isLast ? "└─ " : "├─ "}${label}`);
    const kids = childrenOf.get(runId) || [];
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    kids.forEach((k, i) => walk(k, childPrefix, i === kids.length - 1));
  }
  roots.forEach((r, i) => walk(r, "", i === roots.length - 1));
  // A pure cycle (every node has an in-graph parent, so no node is a root) leaves nodes
  // unvisited. Render the remainder as fallback roots so nothing is silently dropped; the
  // `seen` guard then flags the back-edge as (cycle) rather than looping forever.
  const remaining = [];
  for (const id of byId.keys()) if (!seen.has(id)) remaining.push(id);
  remaining.forEach((r, i) => walk(r, "", i === remaining.length - 1));
  return lines;
}

/**
 * Structured passthrough — the same LiveState as a JSON-serializable object (deep copy).
 * For a headless consumer (MC feed, an HTTP renderer) that wants the data, not the text.
 *
 * @param {LiveState} liveState
 * @returns {object}
 */
export function renderJson(liveState) {
  if (liveState == null) return {};
  try {
    return JSON.parse(JSON.stringify(liveState));
  } catch {
    return { ...liveState };
  }
}

export default { renderLiveState, renderTreeLines, renderJson };
