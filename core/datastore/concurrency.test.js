// node:test — regression for concurrent multi-process opens of the datastore trunk.
//
// journal_mode=WAL rewrites the journal header under a brief EXCLUSIVE lock, and SQLite
// returns SQLITE_BUSY ("database is locked") IMMEDIATELY for that upgrade under concurrent
// opens — busy_timeout does not cover it (SQLite declines the busy handler to avoid
// deadlock). [A22] armed busy_timeout before the WAL pragma (covering DDL/INSERT) but
// ~1/10 concurrent openers still threw at the WAL switch itself; [A34] retries that switch
// in openDatastore until an opener wins and the file is WAL for everyone else. This spawns
// N processes that open the trunk and append, then asserts every write landed (no crash,
// no loss). Worker stderr is surfaced so a failure is diagnosable, not an opaque exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatastore, close } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "concurrency.fixture.mjs");

test("openDatastore survives concurrent multi-process opens with no lost writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-ds-cc-"));
  const path = join(dir, "trunk.db");
  const N = 8;
  try {
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
      // Generous busy_timeout so DDL/INSERT wait out contention when this races the full
      // suite; the WAL-switch itself is covered by openDatastore's [A34] retry.
      const child = spawn(process.execPath, [FIXTURE, path, `cc-${i}`], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, ILLUCI_DATASTORE_BUSY_TIMEOUT: "15000" },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${i} exited with code ${code}${stderr ? `:\n${stderr.trim()}` : ""}`))));
      child.once("error", reject);
    })));

    close(); // drop any stale singleton, then read fresh
    const { trunk } = openDatastore({ path });
    assert.equal(trunk.records({ kind: "cctest" }).length, N);
  } finally {
    close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});
