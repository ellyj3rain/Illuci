// illuci/core/governance/classifiers/work-thread-classifier.js
//
// Classifies conceptual work threads before session transition, focus shift, or
// PR cleanup. This is not Codex app thread management. It is a continuity and
// loss classifier for unresolved concepts, features, decisions, and artifacts.

import { SEVERITIES, bool, int, list, makeGovernedVerdict, makeSignal, norm } from "./governed-verdict.js";

export const WORK_THREAD_DECISIONS = Object.freeze({
  CONTINUE_HERE: "continue-here",
  TRANSITION_WITH_CAPTURE: "transition-with-capture",
  CAPTURE_REQUIRED: "capture-required",
  OPERATOR_DECISION: "operator-decision",
});

const HIGH_VALUE_KINDS = new Set(["decision", "architecture", "security", "routing", "classifier", "governance", "pr-cleanup"]);

function normalizedThread(thread, index) {
  const status = norm(thread?.status) || "open";
  const kind = norm(thread?.kind) || "concept";
  return {
    id: String(thread?.id || `thread-${index + 1}`),
    title: String(thread?.title || thread?.summary || `Work thread ${index + 1}`),
    kind,
    status,
    source: String(thread?.source || "session"),
    captured: bool(thread?.captured),
    ledgered: bool(thread?.ledgered),
    hasNextAction: bool(thread?.hasNextAction) || Boolean(thread?.next),
    assignedOwner: bool(thread?.assignedOwner) || Boolean(thread?.owner),
    blocking: bool(thread?.blocking),
    value: norm(thread?.value) || (HIGH_VALUE_KINDS.has(kind) ? "high" : "normal"),
    data: thread && typeof thread === "object" ? thread : {},
  };
}

function isOpen(thread) {
  return !["closed", "resolved", "superseded", "discarded"].includes(thread.status);
}

function threadSignals(threads, input) {
  const signals = [];
  const open = threads.filter(isOpen);
  const uncaptured = open.filter((thread) => !thread.captured && !thread.ledgered);
  const unscheduled = open.filter((thread) => !thread.hasNextAction);
  const unowned = open.filter((thread) => !thread.assignedOwner);
  const blocking = open.filter((thread) => thread.blocking);
  const highValueOpen = open.filter((thread) => thread.value === "high");

  if (blocking.length > 0) {
    signals.push(makeSignal({
      code: "blocking-work-thread-open",
      severity: SEVERITIES.BLOCK,
      dimension: "continuity",
      evidence: `${blocking.length} blocking conceptual work thread(s) remain open`,
      next: "finish-or-explicitly-defer-blocking-thread",
      data: { threadIds: blocking.map((thread) => thread.id) },
    }));
  }

  if (uncaptured.length > 0) {
    signals.push(makeSignal({
      code: "uncaptured-work-thread",
      severity: bool(input.transitionRequested) ? SEVERITIES.OPERATOR : SEVERITIES.CAUTION,
      dimension: "context-retention",
      evidence: `${uncaptured.length} open conceptual thread(s) lack ledger, memory, or transition capture`,
      next: "capture-open-work-threads",
      data: { threadIds: uncaptured.map((thread) => thread.id) },
    }));
  }

  if (unscheduled.length > 0) {
    signals.push(makeSignal({
      code: "unscheduled-work-thread",
      severity: SEVERITIES.CAUTION,
      dimension: "next-action",
      evidence: `${unscheduled.length} open conceptual thread(s) lack a next action`,
      next: "assign-next-action-or-defer",
      data: { threadIds: unscheduled.map((thread) => thread.id) },
    }));
  }

  if (unowned.length > 0) {
    signals.push(makeSignal({
      code: "unowned-work-thread",
      severity: SEVERITIES.WATCH,
      dimension: "ownership",
      evidence: `${unowned.length} open conceptual thread(s) lack an owner or authority binding`,
      next: "assign-owner-or-authority",
      data: { threadIds: unowned.map((thread) => thread.id) },
    }));
  }

  if (bool(input.transitionRequested) && highValueOpen.length > 0 && !bool(input.transitionKernelReady)) {
    signals.push(makeSignal({
      code: "transition-kernel-needed",
      severity: SEVERITIES.OPERATOR,
      dimension: "handoff",
      evidence: `${highValueOpen.length} high-value open thread(s) require a transition kernel before context shift`,
      next: "write-transition-kernel",
      data: { threadIds: highValueOpen.map((thread) => thread.id) },
    }));
  }

  if (int(input.openPrCount, 0) > 0 && bool(input.transitionRequested) && !bool(input.prStateCaptured)) {
    signals.push(makeSignal({
      code: "open-pr-state-uncaptured",
      severity: SEVERITIES.OPERATOR,
      dimension: "gitops",
      evidence: `${int(input.openPrCount, 0)} open PR(s) exist and PR state has not been captured for transition`,
      next: "capture-pr-state",
      data: { openPrCount: int(input.openPrCount, 0) },
    }));
  }

  return signals;
}

