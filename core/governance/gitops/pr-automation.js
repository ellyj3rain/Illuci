// illuci/core/governance/gitops/pr-automation.js
//
// Governed GitOps PR automation actuator. This module keeps the automation
// decision deterministic and traceable while isolating GitHub mutations to the
// governed squash auto-merge request or the same-strategy immediate merge path
// GitHub requires when an eligible PR is already clean.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { runtimeDataPath } from "../../data/paths.js";
import { buildPrClassificationRecord, normalizeLabels } from "./pr-classification.js";

export const PR_AUTOMATION_SCHEMA = "illuci.gitops.pr-automation/1";
export const PR_AUTOMATION_RECORDS_RELPATH = ".illuci/data/gitops/pr-automation/records.jsonl";

export const PR_AUTOMATION_OUTCOMES = Object.freeze({
  BLOCKED: "blocked",
  ALREADY_REQUESTED: "already-requested",
  AUTO_MERGE_REQUESTED: "auto-merge-requested",
  MERGED_IMMEDIATELY: "merged-immediately",
  OBSERVED_MERGED: "observed-merged",
  SKIPPED: "skipped",
});

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";
const PASSING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING_CHECK_STATES = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
}

function upper(value) {
  return clean(value).toUpperCase();
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

function headerToken(token) {
  const value = clean(token);
  if (!value) throw new Error("GITHUB_TOKEN or GH_TOKEN is required for PR auto-merge automation");
  return value;
}

function parseLinkNext(linkHeader) {
  const parts = String(linkHeader || "").split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export function parseRepository(value) {
  const raw = clean(value)
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`repository must be owner/name, got "${value || ""}"`);
  return {
    owner: parts[0],
    name: parts[1],
    nameWithOwner: `${parts[0]}/${parts[1]}`,
  };
}

export function parsePullRequestNumber(value) {
  const raw = clean(value);
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/\/pull\/(\d+)(?:\D|$)/i);
  if (match) return Number(match[1]);
  return null;
}

export function requiredContextsFromProtection(payload = {}) {
  const contexts = Array.isArray(payload.contexts) ? payload.contexts : [];
  const checks = Array.isArray(payload.checks) ? payload.checks.map((check) => check?.context) : [];
  return uniq([...contexts, ...checks]);
}

function requiredContextsFromBranchRules(rules = []) {
  const contexts = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type !== "required_status_checks") continue;
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) continue;
    contexts.push(...checks.map((check) => check?.context));
  }
  return uniq(contexts);
}

function policySource(kind, result = {}, { branchRulesReadable = false } = {}) {
  const statusCode = result.statusCode || null;
  let status = result.ok ? "ok" : "unavailable";
  if (kind === "branch-protection" && statusCode === 404 && branchRulesReadable) {
    status = "not-configured";
  }
  return {
    kind,
    status,
    requiredContexts: status === "ok" ? uniq(result.requiredContexts || []) : [],
    error: status === "unavailable" ? result.error || null : null,
    statusCode,
  };
}

function legacyRequiredCheckPolicy(branchProtection = {}) {
  const source = policySource("branch-protection", branchProtection);
  const requiredContexts = source.requiredContexts;
  const status = source.status === "unavailable"
    ? "unavailable"
    : requiredContexts.length > 0 ? "ok" : "empty";
  return {
    ok: status === "ok",
    status,
    requiredContexts,
    sources: [source],
    errors: source.error ? [{ kind: source.kind, statusCode: source.statusCode, message: source.error }] : [],
  };
}

function buildRequiredCheckPolicy({ branchProtection = {}, branchRules = {} } = {}) {
  const branchRulesReadable = branchRules.ok === true;
  const sources = [
    policySource("branch-protection", branchProtection, { branchRulesReadable }),
    policySource("branch-rules", branchRules),
  ];
  const unavailable = sources.filter((source) => source.status === "unavailable");
  const requiredContexts = uniq(sources.flatMap((source) => source.requiredContexts));
  const status = unavailable.length > 0 ? "unavailable" : requiredContexts.length > 0 ? "ok" : "empty";
  return {
    ok: status === "ok",
    status,
    requiredContexts,
    sources,
    errors: unavailable.map((source) => ({
      kind: source.kind,
      statusCode: source.statusCode,
      message: source.error,
    })),
  };
}

