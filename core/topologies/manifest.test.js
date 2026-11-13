/**
 * illuci — [A24.1] Topology governance manifest (node:test, hermetic)
 *
 * The factory's slice 1: every topology — the 34 standard-library entries AND
 * runtime ad-hoc compositions (first-class, ratified D1) — projects a derived,
 * border-validated governance manifest a classifier can read. The [A27]
 * security ruling is enforced structurally: the schema is strict, so an
 * `isExempt`-class bypass flag cannot ride a manifest.
 *
 * Run: node --test core/topologies/manifest.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANIFEST_SCHEMA_ID,
  deriveTopologyManifest,
  validateTopologyManifest,
  getTopologyGovernanceManifest,
} from "./manifest.js";
import { TOPOLOGIES, getTopology } from "./index.js";
import { anchorSeatCandidates } from "./anchor.js";
import { ADAPTIVE_POLICY_DEFAULTS } from "./adaptive-route.js";

test("A24.1: EVERY standard-library topology derives a border-valid manifest", () => {
  const ids = Object.keys(TOPOLOGIES);
  assert.ok(ids.length >= 34, `expected the standard library (>=34), got ${ids.length}`);
  for (const id of ids) {
    const m = deriveTopologyManifest(getTopology(id));
    const v = validateTopologyManifest(m);
    assert.ok(v.ok, `manifest for "${id}" must validate: ${v.ok ? "" : v.errors.join("; ")}`);
    assert.equal(m.schema, MANIFEST_SCHEMA_ID);
    assert.equal(m.id, id);
    assert.equal(m.source, "registry");
    assert.ok(m.seatIds.length >= 1, `"${id}" must list its seats`);
    assert.ok(m.phaseIds.length >= 1, `"${id}" must list its phases`);
    assert.ok(m.anchorSeat, `"${id}" must derive an anchor seat`);
  }
});

test("A24.1: the manifest anchorSeat IS the A17.6 anchor rule (first candidate of the shared walk)", () => {
  for (const id of Object.keys(TOPOLOGIES)) {
    const spec = getTopology(id);
    const m = deriveTopologyManifest(spec);
    assert.equal(m.anchorSeat, anchorSeatCandidates(spec)[0] ?? null, `anchorSeat coherence for "${id}"`);
  }
});

test("A24.1: devops-pipeline manifest reads as expected (anchor=build, gated phases surfaced)", () => {
  const m = deriveTopologyManifest(getTopology("devops-pipeline"));
  assert.equal(m.anchorSeat, "build");
  assert.deepEqual(m.seatIds, ["build", "test", "security", "staging", "deploy", "monitor"]);
  assert.ok(m.gatedPhaseIds.length >= 1, "the gated pipeline must surface its gates");
  assert.deepEqual(m.invariants.adaptive, { ...ADAPTIVE_POLICY_DEFAULTS });
});

test("A24.1 (D1): a runtime ad-hoc topology is a FIRST-CLASS manifest source", () => {
  const runtime = {
    id: "adhoc-factory-probe",
    name: "Ad-hoc probe",
    description: "governed inline composition",
    runtime: true,
    seats: [
      { id: "prober", label: "Prober", min: 1, max: 1, roleHint: null, weight: 0.5, relationships: [] },
    ],
    phases: [{ id: "probe", type: "single", seat: "prober", input: "prompt", gate: true }],
  };
  const m = deriveTopologyManifest(runtime);
  const v = validateTopologyManifest(m);
  assert.ok(v.ok, v.ok ? "" : v.errors.join("; "));
  assert.equal(m.source, "runtime");
  assert.equal(m.anchorSeat, "prober");
  assert.deepEqual(m.gatedPhaseIds, ["probe"]);
});

test("A24.1: a pinned-linear topology surfaces adaptive.enabled=false in its invariants", () => {
  const spec = { id: "pinned", adaptive: false, seats: [{ id: "s" }], phases: [{ id: "p", type: "single", seat: "s", input: "prompt" }] };
  const m = deriveTopologyManifest(spec);
  assert.equal(m.invariants.adaptive.enabled, false);
});

test("A24.1 (no-bypass): a manifest carrying an isExempt-class flag is REJECTED by the strict border", () => {
  const base = deriveTopologyManifest(getTopology("devops-pipeline"));
  for (const poisoned of [
    { ...base, isExempt: true },
    { ...base, exempt: true },
    { ...base, invariants: { ...base.invariants, bypass: true } },
  ]) {
    const v = validateTopologyManifest(poisoned);
    assert.equal(v.ok, false, "a bypass flag must not ride the manifest border");
  }
});

test("A24.1: relationshipTypes fall back to seat-derived vocabulary when the spec omits them", () => {
  const spec = {
    id: "rel-derive",
    runtime: true,
    seats: [
      { id: "a", relationships: [{ type: "adversarial-to", target: "b", semantics: "opposes" }] },
      { id: "b", relationships: [] },
    ],
    phases: [{ id: "p", type: "parallel", seats: ["a", "b"], input: "prompt" }],
  };
  assert.deepEqual(deriveTopologyManifest(spec).invariants.relationshipTypes, ["adversarial-to"]);
});

test("A24.1: the registry accessor resolves ids and returns null for the unknown", () => {
  const m = getTopologyGovernanceManifest("devops-pipeline");
  assert.equal(m?.id, "devops-pipeline");
  assert.equal(getTopologyGovernanceManifest("no-such-topology-xyz"), null);
});

test("A24.1: a garbage spec throws LOUDLY (no null riding the governance read path)", () => {
  for (const bad of [null, undefined, 42, "devops-pipeline", {}, { id: "" }]) {
    assert.throws(() => deriveTopologyManifest(bad), /topology object with a non-empty id/);
  }
});
