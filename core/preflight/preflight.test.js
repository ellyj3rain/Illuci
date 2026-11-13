import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightLineup, PreflightError, reseatDeadSeats } from "./index.js";

const LINEUP = { commander: ["claude-local"], ops: ["qwen-code"] };

function clearFlags() {
  delete process.env.ILLUCI_PREFLIGHT_ENABLED;
  delete process.env.ILLUCI_PREFLIGHT_PROBE;
}

test("flag OFF (explicit): ready with no lineup (behavior-identical-off — no inspection)", async () => {
  clearFlags();
  // [A50]/DR-130: ILLUCI_PREFLIGHT_ENABLED now DEFAULTS ON — the config-half runs
  // unless the operator turns it off. So "off" is set EXPLICITLY here; unset no
  // longer means off. The assertion (dark gate => no inspection) is unchanged.
  process.env.ILLUCI_PREFLIGHT_ENABLED = "false";
  const r = await preflightLineup("incident-command", LINEUP, { seatDispositions: { ops: { presetId: "conformist" } } });
  assert.equal(r.ready, true);
  assert.equal(r.lineup, undefined); // a bad preset is NOT inspected when the gate is dark
  clearFlags();
});

test("flag ON, valid presets: ready", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  const r = await preflightLineup("incident-command", LINEUP, { seatDispositions: { commander: { presetId: "O5C6E6A3N0" }, ops: { presetId: "O5C6E0A2N4" } } });
  assert.equal(r.ready, true);
  assert.equal(r.presetErrors.length, 0);
  assert.deepEqual(r.lineup, LINEUP); // authoritative lineup equals the input (no reseat in Phase 1)
  clearFlags();
});

test("flag ON, invalid preset: HALT with the valid-id list (strict)", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  const r = await preflightLineup("incident-command", LINEUP, { seatDispositions: { ops: { presetId: "conformist" }, safety: { presetId: "perfectionist" } } });
  assert.equal(r.ready, false);
  assert.equal(r.presetErrors.length, 2);
  assert.ok(r.presetErrors[0].available.includes("O5C6E6A3N0"));
  assert.ok(!r.presetErrors[0].available.includes("conformist"));
  // the runner would throw this:
  const err = new PreflightError(r);
  assert.equal(err.name, "PreflightError");
  assert.equal(err.report, r);
  clearFlags();
});

test("flag ON, no seatDispositions: ready (nothing to validate)", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  const r = await preflightLineup("incident-command", LINEUP, {});
  assert.equal(r.ready, true);
  clearFlags();
});

test("flag ON, invalid role and skill: HALT before runtime composition", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  const r = await preflightLineup("incident-command", LINEUP, {
    seatDispositions: {
      commander: { presetId: "O5C6E6A3N0", role: "not-a-role" },
      ops: { presetId: "O5C6E0A2N4", skills: ["not-a-skill"] },
    },
  });

  assert.equal(r.ready, false);
  assert.deepEqual(r.presetErrors.map((error) => error.kind), ["role", "skills"]);
  clearFlags();
});

test("flag ON, known matrix role without skill bundle: ready", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  const r = await preflightLineup("incident-command", LINEUP, {
    seatDispositions: { commander: { presetId: "O5C6E6A3N0", role: "tester" } },
  });

  assert.equal(r.ready, true);
  assert.equal(r.presetErrors.length, 0);
  clearFlags();
});

test("flag ON, malformed budget: warns but stays ready (clamp-not-halt)", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  const r = await preflightLineup("incident-command", LINEUP, { tokenBudget: "lots" });
  assert.equal(r.ready, true);
  assert.ok(r.warnings.some((w) => w.kind === "budget"));
  clearFlags();
});

test("probeArmed reflects the sub-flag without touching the live bridge", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  let r = await preflightLineup("incident-command", LINEUP, {});
  assert.equal(r.probeArmed, false); // master on, probe sub-flag off => config-only

  let probed = false;
  const fakeProbe = async (lineup) => {
    probed = true;
    assert.deepEqual(lineup, LINEUP);
    return [];
  };

  process.env.ILLUCI_PREFLIGHT_PROBE = "true";
  r = await preflightLineup("incident-command", LINEUP, { _probeSeats: fakeProbe });
  assert.equal(r.probeArmed, true);
  assert.equal(probed, true);
  clearFlags();
});

