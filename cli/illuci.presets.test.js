import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function runIlluci(args, env = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

const topologyGraphSpec = {
  nodes: [
    { id: "orchestrator", type: "orchestrator" },
    {
      id: "topology.cli",
      type: "topology",
      spec: {
        id: "cli-review-loop",
        name: "CLI Review Loop",
        description: "Runtime topology from CLI graph preset.",
        seats: [
          { id: "author", label: "Author", min: 1, max: 1, roleHint: "implementer", relationships: [{ type: "precedes", target: "reviewer", semantics: "submits-to" }] },
          { id: "reviewer", label: "Reviewer", min: 1, max: 1, roleHint: "reviewer", relationships: [] },
        ],
        phases: [
          { id: "draft", type: "single", seat: "author", input: "prompt" },
          { id: "review", type: "single", seat: "reviewer", input: "phase:draft" },
        ],
      },
    },
  ],
  edges: [{ from: "orchestrator", to: "topology.cli", type: "delegates-to" }],
};

test("presets CLI lists canonical presets and validates by id", () => {
  const rows = JSON.parse(runIlluci(["presets", "list", "--json"]));
  assert.ok(rows.some((row) => row.id === "direct-harness"));

  const validation = JSON.parse(runIlluci(["presets", "validate", "direct-harness", "--json"]));
  assert.equal(validation.valid, true);
  assert.equal(validation.status, "runnable");

  const inlineValidation = JSON.parse(runIlluci(["presets", "validate", "--spec", JSON.stringify({ id: "inline-graph", ...topologyGraphSpec }), "--json"]));
  assert.equal(inlineValidation.valid, true);
  assert.equal(inlineValidation.status, "runnable");
});

test("presets CLI creates runtime graph presets and materializes topology overlays", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-cli-presets-"));
  const env = {
    ILLUCI_GRAPH_PRESET_STORE: join(root, "graph-presets.json"),
    ILLUCI_RUNTIME_TOPOLOGY_STORE: join(root, "runtime-topologies.json"),
  };
  try {
    const created = JSON.parse(runIlluci(["presets", "create", "cli-graph", "--spec", JSON.stringify(topologyGraphSpec), "--json"], env));
    assert.equal(created.created, true);

    const resolved = JSON.parse(runIlluci(["presets", "resolve", "cli-graph", "--json"], env));
    assert.equal(resolved.telemetry.status, "resolved");

    const materialized = JSON.parse(runIlluci(["presets", "materialize-topology", "cli-graph", "topology.cli", "--json"], env));
    assert.equal(materialized.created, true);
    assert.equal(materialized.id, "cli-review-loop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("topologies CLI exposes curation metadata without hiding canonical registry JSON", () => {
  const registry = JSON.parse(runIlluci(["topologies", "--json"]));
  assert.equal(registry["devops-pipeline"].id, "devops-pipeline");

  const curated = JSON.parse(runIlluci(["topologies", "--curation", "--all", "--json"]));
  const devops = curated.find((row) => row.id === "devops-pipeline");
  assert.equal(devops.curation.status, "curation-needed");
  assert.ok(devops.curation.aliases.includes("devops"));
});

test("topologies CLI text surfaces seat cardinality constraints", () => {
  const output = runIlluci(["topologies"]);

  assert.match(output, /incident-command/);
  assert.match(output, /seats: commander 1\.\.1, ops 1\.\.1, investigator 1\.\.1, safety 1\.\.1, comms 1\.\.1, scribe 1\.\.1/);
  assert.match(output, /colosseum/);
  assert.match(output, /seats: gladiator 3\.\.7, emperor 1\.\.1, crowd 1\.\.3/);
});

test("presets CLI scaffolds pipeline presets, plans them, and runs behind the explicit gate", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-cli-preset-run-"));
  const env = {
    ILLUCI_GRAPH_PRESET_STORE: join(root, "graph-presets.json"),
    ILLUCI_GRAPH_PRESET_RECORD_STORE: join(root, "graph-preset-records.json"),
    ILLUCI_PRESET_RUN_ENABLED: "1",
    ILLUCI_PRESET_RUN_TEST_STUB: "1",
  };
  const spec = {
    stages: [
      { id: "research", topologyId: "research-swarm" },
      { id: "devops", topologyId: "devops-pipeline" },
    ],
  };
  try {
    const created = JSON.parse(runIlluci(["presets", "create", "cli-pipeline", "--kind", "pipeline", "--spec", JSON.stringify(spec), "--json"], env));
    assert.equal(created.created, true);

    const plan = JSON.parse(runIlluci(["presets", "plan", "cli-pipeline", "Repair the dependency bot", "--worker", "gpt-oss", "--json"], env));
    assert.equal(plan.planned, true);
    assert.equal(plan.compiledNode.kind, "pipeline");
    assert.equal(plan.resolvedLineup.worker, "gpt-oss");

    const companySpec = { members: [{ id: "direct-member", topologyId: "direct" }] };
    const createdCompany = JSON.parse(runIlluci(["presets", "create", "cli-company", "--kind", "company", "--spec", JSON.stringify(companySpec), "--json"], env));
    assert.equal(createdCompany.created, true);
    const companyPlan = JSON.parse(runIlluci(["presets", "plan", "cli-company", "Coordinate a direct run", "--json"], env));
    assert.equal(companyPlan.planned, true);
    assert.equal(companyPlan.compiledNode.kind, "company");

    const run = JSON.parse(runIlluci(["presets", "run", "cli-pipeline", "Repair the dependency bot", "--worker", "gpt-oss", "--json"], env));
    assert.equal(run.ran, true);
    assert.equal(run.resultSummary.status, "complete");
    assert.equal(run.plan.compiledNode.kind, "pipeline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("presets CLI accepts file-backed JSON for specs and lineups", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-cli-preset-files-"));
  const env = {
    ILLUCI_GRAPH_PRESET_STORE: join(root, "graph-presets.json"),
    ILLUCI_GRAPH_PRESET_RECORD_STORE: join(root, "graph-preset-records.json"),
    ILLUCI_PRESET_RUN_ENABLED: "1",
    ILLUCI_PRESET_RUN_TEST_STUB: "1",
  };
  const pipelineSpec = {
    stages: [
      { id: "incident", topologyId: "incident-command" },
      { id: "legislature", topologyId: "legislature" },
    ],
  };
  const graphSpec = { id: "file-graph", ...topologyGraphSpec };
  const specFile = join(root, "pipeline-spec.json");
  const graphFile = join(root, "graph-spec.json");
  const lineupFile = join(root, "lineup.json");
  writeFileSync(specFile, "\uFEFF" + JSON.stringify(pipelineSpec), "utf8");
  writeFileSync(graphFile, JSON.stringify(graphSpec), "utf8");
  writeFileSync(lineupFile, "\uFEFF" + JSON.stringify({ worker: "gpt-oss" }), "utf8");
  try {
    const created = JSON.parse(runIlluci(["presets", "create", "file-pipeline", "--kind", "pipeline", "--spec-file", specFile, "--json"], env));
    assert.equal(created.created, true);

    const validation = JSON.parse(runIlluci(["presets", "validate", "--spec", "@" + graphFile, "--json"], env));
    assert.equal(validation.valid, true);

    const plan = JSON.parse(runIlluci(["presets", "plan", "file-pipeline", "Assess shell-safe preset authoring", "--lineup-file", lineupFile, "--json"], env));
    assert.equal(plan.planned, true);
    assert.equal(plan.resolvedLineup.worker, "gpt-oss");

    const run = JSON.parse(runIlluci(["presets", "run", "file-pipeline", "Assess shell-safe preset authoring", "--lineup", "@" + lineupFile, "--json"], env));
    assert.equal(run.ran, true);
    assert.equal(run.resultSummary.status, "complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
