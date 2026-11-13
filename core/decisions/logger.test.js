import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionLogPath, decisionLogSources, logDecision, readDecisions } from "./logger.js";

test("decision logger writes runtime data to the configured data root", () => {
  const priorHome = process.env.ILLUCI_DATA_HOME;
  const priorFile = process.env.ILLUCI_DECISIONS_FILE;
  const priorDir = process.env.ILLUCI_DECISIONS_DIR;
  const root = mkdtempSync(join(tmpdir(), "illuci-decision-log-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    delete process.env.ILLUCI_DECISIONS_FILE;
    delete process.env.ILLUCI_DECISIONS_DIR;

    const record = logDecision({
      humanStatus: "operator-initiated",
      modelStatus: { model: "test", role: "recorder" },
      context: "decision logger test",
      type: "test-runtime-route",
      decision: "write to typed runtime data root",
    });

    const expected = join(root, "decisions", "decisions.jsonl");
    assert.equal(decisionLogPath(), expected);
    assert.equal(existsSync(expected), true);
    assert.match(readFileSync(expected, "utf-8"), new RegExp(record.id));
    assert.equal(readDecisions({ type: "test-runtime-route" }).at(-1).id, record.id);
  } finally {
    if (priorHome == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = priorHome;
    if (priorFile == null) delete process.env.ILLUCI_DECISIONS_FILE;
    else process.env.ILLUCI_DECISIONS_FILE = priorFile;
    if (priorDir == null) delete process.env.ILLUCI_DECISIONS_DIR;
    else process.env.ILLUCI_DECISIONS_DIR = priorDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("decision logger honors an explicit decision file override", () => {
  const priorFile = process.env.ILLUCI_DECISIONS_FILE;
  const root = mkdtempSync(join(tmpdir(), "illuci-decision-file-"));
  try {
    const file = join(root, "custom", "decisions.jsonl");
    process.env.ILLUCI_DECISIONS_FILE = file;
    const record = logDecision({
      humanStatus: "operator-approved",
      modelStatus: { model: "test", role: "recorder" },
      context: "decision file override test",
      type: "test-explicit-file",
      decision: "write to override file",
    });
    assert.equal(decisionLogPath(), file);
    assert.equal(JSON.parse(readFileSync(file, "utf-8").trim()).id, record.id);
  } finally {
    if (priorFile == null) delete process.env.ILLUCI_DECISIONS_FILE;
    else process.env.ILLUCI_DECISIONS_FILE = priorFile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("decision reads can expose and filter seed/runtime sources", () => {
  const priorHome = process.env.ILLUCI_DATA_HOME;
  const priorFile = process.env.ILLUCI_DECISIONS_FILE;
  const priorDir = process.env.ILLUCI_DECISIONS_DIR;
  const root = mkdtempSync(join(tmpdir(), "illuci-decision-source-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    delete process.env.ILLUCI_DECISIONS_FILE;
    delete process.env.ILLUCI_DECISIONS_DIR;

    const record = logDecision({
      humanStatus: "operator-initiated",
      modelStatus: { model: "test", role: "source-auditor" },
      context: "decision source test",
      type: "test-runtime-source",
      decision: "write live runtime decision",
    });

    const runtimeRecords = readDecisions({
      type: "test-runtime-source",
      source: "runtime",
      includeSource: true,
    });
    assert.equal(runtimeRecords.length, 1);
    assert.equal(runtimeRecords[0].id, record.id);
    assert.equal(runtimeRecords[0]._source.kind, "runtime");
    assert.equal(runtimeRecords[0]._source.path, join(root, "decisions", "decisions.jsonl"));

    const seedRecords = readDecisions({ type: "test-runtime-source", source: "seed" });
    assert.equal(seedRecords.length, 0);

    const sources = decisionLogSources();
    const runtime = sources.find((source) => source.kind === "runtime");
    const seed = sources.find((source) => source.kind === "seed");
    assert.equal(runtime.exists, true);
    assert.equal(runtime.count, 1);
    assert.equal(seed.exists, false); // Public source contains no private decision seed.
    assert.throws(() => readDecisions({ source: "scratch" }), /Invalid decision source/);
  } finally {
    if (priorHome == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = priorHome;
    if (priorFile == null) delete process.env.ILLUCI_DECISIONS_FILE;
    else process.env.ILLUCI_DECISIONS_FILE = priorFile;
    if (priorDir == null) delete process.env.ILLUCI_DECISIONS_DIR;
    else process.env.ILLUCI_DECISIONS_DIR = priorDir;
    rmSync(root, { recursive: true, force: true });
  }
});


test("existing gate denial status is retained and unknown statuses remain rejected", () => {
  const prior = process.env.ILLUCI_DECISIONS_FILE;
  const root = mkdtempSync(join(tmpdir(), "illuci-denied-status-"));
  try {
    const file = join(root, "decisions.jsonl"); process.env.ILLUCI_DECISIONS_FILE = file;
    const input = { humanStatus: "operator-denied", modelStatus: { model: "fixture" },
      context: "Synthetic gate refusal", type: "tool-gate", decision: "Denied fixture action" };
    const record = logDecision(input);
    assert.equal(record.humanStatus, "operator-denied");
    assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).id, record.id);
    for (const humanStatus of ["operator-denied-guess", "approved", ""]) assert.throws(() => logDecision({ ...input, humanStatus }));
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  } finally {
    if (prior === undefined) delete process.env.ILLUCI_DECISIONS_FILE; else process.env.ILLUCI_DECISIONS_FILE = prior;
    if (!root.startsWith(join(tmpdir(), "illuci-denied-status-"))) throw Error("Unexpected fixture cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});
