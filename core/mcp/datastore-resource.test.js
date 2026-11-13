/**
 * [A19] MCP datastore surface — read-only resource + read-shaped query tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetBackendForTest } from "../storage/sqlite-driver.js";
import { close } from "../datastore/index.js";
import { recordObservation } from "../data/observations.js";
import { DATASTORE_RESOURCE } from "./datastore-resource.js";
import { DATASTORE_QUERY_TOOL } from "./datastore-tools.js";

async function withDatastore(fn) {
  _resetBackendForTest();
  const dir = mkdtempSync(join(tmpdir(), "illuci-ds-mcp-"));
  const prev = { home: process.env.ILLUCI_DATA_HOME, db: process.env.ILLUCI_DATASTORE_DB, on: process.env.ILLUCI_DATASTORE_ENABLED };
  process.env.ILLUCI_DATA_HOME = dir;
  process.env.ILLUCI_DATASTORE_DB = join(dir, "trunk.db");
  process.env.ILLUCI_DATASTORE_ENABLED = "1";
  try { return await fn(dir); }
  finally {
    close();
    for (const [k, v] of [["ILLUCI_DATA_HOME", prev.home], ["ILLUCI_DATASTORE_DB", prev.db], ["ILLUCI_DATASTORE_ENABLED", prev.on]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("resource reads records read-only in MCP contents shape; exposes no write", async () => {
  await withDatastore(() => {
    recordObservation("telemetry", { type: "t", runId: "r1" }, { fileName: "events.jsonl" });
    const out = DATASTORE_RESOURCE.read({ verb: "records", kind: "telemetry" });
    assert.ok(Array.isArray(out.contents), "MCP contents array");
    assert.equal(out.contents[0].mimeType, "application/json");
    const body = JSON.parse(out.contents[0].text);
    assert.equal(body.verb, "records");
    assert.ok(body.count >= 1);
    assert.equal(DATASTORE_RESOURCE.write, undefined, "resource must expose no write capability");
  });
});

test("resource health reports the trunk count", async () => {
  await withDatastore(() => {
    recordObservation("telemetry", { type: "t" }, { fileName: "events.jsonl" });
    const body = JSON.parse(DATASTORE_RESOURCE.read({ verb: "health" }).contents[0].text);
    assert.ok(body.data.count >= 1);
  });
});

test("query tool runs read-only SQL and rejects mutations", async () => {
  await withDatastore(async () => {
    recordObservation("telemetry", { type: "t" }, { fileName: "events.jsonl" });
    const ok = await DATASTORE_QUERY_TOOL.handler({ verb: "sql", sql: "SELECT count(*) AS n FROM records" });
    assert.equal(ok.verb, "sql");
    assert.ok(ok.rows[0].n >= 1);
    const bad = await DATASTORE_QUERY_TOOL.handler({ verb: "sql", sql: "DELETE FROM records" });
    assert.match(bad.error, /read-only/);
  });
});
