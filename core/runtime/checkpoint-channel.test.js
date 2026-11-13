// node:test — [A43] the checkpoint-decision channel: request out (event),
// decision in (resolves the port), timeout fails CLOSED to abort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCheckpointChannel, CHECKPOINT_ACTIONS } from "./checkpoint-channel.js";

test("request → event; decision → the port resolves with it (proceed/redirect verbatim)", async () => {
  const events = [];
  const ch = createCheckpointChannel({ emit: (e) => events.push(e) });
  const pending = ch.port({ step: { id: "implement", type: "authoring", seats: ["implementer"] }, firingMode: "semi", mandate: "add /health" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "checkpoint-request");
  assert.equal(events[0].stepId, "implement");
  assert.equal(events[0].firingMode, "semi");
  assert.deepEqual(ch.pendingRequests().map((r) => r.stepId), ["implement"]);

  const delivered = ch.resolveDecision(events[0].checkpointId, { action: "redirect", intent: "tighten scope to the route only" });
  assert.deepEqual([delivered.ok, delivered.action], [true, "redirect"]);
  const decision = await pending;
  assert.deepEqual(decision, { action: "redirect", intent: "tighten scope to the route only" });
  assert.equal(ch.pendingRequests().length, 0);
  assert.equal(events.at(-1).type, "checkpoint-decision");
});

test("an unanswered checkpoint FAILS CLOSED: timeout resolves abort (pacing without a pacer never proceeds)", async () => {
  const events = [];
  const ch = createCheckpointChannel({ emit: (e) => events.push(e), timeoutMs: 30 });
  const decision = await ch.port({ step: { id: "risky" }, firingMode: "burst" });
  assert.equal(decision.action, "abort");
  assert.match(decision.intent, /fail-closed/);
  assert.equal(events.at(-1).type, "checkpoint-timeout");
});

test("bad decisions are coded, never thrown: unknown id + invalid action", () => {
  const ch = createCheckpointChannel({ emit: () => {} });
  assert.equal(ch.resolveDecision("nope", { action: "proceed" }).code, "unknown-checkpoint");
  const p = ch.port({ step: { id: "s" } });
  const id = ch.pendingRequests()[0].checkpointId;
  const bad = ch.resolveDecision(id, { action: "detonate" });
  assert.equal(bad.code, "invalid-action");
  assert.deepEqual(bad.allowed, [...CHECKPOINT_ACTIONS]);
  // still pending after the bad attempt; clean up
  assert.equal(ch.resolveDecision(id, { action: "skip" }).ok, true);
  return p;
});
