/**
 * illuci — [A96]/DR-189: the seat/member budget cascade, proven through the public
 * run seam (vitest, hermetic — same choke-point mock as runner.genome-run-seam).
 *
 *  - Observation: trace.seatBudget is ALWAYS present; per-seat spend is charged
 *    from each response's usage even with no cascade configured (enforced:false).
 *  - Enforcement + typed traces: an armed cascade records seat_budget_exhausted
 *    in the arrangement when a seat crosses its cap.
 *  - Byte-identical control: an UNCONFIGURED run's control-bearing trace fields
 *    (halted, haltReason, arrangement event types, phase outputs) equal a
 *    no-stanza run's — the cascade's presence changes nothing until configured.
 *
 * Run: npx vitest run core/topologies/runner.budget-cascade.test.js
 */

import { describe, it, beforeAll, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ILLUCI_HOME ||= join(process.cwd(), ".tmp", "illuci-test-home");
process.env.ILLUCI_DATA_HOME ||= join(process.cwd(), ".tmp", "illuci-test-data");
process.env.ILLUCI_GATE_MODE ||= "headless";
process.env.ILLUCI_DRL_ENABLED ||= "0";
const CONTEXT_DB_DIR = mkdtempSync(join(tmpdir(), "illuci-a96-telemetry-"));
process.env.ILLUCI_CONTEXT_DB = join(CONTEXT_DB_DIR, "context.db");

// Deterministic 30-token answers at the ONE dispatch choke-point.
vi.mock("../dispatch/dispatch.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    queryModel: async (model) => ({
      model,
      response: `[a96:${model}] deterministic answer for the budget-cascade proof.`,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      latency: 1,
    }),
  };
});

let runTopology;
let getTopology;
let MODEL_POOL;

beforeAll(async () => {
  ({ runTopology } = await import("./runner.js"));
  ({ getTopology } = await import("./index.js"));
  const { MODELS } = await import("../matrix/capability-matrix.js");
  MODEL_POOL = [...MODELS].sort();
});

function lineupFor(topology) {
  const lineup = {};
  let slot = 0;
  for (const seat of topology.seats || []) {
    const count = Math.min(Math.max(seat.min || 0, 1), seat.max ?? Infinity);
    lineup[seat.id] = Array.from({ length: count }, () => MODEL_POOL[slot++ % MODEL_POOL.length]);
  }
  return lineup;
}

const BASE_RC = { agenda: { strategy: "ritual" }, execution: { mutationAuthority: "blocked" }, tools: { autonomy: "directed" } };
const controlShape = (t) => ({
  halted: t.halted ?? null,
  haltReason: t.haltReason ?? null,
  events: (t.arrangement || []).map((e) => e.type),
  phaseOutputs: Object.fromEntries(Object.entries(t.phases || {}).map(([k, p]) => [k, (p.responses || []).length])),
});

describe("A96/DR-189 — the budget cascade run seam", () => {
  it("observation: trace.seatBudget is present and per-seat spend is charged, cascade OFF", async () => {
    const topology = getTopology("adversarial-debate") || getTopology("dev-team");
    const t = await runTopology(topology.id, lineupFor(topology), "budget observation proof.", { runControl: BASE_RC, projectId: null }, "a96-obs-1");
    assert.ok(!t.halted, "run completes");
    assert.ok(t.seatBudget, "trace.seatBudget exists");
    assert.equal(t.seatBudget.enforced, false, "off → not enforced");
    const seats = Object.keys(t.seatBudget.seats);
    assert.ok(seats.length >= 1, "at least one seat observed");
    const totalSeatSpend = Object.values(t.seatBudget.seats).reduce((s, x) => s + x.spent, 0);
    assert.ok(totalSeatSpend > 0, "per-seat spend was charged from usage");
    assert.equal(totalSeatSpend, t.seatBudget.memberSpent, "member spend == sum of seat spend");
  });

  it("byte-identical control: unconfigured cascade == no-stanza on all control-bearing fields", async () => {
    const topology = getTopology("adversarial-debate") || getTopology("dev-team");
    const lineup = lineupFor(topology);
    const noStanza = await runTopology(topology.id, lineup, "identical-A.", { runControl: BASE_RC, projectId: null }, "a96-idA");
    const withCode = await runTopology(topology.id, lineup, "identical-A.", { runControl: { ...BASE_RC, budget: null }, projectId: null }, "a96-idB");
    assert.deepEqual(controlShape(withCode), controlShape(noStanza), "cascade code present-but-off changes no control-bearing trace field");
  });

  it("enforcement: an armed seat cap records a typed seat_budget_exhausted trace", async () => {
    const topology = getTopology("adversarial-debate") || getTopology("dev-team");
    const lineup = lineupFor(topology);
    const seatId = topology.seats[0].id; // fires in phase 1
    // Each response is 30 tokens; a 10-token seat cap is crossed on the first charge.
    const rc = { ...BASE_RC, budget: { seats: { [seatId]: { cap: 10 } } } };
    const t = await runTopology(topology.id, lineup, "enforcement proof.", { runControl: rc, projectId: null }, "a96-enf-1");
    assert.equal(t.seatBudget.enforced, true, "armed → enforced");
    const exhaustEvents = (t.arrangement || []).filter((e) => e.type === "seat_budget_exhausted" && e.seat === seatId);
    assert.ok(exhaustEvents.length >= 1, "the over-cap seat recorded a typed exhaustion trace");
    assert.ok(t.seatBudget.seats[seatId].spent >= 30, "the seat was still charged its actual spend (observation honest)");
  });
});