export function classifyWorkThreads(input = {}) {
  const threads = list(input.threads).map(normalizedThread);
  const open = threads.filter(isOpen);
  const signals = threadSignals(threads, input);
  const captureReady = bool(input.captureReady) || bool(input.transitionKernelReady);
  const hasBlocking = signals.some((signal) => signal.severity === SEVERITIES.BLOCK || signal.severity === SEVERITIES.OPERATOR);

  let decision = WORK_THREAD_DECISIONS.CONTINUE_HERE;
  let code = open.length > 0 ? "open-threads-present" : "no-open-threads";
  let allowed = open.length === 0 || captureReady;
  let next = open.length === 0 ? "transition-safe" : "continue-or-capture";

  if (bool(input.transitionRequested)) {
    if (hasBlocking && !captureReady) {
      decision = WORK_THREAD_DECISIONS.CAPTURE_REQUIRED;
      code = "transition-capture-required";
      allowed = false;
      next = signals.find((signal) => signal.next)?.next || "capture-open-work-threads";
    } else if (open.length > 0) {
      decision = WORK_THREAD_DECISIONS.TRANSITION_WITH_CAPTURE;
      code = "transition-with-captured-threads";
      allowed = captureReady;
      next = captureReady ? "transition-with-kernel" : "capture-open-work-threads";
    } else {
      decision = WORK_THREAD_DECISIONS.TRANSITION_WITH_CAPTURE;
      code = "transition-clear";
      allowed = true;
      next = "transition-safe";
    }
  } else if (hasBlocking) {
    decision = WORK_THREAD_DECISIONS.OPERATOR_DECISION;
    code = "open-thread-governance-hazard";
    allowed = false;
    next = signals.find((signal) => signal.next)?.next || "resolve-work-thread-hazard";
  }

  return makeGovernedVerdict({
    classifier: "illuci.governance.work-thread",
    subject: input.subject || "session-continuity",
    decision,
    allowed,
    requiresOperator: hasBlocking && !captureReady,
    code,
    evidence: open.length > 0
      ? `${open.length} conceptual work thread(s) remain open`
      : "no conceptual work threads remain open",
    next,
    dimensions: {
      counts: {
        total: threads.length,
        open: open.length,
        captured: threads.filter((thread) => thread.captured || thread.ledgered).length,
        highValueOpen: open.filter((thread) => thread.value === "high").length,
      },
      transition: {
        requested: bool(input.transitionRequested),
        captureReady,
        transitionKernelReady: bool(input.transitionKernelReady),
      },
      openThreads: open.map((thread) => ({
        id: thread.id,
        title: thread.title,
        kind: thread.kind,
        status: thread.status,
        value: thread.value,
      })),
    },
    signals,
  });
}

export default { WORK_THREAD_DECISIONS, classifyWorkThreads };
