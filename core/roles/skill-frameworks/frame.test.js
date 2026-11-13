import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSkillFrameworkRequests,
  renderSkillFrameworkUseBlock,
  resolveSkillFrameworkBlocksForTopology,
} from "./frame.js";
import { resolveSkillFrameworkUse } from "./catalog.js";

test("skill-framework frame requests normalize string and object inputs", () => {
  assert.deepEqual(normalizeSkillFrameworkRequests("gitops-review"), [{ frameworkId: "gitops-review" }]);
  assert.deepEqual(
    normalizeSkillFrameworkRequests([{ id: "hosted-infrastructure-operations", skillRefs: ["infrastructure.account-posture"] }]),
    [{ id: "hosted-infrastructure-operations", frameworkId: "hosted-infrastructure-operations", skillRefs: ["infrastructure.account-posture"] }],
  );
});

test("skill-framework blocks render resolved graph controls for a topology seat", () => {
  const topology = {
    seats: [
      { id: "architect", roleHint: "architect" },
      { id: "reviewer", roleHint: "reviewer" },
    ],
  };

  const result = resolveSkillFrameworkBlocksForTopology({
    topology,
    topologyId: "dev-team",
    skillFrameworks: [{
      frameworkId: "hosted-infrastructure-operations",
      skillRefs: ["infrastructure.account-posture"],
      toolChannelToggles: [{ toolChannel: "browser", enabled: false }],
    }],
    seatSkillFrameworks: {
      reviewer: "gitops-review",
    },
  });

  assert.match(result.blocks.architect, /^\[Skill Frameworks\]/);
  assert.match(result.blocks.architect, /hosted-infrastructure-operations/);
  assert.match(result.blocks.architect, /infrastructure.account-posture/);
  assert.match(result.blocks.architect, /browser_frontend_read/);
  assert.equal(result.usesBySeat.architect[0].resolved.context.topology, "dev-team");
  assert.equal(result.usesBySeat.architect[0].resolved.context.roleId, "architect");

  assert.match(result.blocks.reviewer, /hosted-infrastructure-operations/);
  assert.match(result.blocks.reviewer, /gitops-review/);
});

test("skill-framework render keeps unresolved framework requests visible", () => {
  const block = renderSkillFrameworkUseBlock([{ query: "missing-framework", status: "unresolved", resolved: null }]);

  assert.match(block, /\[Skill Frameworks\]/);
  assert.match(block, /missing-framework: unresolved/);
});

test("evolving skill framework renders promoted behavior contract into topology frames", () => {
  const block = renderSkillFrameworkUseBlock([
    resolveSkillFrameworkUse({ frameworkId: "evolving-skill-frameworks" }),
  ]);

  assert.match(block, /Behavior contract: illuci\.evolving-skill\.behavior-contract\/1/);
  assert.match(block, /Required output fields: seat, candidate, parent, delegation, gate, loopback, reject_if, root_exception/);
  assert.match(block, /Conditional output field: review-coordinator_loopback/);
  assert.match(block, /expert orchestration bodies/);
  assert.match(block, /Blocked promotion gate: evolution\.trace-driven-skill-evolution\.patch/);
  assert.match(block, /trace_id, trace_uri, seat_attribution/);
});
