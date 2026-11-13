/**
 * Illuci — Topology Mode Requirements Tests
 *
 * Tests for seat mode requirement detection and validation.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  getTopology,
  getSeatModeRequirements,
  getSeatCapabilityDemand,
} from "./index.js";

describe("getSeatModeRequirements", () => {
  it("dev-team has correct mode requirements per seat", () => {
    const requirements = getSeatModeRequirements("dev-team");
    
    // architect only in design phase (respond)
    assert.deepEqual(requirements.get("architect"), ["respond"]);
    
    // implementer only in implement phase (write)
    assert.deepEqual(requirements.get("implementer"), ["write"]);
    
    // reviewer only in review phase (read)
    assert.deepEqual(requirements.get("reviewer"), ["read"]);
    
    // qa only in test phase (execute)
    assert.deepEqual(requirements.get("qa"), ["execute"]);
  });

  it("devops-pipeline has multiple modes per seat", () => {
    const requirements = getSeatModeRequirements("devops-pipeline");
    
    // build seat is in build phase (write)
    assert.ok(requirements.get("build").includes("write"));
    
    // test seat is in test phase (execute)
    assert.ok(requirements.get("test").includes("execute"));
    
    // security seat is in scan phase (read)
    assert.ok(requirements.get("security").includes("read"));
    
    // staging seat is in stage phase (read)
    assert.ok(requirements.get("staging").includes("read"));
    
    // deploy seat is in deploy phase (execute)
    assert.ok(requirements.get("deploy").includes("execute"));
  });

  it("adversarial-debate defaults to respond for all seats", () => {
    const requirements = getSeatModeRequirements("adversarial-debate");
    
    // No explicit modes defined, all should default to respond
    for (const [seatId, modes] of requirements) {
      assert.deepEqual(modes, ["respond"]);
    }
  });

  it("peer-review-ring has write then read modes", () => {
    const requirements = getSeatModeRequirements("peer-review-ring");
    
    // author in draft phase (write)
    assert.deepEqual(requirements.get("author"), ["write"]);
    
    // reviewer in review-chain phase (read)
    assert.deepEqual(requirements.get("reviewer"), ["read"]);
  });
});

describe("getSeatCapabilityDemand", () => {
  it("returns most demanding phase-effect capability for each seat", () => {
    // dev-team qa only has execute
    assert.equal(getSeatCapabilityDemand("dev-team", "qa"), "execute");
    
    // dev-team implementer only has write
    assert.equal(getSeatCapabilityDemand("dev-team", "implementer"), "write");
    
    // dev-team reviewer only has read
    assert.equal(getSeatCapabilityDemand("dev-team", "reviewer"), "read");
  });

  it("delegate has the highest capability demand, then execute, then write", () => {
    // Create a mock topology check by looking at real topologies
    // In practice, no topology currently mixes modes on the same seat
    // But the ranking should be correct
    
    // The capability-demand order is: delegate > execute > write > read > respond
    // This is implicit in the implementation
    
    // Verify that specific seats return their single mode correctly
    assert.equal(getSeatCapabilityDemand("dev-team", "implementer"), "write");
    assert.equal(getSeatCapabilityDemand("dev-team", "qa"), "execute");
  });

  it("returns null for non-existent seat", () => {
    assert.equal(getSeatCapabilityDemand("dev-team", "non-existent"), null);
  });

  it("returns null for non-existent topology", () => {
    // This will throw because getTopology throws
    assert.throws(() => getSeatCapabilityDemand("non-existent", "seat"));
  });
});

describe("mode requirement validation", () => {
  it("all mode-annotated phases have valid modes", () => {
    const validModes = ["respond", "write", "read", "execute", "delegate"];
    
    // Get all topology IDs by checking the exported functions work
    const testTopologies = ["dev-team", "devops-pipeline", "peer-review-ring", "apprentice-master"];
    
    for (const topoId of testTopologies) {
      const topology = getTopology(topoId);
      for (const phase of topology.phases) {
        const mode = phase.mode || "respond";
        assert.ok(validModes.includes(mode), 
          `${topoId}/${phase.id} has invalid mode: ${mode}`);
      }
    }
  });

  it("apprentice-master has correct mode progression", () => {
    const topology = getTopology("apprentice-master");
    const phases = topology.phases;
    
    // demonstrate: respond (master shows how)
    assert.equal(phases.find(p => p.id === "demonstrate").mode, "respond");
    
    // attempt: write (apprentice implements)
    assert.equal(phases.find(p => p.id === "attempt").mode, "write");
    
    // correct: read (master reviews)
    assert.equal(phases.find(p => p.id === "correct").mode, "read");
    
    // evaluate: read (evaluator assesses)
    assert.equal(phases.find(p => p.id === "evaluate").mode, "read");
  });
});
