import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "illuci.mjs");
const REPO_ROOT = resolve(__dirname, "..");

function runCli(args, cwd) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

test("project assess defaults to the caller's current governed repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-project-default-"));
  try {
    writeFileSync(join(dir, "VERSION"), "1.2.3\n");
    const { code, stdout, stderr } = await runCli(["project", "assess", "--json"], dir);
    assert.equal(code, 0, stderr);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.version, "1.2.3");
    assert.equal(parsed.target.mode, "default-current");
    assert.equal(parsed.target.repoRoot, dir);
    assert.equal(parsed.target.governed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project assess can point at an explicit governed target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-project-explicit-"));
  try {
    writeFileSync(join(dir, "VERSION"), "2.0.0-beta\n");
    const { code, stdout, stderr } = await runCli(["project", "assess", dir, "--json"], REPO_ROOT);
    assert.equal(code, 0, stderr);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.version, "2.0.0-beta");
    assert.equal(parsed.target.mode, "explicit");
    assert.equal(parsed.target.requestedPath, dir);
    assert.equal(parsed.target.repoRoot, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project assess --target blocks missing targets without shelling into GZDS", async () => {
  const missing = join(tmpdir(), "illuci-project-missing-" + Date.now());
  const { code, stdout } = await runCli(["project", "assess", "--target", missing, "--json"], REPO_ROOT);
  assert.notEqual(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "blocked");
  assert.equal(parsed.target.mode, "explicit");
  assert.ok(parsed.findings.some((finding) => finding.code === "target-missing"));
});
test("project integrate plans and applies the illuci substrate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-project-integrate-"));
  try {
    writeFileSync(join(dir, "VERSION"), "0.1.0\n");
    const planned = await runCli(["project", "integrate", dir, "--local-runtime", "--json"], REPO_ROOT);
    assert.equal(planned.code, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.planned, true);
    assert.equal(plan.plan.profile, "attach");
    assert.equal(plan.plan.apply, false);
    assert.equal(existsSync(join(dir, ".illuci", "project.json")), false);

    const applied = await runCli(["project", "integrate", dir, "--apply", "--local-runtime", "--json"], REPO_ROOT);
    assert.equal(applied.code, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.result.ok, true);
    assert.equal(existsSync(join(dir, ".illuci", "project.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "bridge.local.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "data", "observations")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project create applies a new governed repo substrate", async () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-project-create-root-"));
  const dir = join(root, "made-project");
  try {
    const applied = await runCli(["project", "create", dir, "--name", "Made Project", "--apply", "--local-runtime", "--json"], REPO_ROOT);
    assert.equal(applied.code, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.result.ok, true);
    assert.equal(result.plan.profile, "create");
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.equal(existsSync(join(dir, "CORE.md")), true);
    assert.equal(existsSync(join(dir, "GOVERNANCE.md")), true);
    assert.equal(existsSync(join(dir, ".illuci", "project.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "data", "research")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("project substrate namespace refreshes, doctors, captures, lists, reads, and emits JetBrains ACP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-project-substrate-cli-"));
  try {
    writeFileSync(join(dir, "VERSION"), "0.1.0\n");
    const refresh = await runCli(["project", "substrate", "refresh", "--target", dir, "--apply", "--ide", "jetbrains", "--local-runtime", "--json"], REPO_ROOT);
    assert.equal(refresh.code, 0, refresh.stderr);
    const refreshed = JSON.parse(refresh.stdout);
    assert.equal(refreshed.capture.schema, "illuci.project.substrate.capture/1");
    assert.equal(refreshed.capture.landingZone, "target");
    assert.equal(existsSync(join(dir, ".illuci", "data", "telemetry")), true);
    assert.equal(existsSync(join(dir, ".illuci", "ide.local", "jetbrains", "bridge.json")), true);
    assert.equal(existsSync(join(dir, ".illuci", "ide.local", "jetbrains", "acp.json")), true);
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_Project_Doctor.xml")), false);
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_ACP_Server.xml")), false);

    const doctor = await runCli(["project", "substrate", "doctor", "--target", dir, "--ide", "jetbrains", "--local-runtime", "--json"], REPO_ROOT);
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctored = JSON.parse(doctor.stdout);
    assert.equal(doctored.status, "pass");
    assert.equal(doctored.capture.operation, "doctor");

    const record = await runCli(["project", "substrate", "record", "research", '{"id":"cli-rec","type":"note","payload":{"ok":true}}', "--target", dir, "--json"], REPO_ROOT);
    assert.equal(record.code, 0, record.stderr);
    const recorded = JSON.parse(record.stdout);
    assert.equal(recorded.record.id, "cli-rec");
    assert.equal(recorded.capture.operation, "record");

    const list = await runCli(["project", "substrate", "list", "research", "--target", dir, "--json"], REPO_ROOT);
    assert.equal(list.code, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].id, "cli-rec");
    assert.equal(listed.capture.operation, "list");

    const read = await runCli(["project", "substrate", "read", "cli-rec", "--lane", "research", "--target", dir, "--json"], REPO_ROOT);
    assert.equal(read.code, 0, read.stderr);
    const readRecord = JSON.parse(read.stdout);
    assert.equal(readRecord.record.id, "cli-rec");
    assert.equal(readRecord.capture.operation, "read");

    const payloadFile = join(dir, "substrate-payload.json");
    writeFileSync(payloadFile, JSON.stringify({ id: "cli-file-rec", type: "note", payload: { ok: true, source: "file" } }));
    const fileRecord = await runCli(["project", "substrate", "record", "decisions", "--payload-file", payloadFile, "--target", dir, "--json"], REPO_ROOT);
    assert.equal(fileRecord.code, 0, fileRecord.stderr);
    const fileRecorded = JSON.parse(fileRecord.stdout);
    assert.equal(fileRecorded.record.id, "cli-file-rec");
    assert.equal(fileRecorded.capture.operation, "record");

    const fileRead = await runCli(["project", "substrate", "read", "cli-file-rec", "--lane", "decisions", "--target", dir, "--json"], REPO_ROOT);
    assert.equal(fileRead.code, 0, fileRead.stderr);
    const fileReadRecord = JSON.parse(fileRead.stdout);
    assert.equal(fileReadRecord.record.payload.source, "file");

    const host = await runCli(["project", "substrate", "emit-ide", "--profile", "jetbrains", "--target", dir, "--host-files", "--apply", "--local-runtime", "--json"], REPO_ROOT);
    assert.equal(host.code, 0, host.stderr);
    const hosted = JSON.parse(host.stdout);
    assert.equal(hosted.capture.operation, "emit-ide");
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_Project_Doctor.xml")), true);
    assert.equal(existsSync(join(dir, ".idea", "runConfigurations", "Illuci_ACP_Server.xml")), true);


    const staleSandbox = join(dir, ".illuci-sandboxes", "cli-stale");
    mkdirSync(staleSandbox, { recursive: true });
    const prunePlan = await runCli(["project", "substrate", "prune", "--target", dir, "--json"], REPO_ROOT);
    assert.equal(prunePlan.code, 0, prunePlan.stderr);
    const plannedPrune = JSON.parse(prunePlan.stdout);
    assert.ok(plannedPrune.plan.actions.some((step) => step.kind === "sandbox-prune"));
    assert.equal(existsSync(staleSandbox), true);

    const prune = await runCli(["project", "substrate", "prune", "--target", dir, "--apply", "--json"], REPO_ROOT);
    assert.equal(prune.code, 0, prune.stderr);
    const pruned = JSON.parse(prune.stdout);
    assert.equal(pruned.capture.operation, "prune");
    assert.equal(existsSync(staleSandbox), false);

    const observations = await runCli(["project", "substrate", "list", "observations", "--target", dir, "--json"], REPO_ROOT);
    assert.equal(observations.code, 0, observations.stderr);
    const observed = JSON.parse(observations.stdout);
    assert.ok(observed.records.some((entry) => entry.type === "substrate.refresh"));
    assert.ok(observed.records.some((entry) => entry.type === "substrate.emit-ide"));
    assert.ok(observed.records.some((entry) => entry.type === "substrate.prune"));
    assert.equal(observed.capture.operation, "list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
