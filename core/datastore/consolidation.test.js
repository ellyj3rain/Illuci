/**
 * [A16.4] consolidation mechanism tests. Verifies the strangler-fig is byte-identical
 * when off, redirects + namespaces when armed, and ingests legacy rows once
 * (drift-safe, idempotent, retaining the legacy file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, _resetBackendForTest } from "../storage/sqlite-driver.js";
import { storeDbPath, migrationsTable, ingestLegacy, consolidationEnabled } from "./consolidation.js";

const tmp = () => mkdtempSync(join(tmpdir(), "illuci-ds-consol-"));

test("off (default): byte-identical — legacy path, plain _migrations", () => {
  delete process.env.ILLUCI_DATASTORE_CONSOLIDATE;
  assert.equal(consolidationEnabled(), false);
  assert.equal(storeDbPath("/legacy/context.db"), "/legacy/context.db");
  assert.equal(migrationsTable("context"), "_migrations");
});

test("armed: redirects to the trunk + namespaces the migrations table", () => {
  const dir = tmp();
  process.env.ILLUCI_DATASTORE_CONSOLIDATE = "1";
  process.env.ILLUCI_DATASTORE_DB = join(dir, "trunk.db");
  _resetBackendForTest();
  try {
    assert.equal(consolidationEnabled(), true);
    assert.equal(storeDbPath("/legacy/context.db"), join(dir, "trunk.db"));
    assert.equal(migrationsTable("context"), "_migrations_context");
  } finally {
    delete process.env.ILLUCI_DATASTORE_CONSOLIDATE;
    delete process.env.ILLUCI_DATASTORE_DB;
  }
});

test("ingestLegacy: drift-safe copy, idempotent, legacy file retained", () => {
  _resetBackendForTest();
  const dir = tmp();
  const legacyPath = join(dir, "legacy.db");
  const trunkPath = join(dir, "trunk.db");

  const legacy = openDatabase(legacyPath);
  legacy.exec("CREATE TABLE artifacts (id TEXT PRIMARY KEY, name TEXT, scope TEXT)");
  legacy.prepare("INSERT INTO artifacts(id, name, scope) VALUES (?, ?, ?)").run("a1", "x", "project");
  legacy.prepare("INSERT INTO artifacts(id, name, scope) VALUES (?, ?, ?)").run("a2", "y", "global");
  legacy.close();

  // the store would have created its (possibly drifted) schema in the trunk first
  const trunk = openDatabase(trunkPath);
  trunk.exec("CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, name TEXT, scope TEXT, extra TEXT)");

  const r1 = ingestLegacy(trunk, { storeId: "context", legacyPath, tables: ["artifacts"] });
  assert.equal(r1.copied, 2);
  assert.equal(trunk.prepare("SELECT COUNT(*) AS c FROM artifacts").get().c, 2);
  assert.equal(trunk.prepare("SELECT name FROM artifacts WHERE id='a1'").get().name, "x");

  const r2 = ingestLegacy(trunk, { storeId: "context", legacyPath, tables: ["artifacts"] });
  assert.equal(r2.alreadyDone, true);
  assert.equal(trunk.prepare("SELECT COUNT(*) AS c FROM artifacts").get().c, 2);

  assert.ok(existsSync(legacyPath), "legacy file retained (never deleted)");
  trunk.close();
});
