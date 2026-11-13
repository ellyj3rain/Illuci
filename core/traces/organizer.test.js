// illuci/core/traces/organizer.test.js
//
// Verifies the metadata-driven trace organizer: tag derivation, the loose-artifact
// sweep into .illuci/data/traces/<tag>/, non-trace files left untouched, and
// write-at-birth placement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveTag, organizeLoose, writeTrace, TRACES_ROOT } from "./organizer.js";

function withDataHome(fn) {
  const prior = process.env.ILLUCI_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "trace-org-"));
  try {
    process.env.ILLUCI_DATA_HOME = join(root, ".illuci", "data");
    fn(root);
  } finally {
    if (prior == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
}

test("deriveTag: leading filename segment, with explicit meta.tag override", () => {
  assert.equal(deriveTag("classifier-1-research.trace.json"), "classifier");
  assert.equal(deriveTag("governance-arch-p2-2-legislature.trace.json"), "governance");
  assert.equal(deriveTag("mc-slice3-killrail.trace.json"), "mc");
  assert.equal(deriveTag("worktree-incident-1-triage.trace.json"), "worktree");
  assert.equal(deriveTag("anything.trace.json", { tag: "explicit" }), "explicit");
});

test("organizeLoose: files loose traces into the governed data plane by metadata", () => {
  withDataHome((root) => {
    writeFileSync(join(root, "classifier-1-research.trace.json"), JSON.stringify({ topologyId: "research-swarm" }));
    writeFileSync(join(root, "mc-build-proof.trace.json"), JSON.stringify({ topologyId: "dev-team" }));
    writeFileSync(join(root, "tagged.trace.json"), JSON.stringify({ tag: "deboolean", topologyId: "x" }));
    writeFileSync(join(root, "keep.md"), "not a trace");
    const r = organizeLoose(root);
    assert.equal(r.moved.length, 3, "three traces relocated");
    assert.ok(existsSync(join(root, TRACES_ROOT, "classifier", "classifier-1-research.trace.json")));
    assert.ok(existsSync(join(root, TRACES_ROOT, "mc", "mc-build-proof.trace.json")));
    assert.ok(existsSync(join(root, TRACES_ROOT, "deboolean", "tagged.trace.json")), "meta.tag wins over filename");
    assert.ok(existsSync(join(root, "keep.md")), "non-trace files are untouched");
    assert.equal(r.byTag.classifier, 1);
  });
});

test("organizeLoose: never clobbers an existing destination", () => {
  withDataHome((root) => {
    writeFileSync(join(root, "mc-x.trace.json"), JSON.stringify({ topologyId: "a" }));
    const first = organizeLoose(root);
    assert.equal(first.moved.length, 1);
    writeFileSync(join(root, "mc-x.trace.json"), JSON.stringify({ topologyId: "b" }));
    const second = organizeLoose(root);
    assert.equal(second.moved.length, 0, "a name collision is skipped, not overwritten");
    assert.equal(second.skipped.length, 1);
  });
});

test("writeTrace: organized at birth", () => {
  withDataHome((root) => {
    const rel = writeTrace(root, "skillframework-chain.trace.json", { topologyId: "chain" });
    assert.match(rel.replace(/\\/g, "/"), /\.illuci\/data\/traces\/skillframework\//);
    assert.ok(existsSync(join(root, rel)));
  });
});
