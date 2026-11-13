/**
 * illuci — Topology Relationship Schema Tests
 *
 * Tests the relationship graph compilation, traversal utilities,
 * and structural correctness of all topology definitions.
 *
 * Validates the design from design/topology-relationships-2026-04-05.md.
 * Edge semantics tags, seat weight, and stability thresholds: Grok contribution (2026-04-05).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  TOPOLOGIES,
  RELATIONSHIP_TYPES,
  compileGraph,
  getChildren,
  getParents,
  getAdversaries,
  getPredecessors,
  getSeatWeight,
  getTopology,
  listTopologies,
} from "./index.js";

// ─── Schema Integrity ───

describe("topology relationship schema", () => {
  const allIds = listTopologies();

  it("every topology has relationshipTypes array", () => {
    for (const id of allIds) {
      const t = getTopology(id);
      assert.ok(Array.isArray(t.relationshipTypes), `${id} missing relationshipTypes`);
    }
  });

  it("every topology has stabilityThreshold (number or null)", () => {
    for (const id of allIds) {
      const t = getTopology(id);
      assert.ok(
        t.stabilityThreshold === null || typeof t.stabilityThreshold === "number",
        `${id} has invalid stabilityThreshold: ${t.stabilityThreshold}`
      );
    }
  });

  it("every seat has weight 0-1", () => {
    for (const id of allIds) {
      const t = getTopology(id);
      for (const seat of t.seats) {
        assert.ok(typeof seat.weight === "number", `${id}/${seat.id} missing weight`);
        assert.ok(seat.weight >= 0 && seat.weight <= 1, `${id}/${seat.id} weight out of range: ${seat.weight}`);
      }
    }
  });

  it("every seat has relationships array", () => {
    for (const id of allIds) {
      const t = getTopology(id);
      for (const seat of t.seats) {
        assert.ok(Array.isArray(seat.relationships), `${id}/${seat.id} missing relationships`);
      }
    }
  });

  it("all relationship types are valid", () => {
    for (const id of allIds) {
      const t = getTopology(id);
      for (const seat of t.seats) {
        for (const rel of seat.relationships) {
          assert.ok(RELATIONSHIP_TYPES.includes(rel.type), `${id}/${seat.id} has invalid relationship type: ${rel.type}`);
          assert.ok(typeof rel.target === "string", `${id}/${seat.id} relationship missing target`);
          assert.ok(typeof rel.semantics === "string", `${id}/${seat.id} relationship missing semantics`);
        }
      }
    }
  });

  it("relationship targets reference valid seat IDs within the same topology", () => {
    for (const id of allIds) {
      const t = getTopology(id);
      const seatIds = t.seats.map(s => s.id);
      for (const seat of t.seats) {
        for (const rel of seat.relationships) {
          assert.ok(seatIds.includes(rel.target), `${id}/${seat.id} references unknown seat: ${rel.target}`);
        }
      }
    }
  });
});

// ─── Graph Compilation ───

describe("compileGraph", () => {
  it("compiles mob-sit-down into a tree layout", () => {
    const graph = compileGraph("mob-sit-down", {
      boss: ["grok"],
      underboss: ["claude-local"],
      consigliere: ["codex-local"],
    });
    assert.equal(graph.layout, "tree");
    assert.equal(graph.topologyId, "mob-sit-down");
    assert.ok(graph.nodes.length >= 6); // boss, underboss, consigliere, capo, soldier, associate
    assert.ok(graph.edges.length > 0);
    assert.deepEqual(graph.removalSemantics, { term: "Whacked", evidence: "Boss approval, consigliere evidence" });
  });

  it("compiles dev-team into a pipeline layout", () => {
    const graph = compileGraph("dev-team");
    assert.equal(graph.layout, "pipeline");
    assert.ok(graph.edges.some(e => e.type === "precedes"));
  });

  it("compiles adversarial-debate into adversarial layout", () => {
    const graph = compileGraph("adversarial-debate");
    assert.equal(graph.layout, "adversarial");
    assert.ok(graph.edges.some(e => e.type === "adversarial-to"));
  });

  it("compiles commune into ring layout", () => {
    const graph = compileGraph("commune");
    assert.equal(graph.layout, "ring");
  });

  it("compiles research-swarm into tree layout (parent-of)", () => {
    const graph = compileGraph("research-swarm");
    assert.equal(graph.layout, "tree");
    assert.ok(graph.edges.some(e => e.type === "integrates-from"));
  });

  it("includes model assignments in nodes", () => {
    const graph = compileGraph("direct", { model: ["grok", "claude-local"] });
    const modelNode = graph.nodes.find(n => n.id === "model");
    assert.deepEqual(modelNode.models, ["grok", "claude-local"]);
  });

  it("flat topology has no edges", () => {
    const graph = compileGraph("direct");
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.layout, "flat");
  });
});

// ─── Traversal Utilities ───

describe("getChildren", () => {
  it("boss has underboss, consigliere, capo as children in mob-sit-down", () => {
    const children = getChildren("mob-sit-down", "boss");
    assert.ok(children.includes("underboss"));
    assert.ok(children.includes("consigliere"));
    assert.ok(children.includes("capo"));
  });

  it("capo has soldier and associate as children", () => {
    const children = getChildren("mob-sit-down", "capo");
    assert.ok(children.includes("soldier"));
    assert.ok(children.includes("associate"));
  });

  it("returns empty for leaf seats", () => {
    const children = getChildren("mob-sit-down", "associate");
    assert.equal(children.length, 0);
  });
});

describe("getParents", () => {
  it("soldier reports to capo in mob-sit-down", () => {
    const parents = getParents("mob-sit-down", "soldier");
    assert.ok(parents.includes("capo"));
  });

  it("boss has no parents", () => {
    const parents = getParents("mob-sit-down", "boss");
    assert.equal(parents.length, 0);
  });
});

describe("getAdversaries", () => {
  it("red team opposes blue team in adversarial-debate", () => {
    const adversaries = getAdversaries("adversarial-debate", "red");
    assert.ok(adversaries.includes("blue"));
  });

  it("prosecutor opposes defender in judiciary", () => {
    const adversaries = getAdversaries("judiciary", "prosecutor");
    assert.ok(adversaries.includes("defender"));
  });
});

describe("getPredecessors", () => {
  it("reviewer follows implementer in dev-team", () => {
    const preds = getPredecessors("dev-team", "reviewer");
    assert.ok(preds.includes("implementer"));
  });

  it("architect has no predecessors in dev-team", () => {
    const preds = getPredecessors("dev-team", "architect");
    assert.equal(preds.length, 0);
  });
});

describe("getSeatWeight", () => {
  it("boss has weight 1.0 in mob-sit-down", () => {
    assert.equal(getSeatWeight("mob-sit-down", "boss"), 1.0);
  });

  it("associate has weight 0.4 in mob-sit-down", () => {
    assert.equal(getSeatWeight("mob-sit-down", "associate"), 0.4);
  });

  it("unknown seat returns 1.0 default", () => {
    assert.equal(getSeatWeight("mob-sit-down", "nonexistent"), 1.0);
  });
});

// ─── Removal Semantics ───

describe("removalSemantics", () => {
  it("mob-sit-down uses Whacked", () => {
    const t = getTopology("mob-sit-down");
    assert.equal(t.removalSemantics.term, "Whacked");
  });

  it("judiciary uses Disbarred", () => {
    const t = getTopology("judiciary");
    assert.equal(t.removalSemantics.term, "Disbarred");
  });

  it("legislature uses Expelled", () => {
    const t = getTopology("legislature");
    assert.equal(t.removalSemantics.term, "Expelled");
  });

  it("corporate-hierarchy uses Terminated", () => {
    const t = getTopology("corporate-hierarchy");
    assert.equal(t.removalSemantics.term, "Terminated");
  });

  it("incident-command uses Relieved of duty", () => {
    const t = getTopology("incident-command");
    assert.equal(t.removalSemantics.term, "Relieved of duty");
  });

  it("direct has no removal semantics", () => {
    const t = getTopology("direct");
    assert.equal(t.removalSemantics, null);
  });
});

// ─── Stability Thresholds (Grok contribution) ───

describe("stabilityThreshold", () => {
  it("legislature has highest threshold (0.6) — requires supermajority", () => {
    assert.equal(getTopology("legislature").stabilityThreshold, 0.6);
  });

  it("mob-sit-down has low threshold (0.2) — boss decides", () => {
    assert.equal(getTopology("mob-sit-down").stabilityThreshold, 0.2);
  });

  it("commune has null threshold — no removal governance", () => {
    assert.equal(getTopology("commune").stabilityThreshold, null);
  });

  it("direct has null threshold — passthrough", () => {
    assert.equal(getTopology("direct").stabilityThreshold, null);
  });
});
