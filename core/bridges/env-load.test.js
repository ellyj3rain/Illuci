// node:test — [A94]/DR-187 (F-129): the ONE bridge-env seam. The loader is
// explicit, no-clobber, idempotent, and reports key NAMES only — so diagnosis
// (the fleet doctor) and dispatch (the bridge barrel) provably see one world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBridgeEnv } from "./env-load.js";

test("loadBridgeEnv sets unset keys, never clobbers set ones, and reports names only", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-envload-"));
  const envPath = join(dir, "envarapi.env");
  const KEY_NEW = "ILLUCI_A94_TEST_NEW_KEY";
  const KEY_SET = "ILLUCI_A94_TEST_SET_KEY";
  const prevSet = process.env[KEY_SET];
  try {
    process.env[KEY_SET] = "operator-wins";
    writeFileSync(envPath, `# comment line\n${KEY_NEW}=from-file\n${KEY_SET}=file-must-lose\n\n`, "utf8");

    const r = loadBridgeEnv(envPath);
    assert.equal(r.loaded, true);
    assert.deepEqual(r.keys.sort(), [KEY_NEW, KEY_SET].sort(), "key NAMES reported");
    assert.ok(!JSON.stringify(r).includes("from-file"), "values never appear in the report");
    assert.equal(process.env[KEY_NEW], "from-file", "unset key loaded");
    assert.equal(process.env[KEY_SET], "operator-wins", "an already-set variable always wins (no clobber)");

    const again = loadBridgeEnv(envPath);
    assert.equal(again.cached, true, "idempotent for the same path");

    const missing = loadBridgeEnv(join(dir, "absent.env"));
    assert.equal(missing.loaded, false, "an absent file is a quiet no-op, never a throw");
  } finally {
    delete process.env[KEY_NEW];
    if (prevSet === undefined) delete process.env[KEY_SET];
    else process.env[KEY_SET] = prevSet;
    rmSync(dir, { recursive: true, force: true });
  }
});
