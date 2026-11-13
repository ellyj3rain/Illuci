/**
 * illuci — [A24.3] Tier-3 stopgap chain (node:test, hermetic — fake ports, no LLM)
 *
 * The chain: two independent adversarial auditors → J3rain → operator 2FA.
 * Every structural property of the ratified law is pinned here: Tier-3-only
 * intake, cross-model independence, vacuum brief purity, both-reports-to-
 * J3rain, the fail-closed default J3rain mock, pre-filter-never-authority,
 * the opaque unbypassable 2FA port, fail-closed on every error path, and the
 * replayable record for releases AND rejections.
 *
 * Run: node --test core/governance/stopgap/tier3-chain.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic records home BEFORE the module loads paths.
process.env.ILLUCI_DATA_HOME = mkdtempSync(join(tmpdir(), "illuci-stopgap-test-"));

const {
  STOPGAP_CODES,
  buildAuditorBrief,
  buildJ3rainBrief,
  createJ3rainPort,
  runTier3StopgapChain,
} = await import("./tier3-chain.js");

const TIER3_SUBJECT = Object.freeze({
  action: "force-mirror zero/main to the public forge",
  evidence: "operator requested a forward mirror after the A24 deliveries",
  tierVerdict: { code: "tier3-production-target", dimensions: { tier: 3 }, signals: [] },
});

const auditorOk = (modelId) => ({
  modelId,
  dispatch: async () => JSON.stringify({ verdict: "no-refutation-found", findings: [], confidence: 0.8 }),
});
const auditorRefute = (modelId, finding) => ({
  modelId,
  dispatch: async () => JSON.stringify({ verdict: "refute", findings: [finding], confidence: 0.9 }),
});
const j3rainPass = () => createJ3rainPort({ evaluator: async () => ({ decision: "pass-to-operator", reasoning: "coherent with operator law" }) });
const twoFactorYes = () => {
  const calls = [];
  return {
    calls,
    requestRelease: async (subject, evidence) => {
      calls.push({ subject, evidence });
      return { released: true, channel: "test-oob", evidence: "operator-approved" };
    },
  };
};

// ─── The happy path exists — and it takes ALL THREE stages ─────────────────────

test("A24.3: full release requires auditors + injected J3rain pass + operator 2FA", async () => {
  const twoFactor = twoFactorYes();
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("deepseek")],
    j3rain: j3rainPass(),
    twoFactor,
  });
  assert.equal(record.outcome.released, true);
  assert.equal(record.outcome.code, STOPGAP_CODES.RELEASED);
  assert.equal(record.stages.auditors.length, 2);
  assert.equal(record.stages.j3rain.decision, "pass-to-operator");
  assert.equal(twoFactor.calls.length, 1);
  // Both reports flowed to the 2FA evidence too (see-and-verify).
  assert.equal(twoFactor.calls[0].evidence.reports.length, 2);
});

// ─── Intake: the chain exists for Tier-3 only ──────────────────────────────────

test("A24.3: a non-Tier-3 subject is rejected at intake (auditors never run)", async () => {
  let dispatched = 0;
  const spy = { modelId: "kimi-cloud", dispatch: async () => { dispatched++; return "{}"; } };
  const record = await runTier3StopgapChain(
    { action: "x", tierVerdict: { dimensions: { tier: 2 } } },
    { auditors: [spy, { ...spy, modelId: "deepseek" }], j3rain: j3rainPass(), twoFactor: twoFactorYes() },
  );
  assert.equal(record.outcome.released, false);
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_NOT_TIER3);
  assert.equal(dispatched, 0);
});

// ─── Stage 1: independence is structural ───────────────────────────────────────

test("A24.3: same-model auditors are rejected (cross-model independence)", async () => {
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("kimi-cloud")],
    j3rain: j3rainPass(),
    twoFactor: twoFactorYes(),
  });
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_AUDITORS_NOT_INDEPENDENT);
});

test("A24.3: a failed or unparseable auditor fails the chain closed", async () => {
  const bad = { modelId: "deepseek", dispatch: async () => "no json here" };
  const thrown = { modelId: "deepseek", dispatch: async () => { throw new Error("route down"); } };
  for (const second of [bad, thrown]) {
    const record = await runTier3StopgapChain(TIER3_SUBJECT, {
      auditors: [auditorOk("kimi-cloud"), second],
      j3rain: j3rainPass(),
      twoFactor: twoFactorYes(),
    });
    assert.equal(record.outcome.released, false);
    assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_AUDITOR_FAILED);
  }
});

test("A24.3: the auditor brief is a pure vacuum of the subject (adversarial, isolated)", () => {
  const brief = buildAuditorBrief(TIER3_SUBJECT, 1);
  assert.match(brief, /INDEPENDENT ADVERSARIAL AUDITOR 1 of 2/);
  assert.match(brief, /vacuum/i);
  assert.match(brief, /REFUTATION/);
  assert.ok(brief.includes(TIER3_SUBJECT.action));
  assert.ok(brief.includes(TIER3_SUBJECT.evidence));
  // Purity: identical inputs compose the identical brief (no ambient state).
  assert.equal(brief, buildAuditorBrief(TIER3_SUBJECT, 1));
});

// ─── Stage 2: J3rain — fail-closed default, pre-filter never authority ─────────

test("A24.3: the DEFAULT J3rain port rejects everything, and 2FA is never invoked", async () => {
  const twoFactor = twoFactorYes();
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("deepseek")],
    // no j3rain port supplied → the ratified fail-closed mock
    twoFactor,
  });
  assert.equal(record.outcome.released, false);
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_J3RAIN_DEFAULT);
  assert.equal(record.stages.j3rain.injected, false);
  assert.equal(twoFactor.calls.length, 0, "the human channel is not spammed by default-path rejections");
});

test("A24.3: BOTH auditor reports flow to J3rain regardless of refutations", async () => {
  let seen = null;
  const j3rain = createJ3rainPort({
    evaluator: async ({ reports, brief }) => {
      seen = { reports, brief };
      return { decision: "reject", reasoning: "auditor 2's refutation stands" };
    },
  });
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorRefute("deepseek", "the mirror would overwrite provenance")],
    j3rain,
    twoFactor: twoFactorYes(),
  });
  assert.equal(seen.reports.length, 2);
  assert.equal(seen.reports[1].verdict, "refute");
  assert.match(seen.brief, /Auditor 1 report/);
  assert.match(seen.brief, /Auditor 2 report/);
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_BY_J3RAIN);
});

test("A24.3: a thrown J3rain evaluator fails closed", async () => {
  const j3rain = createJ3rainPort({ evaluator: async () => { throw new Error("fidelity method unavailable"); } });
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("deepseek")],
    j3rain,
    twoFactor: twoFactorYes(),
  });
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_J3RAIN_FAILED);
});

test("A24.3: a J3rain pass NEVER releases by itself (pre-filter, not authority)", async () => {
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("deepseek")],
    j3rain: j3rainPass(),
    // no 2FA port
  });
  assert.equal(record.outcome.released, false);
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_NO_2FA_CHANNEL);
});

// ─── Stage 3: the operator is the unbypassable key ─────────────────────────────

test("A24.3: an operator 2FA denial is terminal and recorded", async () => {
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("deepseek")],
    j3rain: j3rainPass(),
    twoFactor: { requestRelease: async () => ({ released: false }) },
  });
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_BY_OPERATOR);
});

test("A24.3: a thrown 2FA channel fails closed (never fail-open on channel error)", async () => {
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("deepseek")],
    j3rain: j3rainPass(),
    twoFactor: { requestRelease: async () => { throw new Error("channel offline"); } },
  });
  assert.equal(record.outcome.code, STOPGAP_CODES.REJECTED_2FA_FAILED);
});

// ─── The record: releases AND rejections are replayable evidence ───────────────

test("A24.3: every run yields a schema-stamped record with stages and terminal outcome", async () => {
  const record = await runTier3StopgapChain(TIER3_SUBJECT, {
    auditors: [auditorOk("kimi-cloud"), auditorOk("deepseek")],
    twoFactor: twoFactorYes(),
  });
  assert.equal(record.schema, "illuci.governance.tier3-stopgap/1");
  assert.ok(record.id.startsWith("t3s-"));
  assert.ok(record.startedAt && record.completedAt);
  assert.equal(record.subject.tier, 3);
  assert.ok(Array.isArray(record.stages.auditors));
  assert.ok(record.outcome && typeof record.outcome.released === "boolean");
});

test("A24.3: the J3rain brief carries the subject and both reports verbatim", () => {
  const reports = [
    { auditor: 1, modelId: "a", verdict: "no-refutation-found", findings: [] },
    { auditor: 2, modelId: "b", verdict: "refute", findings: ["x"] },
  ];
  const brief = buildJ3rainBrief(TIER3_SUBJECT, reports);
  assert.match(brief, /J3RAIN/);
  assert.match(brief, /not the authority/);
  assert.ok(brief.includes(TIER3_SUBJECT.action));
  assert.ok(brief.includes(JSON.stringify(reports[0])));
  assert.ok(brief.includes(JSON.stringify(reports[1])));
});
