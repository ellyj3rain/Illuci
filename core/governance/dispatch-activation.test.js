// illuci/core/governance/dispatch-activation.test.js
//
// Verifies the dispatch-side activation of the compiled Bill: the carried obligations fold into
// a governed (non-raw) dispatch's operating context via injectGovernance, raw dispatches stay
// lean, and the gate seam (enforceDispatchBill) runs fail-open without facts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { injectGovernance } from "./injector.js";
import { enforceDispatchBill } from "./enforcement/enforce.js";

test("injectGovernance folds the compiled carried obligations into a governed dispatch", () => {
  const out = injectGovernance("do the task", { modelId: "test-model", topology: "swarm" });
  assert.match(out, /Carried obligations \(the compiled Bill\)/, "the carried block must ride a governed dispatch");
  assert.match(out, /operates under its recorded scope|documentation-first|see-and-verify/i, "real obligation text rides");
  assert.match(out, /do the task$/, "the original message is preserved at the end");
});

test("injectGovernance stays lean for raw dispatches", () => {
  assert.equal(injectGovernance("do the task", { raw: true }), "do the task");
});

test("enforceDispatchBill gate seam runs and is fail-open without dispatch facts", async () => {
  const r = await enforceDispatchBill({});
  assert.equal(r.ok, true, "inert (no facts) -> allowed");
  assert.ok(Array.isArray(r.blocking));
});

test("current release floors preserve allowed work and refuse known violations", async () => {
  const attribution = await import("./compiled/floor/std-15.attribution.no-model-git-author.js");
  assert.equal(attribution.check({ model_coauthor: false }).ok, true);
  assert.equal(attribution.check({ model_coauthor: true }).ok, false);
  const release = await import("./compiled/floor/std-17.dedicated-repo.pr-release-hygiene.js");
  const data = await import("./compiled/floor/std-17.dedicated-repo.data-plane-discipline.js");
  assert.equal(release.check({ branch_workflow: true, pr_review_path: true, batch_prefix_present: true }).ok, true);
  assert.equal(release.check({ branch_workflow: true, pr_review_path: false, batch_prefix_present: true }).ok, false);
  assert.equal(data.check({ committed_private_or_transient_state: false }).ok, true);
  assert.equal(data.check({ committed_private_or_transient_state: true }).ok, false);
});