test("Phase 3: a dead seat HEALS via reseat + passes cardinality re-validation (gate, direct)", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  process.env.ILLUCI_PREFLIGHT_PROBE = "true";
  const fakeProbe = async () => [{ seatId: "model", model: "gemini-3.1-pro", status: "throttled", live: false, blocking: true }];
  const fakeReseat = async (tid, lineup, dead) => ({ ok: true, lineup: { model: "qwen-code" }, reseatLog: dead.map((d) => ({ seatId: d.seatId, from: d.model, to: "qwen-code" })) });
  const r = await preflightLineup("direct", { model: "gemini-3.1-pro" }, { _probeSeats: fakeProbe, _reseatDeadSeats: fakeReseat });
  assert.equal(r.ready, true); // healed lineup re-validated by validateLineup
  assert.equal(r.reseated, true);
  assert.equal(r.lineup.model, "qwen-code");
  assert.equal(r.summary.autoReseated, 1);
  clearFlags();
});

test("Phase 3: reseat exhausted -> HALT with fleetOutage (injected)", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  process.env.ILLUCI_PREFLIGHT_PROBE = "true";
  const fakeProbe = async () => [{ seatId: "ops", model: "gemini-3.1-pro", status: "throttled", live: false, blocking: true }];
  const fakeReseat = async () => ({ ok: false, reason: "no live candidate", fleetOutage: true });
  const r = await preflightLineup("incident-command", { ops: "gemini-3.1-pro" }, { _probeSeats: fakeProbe, _reseatDeadSeats: fakeReseat });
  assert.equal(r.ready, false);
  assert.equal(r.fleetOutage, true);
  clearFlags();
});

test("Phase 3 reseatDeadSeats: dead seat heals to a re-probed live candidate (resolveRole real)", async () => {
  const dead = [{ seatId: "ops", model: "gemini-3.1-pro", status: "throttled", blocking: true }];
  const r = await reseatDeadSeats("incident-command", { ops: "gemini-3.1-pro" }, dead, { _probeOne: async () => ({ status: "available" }) });
  assert.equal(r.ok, true);
  assert.ok(r.lineup.ops && r.lineup.ops !== "gemini-3.1-pro");
  assert.equal(r.reseatLog[0].from, "gemini-3.1-pro");
});

test("Phase 3 reseatDeadSeats: all candidates dead -> exhausted (fleetOutage)", async () => {
  const dead = [{ seatId: "ops", model: "gemini-3.1-pro", status: "throttled", blocking: true }];
  const r = await reseatDeadSeats("incident-command", { ops: "gemini-3.1-pro" }, dead, { _probeOne: async () => ({ status: "throttled" }) });
  assert.equal(r.ok, false);
  assert.equal(r.fleetOutage, true);
});

test("Phase 3 reseatDeadSeats: a seat with no roleHint is irrecoverable (not an outage)", async () => {
  const dead = [{ seatId: "model", model: "gemini-3.1-pro", status: "throttled", blocking: true }];
  const r = await reseatDeadSeats("direct", { model: "gemini-3.1-pro" }, dead, { _probeOne: async () => ({ status: "available" }) });
  assert.equal(r.ok, false);
  assert.equal(r.fleetOutage, false);
  assert.ok(/roleHint/.test(r.reason));
});

test("probe ON, all seats live: ready", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  process.env.ILLUCI_PREFLIGHT_PROBE = "true";
  const fakeProbe = async () => [
    { seatId: "commander", model: "claude-local", status: "live", live: true, blocking: false },
    { seatId: "ops", model: "qwen-code", status: "live", live: true, blocking: false },
  ];
  const r = await preflightLineup("incident-command", LINEUP, { _probeSeats: fakeProbe });
  assert.equal(r.ready, true);
  assert.equal(r.summary.liveBlocking, 0);
  clearFlags();
});

test("probe sub-flag OFF (master ON): no probe runs — Phase-1 config-only behavior", async () => {
  clearFlags();
  process.env.ILLUCI_PREFLIGHT_ENABLED = "true";
  let probed = false;
  const fakeProbe = async () => { probed = true; return []; };
  const r = await preflightLineup("incident-command", LINEUP, { _probeSeats: fakeProbe });
  assert.equal(r.ready, true);
  assert.equal(probed, false); // probe sub-flag off => probeSeats is never called
  assert.deepEqual(r.seats, []);
  clearFlags();
});
