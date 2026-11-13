/**
 * [A16.3] projection tests — real backends (graph: SQLite; vector: sqlite-vec with
 * a deterministic stub embedder; analytics: DuckDB). The vector/analytics tests
 * degrade-safe-skip only if the optional native lib is genuinely absent; with the
 * deps installed (the default) they exercise the real capture/query path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, _resetBackendForTest } from "../storage/sqlite-driver.js";
import { GRAPH_EDGE_TYPES } from "../composition/graph-preset.js";
import { openTrunk } from "./trunk.js";
import { createGraphProjection } from "./projections/graph.js";
import { createVectorProjection } from "./projections/vector.js";
import { createAnalyticsProjection } from "./projections/analytics.js";

function freshTrunk() {
  _resetBackendForTest();
  const dir = mkdtempSync(join(tmpdir(), "illuci-ds-proj-"));
  const dbPath = join(dir, "trunk.db");
  const driver = openDatabase(dbPath);
  driver.pragma("journal_mode = WAL");
  driver.pragma("busy_timeout = 5000");
  return { trunk: openTrunk(driver), dir, dbPath };
}

function seedRun(trunk) {
  trunk.append({ id: "c1", kind: "company", type: "company.synthesis", companyId: "co1",
    payload: { members: [{ runId: "r1", topologyId: "alpha" }] } });
  trunk.append({ id: "r1s", kind: "run", type: "run.started", runId: "r1", topologyId: "alpha" });
  trunk.append({ id: "r1p0", kind: "run", type: "seat.output", runId: "r1", seatId: "s0",
    modelId: "claude", inputTokens: 5, outputTokens: 7, payload: { response: "the sky is blue" } });
  trunk.append({ id: "r1p1", kind: "run", type: "seat.output", runId: "r1", seatId: "s1",
    modelId: "grok", inputTokens: 3, outputTokens: 4, payload: { response: "rivers flow downhill" } });
}

// deterministic embedder for tests — same text → same vector (exact match, distance ~0).
const stubEmbed = (dim) => (text) => {
  const v = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i += 1) v[i % dim] += text.charCodeAt(i) / 255;
  return v;
};

test("graph: folds run/company into a graph; reach finds the models under a company", () => {
  const { trunk } = freshTrunk();
  seedRun(trunk);
  const g = createGraphProjection(trunk.driver);
  const res = g.rebuild(trunk);
  assert.ok(res.applied >= 4);
  const models = g.reach("company:co1", { nodeType: "model" }).map((n) => n.label).sort();
  assert.deepEqual(models, ["claude", "grok"]);
});

test("graph: rebuild is idempotent and every edge uses a ratified GRAPH_EDGE_TYPE", () => {
  const { trunk } = freshTrunk();
  seedRun(trunk);
  const g = createGraphProjection(trunk.driver);
  g.rebuild(trunk);
  const before = g.counts();
  g.rebuild(trunk); // offset advanced — no double-apply
  assert.deepEqual(g.counts(), before);
  const types = trunk.driver.prepare("SELECT DISTINCT edge_type FROM graph_edges").all().map((r) => r.edge_type);
  for (const t of types) assert.ok(GRAPH_EDGE_TYPES.includes(t), `edge_type "${t}" is ratified`);
});

test("vector: indexes seat outputs; search returns the nearest by embedding", async () => {
  const { trunk, dir } = freshTrunk();
  seedRun(trunk);
  const v = createVectorProjection({ dbPath: join(dir, "vec.db"), embedder: stubEmbed(8), dim: 8 });
  if (!v.available) return; // sqlite-vec absent — degrade-safe skip
  await v.rebuild(trunk);
  const hits = await v.search("the sky is blue", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record_id, "r1p0");
  assert.ok(hits[0].distance < 1e-4);
  v.close();
});

test("analytics: DuckDB attaches the trunk read-only and rolls up tokens by model", async () => {
  const { trunk, dbPath } = freshTrunk();
  seedRun(trunk);
  trunk.driver.pragma("wal_checkpoint(FULL)"); // flush WAL so the separate reader sees it
  const a = createAnalyticsProjection({ trunkPath: dbPath });
  if (!a.available) return; // duckdb absent — degrade-safe skip
  const rows = await a.costByModel();
  const byModel = Object.fromEntries(rows.map((r) => [r.model_id, r]));
  assert.equal(byModel.claude.input_tokens, 5);
  assert.equal(byModel.grok.output_tokens, 4);
  await a.close();
});
