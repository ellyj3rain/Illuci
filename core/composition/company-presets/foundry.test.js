// node:test — the Foundry canonical company preset ([A106]/DR-199): the
// operator's first preset, promoted. Declaration-contract tests: every fact
// the preset declares (agents, seats, topologies, models, world roster) is
// checked against the registries that would consume it at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

import {
  FOUNDRY_GRAPH_PRESET,
  FOUNDRY_AGENTS,
  FOUNDRY_SEATS,
  FOUNDRY_TOPOLOGIES,
  FOUNDRY_WORLD,
  FOUNDRY_MASTER_SEED,
} from "./foundry.js";
import { getGraphPreset, listGraphPresets, createRuntimeGraphPreset, _resetGraphPresetStoreCache } from "../graph-preset-store.js";
import { planGraphPreset } from "../graph-preset-runner.js";
import { TOPOLOGIES } from "../../topologies/index.js";
import { dispatchIdForPublicModel } from "../../fleet/resource-gateway.js";
import { DISPOSITION_PRESETS } from "../../agents/disposition-presets.js";

const slugs = Object.keys(FOUNDRY_AGENTS);

test("foundry is a canonical store preset that runtime presets cannot shadow", () => {
  const listed = listGraphPresets().find((p) => p.id === "foundry");
  assert.ok(listed, "foundry must be listed");
  assert.equal(listed.provenance.source, "canon");
  const got = getGraphPreset("foundry");
  assert.equal(got.id, "foundry");
  assert.equal(got.governance.rootNodeId, "company.foundry");
  const storeFile = join(mkdtempSync(join(tmpdir(), "illuci-foundry-test-")), "graph-presets.json");
  const shadow = createRuntimeGraphPreset(
    { id: "foundry", nodes: [{ id: "orchestrator", type: "orchestrator" }], edges: [] },
    { storeFile },
  );
  assert.equal(shadow.created, false, "canon ids must refuse runtime shadowing");
  assert.equal(shadow.reason, "canonical-shadow-refused");
  _resetGraphPresetStoreCache();
});

test("the roster is 14 agents; every seat binding resolves to a declared agent; every agent is seated", () => {
  assert.equal(slugs.length, 14);
  const seated = new Set();
  for (const [topologyId, seatMap] of Object.entries(FOUNDRY_SEATS)) {
    assert.ok(FOUNDRY_TOPOLOGIES.includes(topologyId), `${topologyId} must be a declared topology`);
    for (const [seat, bound] of Object.entries(seatMap)) {
      for (const slug of Array.isArray(bound) ? bound : [bound]) {
        assert.ok(FOUNDRY_AGENTS[slug], `${topologyId}.${seat} binds unknown agent "${slug}"`);
        seated.add(slug);
      }
    }
  }
  assert.deepEqual([...seated].sort(), [...slugs].sort(), "every declared agent holds at least one seat");
});

test("every declared topology exists in the canonical topology registry", () => {
  for (const topologyId of FOUNDRY_TOPOLOGIES) {
    assert.ok(TOPOLOGIES[topologyId], `topology "${topologyId}" must exist`);
  }
});

test("every agent's model resolves through the public-model gateway and its cold-path disposition exists", () => {
  for (const [slug, agent] of Object.entries(FOUNDRY_AGENTS)) {
    const dispatchId = dispatchIdForPublicModel(agent.model);
    assert.ok(dispatchId, `${slug}: model "${agent.model}" must resolve to a dispatch id`);
    assert.ok(DISPOSITION_PRESETS[agent.disposition.presetId], `${slug}: disposition preset "${agent.disposition.presetId}" must exist`);
    assert.ok(agent.public.displayName && agent.public.summary, `${slug}: public card must be complete`);
  }
});

test("the world document loads and its roster matches the manifest", () => {
  assert.ok(FOUNDRY_WORLD.length > 1000, "world doc must be the real document, not a stub");
  assert.match(FOUNDRY_WORLD, /the Commons/);
  for (const agent of Object.values(FOUNDRY_AGENTS)) {
    const first = agent.public.displayName.split(" ")[0];
    assert.ok(FOUNDRY_WORLD.includes(first), `world doc must mention ${agent.public.displayName}`);
  }
});

test("friendships reference declared slugs only", () => {
  for (const pair of FOUNDRY_GRAPH_PRESET.nodes.find((n) => n.id === "company.foundry").spec.notes.friendships) {
    for (const slug of pair) assert.ok(FOUNDRY_AGENTS[slug], `friendship references unknown "${slug}"`);
  }
});

test("planGraphPreset('foundry') compiles one shared-bus company with the world + defaults fanned", () => {
  const plan = planGraphPreset("foundry", { prompt: "WO: test", record: false });
  assert.equal(plan.planned, true, JSON.stringify(plan.errors || plan.reason));
  const node = plan.compiledNode;
  assert.equal(node.kind, "company");
  assert.equal(node.concurrency, 3);
  assert.equal(node.awareness, true);
  assert.equal(node.preamble, FOUNDRY_WORLD);
  assert.deepEqual(node.members.map((m) => m.topologyId), FOUNDRY_TOPOLOGIES);
  for (const member of node.members) {
    assert.equal(member.options.agents.agents, FOUNDRY_AGENTS);
    assert.equal(member.options.agents.seats, FOUNDRY_SEATS);
    assert.equal(member.options.runControl.agenda.strategy, "ritual");
    assert.equal(member.options.runControl.execution.mutationAuthority, "blocked");
    assert.equal(member.options.params.num_predict, 6000, "the engine's snake_case params vocabulary — the key dispatch actually reads");
    assert.equal(member.options.timeoutMs, 300000);
  }
});

test("the preset entry is deep-frozen (canon immutability) and carries its provenance", () => {
  // DEEP freeze — every reachable object, not just the top level (the verify
  // fleet caught the original shallow assertion passing over mutable nodes).
  const walk = (value, path) => {
    if (value && typeof value === "object") {
      assert.ok(Object.isFrozen(value), `${path} must be frozen`);
      for (const key of Object.keys(value)) walk(value[key], `${path}.${key}`);
    }
  };
  walk(FOUNDRY_GRAPH_PRESET, "preset");
  assert.ok(Object.isFrozen(FOUNDRY_AGENTS));
  assert.ok(Object.isFrozen(FOUNDRY_SEATS));
  assert.equal(FOUNDRY_GRAPH_PRESET.provenance.source, "canon");
  assert.match(FOUNDRY_GRAPH_PRESET.provenance.referenceBasis, /A106/);
  assert.equal(FOUNDRY_MASTER_SEED, "foundry-a94-20260710");
});

test("presets plan: genome flags are reserved out of the lineup (no phantom seats, no machine paths in records)", () => {
  const out = execFileSync(process.execPath, [
    join(repoRoot, "cli", "illuci.mjs"), "presets", "plan", "foundry", "smoke task",
    "--record", "false", "--genome-project-dir", "C:/fake-root", "--genome-child-identity", "inherit", "--json",
  ], { encoding: "utf8", cwd: repoRoot });
  const plan = JSON.parse(out);
  for (const bag of [plan.invocationLineup, plan.resolvedLineup, ...plan.compiledNode.members.map((m) => m.lineup)]) {
    for (const key of Object.keys(bag || {})) {
      assert.ok(!key.startsWith("genome-"), `genome flag leaked into lineup as seat "${key}"`);
    }
  }
});
