import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  _resetGraphPresetStoreCache,
  createRuntimeGraphPreset,
  getGraphPreset,
  listGraphPresets,
  listRuntimeGraphPresets,
  resolveGraphPresetById,
} from "./graph-preset-store.js";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "illuci-graph-store-"));
  return { root, storeFile: join(root, "graph-presets.json") };
}

const runtimePreset = {
  id: "runtime-direct",
  nodes: [
    { id: "orchestrator", type: "orchestrator" },
    { id: "topology.direct", type: "topology", ref: "direct" },
  ],
  edges: [{ from: "orchestrator", to: "topology.direct", type: "delegates-to" }],
};

test("graph preset store merges canon and runtime overlays", () => {
  const { root, storeFile } = tempStore();
  try {
    const created = createRuntimeGraphPreset(runtimePreset, { storeFile, now: "2026-06-24T00:00:00.000Z" });
    assert.equal(created.created, true);

    const ids = listGraphPresets({ storeFile }).map((preset) => preset.id);
    assert.ok(ids.includes("direct-harness"));
    assert.ok(ids.includes("topology-authoring"));
    assert.ok(ids.includes("runtime-direct"));
    assert.equal(getGraphPreset("runtime-direct", { storeFile }).provenance.source, "runtime");
  } finally {
    _resetGraphPresetStoreCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime graph presets cannot shadow canonical ids", () => {
  const { root, storeFile } = tempStore();
  try {
    const result = createRuntimeGraphPreset({ ...runtimePreset, id: "direct-harness" }, { storeFile });
    assert.equal(result.created, false);
    assert.equal(result.reason, "canonical-shadow-refused");
  } finally {
    _resetGraphPresetStoreCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime listing filters malformed canonical shadows from disk", () => {
  const { root, storeFile } = tempStore();
  try {
    mkdirSync(dirname(storeFile), { recursive: true });
    writeFileSync(storeFile, JSON.stringify({ presets: { "direct-harness": runtimePreset } }), "utf8");
    _resetGraphPresetStoreCache();

    assert.deepEqual(listRuntimeGraphPresets({ storeFile }), []);
  } finally {
    _resetGraphPresetStoreCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph preset resolution records preserve audit telemetry", () => {
  const record = resolveGraphPresetById("direct-harness");
  assert.equal(record.layer, "graph-preset");
  assert.equal(record.telemetry.status, "resolved");
  assert.equal(record.telemetry.graphStatus, "runnable");
  assert.equal(record.governance.auditable, true);
  assert.equal(record.governance.runnable, true);
});