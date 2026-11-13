import { test } from "node:test";
import assert from "node:assert/strict";

import { WORK_THREAD_DECISIONS, classifyWorkThreads } from "./work-thread-classifier.js";

test("transition with uncaptured high-value conceptual work requires capture", () => {
  const r = classifyWorkThreads({
    transitionRequested: true,
    threads: [
      {
        id: "classifier-hardening",
        title: "Harden classifier beyond booleans",
        kind: "classifier",
        status: "open",
        captured: false,
        hasNextAction: false,
      },
    ],
  });

  assert.equal(r.decision, WORK_THREAD_DECISIONS.CAPTURE_REQUIRED);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.equal(r.code, "transition-capture-required");
  assert.ok(r.signals.some((signal) => signal.code === "uncaptured-work-thread"));
  assert.ok(r.signals.some((signal) => signal.code === "transition-kernel-needed"));
});

test("transition is allowed when open threads are captured in the transition kernel", () => {
  const r = classifyWorkThreads({
    transitionRequested: true,
    transitionKernelReady: true,
    threads: [
      {
        id: "security-sidecars",
        title: "Security sidecar governance",
        kind: "security",
        status: "deferred",
        captured: true,
        hasNextAction: true,
        owner: "operator",
      },
    ],
  });

  assert.equal(r.decision, WORK_THREAD_DECISIONS.TRANSITION_WITH_CAPTURE);
  assert.equal(r.allowed, true);
  assert.equal(r.code, "transition-with-captured-threads");
  assert.equal(r.next, "transition-with-kernel");
});

test("open PR state is treated as continuity loss when not captured", () => {
  const r = classifyWorkThreads({
    transitionRequested: true,
    openPrCount: 2,
    prStateCaptured: false,
    threads: [],
  });

  assert.equal(r.allowed, false);
  assert.equal(r.code, "transition-capture-required");
  assert.ok(r.signals.some((signal) => signal.code === "open-pr-state-uncaptured"));
});

test("without transition request, blocking work routes to operator decision", () => {
  const r = classifyWorkThreads({
    threads: [
      {
        id: "merge-cleanup",
        title: "Finish PR cleanup",
        kind: "pr-cleanup",
        status: "open",
        captured: true,
        hasNextAction: true,
        owner: "codex",
        blocking: true,
      },
    ],
  });

  assert.equal(r.decision, WORK_THREAD_DECISIONS.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "open-thread-governance-hazard");
});
