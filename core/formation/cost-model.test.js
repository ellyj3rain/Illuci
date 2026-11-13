/**
 * Illuci — Cost Model Tests
 *
 * Validates cost-based topology ranking and R10 tie-breaking
 * in the formation engine.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { calculateTopologyCost, compareTopologiesByCost } from "./cost-model.js";
import { formTeam, inferComplexity } from "./engine.js";

// ─── Cost Calculation ───

describe("calculateTopologyCost", () => {
  it("direct topology is cheapest (1 seat, 1 phase)", () => {
    const cost = calculateTopologyCost("direct", "simple question");
    assert.ok(cost > 0);
    assert.ok(cost < 20); // 7 max seats * 1 phase * 0.8 complexity
  });

  it("dev-team costs more than direct", () => {
    const directCost = calculateTopologyCost("direct", "build auth");
    const devTeamCost = calculateTopologyCost("dev-team", "build auth");
    assert.ok(devTeamCost > directCost);
  });

  it("mob-sit-down is expensive (many seats, many phases)", () => {
    const cost = calculateTopologyCost("mob-sit-down", "evaluate the team");
    assert.ok(cost > 50); // 20+ seats * 7 phases
  });

  it("complexity factor affects cost", () => {
    const lowCost = calculateTopologyCost("dev-team", "simple quick fix");
    const highCost = calculateTopologyCost("dev-team", "critical security architecture refactor");
    assert.ok(highCost > lowCost);
  });
});

// ─── Comparison ───

describe("compareTopologiesByCost", () => {
  it("returns negative when first is cheaper", () => {
    const result = compareTopologiesByCost("direct", "mob-sit-down", "test");
    assert.ok(result < 0);
  });

  it("returns positive when first is more expensive", () => {
    const result = compareTopologiesByCost("mob-sit-down", "direct", "test");
    assert.ok(result > 0);
  });
});

// ─── R10: Formation Engine Cost Tie-Breaking ───

describe("formTeam cost integration", () => {
  it("returns estimatedCost in formation result", () => {
    const result = formTeam("build a feature");
    assert.ok(typeof result.estimatedCost === "number");
    assert.ok(result.estimatedCost > 0);
  });

  it("breaks ties by cost when keyword scores are equal", () => {
    // "consensus equal" matches both commune and co-operative
    const result = formTeam("consensus equal democratic collective");
    // Both should match, but the cheaper one should win
    assert.ok(result.scores.length >= 2);
    if (result.scores.length >= 2 && result.scores[0].score === result.scores[1].score) {
      const cost0 = calculateTopologyCost(result.scores[0].id, "consensus equal democratic collective");
      const cost1 = calculateTopologyCost(result.scores[1].id, "consensus equal democratic collective");
      assert.ok(cost0 <= cost1, "First result should be cheaper or equal when scores tie");
    }
  });

  it("operator override ignores cost ranking", () => {
    const result = formTeam("anything", { topologyId: "mob-sit-down" });
    assert.equal(result.topologyId, "mob-sit-down");
    assert.equal(result.confidence, 1.0);
  });
});

// ─── Complexity Inference ───

describe("inferComplexity", () => {
  it("low for simple tasks", () => {
    assert.equal(inferComplexity("simple quick fix"), "low");
  });

  it("high for critical tasks", () => {
    assert.equal(inferComplexity("critical security architecture audit"), "high");
  });

  it("medium for ambiguous tasks", () => {
    assert.equal(inferComplexity("refactor the authentication module to use JWT tokens"), "medium");
  });
});