function requiredCheckPolicyFromSnapshot(snapshot = {}) {
  if (snapshot.requiredCheckPolicy) return snapshot.requiredCheckPolicy;
  if (snapshot.branchRules) {
    return buildRequiredCheckPolicy({
      branchProtection: snapshot.branchProtection || {},
      branchRules: snapshot.branchRules || {},
    });
  }
  return legacyRequiredCheckPolicy(snapshot.branchProtection || {});
}

function checkContextName(node = {}) {
  return clean(node.name || node.context);
}

function checkTimestamp(node = {}) {
  const dates = [node.completedAt, node.startedAt, node.createdAt]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return dates.length ? Math.max(...dates) : 0;
}

function normalizeCheckNode(node = {}) {
  const context = checkContextName(node);
  const status = upper(node.status);
  const conclusion = upper(node.conclusion || node.state);
  let state = "pending";
  if (PASSING_CHECK_STATES.has(conclusion)) state = "passed";
  else if (FAILING_CHECK_STATES.has(conclusion)) state = "failed";
  else if (status && status !== "COMPLETED") state = "pending";
  else if (!conclusion) state = "pending";
  else state = "failed";

  return {
    context,
    state,
    rawStatus: status || null,
    rawConclusion: conclusion || null,
    detailsUrl: node.detailsUrl || node.targetUrl || null,
    completedAt: node.completedAt || null,
    startedAt: node.startedAt || node.createdAt || null,
  };
}

export function latestChecksByContext(statusCheckRollup = []) {
  const map = new Map();
  for (const node of Array.isArray(statusCheckRollup) ? statusCheckRollup : []) {
    const normalized = normalizeCheckNode(node);
    if (!normalized.context) continue;
    const key = normalized.context.toLowerCase();
    const prior = map.get(key);
    if (!prior || checkTimestamp(node) >= prior.timestamp) {
      map.set(key, { timestamp: checkTimestamp(node), check: normalized });
    }
  }
  return map;
}

export function summarizeRequiredChecks({ requiredContexts = [], statusCheckRollup = [] } = {}) {
  const latest = latestChecksByContext(statusCheckRollup);
  const checks = uniq(requiredContexts).map((context) => {
    const found = latest.get(context.toLowerCase());
    if (!found) return { context, state: "missing", rawStatus: null, rawConclusion: null, detailsUrl: null };
    return { ...found.check, context };
  });
  const passed = checks.filter((check) => check.state === "passed");
  const pending = checks.filter((check) => check.state === "pending");
  const failed = checks.filter((check) => check.state === "failed");
  const missing = checks.filter((check) => check.state === "missing");
  return {
    requiredContexts: uniq(requiredContexts),
    checks,
    passed,
    pending,
    failed,
    missing,
    allPassed: checks.length > 0 && pending.length === 0 && failed.length === 0 && missing.length === 0,
  };
}

