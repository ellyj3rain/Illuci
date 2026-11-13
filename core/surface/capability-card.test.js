import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCapabilityCard,
  renderCapabilityCard,
  detectHost,
  CAPABILITY_CARD_SCHEMA,
  ILLUCI_TAGLINE,
} from "./capability-card.js";
import { featureGatesSnapshot } from "./feature-gates.js";

test("capability card carries schema, tagline, and identity", () => {
  const c = buildCapabilityCard({ env: {} });
  assert.equal(c.schema, CAPABILITY_CARD_SCHEMA);
  assert.equal(c.illuci.name, "illuci");
  assert.equal(c.illuci.tagline, ILLUCI_TAGLINE);
  assert.ok(typeof c.illuci.whatItIsFor === "string" && c.illuci.whatItIsFor.length > 0);
});

test("card discloses all three invocation channels (cli / mcp / api)", () => {
  const c = buildCapabilityCard({ env: {} });
  assert.ok(c.invocation.cli && c.invocation.cli.how);
  assert.ok(c.invocation.mcp && c.invocation.mcp.how);
  assert.ok(c.invocation.api && c.invocation.api.how);
});

test("card surfaces capabilities from the surface map with legible states", () => {
  const c = buildCapabilityCard({ env: {} });
  assert.ok(Array.isArray(c.capabilities) && c.capabilities.length > 0);
  const states = new Set(["on", "gated", "dark", "context"]);
  for (const cap of c.capabilities) {
    assert.ok(states.has(cap.state), `unexpected state ${cap.state}`);
    assert.ok(typeof cap.what === "string" && cap.what.length > 0);
  }
  assert.ok(c.summary.on >= 1, "at least one capability should be on");
});

test("card exposes run-posture controls from the defaults registry", () => {
  const c = buildCapabilityCard({ env: {} });
  assert.ok(Array.isArray(c.controls.runPosture) && c.controls.runPosture.length > 0);
  for (const d of c.controls.runPosture) {
    assert.ok(d.id && d.title && d.current, "each control discloses id/title/current");
  }
});

test("feature gates report factual env state and a turn-on control; nothing is flipped", () => {
  const off = featureGatesSnapshot({});
  const on = featureGatesSnapshot({ ILLUCI_DATASTORE_ENABLED: "1" });
  const dsOn = on.gates.find((g) => g.env === "ILLUCI_DATASTORE_ENABLED");
  const dsOff = off.gates.find((g) => g.env === "ILLUCI_DATASTORE_ENABLED");
  assert.equal(dsOn.current, "on");
  assert.ok(dsOn.turnOn.includes("ILLUCI_DATASTORE_ENABLED"));
  assert.notEqual(dsOff.current, "on");
  // disclosure must not have mutated the environment
  assert.equal(process.env.ILLUCI_DATASTORE_ENABLED, undefined);
});

test("host detection is honest: unknown without markers; identified with a marker", () => {
  assert.equal(detectHost({}).host, "unknown");
  assert.equal(detectHost({ CLAUDECODE: "1" }).host, "claude-code");
  assert.equal(detectHost({ CODEX_HOME: "/x" }).host, "codex");
  assert.equal(detectHost({ CURSOR_TRACE_ID: "abc" }).host, "cursor");
});

test("activation offers turning on what is off (the inclination layer)", () => {
  const c = buildCapabilityCard({ env: {} });
  assert.ok(typeof c.activation.offer === "string" && c.activation.offer.length > 0);
  assert.ok(c.summary.featureGatesOff >= 1);
});

test("the card is OPSEC-clean: no absolute paths or repo/operator identifiers", () => {
  const json = JSON.stringify(buildCapabilityCard({ env: {} }));
  assert.ok(!/[A-Za-z]:\\/.test(json), "no Windows absolute paths");
  assert.ok(!/\/Users\/|\/home\//.test(json), "no unix home paths");
  assert.ok(!/example-org|GroundZeroSolutions|ground-zero\//.test(json), "no repo/operator identifiers");
});

test("render produces a readable card", () => {
  const text = renderCapabilityCard({});
  assert.ok(text.includes("illuci"));
  assert.ok(text.includes(ILLUCI_TAGLINE));
  assert.ok(text.includes("Invocation:"));
});
