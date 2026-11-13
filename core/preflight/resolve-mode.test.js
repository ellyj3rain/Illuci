// core/preflight/resolve-mode.test.js — [A49]/DR-129
//
// The explicit-or-ambient preflight control: an explicit options.preflight wins
// over the env flags (the specific beats the ambient), an absent option falls
// through to the env defaults (byte-identical), and an invalid mode throws
// (fail-closed — never a silent downgrade to a weaker posture).

import test from "node:test";
import assert from "node:assert/strict";
import { resolvePreflightMode, PREFLIGHT_MODES, PreflightConfigError } from "./config.js";

const noEnv = {};

test("the vocabulary is the closed, ordered off|config|probe", () => {
  assert.deepEqual([...PREFLIGHT_MODES], ["off", "config", "probe"]);
});

test("explicit modes map to the right (enabled, probe) posture, over ANY env", () => {
  const armedEnv = { ILLUCI_PREFLIGHT_ENABLED: "1", ILLUCI_PREFLIGHT_PROBE: "1" };
  assert.deepEqual(resolvePreflightMode({ preflight: "off" }, armedEnv), { enabled: false, probe: false, mode: "off", source: "explicit" });
  assert.deepEqual(resolvePreflightMode({ preflight: "config" }, armedEnv), { enabled: true, probe: false, mode: "config", source: "explicit" });
  assert.deepEqual(resolvePreflightMode({ preflight: "probe" }, noEnv), { enabled: true, probe: true, mode: "probe", source: "explicit" });
});

test("absent option falls through to the env defaults", () => {
  // [A50]/DR-130: the master defaults ON (config-validity), so an unset env is 'config'.
  assert.deepEqual(resolvePreflightMode({}, noEnv), { enabled: true, probe: false, mode: "config", source: "env" });
  assert.deepEqual(resolvePreflightMode({}, { ILLUCI_PREFLIGHT_ENABLED: "0" }), { enabled: false, probe: false, mode: "off", source: "env" });
  assert.deepEqual(resolvePreflightMode({}, { ILLUCI_PREFLIGHT_ENABLED: "1", ILLUCI_PREFLIGHT_PROBE: "1" }), { enabled: true, probe: true, mode: "probe", source: "env" });
});

test("probe is meaningless without the master — explicit disable stays off even with probe set", () => {
  assert.deepEqual(resolvePreflightMode({}, { ILLUCI_PREFLIGHT_ENABLED: "0", ILLUCI_PREFLIGHT_PROBE: "1" }), { enabled: false, probe: false, mode: "off", source: "env" });
});

test("an invalid explicit mode throws PreflightConfigError (fail-closed, never a silent downgrade)", () => {
  assert.throws(() => resolvePreflightMode({ preflight: "yes" }), (e) => e instanceof PreflightConfigError && /off, config, probe/.test(e.message));
  assert.throws(() => resolvePreflightMode({ preflight: true }), (e) => e instanceof PreflightConfigError);
});

test("null/undefined preflight is 'absent', not invalid", () => {
  assert.equal(resolvePreflightMode({ preflight: null }, noEnv).source, "env");
  assert.equal(resolvePreflightMode({ preflight: undefined }, noEnv).source, "env");
});
