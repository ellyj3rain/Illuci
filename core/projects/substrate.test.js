import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyProjectSubstratePlan,
  buildProjectSubstratePlan,
  captureProjectSubstrateObservation,
  doctorProjectSubstrate,
  listProjectData,
  materializeProjectSubstrate,
  readProjectData,
  recordProjectData,
} from "./substrate.js";

function tempGitProject(name) {
  const dir = mkdtempSync(join(tmpdir(), name));
  execFileSync("git", ["-C", dir, "init"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  writeFileSync(join(dir, "VERSION"), "0.1.0\n", "utf8");
  return dir;
}

test("project substrate attach plans explicit dev bridge, runtime data, IDE, and optional hooks without applying", () => {
  const dir = tempGitProject("illuci-substrate-attach-plan-");
  try {
    const plan = buildProjectSubstratePlan(dir, { hooks: true, localRuntime: true });
    assert.equal(plan.schema, "illuci.project.substrate.plan/1");
    assert.equal(plan.blocked, false);
    assert.equal(plan.apply, false);
    assert.equal(plan.profile, "attach");
    assert.equal(plan.target.repoRoot, dir);
    assert.ok(plan.actions.some((step) => step.path.endsWith(join(".illuci", "project.json"))));
    assert.ok(plan.actions.some((step) => step.path.endsWith(join(".illuci", "bridge.local.json")) && step.local));
    assert.ok(plan.actions.some((step) => step.path.endsWith(join(".illuci", "data", "observations")) && step.local));
    assert.ok(plan.actions.some((step) => step.path.endsWith(join(".illuci", "ide.local", "mcp.json")) && step.local));
    assert.ok(plan.actions.some((step) => step.kind === "git-config" && step.key === "core.hooksPath"));
    assert.equal(existsSync(join(dir, ".illuci", "bridge.local.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate attach apply writes committed config and local data surfaces", () => {
  const dir = tempGitProject("illuci-substrate-attach-apply-");
  try {
    const out = materializeProjectSubstrate(dir, { apply: true, localRuntime: true });
    assert.equal(out.result.ok, true);
    assert.equal(existsSync(join(dir, ".illuci", "project.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "bridge.local.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "ide.local", "mcp.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "data", "runs")), true);
    assert.equal(existsSync(join(dir, ".illuci", "data", "research")), true);

    const project = JSON.parse(readFileSync(join(dir, ".illuci", "project.json"), "utf8"));
    assert.equal(project.substrate.schema, "illuci.project.substrate/1");
    assert.equal(project.substrate.bridgeManifest, ".illuci/bridge.local.json");
    assert.equal(project.substrate.runtimeData, ".illuci/data/");
    assert.equal(project.substrate.legacyRuntimeData, ".illuci/runtime/");
    assert.equal(project.substrate.sandboxRuntime.root, ".illuci-sandboxes/");
    assert.equal(project.substrate.sandboxRuntime.branchPrefix, "illuci/sandbox/");
    assert.equal(project.substrate.dataStreams.telemetry, ".illuci/data/telemetry");
    assert.equal(project.substrate.researchRuntime.nodeCore, "orchestration-governance-cli-ide-bridges");
    assert.equal(project.substrate.researchRuntime.pythonBoundary, "planned-service-or-worker-boundary");
    assert.equal(project.governanceStandardId, "gzs-governance-standard");

    const bridge = JSON.parse(readFileSync(join(dir, ".illuci", "bridge.local.json"), "utf8"));
    assert.equal(bridge.schema, "illuci.project.bridge.local/1");
    assert.equal(bridge.projectRoot, dir);
    assert.ok(bridge.surfaces.cli.args[0].endsWith(join("cli", "illuci.mjs")));
    assert.ok(bridge.surfaces.mcp.args[0].endsWith(join("core", "mcp", "server.js")));
    assert.equal(bridge.sandboxRuntime.branchPrefix, "illuci/sandbox/");
    assert.ok(bridge.sandboxRuntime.root.endsWith(".illuci-sandboxes"));
    assert.deepEqual(bridge.researchRuntime.integrationPatterns, ["http-service", "ndjson-subprocess", "queue-worker", "shared-storage"]);

    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /\.illuci\/bridge\.local\.json/);
    assert.match(exclude, /\.illuci\/ide\.local\//);
    assert.match(exclude, /\.illuci\/data\//);
    assert.match(exclude, /\.illuci\/runtime\//);
    assert.match(exclude, /\.illuci-sandboxes\//);
    assert.match(exclude, /\.idea\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate attach resolves local excludes for linked git worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-substrate-linked-root-"));
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  try {
    mkdirSync(primary, { recursive: true });
    execFileSync("git", ["-C", primary, "init"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", primary, "config", "user.email", "illuci@example.invalid"], { encoding: "utf8" });
    execFileSync("git", ["-C", primary, "config", "user.name", "illuci test"], { encoding: "utf8" });
    writeFileSync(join(primary, "VERSION"), "0.1.0\n", "utf8");
    execFileSync("git", ["-C", primary, "add", "VERSION"], { encoding: "utf8" });
    execFileSync("git", ["-C", primary, "commit", "-m", "initial"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", primary, "worktree", "add", "-b", "linked-substrate", linked], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    const out = materializeProjectSubstrate(linked, { apply: true, localRuntime: true });
    assert.equal(out.result.ok, true);
    assert.equal(existsSync(join(linked, ".illuci", "project.json")), true);

    const gitPath = execFileSync("git", ["-C", linked, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
    const exclude = readFileSync(resolve(linked, gitPath), "utf8");
    assert.match(exclude, /\.illuci\/bridge\.local\.json/);
    assert.match(exclude, /\.illuci\/data\//);
    assert.equal(doctorProjectSubstrate(linked, { localRuntime: true }).status, "pass");
  } finally {
    try { execFileSync("git", ["-C", primary, "worktree", "remove", "--force", linked], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("project substrate create materializes a new governed repo skeleton", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-substrate-create-root-"));
  const dir = join(root, "created-project");
  try {
    const planned = buildProjectSubstratePlan(dir, { profile: "create", name: "Created Project", localRuntime: true });
    assert.equal(planned.blocked, false);
    assert.ok(planned.actions.some((step) => step.kind === "root-directory"));
    assert.ok(planned.actions.some((step) => step.kind === "git-init"));
    assert.ok(planned.actions.some((step) => step.path.endsWith("CORE.md")));

    const out = materializeProjectSubstrate(dir, { profile: "create", apply: true, name: "Created Project", localRuntime: true });
    assert.equal(out.result.ok, true);
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.equal(readFileSync(join(dir, "VERSION"), "utf8"), "0.1.0\n");
    assert.equal(existsSync(join(dir, "CORE.md")), true);
    assert.equal(existsSync(join(dir, "GOVERNANCE.md")), true);
    assert.equal(existsSync(join(dir, "BATCH_LOG.md")), true);
    assert.match(readFileSync(join(dir, "DECISION_REGISTRY.md"), "utf8"), /DR-001/);
    assert.equal(existsSync(join(dir, "illuci-governance.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "data", "observations")), true);
    assert.equal(existsSync(join(dir, ".illuci", "runtime", "observations")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project substrate can arm repository hooks when explicitly requested", () => {
  const dir = tempGitProject("illuci-substrate-hooks-");
  try {
    const out = materializeProjectSubstrate(dir, { apply: true, hooks: true, localRuntime: true });
    assert.equal(out.result.ok, true);
    const hooksPath = execFileSync("git", ["-C", dir, "config", "--local", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
    assert.ok(hooksPath.endsWith(join("core", "governance", "authortime", "hooks")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate attach blocks missing targets", () => {
  const missing = join(tmpdir(), "illuci-substrate-missing-" + Date.now());
  const plan = buildProjectSubstratePlan(missing, { localRuntime: true });
  assert.equal(plan.blocked, true);
  assert.equal(plan.actions.length, 0);
  const result = applyProjectSubstratePlan(plan);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === "target-missing"));
});

test("project substrate doctor passes refreshed projects and fails damaged projects", () => {
  const dir = tempGitProject("illuci-substrate-doctor-");
  try {
    const out = materializeProjectSubstrate(dir, { apply: true, localRuntime: true });
    assert.equal(out.result.ok, true);
    const healthy = doctorProjectSubstrate(dir, { localRuntime: true });
    assert.equal(healthy.status, "pass");

    const damaged = tempGitProject("illuci-substrate-damaged-");
    try {
      const result = doctorProjectSubstrate(damaged, { localRuntime: true });
      assert.equal(result.status, "fail");
      assert.ok(result.findings.some((finding) => finding.code === "project-config-missing-or-invalid"));
      assert.ok(result.findings.some((finding) => finding.code === "data-lane-missing"));
    } finally {
      rmSync(damaged, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate emits JetBrains snippets and gates host .idea files", () => {
  const dir = tempGitProject("illuci-substrate-jetbrains-");
  try {
    materializeProjectSubstrate(dir, { apply: true, ideProfiles: ["jetbrains"], localRuntime: true });
    assert.equal(existsSync(join(dir, ".illuci", "ide.local", "jetbrains", "bridge.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "ide.local", "jetbrains", "acp.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "ide.local", "jetbrains", "README.md")), true);
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_Project_Doctor.xml")), false);
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_ACP_Server.xml")), false);

    const missingHost = doctorProjectSubstrate(dir, { ideProfiles: ["jetbrains"], ideHostFiles: true, localRuntime: true });
    assert.equal(missingHost.status, "warn");
    assert.ok(missingHost.findings.some((finding) => finding.code === "jetbrains-doctor-host-file-missing"));
    assert.ok(missingHost.findings.some((finding) => finding.code === "jetbrains-acp-host-file-missing"));

    const host = materializeProjectSubstrate(dir, { apply: true, scope: "ide", ideProfiles: ["jetbrains"], ideHostFiles: true, localRuntime: true });
    assert.equal(host.result.ok, true);
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_Project_Doctor.xml")), true);
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_ACP_Server.xml")), true);

    const healthyHost = doctorProjectSubstrate(dir, { ideProfiles: ["jetbrains"], ideHostFiles: true, localRuntime: true });
    assert.equal(healthyHost.status, "pass");
    assert.ok(healthyHost.findings.some((finding) => finding.code === "jetbrains-doctor-host-file-present"));
    assert.ok(healthyHost.findings.some((finding) => finding.code === "jetbrains-acp-host-file-present"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate doctor reports and prunes stale sandbox directories", () => {
  const dir = tempGitProject("illuci-substrate-sandbox-hygiene-");
  try {
    materializeProjectSubstrate(dir, { apply: true, localRuntime: true });
    const staleDir = join(dir, ".illuci-sandboxes", "stale-seat");
    mkdirSync(staleDir, { recursive: true });

    const diagnosed = doctorProjectSubstrate(dir, { localRuntime: true });
    assert.equal(diagnosed.status, "warn");
    assert.equal(diagnosed.sandbox.counts.staleDirectories, 1);
    assert.ok(diagnosed.findings.some((finding) => finding.code === "sandbox-directory-stale"));

    const pruned = materializeProjectSubstrate(dir, { apply: true, scope: "hygiene", ide: false, sandboxPrune: true });
    assert.equal(pruned.result.ok, true);
    assert.equal(existsSync(staleDir), false);
    assert.ok(pruned.result.applied.some((step) => step.kind === "sandbox-prune"));

    const healthy = doctorProjectSubstrate(dir, { localRuntime: true });
    assert.equal(healthy.status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate records write canonical data and read legacy runtime data", () => {
  const dir = tempGitProject("illuci-substrate-data-");
  try {
    materializeProjectSubstrate(dir, { apply: true, localRuntime: true });
    const recorded = recordProjectData(dir, "research", { id: "rec-1", type: "note", payload: { ok: true } });
    assert.equal(recorded.ok, true);
    assert.equal(existsSync(join(dir, ".illuci", "data", "research", "records.jsonl")), true);
    assert.equal(existsSync(join(dir, ".illuci", "runtime", "research", "records.jsonl")), false);

    mkdirSync(join(dir, ".illuci", "runtime", "research"), { recursive: true });
    writeFileSync(join(dir, ".illuci", "runtime", "research", "records.jsonl"), JSON.stringify({ id: "legacy-1", lane: "research", type: "legacy" }) + "\n", "utf8");

    const listed = listProjectData(dir, { lane: "research" });
    assert.equal(listed.ok, true);
    assert.equal(listed.records.length, 2);
    assert.ok(listed.records.some((record) => record.id === "rec-1" && record._source.kind === "canonical"));
    assert.ok(listed.records.some((record) => record.id === "legacy-1" && record._source.kind === "legacy"));

    const read = readProjectData(dir, "rec-1", { lane: "research" });
    assert.equal(read.record.id, "rec-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate data list reports bad JSON without hiding valid records", () => {
  const dir = tempGitProject("illuci-substrate-bad-json-");
  try {
    materializeProjectSubstrate(dir, { apply: true, localRuntime: true });
    recordProjectData(dir, "traces", { id: "good-1", payload: { ok: true } });
    writeFileSync(join(dir, ".illuci", "data", "traces", "records.jsonl"), '{"id":"good-1","lane":"traces"}\nnot-json\n', "utf8");
    const listed = listProjectData(dir, { lane: "traces" });
    assert.equal(listed.ok, false);
    assert.equal(listed.records.length, 1);
    assert.equal(listed.errors.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project substrate capture writes control-plane observations for unattached targets", () => {
  const dir = tempGitProject("illuci-substrate-capture-unattached-");
  const control = mkdtempSync(join(tmpdir(), "illuci-substrate-control-"));
  try {
    const capture = captureProjectSubstrateObservation(dir, "doctor", { status: "fail" }, { controlRoot: control });
    assert.equal(capture.ok, true);
    assert.equal(capture.landingZone, "control-plane");
    assert.ok(capture.path.startsWith(join(control, ".illuci", "data", "observations")));
    const raw = readFileSync(capture.path, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].type, "substrate.doctor");
    assert.equal(raw[0].payload.schema, "illuci.project.substrate.capture/1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});

test("project substrate capture writes target observations for attached targets", () => {
  const dir = tempGitProject("illuci-substrate-capture-attached-");
  const control = mkdtempSync(join(tmpdir(), "illuci-substrate-control-unused-"));
  try {
    materializeProjectSubstrate(dir, { apply: true, localRuntime: true });
    const capture = captureProjectSubstrateObservation(dir, "refresh", { resultOk: true }, { controlRoot: control });
    assert.equal(capture.ok, true);
    assert.equal(capture.landingZone, "target");
    assert.ok(capture.path.startsWith(join(dir, ".illuci", "data", "observations")));
    assert.equal(existsSync(join(control, ".illuci", "data", "observations", "records.jsonl")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});

test("[A22.9/A69] runtime consumption: URL is default contract, local stdio is explicit dev-only", () => {
  const dir = tempGitProject("illuci-substrate-remote-");
  try {
    // Default: no bridge emission without a deployed runtime URL.
    const blockedPlan = buildProjectSubstratePlan(dir, {});
    assert.equal(blockedPlan.blocked, true);
    assert.equal(blockedPlan.actions.length, 0);
    assert.equal(blockedPlan.runtime.mode, "remote-required");
    assert.ok(blockedPlan.target.findings.some((finding) => finding.code === "remote-runtime-required"));

    // Explicit dev mode: local stdio remains available only when deliberately requested.
    const localPlan = buildProjectSubstratePlan(dir, { localRuntime: true });
    const localMcp = localPlan.actions.find((s) => s.path.endsWith(join(".illuci", "ide.local", "mcp.json"))).data;
    assert.ok(localMcp.mcpServers.illuci.command, "local mode launches stdio");
    assert.equal(localMcp.mcpServers.illuci.type, undefined);
    assert.equal(localPlan.bridge.runtime.mode, "local-stdio-dev");
    assert.equal(localPlan.bridge.remoteRuntime, undefined);
    assert.equal(localPlan.bridge.surfaces.mcp.transport, "stdio");

    // --runtime-url: the hosted Streamable-HTTP shape (Lane 1b — cold clone connects, no local launch).
    const plan = buildProjectSubstratePlan(dir, { runtimeUrl: "http://192.0.2.10:7473/", ideProfiles: ["codex"] });
    const mcp = plan.actions.find((s) => s.path.endsWith(join(".illuci", "ide.local", "mcp.json"))).data;
    assert.deepEqual(mcp.mcpServers.illuci, {
      type: "http",
      url: "http://192.0.2.10:7473/mcp",
      headers: { Authorization: "Bearer ${ILLUCI_RUNTIME_TOKEN}" },
    });
    assert.equal(plan.bridge.surfaces.mcp.transport, "http");
    assert.equal(plan.bridge.surfaces.mcp.url, "http://192.0.2.10:7473/mcp");
    assert.deepEqual(plan.bridge.remoteRuntime, {
      url: "http://192.0.2.10:7473",
      mcp: "http://192.0.2.10:7473/mcp",
      authorization: { scheme: "bearer", tokenEnv: "ILLUCI_RUNTIME_TOKEN" },
    });
    const codexProfile = plan.actions.find((s) => s.path.endsWith(join("codex", "bridge.json"))).data;
    assert.equal(codexProfile.mcpServers.illuci.type, "http", "IDE profile snippets consume the remote too");
    assert.ok(!JSON.stringify(plan.bridge).match(/Bearer [A-Za-z0-9]/), "no literal secret value is ever emitted");

    // A /mcp-suffixed URL and a custom token env normalize correctly.
    const suffixed = buildProjectSubstratePlan(dir, { runtimeUrl: "http://host:7473/mcp", runtimeTokenEnv: "MY_ILLUCI_TOKEN" });
    const suffixedMcp = suffixed.actions.find((s) => s.path.endsWith(join(".illuci", "ide.local", "mcp.json"))).data;
    assert.equal(suffixedMcp.mcpServers.illuci.url, "http://host:7473/mcp");
    assert.equal(suffixedMcp.mcpServers.illuci.headers.Authorization, "Bearer ${MY_ILLUCI_TOKEN}");

    // Ambient ILLUCI_RUNTIME_URL is the fallback; explicit option wins over it elsewhere.
    process.env.ILLUCI_RUNTIME_URL = "http://ambient:7473";
    try {
      const ambient = buildProjectSubstratePlan(dir, {});
      const ambientMcp = ambient.actions.find((s) => s.path.endsWith(join(".illuci", "ide.local", "mcp.json"))).data;
      assert.equal(ambientMcp.mcpServers.illuci.url, "http://ambient:7473/mcp");
    } finally {
      delete process.env.ILLUCI_RUNTIME_URL;
    }

    // Applied: the written mcp.json carries the remote shape end to end.
    const out = materializeProjectSubstrate(dir, { apply: true, runtimeUrl: "http://192.0.2.10:7473" });
    assert.equal(out.result.ok, true);
    const written = JSON.parse(readFileSync(join(dir, ".illuci", "ide.local", "mcp.json"), "utf8"));
    assert.equal(written.mcpServers.illuci.type, "http");
    assert.equal(written.mcpServers.illuci.url, "http://192.0.2.10:7473/mcp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
