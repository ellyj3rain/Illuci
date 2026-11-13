// core/preflight/explicit-integration.test.js — [A49]/DR-129
//
// preflightLineup honors an EXPLICIT options.preflight over the env flags, and
// reports the resolved posture (mode / modeSource / probeArmed) so a caller — CLI
// or GUI — can SEE which gate ran and why. Hermetic: the probe path is exercised
// through the injectable _probeSeats seam, no network.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { preflightLineup } from "./index.js";

const LINEUP = { participant: ["deepseek", "kimi-cloud"] }; // war-room: one multi-model seat

beforeEach(() => {
  delete process.env.ILLUCI_PREFLIGHT_ENABLED;
  delete process.env.ILLUCI_PREFLIGHT_PROBE;
});

test("explicit 'off' wins over an ARMED env — the gate is skipped", async () => {
  process.env.ILLUCI_PREFLIGHT_ENABLED = "1";
  process.env.ILLUCI_PREFLIGHT_PROBE = "1";
  const r = await preflightLineup("war-room", LINEUP, { preflight: "off" });
  assert.equal(r.ready, true);
  assert.equal(r.mode, undefined, "off returns the bare ready report (byte-identical to the disabled path)");
});

test("explicit 'config' runs the config-validity half even with env OFF (no probe)", async () => {
  let probed = false;
  const r = await preflightLineup("war-room", LINEUP, {
    preflight: "config",
    _probeSeats: async () => { probed = true; return []; },
  });
  assert.equal(r.ready, true);
  assert.equal(r.mode, "config");
  assert.equal(r.modeSource, "explicit");
  assert.equal(r.probeArmed, false);
  assert.equal(probed, false, "config mode never touches the network probe");
});

test("explicit 'probe' runs the liveness probe (injected) even with env OFF", async () => {
  let probed = false;
  const r = await preflightLineup("war-room", LINEUP, {
    preflight: "probe",
    _probeSeats: async (lineup) => {
      probed = true;
      return Object.entries(lineup).flatMap(([seatId, ms]) => (Array.isArray(ms) ? ms : [ms]).map((model) => ({ seatId, model, status: "live", live: true, blocking: false })));
    },
  });
  assert.equal(probed, true, "probe mode runs the network half");
  assert.equal(r.ready, true);
  assert.equal(r.mode, "probe");
  assert.equal(r.probeArmed, true);
});

test("an invalid explicit mode fails closed (ready:false), never a silent downgrade", async () => {
  const r = await preflightLineup("war-room", LINEUP, { preflight: "sorta" });
  assert.equal(r.ready, false);
  assert.equal(r.failClosed, true);
  assert.match(r.error, /off, config, probe/);
});

test("absent option falls through to env: default-on now runs config-validity", async () => {
  // [A50]/DR-130: the master defaults ON, so an absent option + unset env runs the
  // config-validity gate (mode 'config'), not the bare disabled path.
  const r = await preflightLineup("war-room", LINEUP, {});
  assert.equal(r.ready, true);
  assert.equal(r.mode, "config");
  assert.equal(r.modeSource, "env");
});

test("explicit env ILLUCI_PREFLIGHT_ENABLED=0 restores the bare disabled path", async () => {
  process.env.ILLUCI_PREFLIGHT_ENABLED = "0";
  const r = await preflightLineup("war-room", LINEUP, {});
  assert.equal(r.ready, true);
  assert.equal(r.mode, undefined, "explicit disable returns the bare ready report");
});
