/**
 * Phase 0 — per-run context isolation (concurrency safety).
 *
 * Before this fix, emitter.js held run state (runId, sessionId, projectId, clock)
 * in module globals: two concurrent topology runs clobbered one another's run_id,
 * and one run completing nulled the global mid-flight for any still-running run.
 * These tests pin the isolation the AsyncLocalStorage scope now guarantees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runWithContext,
  runStore,
  nextRunId,
  onEvent,
  clearListeners,
  emitTopologyStart,
  emitPhaseStart,
} from "./emitter.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("concurrent run scopes keep distinct run_ids across interleaved awaits", async () => {
  const seen = {};
  await Promise.all([
    runWithContext({ runId: "run-A" }, async () => {
      await delay(15);
      seen.A = runStore.getStore().runId;
    }),
    runWithContext({ runId: "run-B" }, async () => {
      await delay(5);
      seen.B1 = runStore.getStore().runId;
      await delay(15);
      seen.B2 = runStore.getStore().runId; // still B after A's scope has resolved
    }),
  ]);
  assert.equal(seen.A, "run-A");
  assert.equal(seen.B1, "run-B");
  assert.equal(seen.B2, "run-B");
});

test("a sibling run completing does not null another run's context", async () => {
  // Pre-fix: the fast run's emitTopologyComplete set the global runId to null,
  // so the slow run's later events were attributed to run_id=null.
  let slowMid = "unset";
  await Promise.all([
    runWithContext({ runId: "fast" }, async () => {
      /* resolves immediately, ending its scope */
    }),
    runWithContext({ runId: "slow" }, async () => {
      await delay(20);
      slowMid = runStore.getStore().runId;
    }),
  ]);
  assert.equal(slowMid, "slow");
});

test("startTime (the elapsed clock) is isolated per run scope", async () => {
  const aStart = await runWithContext({ runId: "a" }, async () => {
    const t0 = runStore.getStore().startTime;
    await delay(10);
    return t0;
  });
  const bStart = await runWithContext({ runId: "b" }, async () => runStore.getStore().startTime);
  assert.equal(typeof aStart, "number");
  assert.ok(aStart > 0, "a scope got a real startTime");
  assert.ok(bStart >= aStart, "b scope got its own, later startTime — clocks are not shared");
});

test("emitted events carry the run's own sessionId under concurrent runs", async () => {
  const mainBySession = {};
  const unsub = onEvent((e) => {
    if (e.type === "agent_spawn" && e.payload?.isMain) mainBySession[e.sessionId] = e.payload.name;
  });
  await Promise.all([
    runWithContext({ runId: nextRunId("t"), sessionId: "sA" }, () =>
      emitTopologyStart("dev-team", "Team A", { lead: ["m"] }, "task A", "sA", null, null),
    ),
    runWithContext({ runId: nextRunId("t"), sessionId: "sB" }, () =>
      emitTopologyStart("dev-team", "Team B", { lead: ["m"] }, "task B", "sB", null, null),
    ),
  ]);
  unsub();
  clearListeners();
  assert.equal(mainBySession.sA, "Team A");
  assert.equal(mainBySession.sB, "Team B");
});

test("nextRunId is collision-free within a single synchronous tick", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(nextRunId("topo"));
  assert.equal(ids.size, 1000);
});

test("emitting outside any run scope falls back safely (no throw)", () => {
  // Pipeline-level and direct callers run outside a topology scope.
  assert.equal(runStore.getStore(), undefined);
  // Should not throw; emits with the fallback (unscoped) context.
  assert.doesNotThrow(() => {
    const unsub = onEvent(() => {});
    unsub();
  });
});

test("unscoped emits are marked with a sentinel, never a real topology name", () => {
  // Adversarial-debate council finding: a "illuci" fallback made out-of-scope events
  // (pipeline-level, direct callers) masquerade as a real topology named "illuci".
  const events = [];
  const unsub = onEvent((e) => events.push(e));
  emitPhaseStart("p1", "parallel", ["a"], "sess-x"); // no run scope
  unsub();
  clearListeners();
  const tc = events.find((e) => e.type === "tool_call_start");
  assert.ok(tc, "tool_call_start emitted");
  assert.notEqual(tc.payload.agent, "illuci");
  assert.equal(tc.payload.agent, "__unscoped__");
});
