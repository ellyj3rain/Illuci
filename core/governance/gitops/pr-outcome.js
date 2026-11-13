// illuci/core/governance/gitops/pr-outcome.js
//
// GitOps PR outcome corpus builder. This joins live PR state, classifier output,
// actuator posture, required-check policy, and post-merge check evidence into
// replayable records for governance review and later evaluation.

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { committedProvenancePath, runtimeDataPath } from "../../data/paths.js";
import { buildPrAutomationPlan, fetchPrAutomationSnapshot, parsePullRequestNumber, parseRepository } from "./pr-automation.js";

export const PR_OUTCOME_OBSERVATION_SCHEMA = "illuci.gitops.pr-outcome-observation/1";
export const PR_OUTCOME_SCHEMA = "illuci.gitops.pr-outcome/1";
export const PR_OUTCOME_CORPUS_CONTINUITY_SCHEMA = "illuci.gitops.pr-outcome-corpus-continuity/1";
export const PR_OUTCOME_OBSERVATION_RECORDS_RELPATH = ".illuci/data/gitops/pr-outcome-observations/records.jsonl";
export const PR_OUTCOME_RECORDS_RELPATH = ".illuci/data/gitops/pr-outcomes/records.jsonl";
export const PR_OUTCOME_CORPUS_RELPATH = "core/governance/gitops/corpus/pr-outcomes";

const DEFAULT_API_URL = "https://api.github.com";
const PASSING_RUN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const TERMINAL_PR_STATES = new Set(["MERGED", "CLOSED"]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
}

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function bool(value) {
  return value === true;
}

