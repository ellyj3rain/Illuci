/**
 * illuci — Agent core: identity-decoupling invariants.
 *
 * The core record is identity ONLY. Two structural separations are enforced by the
 * validator refusing keys (an author cannot fuse them in):
 *   - agent ≠ model, identity ≠ role  (model / role / archetype / seat)
 *   - disposition != privilege        (permission / gate / privilege / allowedTools / trust)
 * The second is the gate-safety invariant: privilege is granted by the seat + the operator's
 * gate (loop.js keys on the tool's gateLevel, never on disposition), so a "spicy" disposition
 * can never carry an elevated privilege into the run.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { validateAgent, FORBIDDEN_CORE_KEYS } from "./agent-core.js";

// A minimal valid core: identity + the required provenance block, nothing else.
const baseCore = () => ({
  id: "agt_test",
  name: "Test",
  provenance: { codedBy: "test", codedOn: "2026-05-25" },
});

describe("agent-core: identity decoupling", () => {
  it("accepts a minimal valid core (id + name + provenance)", () => {
    const r = validateAgent(baseCore());
    assert.equal(r.valid, true, r.errors.join("; "));
  });

  it("rejects model/role/archetype/seat fused into identity", () => {
    for (const key of ["model", "role", "archetype", "seat"]) {
      const r = validateAgent({ ...baseCore(), [key]: "x" });
      assert.equal(r.valid, false, `should reject ${key}`);
      assert.ok(
        r.errors.some((e) => e.includes(`forbidden key "${key}"`)),
        `error names ${key}`,
      );
    }
  });

  it("rejects privilege/gate keys - disposition != privilege", () => {
    for (const key of [
      "permission", "permissions", "gate", "gateLevel", "privilege", "allowedTools", "trust", "trustLevel",
    ]) {
      const r = validateAgent({ ...baseCore(), [key]: "x" });
      assert.equal(r.valid, false, `should reject privilege key ${key}`);
      assert.ok(
        r.errors.some((e) => e.includes("disposition != privilege")),
        `${key} rejected with the disposition!=privilege rationale`,
      );
    }
  });

  it("FORBIDDEN_CORE_KEYS spans both the decoupling and privilege sets", () => {
    for (const k of ["model", "role", "permission", "gate", "gateLevel", "allowedTools", "privilege", "trust", "trustLevel"]) {
      assert.ok(FORBIDDEN_CORE_KEYS.includes(k), `forbidden set includes ${k}`);
    }
  });
});
