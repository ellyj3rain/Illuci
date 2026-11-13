import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  McpRuntimeStaleError,
  buildMcpRuntimeStamp,
  createMcpRuntimeGuard,
  describeRuntimeDelta,
} from "./runtime-guard.js";
import { startServer } from "./server.js";

const CURRENT_VERSION = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

function stamp(fingerprint, extra = {}) {
  return {
    schema: "illuci.mcp.runtime-stamp/1",
    root: "test-root",
    gitHead: "head-" + fingerprint,
    gitBranch: "test",
    version: CURRENT_VERSION,
    packageVersion: CURRENT_VERSION,
    fileCount: 1,
    fileStats: ["core/mcp/server.js:1:1"],
    fingerprint,
    ...extra,
  };
}

test("MCP runtime guard fails closed when the source stamp changes after boot", () => {
  const snapshots = [stamp("boot"), stamp("boot"), stamp("changed")];
  let index = 0;
  const guard = createMcpRuntimeGuard({
    checkIntervalMs: 0,
    snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)],
  });

  assert.deepEqual(guard.assertFresh(), { fresh: true, boot: snapshots[0] });
  assert.throws(
    () => guard.assertFresh(),
    (err) => {
      assert.ok(err instanceof McpRuntimeStaleError);
      assert.equal(err.code, "MCP_RUNTIME_STALE");
      assert.equal(err.jsonRpcCode, -32075);
      assert.equal(err.boot.fingerprint, "boot");
      assert.equal(err.current.fingerprint, "changed");
      return true;
    },
  );
});

test("MCP runtime delta reports restart-relevant boot/current fields", () => {
  const delta = describeRuntimeDelta(
    stamp("boot", { gitHead: "abc" }),
    stamp("changed", { gitHead: "def" }),
  );
  assert.equal(delta.boot.gitHead, "abc");
  assert.equal(delta.current.gitHead, "def");
  assert.equal(delta.boot.fingerprint, "boot");
  assert.equal(delta.current.fingerprint, "changed");
});

test("MCP runtime stamp includes a stable fingerprint for this checkout", () => {
  const current = buildMcpRuntimeStamp();
  assert.equal(current.schema, "illuci.mcp.runtime-stamp/1");
  assert.equal(typeof current.fingerprint, "string");
  assert.equal(current.fingerprint.length, 64);
  assert.ok(current.fileCount > 0);
});

test("MCP server advertises its boot runtime stamp", async () => {
  const { info } = await startServer({ tenantId: "runtime-guard-test", transport: "in-process" });
  assert.equal(info.runtime.guard, "source-stale-fail-closed");
  assert.equal(typeof info.runtime.boot.fingerprint, "string");
  assert.equal(info.runtime.boot.version, CURRENT_VERSION);
});
