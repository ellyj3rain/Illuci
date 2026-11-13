/**
 * NVIDIA NIM presentation slice (A26): the capability spine + resource gateway must
 * surface the key-gated NIM lane, all DERIVED from NVIDIA_NIM_MANIFEST (one source).
 * Pure / hermetic — no network, no credential; reads only the static tables.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCapabilities, listFamilies, FAMILY_PROFILES } from "./capabilities.js";
import { NVIDIA_NIM_MANIFEST } from "./model-registry.js";
import { getModelResource, listModelResources } from "../fleet/resource-gateway.js";

// ── capabilities: the family is KNOWN, not the unknown fallthrough ──

test("getCapabilities resolves every NIM id to the known nvidia-nim family", () => {
  for (const m of NVIDIA_NIM_MANIFEST) {
    const cap = getCapabilities(m.id);
    assert.equal(cap.known, true, `${m.id} should be known`);
    assert.equal(cap.family, "nvidia-nim");
  }
});

test("the nvidia-nim family profile has the neighboring-entry shape (effort control, no native tools)", () => {
  const p = FAMILY_PROFILES["nvidia-nim"];
  assert.ok(p, "FAMILY_PROFILES has an nvidia-nim entry");
  assert.equal(p.label, "NVIDIA NIM");
  assert.equal(p.streaming, true);
  assert.equal(p.nativeTools, false);
  assert.equal(typeof p.contextWindow, "number");
  assert.equal(p.reasoning.supported, true);
  assert.equal(p.reasoning.control, "effort");
  assert.equal(p.reasoning.default, "high");
  assert.ok(Array.isArray(p.reasoning.tiers) && p.reasoning.tiers.includes("high"));
  assert.deepEqual(p.ultra, { available: false });
});

test("nvidia-nim sub-models are DERIVED from the manifest (ids + models match a real row)", () => {
  const p = FAMILY_PROFILES["nvidia-nim"];
  assert.ok(p.subModels.length > 0 && p.subModels.length <= NVIDIA_NIM_MANIFEST.length);
  const byId = new Map(NVIDIA_NIM_MANIFEST.map((m) => [m.id, m]));
  for (const sm of p.subModels) {
    const src = byId.get(sm.id);
    assert.ok(src, `sub-model ${sm.id} is a manifest id`);
    assert.equal(sm.model, src.model);      // wire string carried through, not invented
    assert.equal(sm.label, src.label);
  }
});

test("listFamilies surfaces the nvidia-nim family for a UI to render", () => {
  const fam = listFamilies().find((f) => f.family === "nvidia-nim");
  assert.ok(fam, "nvidia-nim appears in listFamilies()");
  assert.equal(fam.label, "NVIDIA NIM");
});

// ── resource gateway: MODEL_PROFILES derived for every NIM id ──

test("every NIM id gets a derived model resource with a model.nvidia.<shortId> id", () => {
  for (const m of NVIDIA_NIM_MANIFEST) {
    const mr = getModelResource(m.id);
    assert.ok(mr, `${m.id} resolves to a model resource`);
    assert.equal(mr.id, "model.nvidia." + m.id.replace(/^nim-/, ""));
    assert.equal(mr.label, m.label);
    assert.equal(mr.tier, m.tier);
    assert.equal(mr.modality, m.modality);
    assert.equal(mr.fleetUse, m.fleetUse || "seat");
    assert.deepEqual(mr.capabilityLanes, m.capabilityLanes || []);
  }
});

test("listModelResources(family nvidia-nim) returns exactly the manifest, all profiled (no safePart fallback)", () => {
  const resources = listModelResources({ family: "nvidia-nim" });
  assert.equal(resources.length, NVIDIA_NIM_MANIFEST.length);
  for (const r of resources) {
    assert.ok(r.id.startsWith("model.nvidia."), `${r.id} uses the derived id, not the family.variant fallback`);
  }
});

test("small and utility NIM routes are delegate-only resources, not topology seats", () => {
  // [A19.5] fleet curation: llama-3.2-11b-vision and nemotron-nano-vl-8b were RETIRED
  // (stale bases), and llama-3.2-90b-vision was demoted seat -> delegate.
  const delegateIds = [
    "nim-riva-translate-4b",
    "nim-llama-3.2-90b-vision",
    "nim-nemotron-nano-12b-vl",
  ];
  for (const id of delegateIds) {
    const mr = getModelResource(id);
    assert.equal(mr.fleetUse, "delegate");
    assert.ok(mr.capabilityLanes.length > 0, `${id} carries delegated capability lanes`);
    assert.ok(!mr.capabilityLanes.includes("deliberation"), `${id} never advertises a deliberation lane`);
  }
  for (const retired of ["nim-llama-3.2-11b-vision", "nim-nemotron-nano-vl-8b", "hermes", "hermes4"]) {
    assert.equal(getModelResource(retired), null, `${retired} stays retired`);
  }

  const seat = getModelResource("nim-nemotron-3-ultra");
  assert.equal(seat.fleetUse, "seat");
  assert.ok(seat.capabilityLanes.includes("deliberation"));
});
