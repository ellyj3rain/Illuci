/**
 * illuci — Standing org + session records + distillation tests (node:test)
 *
 * M5 acceptance: org.json round-trips and validates against the charter;
 * session-kind policy pins fixed arrangements; session records are immutable
 * stratum-4 joins; distillation appends project lessons (stratum 2) and
 * persona experiences keyed by agentSlug (stratum 3); the persona digest
 * recalls accrued history and renders into the [You] frame block — and the
 * digest survives a model hotswap because it keys on identity, never model.
 *
 * File-based throughout (F-016: no sqlite imports anywhere on this path).
 *
 * Run: node --test illuci/core/sessions/record.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createOrg, validateOrg, saveOrg, loadOrg, applyKindPolicy } from "../projects/org.js";
import {
  buildSessionRecord, appendSessionRecord, listSessionRecords, getSessionRecord,
  distillSession, loadAgentDigest, loadPersonaDigest,
} from "./record.js";
import { renderYouBlock } from "../topologies/frame.js";
import { getTopology } from "../topologies/index.js";

function tmpProject() {
  return mkdtempSync(join(tmpdir(), "illuci-m5-"));
}

const TRACE = {
  topologyId: "adversarial-debate",
  startedAt: "2026-06-11T01:00:00Z",
  completedAt: "2026-06-11T01:05:00Z",
  halted: false,
  lineup: { red: ["deepseek"], blue: ["glm"], arbiter: ["kimi-cloud"] },
  agenda: { mode: "derived" },
  arrangement: [
    { t: "t0", type: "run_started" },
    { t: "t1", type: "checkpoint", action: "proceed" },
    { t: "t2", type: "checkpoint", action: "redirect", intent: "actually compare on write-throughput" },
    { t: "t3", type: "run_completed" },
  ],
  phases: { "layer-0": {}, "layer-1": {}, "arbiter": {} },
};
const MANDATE = { operator: { name: "Example" }, intent: { raw: "Pick a database for OTL", revision: 1 } };

test("org: create → validate → save → load round-trip against the charter", () => {
  const dir = tmpProject();
  try {
    const topo = getTopology("adversarial-debate");
    const org = createOrg({
      charterId: "adversarial-debate",
      kind: "fixed",
      lineup: { red: "deepseek", blue: "glm" },
      personas: { red: { agentSlug: "maverick", presetId: "maverick", skills: ["code-review"] } },
      anchor: { mode: "operator" },
    });
    const v = validateOrg(org, topo);
    assert.equal(v.valid, true, v.errors.join("; "));
    saveOrg(dir, org);
    const loaded = loadOrg(dir);
    assert.equal(loaded.charterId, "adversarial-debate");
    assert.equal(loaded.personas.red.agentSlug, "maverick");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("org validation rejects unknown seats, missing agentSlug, unbounded delegated anchor", () => {
  const topo = getTopology("adversarial-debate");
  const bad = createOrg({
    charterId: "adversarial-debate",
    lineup: { nosuch: "deepseek" },
    personas: { blue: { presetId: "critic" } },
    anchor: { mode: "delegated" },
  });
  const v = validateOrg(bad, topo);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('unknown seat "nosuch"')));
  assert.ok(v.errors.some((e) => e.includes("no agentSlug")));
  assert.ok(v.errors.some((e) => e.includes("requires an explicit modelId")));
});

test("kind policy: fixed pins the arrangement (conducted → derived, recorded); dynamic does not", () => {
  const pinned = applyKindPolicy("fixed", "conducted");
  assert.equal(pinned.agendaMode, "derived");
  assert.equal(pinned.downgraded, true);
  assert.match(pinned.reason, /fixed/);
  const free = applyKindPolicy("dynamic", "conducted");
  assert.equal(free.agendaMode, "conducted");
  assert.equal(free.downgraded, false);
  const ritualOk = applyKindPolicy("fixed", "ritual");
  assert.equal(ritualOk.downgraded, false);
});

test("session record: build → append (immutable) → list summary", () => {
  const dir = tmpProject();
  try {
    const record = buildSessionRecord({ sessionId: "illuci-test-1", trace: TRACE, mandate: MANDATE, org: { kind: "fixed" } });
    assert.equal(record.topologyId, "adversarial-debate");
    assert.equal(record.kind, "fixed");
    assert.equal(record.arrangement.length, 4);
    appendSessionRecord(dir, record);
    assert.throws(() => appendSessionRecord(dir, record), /immutable/);
    const list = listSessionRecords(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, "illuci-test-1");
    assert.match(list[0].intent, /Pick a database/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("distillation: project lesson (stratum 2) + persona experiences keyed by agentSlug (stratum 3)", () => {
  const dir = tmpProject();
  try {
    const org = { kind: "dynamic", personas: { red: { agentSlug: "maverick" }, blue: { agentSlug: "sentinel" } } };
    const record = buildSessionRecord({ sessionId: "illuci-test-2", trace: TRACE, mandate: MANDATE, org });
    const out = distillSession(dir, record, org);
    // stratum 2: one project lesson with intervention count from the timeline
    const projectLog = readFileSync(join(dir, ".illuci", "data", "memory", "project.jsonl"), "utf-8").trim().split("\n");
    assert.equal(projectLog.length, 1);
    const lesson = JSON.parse(projectLog[0]);
    assert.equal(lesson.sessionId, "illuci-test-2");
    assert.equal(lesson.operatorInterventions, 2); // checkpoint + checkpoint_passed
    // stratum 3: agents by agentSlug where bound, model id where not
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "agents", "maverick.jsonl")));
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "agents", "sentinel.jsonl")));
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "agents", "kimi-cloud.jsonl")), "unbound seat falls back to model id");
    // legacy alias remains present for old callers and genome storage adjacency.
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "personas", "maverick.jsonl")));
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "personas", "sentinel.jsonl")));
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "personas", "kimi-cloud.jsonl")), "unbound seat falls back to model id");
    assert.deepEqual(Object.keys(out.agents).sort(), ["kimi-cloud", "maverick", "sentinel"]);
    assert.deepEqual(Object.keys(out.personas).sort(), ["kimi-cloud", "maverick", "sentinel"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("session and persona digest reads legacy .illuci lanes", () => {
  const dir = tmpProject();
  try {
    const record = buildSessionRecord({ sessionId: "legacy-1", trace: TRACE, mandate: MANDATE, org: { kind: "fixed" } });
    mkdirSync(join(dir, ".illuci", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".illuci", "sessions", "legacy-1.json"), JSON.stringify(record), "utf-8");
    assert.equal(listSessionRecords(dir)[0].sessionId, "legacy-1");
    assert.equal(getSessionRecord(dir, "legacy-1").sessionId, "legacy-1");

    mkdirSync(join(dir, ".illuci", "memory", "personas"), { recursive: true });
    writeFileSync(
      join(dir, ".illuci", "memory", "personas", "maverick.jsonl"),
      JSON.stringify({ sessionId: "legacy-1", topologyId: "adversarial-debate", seat: "red", intent: "legacy" }) + "\n",
      "utf-8",
    );
    const digest = loadPersonaDigest(dir, "maverick");
    assert.equal(digest.sessions, 1);
    assert.deepEqual(digest.seats, ["red"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("agent assignments on repeated seats distill to separate agent memories", () => {
  const dir = tmpProject();
  try {
    const trace = {
      ...TRACE,
      lineup: { investigator: ["deepseek", "glm"] },
      agentAssignments: {
        investigator: [
          { agentId: "researcher-a", agentSlug: "researcher-a", model: "deepseek" },
          { agentId: "researcher-b", agentSlug: "researcher-b", model: "glm" },
        ],
      },
    };
    const record = buildSessionRecord({ sessionId: "agents-1", trace, mandate: MANDATE, org: { kind: "dynamic" } });
    distillSession(dir, record);

    const a = JSON.parse(readFileSync(join(dir, ".illuci", "data", "memory", "agents", "researcher-a.jsonl"), "utf-8").trim());
    const b = JSON.parse(readFileSync(join(dir, ".illuci", "data", "memory", "agents", "researcher-b.jsonl"), "utf-8").trim());
    assert.equal(a.seat, "investigator");
    assert.equal(a.model, "deepseek");
    assert.equal(b.seat, "investigator");
    assert.equal(b.model, "glm");
    assert.equal(loadAgentDigest(dir, "researcher-a").sessions, 1);
    assert.equal(loadAgentDigest(dir, "researcher-b").sessions, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("persona digest: recall not replay — and it SURVIVES a model hotswap (identity-keyed)", () => {
  const dir = tmpProject();
  try {
    const org = { kind: "dynamic", personas: { red: { agentSlug: "maverick" } } };
    // session 1: maverick rides deepseek
    distillSession(dir, buildSessionRecord({ sessionId: "s1", trace: TRACE, mandate: MANDATE, org }), org);
    // session 2: HOTSWAP — maverick now rides glm; same identity
    const swapped = { ...TRACE, lineup: { ...TRACE.lineup, red: ["glm"] } };
    distillSession(dir, buildSessionRecord({ sessionId: "s2", trace: swapped, mandate: MANDATE, org }), org);

    const digest = loadAgentDigest(dir, "maverick");
    assert.equal(digest.sessions, 2, "both sessions accrued to ONE persona across the model swap");
    assert.deepEqual(digest.seats, ["red"]);
    assert.match(digest.summary, /2 prior session/);

    // and it renders into the [You] frame block
    const you = renderYouBlock("maverick", digest);
    assert.match(you, /^\[You\]/);
    assert.match(you, /capable collaborator first/);
    assert.match(you, /2 prior session/);
    // no history → block still renders identity line; no digest line
    const fresh = renderYouBlock("newcomer", null);
    assert.match(fresh, /newcomer/);
    assert.ok(!fresh.includes("prior session"));
    // unknown persona digest is null (graceful)
    assert.equal(loadPersonaDigest(dir, "nobody"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent assignment memory survives model hotswap without using the awareness bus", () => {
  const dir = tmpProject();
  try {
    const base = {
      ...TRACE,
      lineup: { implementer: ["qwen-code"] },
      agentAssignments: { implementer: [{ agentId: "builder", agentSlug: "builder", model: "qwen-code" }] },
      phases: {
        publish: { responses: [{ seat: "awareness", model: "bus", response: "shared observation" }] },
      },
    };
    const swapped = {
      ...base,
      lineup: { implementer: ["codex-local"] },
      agentAssignments: { implementer: [{ agentId: "builder", agentSlug: "builder", model: "codex-local" }] },
    };

    distillSession(dir, buildSessionRecord({ sessionId: "agent-s1", trace: base, mandate: MANDATE, org: { kind: "dynamic" } }));
    distillSession(dir, buildSessionRecord({ sessionId: "agent-s2", trace: swapped, mandate: MANDATE, org: { kind: "dynamic" } }));

    const digest = loadAgentDigest(dir, "builder");
    assert.equal(digest.sessions, 2);
    assert.deepEqual(digest.seats, ["implementer"]);
    assert.equal(existsSync(join(dir, ".illuci", "data", "memory", "agents", "bus.jsonl")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
