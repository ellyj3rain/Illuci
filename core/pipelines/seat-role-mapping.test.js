import test from "node:test";
import assert from "node:assert/strict";

import { TOPOLOGIES } from "../topologies/index.js";
import {
  PhaseSeatRole,
  SeatRoleMapping,
  resolveSeatId,
} from "./pipeline-types.js";

test("functional role mappings point at real topology seats", () => {
  for (const [topologyId, mapping] of Object.entries(SeatRoleMapping)) {
    const topology = TOPOLOGIES[topologyId];
    assert.ok(topology, `mapping references unknown topology: ${topologyId}`);
    const seatIds = new Set(topology.seats.map((seat) => seat.id));

    for (const [role, seatId] of Object.entries(mapping)) {
      assert.ok(seatIds.has(seatId), `${topologyId}: role ${role} maps to unknown seat ${seatId}`);
    }
  }
});

test("role-to-seat resolution follows current topology vocabulary", () => {
  assert.equal(resolveSeatId("research-swarm", PhaseSeatRole.SYNTHESIZER), "integrator");
  assert.equal(resolveSeatId("judiciary", PhaseSeatRole.DEFENDER), "defender");
  assert.equal(resolveSeatId("legislature", PhaseSeatRole.AUTHORITY), "sponsor");
  assert.equal(resolveSeatId("kgotla", PhaseSeatRole.AUDITOR), "motho");
});
