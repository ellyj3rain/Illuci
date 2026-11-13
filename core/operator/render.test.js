/**
 * Phase 7 — operator surface lane: the dependency-free renderer.
 * Hermetic: plain LiveState objects in, strings out. node:test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLiveState, renderTreeLines, renderJson } from "./render.js";

function liveState(over = {}) {
  return {
    sessionId: "company-1",
    eventCount: 5,
    lastEventTs: 1.2,
    teams: [
      { topologyId: "dev-team", topologyName: "Dev Team", status: "running", lastMessage: "drafting the api", tokens: 120, error: null, phasesComplete: 1 },
      { topologyId: "research-swarm", topologyName: null, status: "complete", lastMessage: null, tokens: 80, error: null, phasesComplete: 2 },
    ],
    phases: { started: 3, complete: 2 },
    gates: [],
    budget: null,
    lastMessage: { agent: "a:claude", content: "drafting the api", tokens: 12 },
    tree: { sessionId: "company-1", activeCount: 1, totalChildren: 2, nodeCount: 3 },
    nodes: [
      { runId: "dev-team-1", parentRunId: null, topologyId: "dev-team", active: true, childRunIds: ["res-2"] },
      { runId: "res-2", parentRunId: "dev-team-1", topologyId: "research-swarm", active: false, childRunIds: [] },
    ],
    awareness: [
      { id: "aw-1", company: "company-1", topologyId: "dev-team", seatId: "lead", kind: "dispatch.out", summary: "scanned the repo layout" },
    ],
    ...over,
  };
}

test("renderLiveState produces a non-empty multi-line string with the key sections", () => {
  const out = renderLiveState(liveState());
  assert.equal(typeof out, "string");
  assert.ok(out.includes("illuci operator"));
  assert.ok(out.includes("company-1"));
  assert.ok(out.includes("Teams:"));
  assert.ok(out.includes("Dev Team"));
  assert.ok(out.includes("research-swarm"));       // falls back to topologyId when no name
  assert.ok(out.includes("Topology tree:"));
  assert.ok(out.includes("Cross-team awareness"));
  assert.ok(out.includes("scanned the repo layout"));
});

test("renderLiveState shows the gate + budget banners when present", () => {
  const out = renderLiveState(liveState({
    gates: [{ phaseId: "p2", reason: "operator review", ts: 3.5 }],
    budget: { spent: 500, limit: 1000 },
  }));
  assert.ok(/GATE HALT/.test(out));
  assert.ok(out.includes("operator review"));
  assert.ok(/budget 500 \/ 1000/.test(out));
});

test("renderLiveState degrades gracefully on an empty / undefined state", () => {
  assert.ok(renderLiveState({}).includes("(no teams yet)"));
  assert.ok(typeof renderLiveState(undefined) === "string");
  assert.ok(renderLiveState(undefined).includes("(no session)"));
});

test("renderTreeLines builds a parent→child ASCII tree and marks done nodes", () => {
  const lines = renderTreeLines([
    { runId: "root", parentRunId: null, topologyId: "dev-team", active: true },
    { runId: "child-a", parentRunId: "root", topologyId: "research-swarm", active: false },
    { runId: "child-b", parentRunId: "root", topologyId: "adversarial-debate", active: true },
  ]);
  const joined = lines.join("\n");
  assert.ok(joined.includes("dev-team"));
  assert.ok(joined.includes("research-swarm"));
  assert.ok(/└─|├─/.test(joined), "uses tree-branch glyphs");
  assert.ok(joined.includes("(done)"), "inactive node marked done");
});

test("renderTreeLines is cycle-safe and promotes orphans to roots", () => {
  // a node whose parent is missing → promoted to root, not dropped
  const lines = renderTreeLines([
    { runId: "orphan", parentRunId: "ghost", topologyId: "t", active: true },
  ]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("orphan"));

  // a direct cycle does not infinite-loop
  const cyc = renderTreeLines([
    { runId: "a", parentRunId: "b", topologyId: "t", active: true },
    { runId: "b", parentRunId: "a", topologyId: "t", active: true },
  ]);
  assert.ok(cyc.length >= 1);
  assert.ok(cyc.join("\n").includes("cycle"));
});

test("renderJson is a deep-copy passthrough", () => {
  const ls = liveState();
  const json = renderJson(ls);
  assert.deepEqual(json, ls);
  json.teams[0].status = "mutated";
  assert.equal(ls.teams[0].status, "running", "deep copy — original untouched");
  assert.deepEqual(renderJson(null), {});
});
