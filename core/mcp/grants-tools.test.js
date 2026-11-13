// node:test — [A43] the grants verbs: list/issue/revoke/verify over the MCP
// surface, end-to-end with a throwaway ssh key (skips when ssh-keygen absent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { GRANTS_TOOLS } from "./grants-tools.js";
import { sshKeygenAvailable } from "../governance/grants/signing.js";

const tool = (name) => GRANTS_TOOLS.find((t) => t.name === name);

test("the four verbs are declared; mutators gate as writes, readers do not", () => {
  assert.deepEqual(GRANTS_TOOLS.map((t) => t.name), ["grants_list_v1", "grants_issue_v1", "grants_revoke_v1", "grants_verify_v1"]);
  assert.deepEqual(tool("grants_issue_v1").requiredActions, ["file_write"]);
  assert.deepEqual(tool("grants_revoke_v1").requiredActions, ["file_write"]);
  assert.deepEqual(tool("grants_list_v1").requiredActions, []);
  assert.deepEqual(tool("grants_verify_v1").requiredActions, []);
});

test("issue → list → verify → revoke over the verbs (throwaway key)", { skip: !sshKeygenAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-grants-mcp-"));
  const prevManifest = process.env.ILLUCI_GRANTS_MANIFEST;
  const prevKey = process.env.ILLUCI_GRANT_SIGNING_KEY;
  try {
    const keyPath = join(dir, "throwaway");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
    process.env.ILLUCI_GRANTS_MANIFEST = join(dir, "grants.json");
    process.env.ILLUCI_GRANT_SIGNING_KEY = keyPath;

    const issued = await tool("grants_issue_v1").handler({ layer: "seat", subjectId: "architect", capability: "vision" });
    assert.equal(issued.issued, true);
    assert.match(issued.record.signature.value, /BEGIN SSH SIGNATURE/);

    const listed = await tool("grants_list_v1").handler({ subjectId: "architect" });
    assert.equal(listed.count, 1);
    assert.equal(listed.grants[0].active, true);

    // verify fails against the COMMITTED registry (the throwaway key is not in
    // allowed_signers) — a coded finding, exactly the honest outcome.
    const verified = await tool("grants_verify_v1").handler({ grantId: issued.record.id });
    assert.equal(verified.found, true);
    assert.equal(verified.grantSignature, "FAILED");

    const revoked = await tool("grants_revoke_v1").handler({ grantId: issued.record.id, reason: "verb roundtrip" });
    assert.equal(revoked.revoked, true);
    const after = await tool("grants_list_v1").handler({ subjectId: "architect" });
    assert.equal(after.grants[0].active, false);
  } finally {
    if (prevManifest === undefined) delete process.env.ILLUCI_GRANTS_MANIFEST; else process.env.ILLUCI_GRANTS_MANIFEST = prevManifest;
    if (prevKey === undefined) delete process.env.ILLUCI_GRANT_SIGNING_KEY; else process.env.ILLUCI_GRANT_SIGNING_KEY = prevKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