async function githubJson(url, { token, fetchImpl = fetch, method = "GET", body = null, userAgent = "illuci-pr-auto-merge" } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${headerToken(token)}`,
      "content-type": "application/json",
      "user-agent": userAgent,
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

async function githubGraphql(query, variables, { graphqlUrl = DEFAULT_GRAPHQL_URL, token, fetchImpl = fetch } = {}) {
  const page = await githubJson(graphqlUrl, {
    token,
    fetchImpl,
    method: "POST",
    body: { query, variables },
    userAgent: "illuci-pr-auto-merge-graphql",
  });
  if (Array.isArray(page.data?.errors) && page.data.errors.length > 0) {
    throw new Error(`GitHub GraphQL request failed: ${page.data.errors.map((err) => err.message).join("; ")}`);
  }
  return page.data?.data;
}

const PR_QUERY = `
query IlluciPrAutomation($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    squashMergeAllowed
    rebaseMergeAllowed
    mergeCommitAllowed
    pullRequest(number: $number) {
      id
      number
      title
      url
      state
      merged
      mergedAt
      closedAt
      isDraft
      mergeStateStatus
      mergeable
      baseRefName
      headRefName
      baseRefOid
      headRefOid
      autoMergeRequest {
        enabledAt
        mergeMethod
      }
      mergeCommit {
        oid
      }
      labels(first: 100) {
        nodes {
          name
        }
      }
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun {
              name
              status
              conclusion
              startedAt
              completedAt
              detailsUrl
            }
            ... on StatusContext {
              context
              state
              createdAt
              targetUrl
            }
          }
        }
      }
    }
  }
}`;

const AUTO_MERGE_MUTATION = `
mutation IlluciEnableAutoMerge($pullRequestId: ID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
    pullRequest {
      number
      url
      state
      merged
      mergedAt
      autoMergeRequest {
        enabledAt
        mergeMethod
      }
      mergeCommit {
        oid
      }
    }
  }
}`;

const MERGE_PULL_REQUEST_MUTATION = `
mutation IlluciMergePullRequest($pullRequestId: ID!) {
  mergePullRequest(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
    pullRequest {
      number
      url
      state
      merged
      mergedAt
      autoMergeRequest {
        enabledAt
        mergeMethod
      }
      mergeCommit {
        oid
      }
    }
  }
}`;

export async function fetchPullRequestGraph({ repository, prNumber, token, graphqlUrl, fetchImpl = fetch }) {
  const repo = parseRepository(repository);
  const data = await githubGraphql(PR_QUERY, {
    owner: repo.owner,
    name: repo.name,
    number: Number(prNumber),
  }, { graphqlUrl, token, fetchImpl });
  const repositoryData = data?.repository;
  const pr = repositoryData?.pullRequest;
  if (!pr) throw new Error(`pull request #${prNumber} was not found in ${repo.nameWithOwner}`);
  return {
    repository: {
      nameWithOwner: repositoryData.nameWithOwner,
      squashMergeAllowed: repositoryData.squashMergeAllowed,
      rebaseMergeAllowed: repositoryData.rebaseMergeAllowed,
      mergeCommitAllowed: repositoryData.mergeCommitAllowed,
    },
    pr: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      merged: pr.merged,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      isDraft: pr.isDraft,
      mergeStateStatus: pr.mergeStateStatus,
      mergeable: pr.mergeable,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      autoMergeRequest: pr.autoMergeRequest || null,
      mergeCommitOid: pr.mergeCommit?.oid || null,
      labels: normalizeLabels(pr.labels?.nodes || []),
      statusCheckRollup: pr.statusCheckRollup?.contexts?.nodes || [],
    },
  };
}

