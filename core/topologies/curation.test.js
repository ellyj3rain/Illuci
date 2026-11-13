import test from "node:test";
import assert from "node:assert/strict";

import { TOPOLOGIES } from "./index.js";
import { assertTopologyCurationComplete, getTopologyCuration, listCuratedTopologies } from "./curation.js";

test("topology curation covers every canonical topology without deleting public ids", () => {
  const complete = assertTopologyCurationComplete();
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);

  const curatedIds = listCuratedTopologies({ includeAdvanced: true, includeSandbox: true }).map((row) => row.id).sort();
  assert.deepEqual(curatedIds, Object.keys(TOPOLOGIES).sort());
});

test("topology curation controls default visibility without losing provenance", () => {
  const defaultIds = listCuratedTopologies().map((row) => row.id);
  assert.ok(defaultIds.includes("direct"));
  assert.ok(!defaultIds.includes("turing-test"));
  assert.ok(!defaultIds.includes("cult"));

  const devops = getTopologyCuration("devops-pipeline");
  assert.equal(devops.status, "curation-needed");
  assert.ok(devops.aliases.includes("devops"));
  assert.match(devops.overlapNotes.join(" "), /pipeline is a separate process layer/);
});