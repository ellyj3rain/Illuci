// node:test - the ceiling consumption-graph + relational-bands primitive.
//
// These tests drive bandOf / dependentsOf off SYNTHETIC in-memory graphs (the
// {nodes, edges} shape buildGraph returns) so the band logic is exercised with no
// filesystem. The buildGraph filesystem scan itself is checked with one tiny on-disk
// fixture tree built under node:os.tmpdir() and torn down after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGraph,
  dependentsOf,
  bandOf,
  SPOKES,
  HUB_NODE,
  GRAPH_NODES,
  BAND_THRESHOLDS,
} from "./graph.js";

// --- helpers ---------------------------------------------------------------

/** Build a synthetic graph whose `target` has exactly `n` distinct dependents. */
function graphWithDependents(target, n, extra = []) {
  const edges = [];
  for (let i = 0; i < n; i++) edges.push({ from: `dep${i}`, to: target });
  edges.push(...extra);
  const nodes = [...GRAPH_NODES];
  return { nodes, edges };
}

// --- node/spoke shape ------------------------------------------------------

test("GRAPH_NODES = the six spokes plus the governance hub", () => {
  assert.deepEqual(GRAPH_NODES, [
    "claude",
    "illuci",
    "codex",
    "otl",
    "constitutional",
    "primitives",
    "governance",
  ]);
  assert.equal(HUB_NODE, "governance");
});

test("SPOKES carries the ARCHITECTURE.md v3.0.0 spoke set (codex + otl present)", () => {
  assert.ok(SPOKES.codex, "codex spoke present");
  assert.ok(SPOKES.otl, "otl spoke present");
  assert.ok(SPOKES.illuci, "illuci spoke present");
});

// --- dependentsOf ----------------------------------------------------------

test("dependentsOf counts DISTINCT dependents (collapses duplicate edges)", () => {
  const graph = {
    nodes: [...GRAPH_NODES],
    edges: [
      { from: "claude", to: "illuci" },
      { from: "claude", to: "illuci" }, // dup -> still one distinct dependent
      { from: "otl", to: "illuci" },
    ],
  };
  assert.equal(dependentsOf("illuci", graph), 2);
});

test("dependentsOf ignores a self-edge", () => {
  const graph = { nodes: [...GRAPH_NODES], edges: [{ from: "illuci", to: "illuci" }] };
  assert.equal(dependentsOf("illuci", graph), 0);
});

test("dependentsOf is 0 for a node nobody depends on, and is null-safe", () => {
  assert.equal(dependentsOf("primitives", { nodes: [], edges: [] }), 0);
  assert.equal(dependentsOf("primitives", null), 0);
  assert.equal(dependentsOf("primitives", {}), 0);
});

// --- bandOf: threshold boundaries ------------------------------------------

test("bandOf LEAF at 0 and 1 dependents", () => {
  assert.equal(bandOf("primitives", graphWithDependents("primitives", 0)), "LEAF");
  assert.equal(bandOf("primitives", graphWithDependents("primitives", 1)), "LEAF");
});

test("bandOf INTERMEDIATE at the 2 and 10 boundaries", () => {
  assert.equal(bandOf("otl", graphWithDependents("otl", 2)), "INTERMEDIATE");
  assert.equal(bandOf("otl", graphWithDependents("otl", 10)), "INTERMEDIATE");
});

test("bandOf HUB at the 11 and 50 boundaries", () => {
  assert.equal(bandOf("claude", graphWithDependents("claude", 11)), "HUB");
  assert.equal(bandOf("claude", graphWithDependents("claude", 50)), "HUB");
});

test("bandOf SUBSTRATE above 50 dependents (51+)", () => {
  assert.equal(bandOf("constitutional", graphWithDependents("constitutional", 51)), "SUBSTRATE");
});

test("BAND_THRESHOLDS exposes the documented edges (1/10/50)", () => {
  assert.equal(BAND_THRESHOLDS.LEAF_MAX, 1);
  assert.equal(BAND_THRESHOLDS.INTERMEDIATE_MAX, 10);
  assert.equal(BAND_THRESHOLDS.HUB_MAX, 50);
});

// --- bandOf: illuci is SUBSTRATE by construction ------------------------------

test("illuci === SUBSTRATE always, even with ZERO dependents", () => {
  assert.equal(bandOf("illuci", { nodes: [...GRAPH_NODES], edges: [] }), "SUBSTRATE");
});

