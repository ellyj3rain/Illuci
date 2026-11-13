// node:test — [A91]/DR-184 + [A92]/DR-185: the childIdentity seam policy.
// One module owns the vocabulary, the arm-time validation, the carry fragment
// every child seam spreads, and the derived-slug scheme. The D1a default
// (`none`) and the loud-unknown law are pinned here once, for all four seams.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHILD_IDENTITY_STATES, normalizeChildIdentity, carryChildIdentity, deriveChildSlug } from "./child-identity.js";

test("the vocabulary is the ratified four states, in D1 order", () => {
  assert.deepEqual([...CHILD_IDENTITY_STATES], ["none", "inherit", "derive", "explicit"]);
});

test("absent childIdentity normalizes to the D1a default (none); all four states are live ([A92])", () => {
  assert.equal(normalizeChildIdentity(null), "none");
  assert.equal(normalizeChildIdentity(undefined), "none");
  assert.equal(normalizeChildIdentity({ projectDir: "/p" }), "none");
  assert.equal(normalizeChildIdentity({ projectDir: "/p", childIdentity: "none" }), "none");
  assert.equal(normalizeChildIdentity({ projectDir: "/p", childIdentity: "inherit" }), "inherit");
  assert.equal(normalizeChildIdentity({ projectDir: "/p", childIdentity: "derive" }), "derive");
  assert.equal(normalizeChildIdentity({ projectDir: "/p", childIdentity: "explicit" }), "explicit");
});

test("an unknown state fails closed, loudly", () => {
  assert.throws(() => normalizeChildIdentity({ childIdentity: "sideways" }), /not a state/);
});

test("none carries NOTHING — the byte-identity law", () => {
  assert.deepEqual(carryChildIdentity({}), {});
  assert.deepEqual(carryChildIdentity({ genome: null, agentManifest: { agents: {} } }), {});
  assert.deepEqual(carryChildIdentity({ genome: { projectDir: "/p" }, agentManifest: { agents: {} } }), {});
});

test("inherit and derive carry the raw manifest + a copy of the genome control", () => {
  const agentManifest = { agents: { "worker-a": {} }, seatAgents: { builder: "worker-a" } };
  for (const state of ["inherit", "derive"]) {
    const genome = { projectDir: "/p", precedence: "seed", childIdentity: state };
    const carry = carryChildIdentity({ genome, agentManifest });
    assert.deepEqual(carry.agents, agentManifest, `${state}: the manifest travels`);
    assert.deepEqual(carry.genome, genome, `${state}: the control travels`);
    assert.notEqual(carry.genome, genome, `${state}: the control is copied, not shared`);
  }
});

test("explicit carries the control ONLY — the child's identities come from its own spawn args", () => {
  const genome = { projectDir: "/p", childIdentity: "explicit" };
  const carry = carryChildIdentity({ genome, agentManifest: { agents: { "worker-a": {} } } });
  assert.equal(carry.agents, undefined, "no manifest crosses under explicit");
  assert.deepEqual(carry.genome, genome);
});

test("deriveChildSlug mints <parent>-<seat>, lowercased; the topologyId hook lengthens; overflow is LOUD, never truncated", () => {
  assert.equal(deriveChildSlug("worker-a", "builder"), "worker-a-builder");
  assert.equal(deriveChildSlug("Worker-A", "Builder"), "worker-a-builder", "case-folds deterministically");
  assert.equal(deriveChildSlug("worker-a", "builder", { topologyId: "dev-team" }), "worker-a-dev-team-builder");
  assert.throws(() => deriveChildSlug("a".repeat(50), "b".repeat(20)), /exceeds 64 chars.*never truncated/s);
  assert.throws(() => deriveChildSlug("", "builder"), /parentAgentId/);
  assert.throws(() => deriveChildSlug("worker-a", ""), /childSeatId/);
});