function uniq(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function tokenHeader(token) {
  const value = clean(token);
  if (!value) throw new Error("GITHUB_TOKEN, GH_TOKEN, or a supplied token is required for PR outcome collection");
  return value;
}

function parseLinkNext(linkHeader) {
  for (const part of String(linkHeader || "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function githubJson(url, { token, fetchImpl = fetch, method = "GET", body = null, accept = "application/vnd.github+json" } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${tokenHeader(token)}`,
      "content-type": "application/json",
      "user-agent": "illuci-pr-outcome-corpus",
      "x-github-api-version": "2022-11-28",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok) {
    const message = payload?.message || text || response.statusText || `HTTP ${response.status}`;
    const err = new Error(`GitHub API request failed (${response.status}): ${message}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return {
    data: payload,
    next: parseLinkNext(response.headers?.get?.("link")),
  };
}

async function listPaged(url, requestOptions) {
  const out = [];
  let next = url;
  while (next) {
    const page = await githubJson(next, requestOptions);
    out.push(...(Array.isArray(page.data) ? page.data : []));
    next = page.next;
  }
  return out;
}

export function prCorpusKey(prNumber) {
  return `pr-${String(int(prNumber, 0)).padStart(5, "0")}`;
}

export function isGeneratedPrOutcomeCorpusPullRequest(pr = {}) {
  const title = clean(pr.title);
  const headRef = clean(pr.head?.ref || pr.headRefName || pr.headRef || "");
  return /^\[A13\] Add PR #\d+ outcome corpus$/.test(title)
    || /^mallowfluff-a13-pr-outcome-corpus-pr-\d{5}$/.test(headRef);
}

function normalizeRun(run = {}) {
  const conclusion = clean(run.conclusion).toLowerCase() || null;
  const status = clean(run.status).toLowerCase() || null;
  const jobSummary = normalizeJobSummary(run.jobSummary || run.jobs || null);
  const normalized = {
    id: run.id || run.databaseId || null,
    name: run.name || run.workflowName || run.display_title || run.displayTitle || null,
    event: run.event || null,
    status,
    conclusion,
    passed: PASSING_RUN_CONCLUSIONS.has(conclusion),
    url: run.html_url || run.url || null,
    headBranch: run.head_branch || run.headBranch || null,
    headSha: run.head_sha || run.headSha || null,
    createdAt: run.created_at || run.createdAt || null,
    updatedAt: run.updated_at || run.updatedAt || null,
    jobSummary,
  };
  return {
    ...normalized,
    executionSubstrate: classifyRunExecutionSubstrate(normalized),
  };
}

function normalizeJob(job = {}) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const runnerName = clean(job.runner_name || job.runnerName);
  return {
    id: job.id || job.databaseId || null,
    name: job.name || null,
    status: clean(job.status).toLowerCase() || null,
    conclusion: clean(job.conclusion).toLowerCase() || null,
    runnerName: runnerName || null,
    labels: uniq(job.labels || []),
    stepsTotal: steps.length,
    startedAt: job.started_at || job.startedAt || null,
    completedAt: job.completed_at || job.completedAt || null,
  };
}

export function summarizeRunJobs(jobs = []) {
  const normalized = (Array.isArray(jobs) ? jobs : []).map(normalizeJob);
  const total = normalized.length;
  return {
    available: true,
    total,
    runnerAssigned: normalized.filter((job) => Boolean(job.runnerName)).length,
    unassignedRunnerJobs: normalized.filter((job) => !job.runnerName).length,
    emptyStepJobs: normalized.filter((job) => job.stepsTotal === 0).length,
    stepsTotal: normalized.reduce((sum, job) => sum + job.stepsTotal, 0),
    jobs: normalized,
  };
}

function normalizeJobSummary(input) {
  if (!input) return null;
  if (Array.isArray(input)) return summarizeRunJobs(input);
  if (Array.isArray(input.jobs) && input.available !== false && input.total === undefined) return summarizeRunJobs(input.jobs);
  if (input.available === false) {
    return {
      available: false,
      total: 0,
      runnerAssigned: 0,
      unassignedRunnerJobs: 0,
      emptyStepJobs: 0,
      stepsTotal: 0,
      error: input.error || null,
      statusCode: input.statusCode || null,
      jobs: [],
    };
  }
  const jobs = Array.isArray(input.jobs) ? input.jobs.map(normalizeJob) : [];
  const total = int(input.total, jobs.length);
  return {
    available: true,
    total,
    runnerAssigned: int(input.runnerAssigned, jobs.filter((job) => Boolean(job.runnerName)).length),
    unassignedRunnerJobs: int(input.unassignedRunnerJobs, Math.max(0, total - jobs.filter((job) => Boolean(job.runnerName)).length)),
    emptyStepJobs: int(input.emptyStepJobs, jobs.filter((job) => job.stepsTotal === 0).length),
    stepsTotal: int(input.stepsTotal, jobs.reduce((sum, job) => sum + job.stepsTotal, 0)),
    jobs,
  };
}

function classifyRunExecutionSubstrate(run = {}) {
  const failed = run.status === "completed" && !run.passed;
  const jobSummary = normalizeJobSummary(run.jobSummary);
  if (!failed) {
    return {
      provider: "github-actions",
      state: run.status === "completed" ? "completed" : run.status || "unknown",
      codeAttribution: run.passed ? "not-needed" : "unknown",
      upstreamOfCode: false,
      signals: [],
    };
  }
  if (!jobSummary) {
    return {
      provider: "github-actions",
      state: "failure-without-job-evidence",
      codeAttribution: "unknown",
      upstreamOfCode: false,
      signals: ["workflow-run-summary-only"],
    };
  }
  if (jobSummary.available === false) {
    return {
      provider: "github-actions",
      state: "job-evidence-unavailable",
      codeAttribution: "unknown",
      upstreamOfCode: false,
      signals: ["workflow-jobs-api-unavailable"],
    };
  }
  const noJobs = jobSummary.total === 0;
  const noRunnerOrSteps = jobSummary.total > 0
    && jobSummary.unassignedRunnerJobs === jobSummary.total
    && jobSummary.emptyStepJobs === jobSummary.total;
  if (noJobs || noRunnerOrSteps) {
    return {
      provider: "github-actions",
      state: "blocked-before-runner",
      codeAttribution: "not-evidenced",
      upstreamOfCode: true,
      entitlement: {
        plan: null,
        tier: null,
        posture: "quota-or-entitlement-suspected",
        source: "workflow-job-evidence",
      },
      suspectedCauses: [
        "hosted-platform-quota-or-entitlement",
        "hosted-runner-capacity-or-assignment",
        "workflow-permission-or-policy",
      ],
      signals: noJobs
        ? ["no-job-records"]
        : ["runner-unassigned", "zero-steps"],
    };
  }
  if (jobSummary.stepsTotal > 0 || jobSummary.runnerAssigned > 0) {
    return {
      provider: "github-actions",
      state: "runner-started",
      codeAttribution: "possible",
      upstreamOfCode: false,
      signals: ["runner-or-step-evidence-present"],
    };
  }
  return {
    provider: "github-actions",
    state: "failed-unknown",
    codeAttribution: "unknown",
    upstreamOfCode: false,
    signals: ["job-evidence-inconclusive"],
  };
}

function runSortTime(run = {}) {
  const parsed = Date.parse(run.updatedAt || run.createdAt || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestRunsByName(runs = []) {
  const latest = new Map();
  for (const run of runs) {
    const name = clean(run.name);
    if (!name) continue;
    const current = latest.get(name);
    if (!current || runSortTime(run) >= runSortTime(current)) latest.set(name, run);
  }
  return latest;
}

function summarizeRuns(runs = [], options = {}) {
  const normalized = (Array.isArray(runs) ? runs : []).map(normalizeRun);
  const expectedContexts = uniq(options.expectedContexts || []);
  const latestByName = latestRunsByName(normalized);
  const assessed = expectedContexts.length > 0
    ? expectedContexts.map((context) => latestByName.get(context)).filter(Boolean)
    : normalized;
  const completed = assessed.filter((run) => run.status === "completed");
  const pending = assessed.filter((run) => run.status && run.status !== "completed");
  const failed = completed.filter((run) => !run.passed);
  const missingRequiredContexts = expectedContexts.filter((context) => !latestByName.has(context));
  const observedContexts = uniq(normalized.map((run) => run.name));
  const assessedContexts = uniq(assessed.map((run) => run.name));
  return {
    runs: normalized,
    total: normalized.length,
    expectedContexts,
    observedContexts,
    assessedContexts,
    assessedTotal: assessed.length,
    missingRequiredContexts,
    completed: completed.length,
    pending: pending.length,
    failed: failed.length,
    passed: completed.filter((run) => run.passed).length,
    allCompleted: assessed.length > 0 && missingRequiredContexts.length === 0 && pending.length === 0,
    allPassed: assessed.length > 0 && missingRequiredContexts.length === 0 && pending.length === 0 && failed.length === 0,
    executionSubstrate: classifyPostMergeExecutionSubstrate(assessed, { expectedContexts }),
  };
}

export function classifyPostMergeExecutionSubstrate(runs = [], options = {}) {
  const assessed = (Array.isArray(runs) ? runs : []).map(normalizeRun);
  const failed = assessed.filter((run) => run.status === "completed" && !run.passed);
  const upstreamBlocked = failed.filter((run) => run.executionSubstrate?.upstreamOfCode);
  const unknownFailures = failed.filter((run) => run.executionSubstrate?.codeAttribution === "unknown");
  const runnerStartedFailures = failed.filter((run) => run.executionSubstrate?.state === "runner-started");
  const pending = assessed.filter((run) => run.status && run.status !== "completed");
  const signals = uniq(failed.flatMap((run) => run.executionSubstrate?.signals || []));
  let state = "available";
  let codeAttribution = "not-needed";
  if (assessed.length === 0) {
    state = options.expectedContexts?.length ? "missing" : "unknown";
    codeAttribution = "unknown";
  } else if (upstreamBlocked.length > 0) {
    state = "blocked-before-runner";
    codeAttribution = failed.length === upstreamBlocked.length ? "not-evidenced" : "mixed-or-unknown";
  } else if (failed.length > 0) {
    state = runnerStartedFailures.length > 0 ? "runner-started-failure" : "failed-unknown";
    codeAttribution = unknownFailures.length === failed.length ? "unknown" : "possible";
  } else if (pending.length > 0) {
    state = "pending";
    codeAttribution = "unknown";
  }
  return {
    provider: "github-actions",
    state,
    upstreamOfCode: upstreamBlocked.length > 0,
    codeAttribution,
    entitlement: {
      plan: null,
      tier: null,
      posture: upstreamBlocked.length > 0 ? "quota-or-entitlement-suspected" : "unknown",
      source: upstreamBlocked.length > 0 ? "workflow-job-evidence" : null,
    },
    affectedRuns: upstreamBlocked.map((run) => ({
      id: run.id,
      name: run.name,
      url: run.url,
      signals: run.executionSubstrate?.signals || [],
    })),
    suspectedCauses: upstreamBlocked.length > 0
      ? [
        "hosted-platform-quota-or-entitlement",
        "hosted-runner-capacity-or-assignment",
        "workflow-permission-or-policy",
      ]
      : [],
    signals,
    decision: upstreamBlocked.length > 0
      ? "treat-as-execution-substrate-until-capacity-evidence-changes"
      : "use-check-result",
  };
}

function requiredCheckEvidence(automationRecord = {}) {
  const requiredChecks = automationRecord.inputs?.requiredChecks || [];
  return {
    policy: automationRecord.inputs?.requiredCheckPolicy || null,
    requiredContexts: automationRecord.inputs?.requiredContexts || [],
    checks: requiredChecks,
    total: requiredChecks.length,
    passed: requiredChecks.filter((check) => check.state === "passed").length,
    pending: requiredChecks.filter((check) => check.state === "pending").length,
    missing: requiredChecks.filter((check) => check.state === "missing").length,
    failed: requiredChecks.filter((check) => check.state === "failed").length,
  };
}

function subjectFromSnapshot(snapshot = {}) {
  const pr = snapshot.pullRequest || {};
  const repository = snapshot.repository || {};
  return {
    kind: "pull-request",
    prNumber: pr.number || null,
    title: pr.title || null,
    url: pr.url || null,
    repository: repository.nameWithOwner || null,
    baseRef: pr.baseRefName || null,
    headRef: pr.headRefName || null,
    baseSha: pr.baseSha || null,
    headSha: pr.headSha || null,
  };
}

export function terminalKind(pr = {}) {
  if (bool(pr.merged) || String(pr.state || "").toUpperCase() === "MERGED") return "merged";
  if (String(pr.state || "").toUpperCase() === "CLOSED") return "closed-unmerged";
  return "not-terminal";
}

function terminalSummary(pr = {}) {
  const kind = terminalKind(pr);
  return {
    terminal: kind !== "not-terminal",
    kind,
    state: pr.state || null,
    merged: bool(pr.merged),
    mergedAt: pr.mergedAt || null,
    closedAt: pr.closedAt || null,
    mergeCommitOid: pr.mergeCommitOid || null,
  };
}

function settledStatus({ terminal, postMergeChecks }) {
  if (!terminal.terminal) return { settled: false, unsettledBy: ["pr-not-terminal"] };
  if (terminal.kind === "closed-unmerged") return { settled: true, unsettledBy: [] };
  if (!terminal.mergeCommitOid) return { settled: false, unsettledBy: ["missing-merge-commit"] };
  if (postMergeChecks.expectedContexts?.length === 0 && postMergeChecks.total === 0) {
    return {
      settled: false,
      evidenceState: "unconfigured",
      unsettledBy: ["post-merge-checks-unconfigured"],
    };
  }
  const unsettledBy = [];
  if (postMergeChecks.missingRequiredContexts?.length) unsettledBy.push("post-merge-required-checks-missing");
  if (postMergeChecks.pending > 0) unsettledBy.push("post-merge-checks-pending");
  const substrateBlocked = postMergeChecks.executionSubstrate?.state === "blocked-before-runner";
  if (substrateBlocked) unsettledBy.push("post-merge-execution-substrate-blocked");
  if (postMergeChecks.failed > 0 && postMergeChecks.executionSubstrate?.codeAttribution !== "not-evidenced") {
    unsettledBy.push("post-merge-checks-failed");
  }
  if (postMergeChecks.total === 0 && unsettledBy.length === 0) unsettledBy.push("post-merge-checks-missing");
  if (unsettledBy.length > 0) {
    return {
      settled: false,
      evidenceState: substrateBlocked ? "execution-substrate-blocked" : postMergeChecks.total === 0 ? "missing" : "incomplete",
      unsettledBy,
    };
  }
  return { settled: true, unsettledBy: [] };
}

function recordId(prefix, timestamp, options = {}) {
  if (options.id) return options.id;
  const stamp = Date.parse(timestamp) || Date.now();
  return `${prefix}-${stamp}-${randomUUID().slice(0, 8)}`;
}

export function buildPrOutcomeObservation(input = {}, options = {}) {
  const timestamp = options.timestamp || input.timestamp || nowIso();
  const snapshot = input.snapshot || {};
  const plan = input.automationPlan || buildPrAutomationPlan(snapshot, { dryRun: true, source: input.source || "illuci.gitops.pr-outcome" });
  const automationRecord = input.automationRecord || plan.record;
  const classification = input.classification || plan.classification;
  const terminal = terminalSummary(snapshot.pullRequest || {});
  const requiredChecks = requiredCheckEvidence(automationRecord);
  const postMergeChecks = summarizeRuns(input.postMergeChecks || snapshot.postMergeChecks || [], {
    expectedContexts: requiredChecks.requiredContexts,
  });
  const settled = settledStatus({ terminal, postMergeChecks });
  const subject = subjectFromSnapshot(snapshot);
  return {
    schema: PR_OUTCOME_OBSERVATION_SCHEMA,
    id: recordId("probs", timestamp, options),
    timestamp,
    source: input.source || "illuci.gitops.pr-outcome",
    subject,
    collector: {
      sourceEvent: input.sourceEvent || "local",
      workflowName: input.workflowName || null,
      workflowConclusion: input.workflowConclusion || null,
      workflowRunId: input.workflowRunId || null,
      attemptKey: input.attemptKey || null,
    },
    inputs: {
      terminal,
      labels: snapshot.pullRequest?.labels || [],
      changedFiles: snapshot.pullRequest?.changedFiles || [],
      requiredChecks,
      postMergeChecks,
    },
    classification,
    automation: automationRecord,
    outcomeCandidate: {
      terminal: terminal.terminal,
      settled: settled.settled,
      kind: terminal.kind,
      evidenceState: settled.evidenceState || (settled.settled ? "complete" : "incomplete"),
      unsettledBy: settled.unsettledBy,
      missingRequiredPostMergeContexts: postMergeChecks.missingRequiredContexts || [],
    },
    promotion: input.promotion || { status: "not-requested", reason: null },
  };
}

export function buildPrOutcome(input = {}, options = {}) {
  const observation = input.observation || buildPrOutcomeObservation(input, options);
  if (!observation.outcomeCandidate.terminal) return null;
  const subject = observation.subject || {};
  return {
    schema: PR_OUTCOME_SCHEMA,
    id: options.id || `pr-outcome-${prCorpusKey(subject.prNumber)}`,
    timestamp: options.timestamp || observation.timestamp,
    source: input.source || observation.source || "illuci.gitops.pr-outcome",
    subject,
    sourceObservationId: observation.id,
    terminal: observation.inputs.terminal,
    settled: observation.outcomeCandidate.settled,
    unsettledBy: observation.outcomeCandidate.unsettledBy,
    labels: observation.inputs.labels,
    changedFiles: observation.inputs.changedFiles,
    requiredChecks: observation.inputs.requiredChecks,
    postMergeChecks: observation.inputs.postMergeChecks,
    classification: observation.classification,
    automation: observation.automation,
  };
}

async function fetchWorkflowRunJobs({ repository, run, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const runId = run.id || run.databaseId;
  if (!runId) {
    return {
      available: false,
      error: "missing-run-id",
      statusCode: null,
    };
  }
  const root = apiUrl.replace(/\/$/, "");
  const repo = parseRepository(repository).nameWithOwner;
  const url = run.jobs_url || run.jobsUrl || `${root}/repos/${repo}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`;
  try {
    const jobs = [];
    let next = url;
    while (next) {
      const page = await githubJson(next, { token, fetchImpl });
      jobs.push(...(Array.isArray(page.data?.jobs) ? page.data.jobs : []));
      next = page.next;
    }
    return summarizeRunJobs(jobs);
  } catch (error) {
    return {
      available: false,
      error: error?.message || "job-evidence-unavailable",
      statusCode: error?.status || null,
    };
  }
}

function shouldFetchWorkflowRunJobs(run = {}) {
  const normalized = normalizeRun(run);
  return Boolean(normalized.id && normalized.status === "completed" && !normalized.passed && !normalized.jobSummary);
}

async function enrichWorkflowRunJobEvidence({ repository, runs = [], token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch } = {}) {
  const out = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!shouldFetchWorkflowRunJobs(run)) {
      out.push(normalizeRun(run));
      continue;
    }
    const jobSummary = await fetchWorkflowRunJobs({ repository, run, token, apiUrl, fetchImpl });
    out.push(normalizeRun({ ...run, jobSummary }));
  }
  return out;
}

export async function fetchPostMergeChecks({ repository, sha, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  if (!sha) return [];
  const root = apiUrl.replace(/\/$/, "");
  const repo = parseRepository(repository).nameWithOwner;
  const url = `${root}/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`;
  const runs = [];
  let next = url;
  while (next) {
    const page = await githubJson(next, { token, fetchImpl });
    runs.push(...(Array.isArray(page.data?.workflow_runs) ? page.data.workflow_runs : []));
    next = page.next;
  }
  return enrichWorkflowRunJobEvidence({ repository, runs, token, apiUrl, fetchImpl });
}

export async function fetchPrOutcomeSnapshot({ repository, prNumber, token, policyToken, apiUrl, graphqlUrl, fetchImpl = fetch }) {
  const snapshot = await fetchPrAutomationSnapshot({
    repository,
    prNumber,
    token,
    policyToken,
    apiUrl,
    graphqlUrl,
    fetchImpl,
  });
  const postMergeChecks = await fetchPostMergeChecks({
    repository: snapshot.repository.nameWithOwner,
    sha: snapshot.pullRequest.mergeCommitOid,
    token,
    apiUrl,
    fetchImpl,
  });
  return {
    ...snapshot,
    postMergeChecks,
  };
}

export async function listTerminalPullRequests({ repository, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const root = apiUrl.replace(/\/$/, "");
  const repo = parseRepository(repository).nameWithOwner;
  const pulls = await listPaged(`${root}/repos/${repo}/pulls?state=closed&per_page=100&sort=created&direction=asc`, { token, fetchImpl });
  return pulls
    .filter((pr) => TERMINAL_PR_STATES.has(String(pr.state || "").toUpperCase()) || pr.merged_at || pr.closed_at)
    .map((pr) => ({
      number: Number(pr.number),
      state: pr.merged_at ? "MERGED" : "CLOSED",
      mergedAt: pr.merged_at || null,
      closedAt: pr.closed_at || null,
      title: pr.title || null,
      url: pr.html_url || pr.url || null,
      baseRefName: pr.base?.ref || null,
      headRefName: pr.head?.ref || null,
    }))
    .filter((pr) => pr.number);
}

export async function collectPrOutcome(options = {}) {
  const snapshot = options.snapshot || await fetchPrOutcomeSnapshot(options);
  const observation = buildPrOutcomeObservation({
    snapshot,
    source: options.source || "illuci.gitops.pr-outcome",
    sourceEvent: options.sourceEvent,
    workflowName: options.workflowName,
    workflowConclusion: options.workflowConclusion,
    workflowRunId: options.workflowRunId,
    attemptKey: options.attemptKey,
    promotion: options.promotion,
  }, options.observation || {});
  const outcome = buildPrOutcome({ observation, source: options.source || "illuci.gitops.pr-outcome" }, options.outcome || {});
  let traces = null;
  if (options.writeTrace) {
    traces = {
      observation: appendPrOutcomeObservationTrace(observation),
      outcome: outcome ? appendPrOutcomeTrace(outcome) : null,
    };
  }
  let corpus = null;
  if (options.promoteCorpus) {
    corpus = promotePrOutcomeCorpus({ observation, outcome, dryRun: options.dryRun, corpusRoot: options.corpusRoot });
  }
  return { observation, outcome, traces, corpus };
}

export async function backfillPrOutcomes(options = {}) {
  const prs = options.prs || await listTerminalPullRequests(options);
  const results = [];
  for (const pr of prs) {
    const result = await collectPrOutcome({
      ...options,
      prNumber: pr.number,
      sourceEvent: options.sourceEvent || "backfill",
      attemptKey: `backfill-${prCorpusKey(pr.number)}`,
    });
    results.push(result);
  }
  return {
    schema: "illuci.gitops.pr-outcome-backfill/1",
    repository: options.repository,
    total: results.length,
    observations: results.map((result) => result.observation.id),
    outcomes: results.map((result) => result.outcome?.id).filter(Boolean),
    results,
  };
}

export function listCommittedPrOutcomeCorpusNumbers({ corpusRoot = prOutcomeCorpusRoot() } = {}) {
  const outcomeRoot = join(corpusRoot, "outcomes");
  if (!existsSync(outcomeRoot)) return [];
  return readdirSync(outcomeRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => /^pr-(\d{5})\.json$/.exec(entry.name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((number) => Number.isInteger(number) && number > 0)
    .sort((a, b) => a - b);
}

export async function auditPrOutcomeCorpusContinuity(options = {}) {
  const timestamp = options.timestamp || nowIso();
  const prs = options.prs || await listTerminalPullRequests(options);
  const committedNumbers = new Set(options.committedNumbers || listCommittedPrOutcomeCorpusNumbers(options));
  const records = (Array.isArray(prs) ? prs : [])
    .filter((pr) => Number.isInteger(Number(pr.number)) && Number(pr.number) > 0)
    .map((pr) => {
      const prNumber = Number(pr.number);
      const generatedCorpusPr = isGeneratedPrOutcomeCorpusPullRequest(pr);
      const committed = committedNumbers.has(prNumber);
      const required = !generatedCorpusPr;
      return {
        prNumber,
        key: prCorpusKey(prNumber),
        title: pr.title || null,
        state: pr.state || null,
        mergedAt: pr.mergedAt || null,
        closedAt: pr.closedAt || null,
        headRefName: pr.headRefName || pr.head?.ref || null,
        url: pr.url || null,
        required,
        committed,
        status: required ? (committed ? "committed" : "missing") : "skipped",
        reason: required ? (committed ? null : "missing-committed-outcome") : "generated-corpus-pr",
      };
    })
    .sort((a, b) => a.prNumber - b.prNumber);
  const required = records.filter((record) => record.required);
  const committed = required.filter((record) => record.committed);
  const missing = required.filter((record) => !record.committed);
  const skipped = records.filter((record) => !record.required);
  return {
    schema: PR_OUTCOME_CORPUS_CONTINUITY_SCHEMA,
    timestamp,
    source: options.source || "illuci.gitops.pr-outcome",
    repository: options.repository || null,
    corpus: {
      root: PR_OUTCOME_CORPUS_RELPATH,
      committedOutcomeCount: committedNumbers.size,
    },
    policy: {
      generatedCorpusPullRequests: {
        continuity: "excluded-from-required-committed-outcome-set",
        promotion: "skipped",
        reason: "self-corpus-pr",
        runtimeObservation: "allowed",
      },
    },
    totals: {
      terminal: records.length,
      required: required.length,
      committed: committed.length,
      missing: missing.length,
      skipped: skipped.length,
    },
    ok: missing.length === 0,
    missing,
    skipped,
    records,
  };
}

export function prOutcomeObservationTracePath() {
  return runtimeDataPath("gitops", join("pr-outcome-observations", "records.jsonl"));
}

export function prOutcomeTracePath() {
  return runtimeDataPath("gitops", join("pr-outcomes", "records.jsonl"));
}

function appendJsonLine(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

export function appendPrOutcomeObservationTrace(record) {
  const path = prOutcomeObservationTracePath();
  appendJsonLine(path, record);
  return {
    ok: true,
    path,
    displayPath: PR_OUTCOME_OBSERVATION_RECORDS_RELPATH,
    recordId: record.id,
  };
}

export function appendPrOutcomeTrace(record) {
  const path = prOutcomeTracePath();
  appendJsonLine(path, record);
  return {
    ok: true,
    path,
    displayPath: PR_OUTCOME_RECORDS_RELPATH,
    recordId: record.id,
  };
}

export function prOutcomeCorpusRoot() {
  return committedProvenancePath(...PR_OUTCOME_CORPUS_RELPATH.split("/"));
}

export function prOutcomeCorpusPaths({ observation, outcome, corpusRoot = prOutcomeCorpusRoot() } = {}) {
  const prKey = prCorpusKey(observation?.subject?.prNumber || outcome?.subject?.prNumber);
  const observationPath = observation
    ? join(corpusRoot, "observations", prKey, `${observation.id}.json`)
    : null;
  const outcomePath = outcome
    ? join(corpusRoot, "outcomes", `${prKey}.json`)
    : null;
  return {
    root: corpusRoot,
    observationPath,
    outcomePath,
    displayPaths: {
      observation: observationPath ? observationPath.replace(/\\/g, "/").split(`${PR_OUTCOME_CORPUS_RELPATH}/`).pop() : null,
      outcome: outcomePath ? outcomePath.replace(/\\/g, "/").split(`${PR_OUTCOME_CORPUS_RELPATH}/`).pop() : null,
    },
  };
}

function writeJsonFile(path, record, { dryRun = false } = {}) {
  if (!path) return { path, written: false, skipped: true, reason: "missing-path" };
  if (dryRun) return { path, written: false, skipped: true, reason: "dry-run" };
  const text = JSON.stringify(record, null, 2) + "\n";
  if (existsSync(path)) {
    return { path, written: false, skipped: true, reason: "already-exists" };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return { path, written: true, skipped: false, reason: null };
}

export function promotePrOutcomeCorpus({ observation, outcome, dryRun = false, corpusRoot } = {}) {
  const paths = prOutcomeCorpusPaths({ observation, outcome, corpusRoot });
  if (!outcome) {
    return {
      ok: false,
      dryRun,
      paths,
      writes: {
        observation: { path: paths.observationPath, written: false, skipped: true, reason: "no-terminal-outcome" },
        outcome: { path: paths.outcomePath, written: false, skipped: true, reason: "no-terminal-outcome" },
      },
    };
  }
  const observationWrite = writeJsonFile(paths.observationPath, observation, { dryRun });
  const outcomeWrite = writeJsonFile(paths.outcomePath, outcome, { dryRun });
  return {
    ok: observationWrite.written || outcomeWrite.written,
    dryRun,
    paths,
    writes: {
      observation: observationWrite,
      outcome: outcomeWrite,
    },
  };
}

export function formatPrOutcomeResult(result = {}) {
  const observation = result.observation || result;
  const outcome = result.outcome || null;
  const subject = observation.subject || {};
  const prefix = subject.prNumber ? `illuci pr outcome - PR #${subject.prNumber}` : "illuci pr outcome";
  const lines = [
    `${prefix}: ${observation.outcomeCandidate?.kind || "unknown"}`,
    `  observation: ${observation.id}`,
    `  settled: ${observation.outcomeCandidate?.settled ? "yes" : "no"}`,
  ];
  if (outcome) lines.push(`  outcome: ${outcome.id}`);
  if (observation.outcomeCandidate?.unsettledBy?.length) lines.push(`  unsettled-by: ${observation.outcomeCandidate.unsettledBy.join(", ")}`);
  if (result.corpus) {
    const writes = result.corpus.writes || {};
    lines.push(`  corpus: observation=${writes.observation?.reason || "written"} outcome=${writes.outcome?.reason || "written"}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatPrOutcomeCorpusContinuity(result = {}) {
  const totals = result.totals || {};
  const lines = [
    `illuci pr outcome audit: ${result.ok ? "ok" : "missing"}`,
    `  terminal=${totals.terminal || 0} required=${totals.required || 0} committed=${totals.committed || 0} missing=${totals.missing || 0} skipped=${totals.skipped || 0}`,
    "  generated-corpus-prs: excluded from the required committed-outcome set; promotion remains skipped",
  ];
  if (result.missing?.length) {
    lines.push(`  missing: ${result.missing.map((record) => `#${record.prNumber}`).join(", ")}`);
  }
  if (result.skipped?.length) {
    lines.push(`  skipped-generated: ${result.skipped.map((record) => `#${record.prNumber}`).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseOutcomePrNumber(value) {
  return parsePullRequestNumber(value);
}

export default {
  PR_OUTCOME_OBSERVATION_SCHEMA,
  PR_OUTCOME_SCHEMA,
  PR_OUTCOME_CORPUS_CONTINUITY_SCHEMA,
  PR_OUTCOME_OBSERVATION_RECORDS_RELPATH,
  PR_OUTCOME_RECORDS_RELPATH,
  PR_OUTCOME_CORPUS_RELPATH,
  appendPrOutcomeObservationTrace,
  appendPrOutcomeTrace,
  auditPrOutcomeCorpusContinuity,
  backfillPrOutcomes,
  buildPrOutcome,
  buildPrOutcomeObservation,
  classifyPostMergeExecutionSubstrate,
  collectPrOutcome,
  fetchPostMergeChecks,
  fetchPrOutcomeSnapshot,
  formatPrOutcomeCorpusContinuity,
  formatPrOutcomeResult,
  isGeneratedPrOutcomeCorpusPullRequest,
  listCommittedPrOutcomeCorpusNumbers,
  listTerminalPullRequests,
  parseOutcomePrNumber,
  prCorpusKey,
  prOutcomeCorpusPaths,
  prOutcomeCorpusRoot,
  prOutcomeObservationTracePath,
  prOutcomeTracePath,
  promotePrOutcomeCorpus,
  summarizeRunJobs,
  terminalKind,
};
