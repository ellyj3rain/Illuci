import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeGraphPreset, _resetGraphPresetStoreCache } from "./graph-preset-store.js";
import { materializeTopologyFromGraphPreset, validateGraphTopologyNode } from "./graph-preset-topology.js";
import { getRuntimeTopology, _resetRuntimeTopologiesCache } from "../topologies/runtime-topologies.js";

const graphWithTopology = {
  id: "runtime-topology-graph",
  nodes: [
    { id: "orchestrator", type: "orchestrator" },
    {
      id: "topology.custom",
      type: "topology",
      label: "Custom Review Loop",
      spec: {
        id: "custom-review-loop",
        name: "Custom Review Loop",
        description: "Test topology from graph materialization.",
        seats: [
          { id: "author", label: "Author", min: 1, max: 1, roleHint: "implementer", relationships: [{ type: "precedes", target: "reviewer", semantics: "submits-to" }] },
          { id: "reviewer", label: "Reviewer", min: 1, max: 1, roleHint: "reviewer", relationships: [] },
        ],
        phases: [
          { id: "draft", type: "single", seat: "author", input: "prompt" },
          { id: "review", type: "single", seat: "reviewer", input: "phase:draft" },
        ],
      },
    },
  ],
  edges: [{ from: "orchestrator", to: "topology.custom", type: "delegates-to" }],
};

test("graph topology nodes validate into the runtime topology overlay", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-graph-topology-"));
  const storeFile = join(root, "graph-presets.json");
  const topologyStoreFile = join(root, "runtime-topologies.json");
  try {
    const created = createRuntimeGraphPreset(graphWithTopology, { storeFile });
    assert.equal(created.created, true);

    const materialized = materializeTopologyFromGraphPreset("runtime-topology-graph", "topology.custom", { storeFile, topologyStoreFile });
    assert.equal(materialized.created, true);
    assert.equal(materialized.id, "custom-review-loop");
    assert.equal(getRuntimeTopology("custom-review-loop", { storeFile: topologyStoreFile }).name, "Custom Review Loop");
  } finally {
    _resetGraphPresetStoreCache();
    _resetRuntimeTopologiesCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph topology materialization refuses canonical topology collisions", () => {
  const result = validateGraphTopologyNode({
    id: "topology.direct",
    type: "topology",
    spec: { id: "direct", seats: [{ id: "model" }], phases: [{ id: "query" }] },
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /collides with a canonical topology/);
});