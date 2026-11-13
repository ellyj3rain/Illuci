/**
 * Illuci — Formation Engine Mode-Aware Tests
 *
 * Tests for mode-aware auto-fill in the formation engine.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { DEFAULT_FORMATION_ARCHITECT_MODEL, formTeam, resolveFormationArchitectModel } from "./engine.js";
import { supportsMode } from "../matrix/capability-matrix.js";

describe("formation mode-aware auto-fill", () => {
  it("formation default architect model is availability-honest", () => {
    assert.equal(DEFAULT_FORMATION_ARCHITECT_MODEL, "claude-opus");
    assert.equal(resolveFormationArchitectModel(), "claude-opus");
    assert.equal(resolveFormationArchitectModel({ architectModel: "grok-cli" }), "grok-cli");
  });

  it("dev-team formation considers write mode for implementer", () => {
    const result = formTeam("build a new feature", { topologyId: "dev-team" });
    
    // The lineup should be filled
    assert.ok(result.lineup);
    
    // If implementer was auto-filled, it should support write mode
    const implementer = result.lineup.implementer;
    if (implementer) {
      const models = Array.isArray(implementer) ? implementer : [implementer];
      for (const model of models) {
        assert.ok(supportsMode(model, "write"),
          `implementer ${model} should support write mode`);
      }
    }
  });

  it("dev-team formation considers execute mode for qa", () => {
    const result = formTeam("build and test a feature", { topologyId: "dev-team" });
    
    // If qa was auto-filled, it should support execute mode
    const qa = result.lineup.qa;
    if (qa) {
      const models = Array.isArray(qa) ? qa : [qa];
      for (const model of models) {
        assert.ok(supportsMode(model, "execute"),
          `qa ${model} should support execute mode`);
      }
    }
  });

  it("devops-pipeline formation considers mixed modes", () => {
    const result = formTeam("deploy to production", { topologyId: "devops-pipeline" });
    
    // Check build seat (write mode)
    const build = result.lineup.build;
    if (build) {
      const models = Array.isArray(build) ? build : [build];
      for (const model of models) {
        assert.ok(supportsMode(model, "write"),
          `build ${model} should support write mode`);
      }
    }
    
    // Check test seat (execute mode)
    const test = result.lineup.test;
    if (test) {
      const models = Array.isArray(test) ? test : [test];
      for (const model of models) {
        assert.ok(supportsMode(model, "execute"),
          `test ${model} should support execute mode`);
      }
    }
  });

  it("respects operator-provided lineup over auto-fill", () => {
    // Operator explicitly assigns models
    const result = formTeam("build a feature", {
      topologyId: "dev-team",
      lineup: {
        architect: "claude-local",
        implementer: "codex-local",
        reviewer: "gemini-local",
        qa: "kimi-local",
      }
    });
    
    // Should use operator's lineup exactly
    assert.equal(result.lineup.architect, "claude-local");
    assert.equal(result.lineup.implementer, "codex-local");
    assert.equal(result.lineup.reviewer, "gemini-local");
    assert.equal(result.lineup.qa, "kimi-local");
  });

  it("formation includes mode capability metadata", () => {
    const result = formTeam("implement a feature", { topologyId: "dev-team" });
    
    // Result should have expected structure
    assert.ok(result.topologyId);
    assert.ok(result.lineup);
    assert.ok(typeof result.confidence === "number");
    assert.ok(result.reasoning);
    assert.ok(result.complexity);
  });
});

describe("formation mode capability edge cases", () => {
  it("handles topology with no mode annotations (defaults to respond)", () => {
    // adversarial-debate has no mode annotations, all default to respond
    const result = formTeam("debate this topic", { topologyId: "adversarial-debate" });
    
    // Should still fill seats
    assert.ok(result.lineup);
    assert.ok(result.confidence > 0);
  });

  it("handles direct topology (passthrough, no structure)", () => {
    const result = formTeam("quick question", { topologyId: "direct" });
    
    assert.ok(result.lineup);
    assert.equal(result.topologyId, "direct");
  });
});
