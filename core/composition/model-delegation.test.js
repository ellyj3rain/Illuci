import test from "node:test";
import assert from "node:assert/strict";

import { composeModelDelegation, inferSeatCapabilityDemand } from "./model-delegation.js";

const topology = {
  id: "sample",
  seats: [
    { id: "architect", min: 1, roleHint: "architect" },
    { id: "worker", min: 1, roleHint: "implementer" },
    { id: "delegate", min: 1, roleHint: "reviewer" },
  ],
  phases: [
    { id: "plan", type: "single", seat: "architect", mode: "respond" },
    { id: "build", type: "single", seat: "worker", mode: "write" },
    { id: "ship", type: "single", seat: "delegate", mode: "delegate" },
  ],
};

const roles = {
  architect: [{ model: "claude-local" }, { model: "codex-local" }],
  implementer: [{ model: "codex-local" }, { model: "kimi-local" }],
  reviewer: [{ model: "grok" }, { model: "claude-local" }],
  analyst: [{ model: "gemini" }],
};

const deps = {
  resolveRole: (role) => roles[role] || [],
  supportsMode: (model, mode) => model === "codex-local" || mode === "respond",
};

test("inferSeatCapabilityDemand picks the most demanding phase effect per seat", () => {
  const modes = inferSeatCapabilityDemand(topology);
  assert.equal(modes.get("architect"), "respond");
  assert.equal(modes.get("worker"), "write");
  assert.equal(modes.get("delegate"), "delegate");
});

test("explicit lineup pins win over harness preference", () => {
  const composed = composeModelDelegation(topology, { worker: "kimi-local" }, {
    ...deps,
    preferHarnessInference: true,
    harnessModelResource: "codex-local",
  });

  assert.equal(composed.lineup.worker, "kimi-local");
  assert.equal(composed.audit.find((entry) => entry.seatId === "worker").source, "explicit-lineup");
});

test("harness inference is preferred when it satisfies role and mode", () => {
  const composed = composeModelDelegation(topology, {}, {
    ...deps,
    preferHarnessInference: true,
    harnessModelResource: "codex-local",
  });

  assert.equal(composed.lineup.worker, "codex-local");
  assert.equal(composed.audit.find((entry) => entry.seatId === "worker").source, "harness-role-candidate");
});

test("delegate mode can use harness by mode when role candidates do not include it", () => {
  const composed = composeModelDelegation(topology, {}, {
    ...deps,
    preferHarnessInference: true,
    harnessModelResource: "codex-local",
  });

  assert.equal(composed.lineup.delegate, "codex-local");
  assert.equal(composed.audit.find((entry) => entry.seatId === "delegate").source, "harness-mode-candidate");
});
