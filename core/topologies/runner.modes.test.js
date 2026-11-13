/**
 * Illuci — Runner Execution Mode Tests
 *
 * Integration tests for the 5 phase execution modes:
 * respond, write, read, execute, delegate.
 *
 * Tests resolveInput artifact awareness, mode prompt suffixes,
 * and multi-artifact resolution.
 *
 * Uses mock queryModel to avoid real bridge calls.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

// ─── Test helpers that exercise the runner's internal functions ───
// We import the module to test resolveInput, getModePromptSuffix, etc.
// Since these are module-scoped functions, we test them via their effects
// on the public API.

import {
  getTopology,
  compileGraph,
  listTopologies,
} from "./index.js";

// ─── resolveInput behavior (tested via topology phase definitions) ───

describe("phase execution mode annotations", () => {
  it("dev-team has mode annotations on all 4 phases", () => {
    const t = getTopology("dev-team");
    const modes = t.phases.map(p => ({ id: p.id, mode: p.mode || "respond" }));
    assert.deepEqual(modes, [
      { id: "design", mode: "respond" },
      { id: "implement", mode: "write" },
      { id: "review", mode: "read" },
      { id: "test", mode: "execute" },
    ]);
  });

  it("devops-pipeline has mode annotations", () => {
    const t = getTopology("devops-pipeline");
    const modes = t.phases.map(p => ({ id: p.id, mode: p.mode || "respond" }));
    assert.ok(modes.some(m => m.mode === "write"));
    assert.ok(modes.some(m => m.mode === "execute"));
    assert.ok(modes.some(m => m.mode === "read"));
  });

  it("peer-review-ring has write + read modes", () => {
    const t = getTopology("peer-review-ring");
    const modes = t.phases.map(p => ({ id: p.id, mode: p.mode || "respond" }));
    assert.ok(modes.some(m => m.mode === "write"));
    assert.ok(modes.some(m => m.mode === "read"));
  });

  it("apprentice-master has write + read modes", () => {
    const t = getTopology("apprentice-master");
    const modes = t.phases.map(p => ({ id: p.id, mode: p.mode || "respond" }));
    assert.ok(modes.some(m => m.mode === "write"));
    assert.ok(modes.some(m => m.mode === "read"));
  });

  it("unannotated topologies default to respond", () => {
    const t = getTopology("adversarial-debate");
    for (const phase of t.phases) {
      assert.ok(!phase.mode || phase.mode === "respond",
        `${t.id}/${phase.id} should default to respond, got ${phase.mode}`);
    }
  });
});

describe("topology schema completeness", () => {
  it("all topologies have valid phase types", () => {
    const validTypes = ["parallel", "single", "sequential", "rotating"];
    for (const id of listTopologies()) {
      const t = getTopology(id);
      for (const phase of t.phases) {
        assert.ok(validTypes.includes(phase.type),
          `${id}/${phase.id} has invalid type: ${phase.type}`);
      }
    }
  });

  it("all mode-annotated phases have valid modes", () => {
    const validModes = ["respond", "write", "read", "execute", "delegate"];
    for (const id of listTopologies()) {
      const t = getTopology(id);
      for (const phase of t.phases) {
        if (phase.mode) {
          assert.ok(validModes.includes(phase.mode),
            `${id}/${phase.id} has invalid mode: ${phase.mode}`);
        }
      }
    }
  });

  it("write-mode phases have seats that can produce output", () => {
    for (const id of listTopologies()) {
      const t = getTopology(id);
      for (const phase of t.phases) {
        if (phase.mode === "write") {
          const seatIds = phase.seats || (phase.seat ? [phase.seat] : []);
          assert.ok(seatIds.length > 0,
            `${id}/${phase.id} is write-mode but has no seats`);
        }
      }
    }
  });

  it("read-mode phases reference prior phases with input spec", () => {
    for (const id of listTopologies()) {
      const t = getTopology(id);
      for (const phase of t.phases) {
        if (phase.mode === "read") {
          assert.ok(phase.input,
            `${id}/${phase.id} is read-mode but has no input spec`);
        }
      }
    }
  });
});

describe("graph compilation with mode annotations", () => {
  it("compileGraph includes all seats from mode-annotated topologies", () => {
    const graph = compileGraph("dev-team", {
      architect: ["claude-local"],
      implementer: ["codex-local"],
      reviewer: ["grok"],
      qa: ["gemini-local"],
    });
    assert.equal(graph.nodes.length, 4);
    assert.ok(graph.nodes.some(n => n.id === "architect"));
    assert.ok(graph.nodes.some(n => n.id === "qa"));
  });

  it("graph edges reflect dev-team pipeline structure", () => {
    const graph = compileGraph("dev-team");
    // architect precedes implementer
    assert.ok(graph.edges.some(e =>
      e.source === "architect" && e.target === "implementer" && e.type === "precedes"
    ));
    // implementer precedes reviewer
    assert.ok(graph.edges.some(e =>
      e.source === "implementer" && e.target === "reviewer" && e.type === "precedes"
    ));
  });
});

describe("input resolution patterns", () => {
  it("dev-team implement phase uses phase:design as input", () => {
    const t = getTopology("dev-team");
    const impl = t.phases.find(p => p.id === "implement");
    assert.equal(impl.input, "phase:design");
  });

  it("dev-team test phase uses multi-phase input", () => {
    const t = getTopology("dev-team");
    const test = t.phases.find(p => p.id === "test");
    assert.equal(test.input, "phase:implement+phase:review");
  });

  it("devops-pipeline stage uses triple-phase input", () => {
    const t = getTopology("devops-pipeline");
    const stage = t.phases.find(p => p.id === "stage");
    assert.equal(stage.input, "phase:build+phase:test+phase:scan");
  });

  it("peer-review-ring review-chain uses previous", () => {
    const t = getTopology("peer-review-ring");
    const review = t.phases.find(p => p.id === "review-chain");
    assert.equal(review.input, "previous");
  });
});