test("illuci === SUBSTRATE even with a self-edge only (count would be 0)", () => {
  const graph = { nodes: [...GRAPH_NODES], edges: [{ from: "illuci", to: "illuci" }] };
  assert.equal(bandOf("illuci", graph), "SUBSTRATE");
});

test("illuci === SUBSTRATE with a null/empty graph", () => {
  assert.equal(bandOf("illuci", null), "SUBSTRATE");
  assert.equal(bandOf("illuci", {}), "SUBSTRATE");
});

// --- bandOf: anything illuci depends on is SUBSTRATE too ----------------------

test("a node illuci depends on is SUBSTRATE regardless of its own dependent count", () => {
  // primitives has only 1 dependent (would be LEAF) but illuci sits on it -> SUBSTRATE.
  const graph = {
    nodes: [...GRAPH_NODES],
    edges: [
      { from: "illuci", to: "primitives" }, // illuci depends on primitives
      { from: "claude", to: "primitives" }, // 1 other dependent
    ],
  };
  assert.equal(dependentsOf("primitives", graph), 2); // sanity: count alone -> INTERMEDIATE
  // but because illuci depends on it, the band is forced to SUBSTRATE:
  const leafCountGraph = {
    nodes: [...GRAPH_NODES],
    edges: [{ from: "illuci", to: "primitives" }],
  };
  assert.equal(dependentsOf("primitives", leafCountGraph), 1); // LEAF by count
  assert.equal(bandOf("primitives", leafCountGraph), "SUBSTRATE"); // forced
});

// --- buildGraph: real filesystem scan over a tiny fixture tree -------------

test("buildGraph scans imports and yields de-duplicated cross-spoke edges", () => {
  const root = mkdtempSync(join(tmpdir(), "ceiling-graph-"));
  try {
    // claude/a.js imports illuci (twice -> one edge) and otl (-> one edge)
    mkdirSync(join(root, "claude"), { recursive: true });
    writeFileSync(
      join(root, "claude", "a.js"),
      [
        "import { x } from '../illuci/core/thing.js'",
        "import { y } from '../illuci/core/other.js'", // dup pair claude->illuci
        "import { z } from '../otl/runner.js'",
        "import { self } from './b.js'", // self-edge claude->claude, dropped
      ].join("\n"),
      "utf8"
    );
    writeFileSync(join(root, "claude", "b.js"), "export const self = 1\n", "utf8");

    // illuci/core/thing.js imports primitives (-> illuci depends on primitives)
    mkdirSync(join(root, "illuci", "core"), { recursive: true });
    writeFileSync(
      join(root, "illuci", "core", "thing.js"),
      "import { p } from '../../primitives/patterns/x.js'\n",
      "utf8"
    );
    writeFileSync(join(root, "illuci", "core", "other.js"), "export const y = 2\n", "utf8");

    mkdirSync(join(root, "otl"), { recursive: true });
    writeFileSync(join(root, "otl", "runner.js"), "export const z = 3\n", "utf8");
    mkdirSync(join(root, "primitives", "patterns"), { recursive: true });
    writeFileSync(join(root, "primitives", "patterns", "x.js"), "export const p = 4\n", "utf8");

    const graph = buildGraph(root);

    // nodes are always the canonical set
    assert.deepEqual(graph.nodes, [...GRAPH_NODES]);

    // edges (sorted): claude->illuci, claude->otl, illuci->primitives ; NO claude->claude
    const keys = graph.edges.map((e) => `${e.from}->${e.to}`);
    assert.deepEqual(keys, ["claude->illuci", "claude->otl", "illuci->primitives"]);

    // band sanity off the SCANNED graph:
    assert.equal(bandOf("illuci", graph), "SUBSTRATE"); // by construction
    assert.equal(bandOf("primitives", graph), "SUBSTRATE"); // illuci depends on it
    assert.equal(dependentsOf("illuci", graph), 1); // claude
    assert.equal(bandOf("otl", graph), "LEAF"); // 1 dependent
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildGraph skips SKIP_DIRS (e.g. node_modules) as edge sources", () => {
  const root = mkdtempSync(join(tmpdir(), "ceiling-skip-"));
  try {
    mkdirSync(join(root, "claude", "node_modules", "pkg"), { recursive: true });
    // a file INSIDE node_modules that imports illuci must NOT produce an edge
    writeFileSync(
      join(root, "claude", "node_modules", "pkg", "index.js"),
      "import { x } from '../../../illuci/core/thing.js'\n",
      "utf8"
    );
    const graph = buildGraph(root);
    assert.equal(graph.edges.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