export async function fetchPullRequestFiles({ repository, prNumber, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const root = apiUrl.replace(/\/$/, "");
  const url = `${root}/repos/${parseRepository(repository).nameWithOwner}/pulls/${Number(prNumber)}/files?per_page=100`;
  const files = await listPaged(url, { token, fetchImpl });
  return files.map((file) => ({
    path: file.filename,
    additions: int(file.additions, 0),
    deletions: int(file.deletions, 0),
  }));
}

export async function fetchRequiredStatusChecks({ repository, baseRefName, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const root = apiUrl.replace(/\/$/, "");
  const url = `${root}/repos/${parseRepository(repository).nameWithOwner}/branches/${encodeURIComponent(baseRefName)}/protection/required_status_checks`;
  try {
    const page = await githubJson(url, { token, fetchImpl });
    return {
      ok: true,
      status: "ok",
      statusCode: 200,
      requiredContexts: requiredContextsFromProtection(page.data),
      raw: page.data,
    };
  } catch (err) {
    return {
      ok: false,
      status: err.status === 404 ? "not-configured" : "unavailable",
      statusCode: err.status || null,
      requiredContexts: [],
      error: err.message,
    };
  }
}

async function fetchBranchRules({ repository, baseRefName, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const root = apiUrl.replace(/\/$/, "");
  const url = `${root}/repos/${parseRepository(repository).nameWithOwner}/rules/branches/${encodeURIComponent(baseRefName)}`;
  try {
    const page = await githubJson(url, { token, fetchImpl });
    return {
      ok: true,
      status: "ok",
      statusCode: 200,
      requiredContexts: requiredContextsFromBranchRules(page.data),
      raw: page.data,
    };
  } catch (err) {
    return {
      ok: false,
      status: "unavailable",
      statusCode: err.status || null,
      requiredContexts: [],
      error: err.message,
    };
  }
}

export async function fetchPrAutomationSnapshot({ repository, prNumber, token, policyToken, apiUrl, graphqlUrl, fetchImpl = fetch }) {
  const graph = await fetchPullRequestGraph({ repository, prNumber, token, graphqlUrl, fetchImpl });
  const files = await fetchPullRequestFiles({ repository, prNumber, token, apiUrl, fetchImpl });
  const policyReadToken = policyToken || token;
  const protection = await fetchRequiredStatusChecks({
    repository: graph.repository.nameWithOwner,
    baseRefName: graph.pr.baseRefName,
    token: policyReadToken,
    apiUrl,
    fetchImpl,
  });
  const branchRules = await fetchBranchRules({
    repository: graph.repository.nameWithOwner,
    baseRefName: graph.pr.baseRefName,
    token: policyReadToken,
    apiUrl,
    fetchImpl,
  });
  const requiredCheckPolicy = buildRequiredCheckPolicy({
    branchProtection: protection,
    branchRules,
  });
  return {
    repository: graph.repository,
    pullRequest: {
      ...graph.pr,
      changedFiles: files,
    },
    branchProtection: protection,
    branchRules,
    requiredCheckPolicy,
  };
}

function mergeStateClean(pr = {}) {
  return upper(pr.mergeStateStatus) === "CLEAN";
}

function mergeable(pr = {}) {
  return upper(pr.mergeable) === "MERGEABLE";
}

function alreadyMerged(pr = {}) {
  return pr.merged === true || upper(pr.state) === "MERGED" || Boolean(pr.mergedAt);
}

function classificationInputFromSnapshot(snapshot = {}, checkSummary) {
  const pr = snapshot.pullRequest || {};
  const repository = snapshot.repository || {};
  return {
    source: "illuci.gitops.pr-automation",
    prNumber: pr.number,
    title: pr.title,
    url: pr.url,
    repository: repository.nameWithOwner,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    labels: pr.labels,
    changedFiles: pr.changedFiles,
    alreadyMerged: alreadyMerged(pr),
    mergeStateStatus: pr.mergeStateStatus,
    requestedStrategy: "squash",
    isDraftPr: bool(pr.isDraft),
    pendingCheckCount: checkSummary.pending.length + checkSummary.missing.length,
    failingCheckCount: checkSummary.failed.length,
    repositoryAllowsSquash: repository.squashMergeAllowed !== false,
    repositoryAllowsRebase: repository.rebaseMergeAllowed !== false,
    repositoryAllowsMergeCommit: repository.mergeCommitAllowed === true,
  };
}

function blockedByFor({ snapshot, classification, checkSummary, requiredCheckPolicy }) {
  const pr = snapshot.pullRequest || {};
  const blockers = [];
  if (!requiredCheckPolicy?.ok) {
    blockers.push(requiredCheckPolicy?.status === "empty"
      ? "required-check-policy-empty"
      : "required-check-policy-unavailable");
  }
  if (bool(pr.isDraft)) blockers.push("draft-pr");
  if (!mergeStateClean(pr)) blockers.push("merge-state-not-clean");
  if (!mergeable(pr)) blockers.push("not-mergeable");
  if (!checkSummary.allPassed) {
    if (checkSummary.missing.length) blockers.push("required-checks-missing");
    if (checkSummary.pending.length) blockers.push("required-checks-pending");
    if (checkSummary.failed.length) blockers.push("required-checks-failing");
  }
  if (!classification.automation.eligible) blockers.push(...classification.automation.blockedBy);
  if (classification.automation.strategy && classification.automation.strategy !== "squash") {
    blockers.push("non-squash-strategy");
  }
  return uniq(blockers);
}

function subjectFor(snapshot = {}) {
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

function buildRecord({ snapshot, classification, checkSummary, requiredCheckPolicy, outcome, blockedBy = [], dryRun = false, error = null, mutation = null, source = "illuci.gitops.pr-automation" }) {
  const timestamp = nowIso();
  const pr = snapshot.pullRequest || {};
  const policy = requiredCheckPolicy || requiredCheckPolicyFromSnapshot(snapshot);
  return {
    schema: PR_AUTOMATION_SCHEMA,
    id: `pra-${Date.parse(timestamp) || Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp,
    source,
    subject: subjectFor(snapshot),
    inputs: {
      dryRun,
      requestedStrategy: "squash",
      isDraftPr: bool(pr.isDraft),
      mergeStateStatus: pr.mergeStateStatus || null,
      mergeable: pr.mergeable || null,
      autoMergeRequestPresent: Boolean(pr.autoMergeRequest),
      branchProtectionAvailable: snapshot.branchProtection?.ok === true,
      requiredCheckPolicy: {
        ok: policy.ok === true,
        status: policy.status || "unknown",
        requiredContexts: uniq(policy.requiredContexts || []),
        sources: (policy.sources || []).map((source) => ({
          kind: source.kind,
          status: source.status,
          requiredContexts: uniq(source.requiredContexts || []),
          error: source.error || null,
          statusCode: source.statusCode || null,
        })),
        errors: policy.errors || [],
      },
      requiredContexts: checkSummary.requiredContexts,
      requiredChecks: checkSummary.checks,
    },
    classification: {
      id: classification.id,
      schema: classification.schema,
      automation: classification.automation,
      outcome: classification.outcome,
      mergeStrategy: classification.verdicts.mergeStrategy,
    },
    action: {
      outcome,
      allowed: blockedBy.length === 0 && !dryRun,
      blockedBy,
      dryRun,
      mutation,
      error: error ? String(error) : null,
    },
  };
}

export function buildPrAutomationPlan(snapshot = {}, options = {}) {
  const requiredCheckPolicy = requiredCheckPolicyFromSnapshot(snapshot);
  const requiredContexts = requiredCheckPolicy.requiredContexts || [];
  const checkSummary = summarizeRequiredChecks({
    requiredContexts,
    statusCheckRollup: snapshot.pullRequest?.statusCheckRollup || [],
  });
  const classification = buildPrClassificationRecord(classificationInputFromSnapshot(snapshot, checkSummary));
  const pr = snapshot.pullRequest || {};

  if (!pr.number) {
    const record = buildRecord({
      snapshot,
      classification,
      checkSummary,
      requiredCheckPolicy,
      outcome: PR_AUTOMATION_OUTCOMES.SKIPPED,
      blockedBy: ["missing-pull-request"],
      dryRun: bool(options.dryRun),
      source: options.source,
    });
    return { record, classification, checkSummary, requestable: false };
  }

  if (alreadyMerged(pr)) {
    const record = buildRecord({
      snapshot,
      classification,
      checkSummary,
      requiredCheckPolicy,
      outcome: PR_AUTOMATION_OUTCOMES.OBSERVED_MERGED,
      dryRun: bool(options.dryRun),
      mutation: {
        mergeMethod: null,
        autoMergeEnabledAt: null,
        mergedAt: pr.mergedAt || null,
        mergeCommitOid: pr.mergeCommitOid || null,
        observedTerminalState: true,
      },
      source: options.source,
    });
    return { record, classification, checkSummary, requestable: false, terminal: true };
  }

  if (pr.autoMergeRequest) {
    const record = buildRecord({
      snapshot,
      classification,
      checkSummary,
      requiredCheckPolicy,
      outcome: PR_AUTOMATION_OUTCOMES.ALREADY_REQUESTED,
      dryRun: bool(options.dryRun),
      source: options.source,
    });
    return { record, classification, checkSummary, requestable: false };
  }

  const blockedBy = blockedByFor({ snapshot, classification, checkSummary, requiredCheckPolicy });
  if (blockedBy.length > 0) {
    const record = buildRecord({
      snapshot,
      classification,
      checkSummary,
      requiredCheckPolicy,
      outcome: PR_AUTOMATION_OUTCOMES.BLOCKED,
      blockedBy,
      dryRun: bool(options.dryRun),
      source: options.source,
    });
    return { record, classification, checkSummary, requestable: false };
  }

  if (bool(options.dryRun)) {
    const record = buildRecord({
      snapshot,
      classification,
      checkSummary,
      requiredCheckPolicy,
      outcome: PR_AUTOMATION_OUTCOMES.SKIPPED,
      blockedBy: ["dry-run"],
      dryRun: true,
      source: options.source,
    });
    return { record, classification, checkSummary, requestable: false, wouldRequest: true };
  }

  const record = buildRecord({
    snapshot,
    classification,
    checkSummary,
    requiredCheckPolicy,
    outcome: PR_AUTOMATION_OUTCOMES.AUTO_MERGE_REQUESTED,
    source: options.source,
  });
  return { record, classification, checkSummary, requestable: true };
}

export async function enablePullRequestAutoMerge({ pullRequestId, token, graphqlUrl, fetchImpl = fetch }) {
  const data = await githubGraphql(AUTO_MERGE_MUTATION, { pullRequestId }, { graphqlUrl, token, fetchImpl });
  const pr = data?.enablePullRequestAutoMerge?.pullRequest;
  if (!pr) throw new Error("GitHub did not return a pull request after enabling auto-merge");
  return pr;
}

async function mergePullRequestImmediately({ pullRequestId, token, graphqlUrl, fetchImpl = fetch }) {
  const data = await githubGraphql(MERGE_PULL_REQUEST_MUTATION, { pullRequestId }, { graphqlUrl, token, fetchImpl });
  const pr = data?.mergePullRequest?.pullRequest;
  if (!pr) throw new Error("GitHub did not return a pull request after immediate squash merge");
  return pr;
}

function isCleanStatusAutoMergeRejection(err) {
  return /pull request.*clean status/i.test(String(err?.message || err || ""));
}

function isTerminalMutationRaceRejection(err) {
  const message = String(err?.message || err || "");
  return /pull request.*already merged/i.test(message) || /merge already in progress/i.test(message);
}

function withAction(record, actionPatch) {
  return {
    ...record,
    action: {
      ...record.action,
      ...actionPatch,
    },
  };
}

async function terminalPlanAfterMutationRace(options = {}) {
  const terminalSnapshot = options.refetchSnapshot
    ? await options.refetchSnapshot()
    : await fetchPrAutomationSnapshot(options);
  const terminalPlan = buildPrAutomationPlan(terminalSnapshot, {
    dryRun: options.dryRun,
    source: options.source || "illuci.gitops.pr-automation",
  });
  return terminalPlan.terminal ? terminalPlan : null;
}

export async function requestPrAutoMerge(options = {}) {
  const snapshot = options.snapshot || await fetchPrAutomationSnapshot(options);
  let plan = buildPrAutomationPlan(snapshot, {
    dryRun: options.dryRun,
    source: options.source || "illuci.gitops.pr-automation",
  });
  let record = plan.record;

  if (plan.requestable) {
    try {
      let mutationPr = null;
      try {
        mutationPr = await enablePullRequestAutoMerge({
          pullRequestId: snapshot.pullRequest.id,
          token: options.token,
          graphqlUrl: options.graphqlUrl,
          fetchImpl: options.fetchImpl,
        });
      } catch (err) {
        if (!isCleanStatusAutoMergeRejection(err)) throw err;
        mutationPr = await mergePullRequestImmediately({
          pullRequestId: snapshot.pullRequest.id,
          token: options.token,
          graphqlUrl: options.graphqlUrl,
          fetchImpl: options.fetchImpl,
        });
      }
      const merged = mutationPr.merged || upper(mutationPr.state) === "MERGED" || Boolean(mutationPr.mergedAt);
      record = withAction(record, {
        outcome: merged ? PR_AUTOMATION_OUTCOMES.MERGED_IMMEDIATELY : PR_AUTOMATION_OUTCOMES.AUTO_MERGE_REQUESTED,
        allowed: true,
        mutation: {
          mergeMethod: mutationPr.autoMergeRequest?.mergeMethod || "SQUASH",
          autoMergeEnabledAt: mutationPr.autoMergeRequest?.enabledAt || null,
          mergedAt: mutationPr.mergedAt || null,
          mergeCommitOid: mutationPr.mergeCommit?.oid || null,
        },
      });
    } catch (err) {
      const terminalPlan = isTerminalMutationRaceRejection(err)
        ? await terminalPlanAfterMutationRace(options).catch(() => null)
        : null;
      if (terminalPlan) {
        plan = terminalPlan;
        record = terminalPlan.record;
      } else {
        record = withAction(record, {
          outcome: PR_AUTOMATION_OUTCOMES.BLOCKED,
          allowed: false,
          blockedBy: uniq([...record.action.blockedBy, "github-rejected-expected-strategy"]),
          error: err.message,
        });
      }
    }
  }

  let trace = null;
  if (options.writeTrace) trace = appendPrAutomationTrace(record);
  return {
    record,
    classification: plan.classification,
    checkSummary: plan.checkSummary,
    trace,
  };
}

export function prAutomationTracePath() {
  return runtimeDataPath("gitops", join("pr-automation", "records.jsonl"));
}

export function appendPrAutomationTrace(record) {
  const path = prAutomationTracePath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  return {
    ok: true,
    path,
    displayPath: PR_AUTOMATION_RECORDS_RELPATH,
    recordId: record.id,
  };
}

export function formatPrAutomationResult(result = {}) {
  const record = result.record || result;
  const subject = record.subject || {};
  const action = record.action || {};
  const prefix = subject.prNumber ? `illuci pr auto-merge - PR #${subject.prNumber}` : "illuci pr auto-merge";
  const lines = [
    `${prefix}: ${action.outcome || "unknown"}`,
    `  strategy: squash`,
    `  checks: ${(record.inputs?.requiredChecks || []).filter((check) => check.state === "passed").length}/${(record.inputs?.requiredChecks || []).length} required passed`,
  ];
  if (action.blockedBy?.length) lines.push(`  blocked-by: ${action.blockedBy.join(", ")}`);
  if (action.error) lines.push(`  error: ${action.error}`);
  if (result.trace) lines.push(`  trace: ${result.trace.displayPath}`);
  return `${lines.join("\n")}\n`;
}

export default {
  PR_AUTOMATION_SCHEMA,
  PR_AUTOMATION_RECORDS_RELPATH,
  PR_AUTOMATION_OUTCOMES,
  appendPrAutomationTrace,
  buildPrAutomationPlan,
  enablePullRequestAutoMerge,
  fetchPrAutomationSnapshot,
  fetchPullRequestFiles,
  fetchPullRequestGraph,
  fetchRequiredStatusChecks,
  formatPrAutomationResult,
  latestChecksByContext,
  parsePullRequestNumber,
  parseRepository,
  prAutomationTracePath,
  requestPrAutoMerge,
  requiredContextsFromProtection,
  summarizeRequiredChecks,
};
