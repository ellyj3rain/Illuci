// illuci/core/governance/gitops/token-readiness.js
//
// Governed GitOps token readiness doctor. The doctor records whether
// operator-owned optional tokens can read the policy and corpus-promotion
// surfaces they are meant to support, without serializing secret values.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { runtimeDataPath } from "../../data/paths.js";
import { parseRepository, requiredContextsFromProtection } from "./pr-automation.js";

export const GITOPS_TOKEN_READINESS_SCHEMA = "illuci.gitops.token-readiness/1";
export const GITOPS_TOKEN_READINESS_RECORDS_RELPATH = ".illuci/data/gitops/token-readiness/records.jsonl";

export const GITOPS_TOKEN_READINESS_OUTCOMES = Object.freeze({
  READY: "ready",
  BLOCKED: "blocked",
});

const DEFAULT_API_URL = "https://api.github.com";

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
}

function bool(value) {
  return value === true;
}

function uniq(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function recordId(timestamp, options = {}) {
  if (options.id) return options.id;
  const stamp = Date.parse(timestamp) || Date.now();
  return `gitops-token-readiness-${stamp}-${randomUUID().slice(0, 8)}`;
}

function headerToken(token, label) {
  const value = clean(token);
  if (!value) throw new Error(`${label} is required`);
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

async function githubJson(url, { token, tokenLabel, fetchImpl = fetch, method = "GET", body = null, userAgent = "illuci-gitops-token-doctor" } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${headerToken(token, tokenLabel || "GitHub token")}`,
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

function tokenSource(name, present, authority) {
  return {
    name,
    present: bool(present),
    authority,
  };
}

function tokenSourcesFromValues({ policyToken, corpusToken, mutationToken, mutationTokenName = "GITHUB_TOKEN|GH_TOKEN" } = {}) {
  return {
    policy: tokenSource("ILLUCI_GITOPS_TOKEN", Boolean(clean(policyToken)), "required-check policy read"),
    corpus: tokenSource("ILLUCI_GITOPS_CORPUS_TOKEN", Boolean(clean(corpusToken)), "corpus promotion readiness"),
    mutation: tokenSource(mutationTokenName, Boolean(clean(mutationToken)), "PR auto-merge mutation"),
  };
}

function sanitizeTokenSource(source = {}, fallback) {
  return tokenSource(
    clean(source.name) || fallback.name,
    source.present,
    clean(source.authority) || fallback.authority,
  );
}

function normalizeTokenSources(sources = {}) {
  return {
    policy: sanitizeTokenSource(sources.policy, tokenSource("ILLUCI_GITOPS_TOKEN", false, "required-check policy read")),
    corpus: sanitizeTokenSource(sources.corpus, tokenSource("ILLUCI_GITOPS_CORPUS_TOKEN", false, "corpus promotion readiness")),
    mutation: sanitizeTokenSource(sources.mutation, tokenSource("GITHUB_TOKEN|GH_TOKEN", false, "PR auto-merge mutation")),
  };
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
    statusCode,
    requiredContexts: status === "ok" ? uniq(result.requiredContexts || []) : [],
    error: status === "unavailable" ? result.error || null : null,
  };
}

function normalizePolicy(policy = {}) {
  const sources = Array.isArray(policy.sources) ? policy.sources : [];
  const requiredContexts = uniq(policy.requiredContexts || sources.flatMap((source) => source.requiredContexts || []));
  const unavailable = sources.filter((source) => source.status === "unavailable");
  const status = clean(policy.status) || (unavailable.length > 0 ? "unavailable" : requiredContexts.length > 0 ? "ok" : "empty");
  return {
    ready: policy.ready === undefined ? status === "ok" : bool(policy.ready),
    status,
    baseRef: policy.baseRef || null,
    requiredContexts,
    sources: sources.map((source) => ({
      kind: source.kind || null,
      status: source.status || null,
      statusCode: source.statusCode || null,
      requiredContexts: uniq(source.requiredContexts || []),
      error: source.error || null,
    })),
    errors: Array.isArray(policy.errors)
      ? policy.errors.map((error) => ({
        kind: error.kind || null,
        statusCode: error.statusCode || null,
        message: error.message || error.error || null,
      }))
      : unavailable.map((source) => ({
        kind: source.kind || null,
        statusCode: source.statusCode || null,
        message: source.error || null,
      })),
  };
}

function normalizePermissions(permissions = {}) {
  return {
    admin: bool(permissions.admin),
    maintain: bool(permissions.maintain),
    push: bool(permissions.push),
    triage: bool(permissions.triage),
    pull: bool(permissions.pull),
  };
}

function normalizeCorpus(corpus = {}) {
  const permissions = normalizePermissions(corpus.permissions || corpus.permissionEvidence || {});
  const writeCapable = bool(corpus.writeCapable) || permissions.admin || permissions.maintain || permissions.push;
  const repositoryReadable = bool(corpus.repositoryReadable);
  const status = clean(corpus.status) || (repositoryReadable ? writeCapable ? "ok" : "insufficient-permission" : "unavailable");
  return {
    ready: corpus.ready === undefined ? status === "ok" : bool(corpus.ready),
    status,
    repositoryReadable,
    writeCapable,
    permissionEvidence: permissions,
    evidence: {
      method: corpus.evidence?.method || "repository-permissions",
      nonMutating: corpus.evidence?.nonMutating === undefined ? true : bool(corpus.evidence.nonMutating),
      pushCapabilityInferred: writeCapable,
    },
    errors: Array.isArray(corpus.errors)
      ? corpus.errors.map((error) => ({
        kind: error.kind || "corpus-token",
        statusCode: error.statusCode || null,
        message: error.message || error.error || null,
      }))
      : [],
  };
}

function normalizeRepositoryInput(input) {
  if (typeof input === "string") return parseRepository(input).nameWithOwner;
  if (input?.nameWithOwner) return parseRepository(input.nameWithOwner).nameWithOwner;
  if (input?.owner && input?.name) return parseRepository(`${input.owner}/${input.name}`).nameWithOwner;
  return null;
}

function mutationFromSources(tokenSources = {}) {
  return {
    token: tokenSources.mutation,
    authority: "GITHUB_TOKEN or GH_TOKEN remains the PR auto-merge mutation authority",
    ready: bool(tokenSources.mutation?.present),
  };
}

function computeBlockedBy({ tokenSources, policy, corpus, mutation }) {
  const blockedBy = [];
  if (!tokenSources.policy.present) blockedBy.push("policy-token-missing");
  else if (policy.status === "unavailable") blockedBy.push("required-check-policy-unavailable");
  else if (policy.status === "empty") blockedBy.push("required-check-policy-empty");
  else if (!policy.ready) blockedBy.push("policy-readiness-blocked");

  if (!tokenSources.corpus.present) blockedBy.push("corpus-token-missing");
  else if (corpus.status === "unavailable") blockedBy.push("corpus-token-unavailable");
  else if (corpus.status === "insufficient-permission") blockedBy.push("corpus-token-insufficient-permission");
  else if (!corpus.ready) blockedBy.push("corpus-token-not-ready");

  if (!mutation.ready) blockedBy.push("mutation-token-missing");
  return uniq(blockedBy);
}

export function buildGitopsTokenReadinessRecord(input = {}, options = {}) {
  const timestamp = options.timestamp || input.timestamp || nowIso();
  const repository = normalizeRepositoryInput(input.repository || input.subject?.repository);
  const baseRef = clean(input.baseRef || input.subject?.baseRef || "main") || "main";
  const tokenSources = normalizeTokenSources(input.tokenSources || {});
  const policy = normalizePolicy(input.policy || input.requiredCheckPolicy || {});
  const corpus = normalizeCorpus(input.corpus || {});
  const mutation = mutationFromSources(tokenSources);
  const blockedBy = computeBlockedBy({ tokenSources, policy, corpus, mutation });
  const ready = blockedBy.length === 0;

  return {
    schema: GITOPS_TOKEN_READINESS_SCHEMA,
    id: recordId(timestamp, options),
    timestamp,
    source: input.source || options.source || "illuci.gitops.token-readiness",
    subject: {
      kind: "repository",
      repository,
      baseRef,
    },
    inputs: {
      tokenSources,
      requiredCheckPolicy: policy,
    },
    policy,
    corpus,
    mutation,
    action: {
      outcome: ready ? GITOPS_TOKEN_READINESS_OUTCOMES.READY : GITOPS_TOKEN_READINESS_OUTCOMES.BLOCKED,
      ready,
      blockedBy,
    },
  };
}

async function fetchBranchProtectionSource({ repository, baseRef, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const root = apiUrl.replace(/\/$/, "");
  const repo = parseRepository(repository).nameWithOwner;
  const url = `${root}/repos/${repo}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`;
  try {
    const page = await githubJson(url, { token, tokenLabel: "ILLUCI_GITOPS_TOKEN", fetchImpl });
    return {
      ok: true,
      statusCode: 200,
      requiredContexts: requiredContextsFromProtection(page.data),
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: err.status || null,
      requiredContexts: [],
      error: err.message,
    };
  }
}

async function fetchBranchRulesSource({ repository, baseRef, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const root = apiUrl.replace(/\/$/, "");
  const repo = parseRepository(repository).nameWithOwner;
  const url = `${root}/repos/${repo}/rules/branches/${encodeURIComponent(baseRef)}`;
  try {
    const page = await githubJson(url, { token, tokenLabel: "ILLUCI_GITOPS_TOKEN", fetchImpl });
    return {
      ok: true,
      statusCode: 200,
      requiredContexts: requiredContextsFromBranchRules(page.data),
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: err.status || null,
      requiredContexts: [],
      error: err.message,
    };
  }
}

export async function fetchRequiredCheckPolicyReadiness({ repository, baseRef = "main", token, apiUrl, fetchImpl = fetch } = {}) {
  if (!clean(token)) {
    return {
      ready: false,
      status: "missing-token",
      baseRef,
      requiredContexts: [],
      sources: [],
      errors: [{ kind: "policy-token", statusCode: null, message: "ILLUCI_GITOPS_TOKEN is missing" }],
    };
  }
  const [branchProtection, branchRules] = await Promise.all([
    fetchBranchProtectionSource({ repository, baseRef, token, apiUrl, fetchImpl }),
    fetchBranchRulesSource({ repository, baseRef, token, apiUrl, fetchImpl }),
  ]);
  const branchRulesReadable = branchRules.ok === true;
  const sources = [
    policySource("branch-protection", branchProtection, { branchRulesReadable }),
    policySource("branch-rules", branchRules),
  ];
  const unavailable = sources.filter((source) => source.status === "unavailable");
  const requiredContexts = uniq(sources.flatMap((source) => source.requiredContexts));
  const status = unavailable.length > 0 ? "unavailable" : requiredContexts.length > 0 ? "ok" : "empty";
  return {
    ready: status === "ok",
    status,
    baseRef,
    requiredContexts,
    sources,
    errors: unavailable.map((source) => ({
      kind: source.kind,
      statusCode: source.statusCode,
      message: source.error,
    })),
  };
}

export async function fetchCorpusTokenReadiness({ repository, token, apiUrl = DEFAULT_API_URL, fetchImpl = fetch } = {}) {
  if (!clean(token)) {
    return {
      ready: false,
      status: "missing-token",
      repositoryReadable: false,
      writeCapable: false,
      permissionEvidence: normalizePermissions({}),
      evidence: { method: "repository-permissions", nonMutating: true, pushCapabilityInferred: false },
      errors: [{ kind: "corpus-token", statusCode: null, message: "ILLUCI_GITOPS_CORPUS_TOKEN is missing" }],
    };
  }
  const root = apiUrl.replace(/\/$/, "");
  const repo = parseRepository(repository).nameWithOwner;
  const url = `${root}/repos/${repo}`;
  try {
    const page = await githubJson(url, {
      token,
      tokenLabel: "ILLUCI_GITOPS_CORPUS_TOKEN",
      fetchImpl,
      userAgent: "illuci-gitops-corpus-token-doctor",
    });
    const permissions = normalizePermissions(page.data?.permissions || {});
    const writeCapable = permissions.admin || permissions.maintain || permissions.push;
    return {
      ready: writeCapable,
      status: writeCapable ? "ok" : "insufficient-permission",
      repositoryReadable: true,
      writeCapable,
      permissionEvidence: permissions,
      evidence: {
        method: "repository-permissions",
        nonMutating: true,
        pushCapabilityInferred: writeCapable,
      },
      errors: writeCapable ? [] : [{
        kind: "corpus-token",
        statusCode: 200,
        message: "repository permissions do not show push, maintain, or admin capability",
      }],
    };
  } catch (err) {
    return {
      ready: false,
      status: "unavailable",
      repositoryReadable: false,
      writeCapable: false,
      permissionEvidence: normalizePermissions({}),
      evidence: { method: "repository-permissions", nonMutating: true, pushCapabilityInferred: false },
      errors: [{ kind: "corpus-token", statusCode: err.status || null, message: err.message }],
    };
  }
}

function repositoryFromSnapshot(snapshot = {}) {
  return normalizeRepositoryInput(snapshot.repository || snapshot.subject?.repository);
}

export async function checkGitopsTokenReadiness(options = {}) {
  const env = options.env || process.env;
  const snapshot = options.snapshot || null;
  const repository = normalizeRepositoryInput(options.repository || repositoryFromSnapshot(snapshot) || env.GITHUB_REPOSITORY);
  const baseRef = clean(options.baseRef || snapshot?.baseRef || snapshot?.subject?.baseRef || "main") || "main";
  if (!repository) throw new Error("repository is required for GitOps token readiness");

  const mutationToken = options.mutationToken || env.GITHUB_TOKEN || env.GH_TOKEN;
  const mutationTokenName = env.GITHUB_TOKEN ? "GITHUB_TOKEN" : env.GH_TOKEN ? "GH_TOKEN" : "GITHUB_TOKEN|GH_TOKEN";
  const tokenSources = normalizeTokenSources(snapshot?.tokenSources || tokenSourcesFromValues({
    policyToken: options.policyToken || env.ILLUCI_GITOPS_TOKEN,
    corpusToken: options.corpusToken || env.ILLUCI_GITOPS_CORPUS_TOKEN,
    mutationToken,
    mutationTokenName,
  }));

  const policy = snapshot?.policy || snapshot?.requiredCheckPolicy || await fetchRequiredCheckPolicyReadiness({
    repository,
    baseRef,
    token: options.policyToken || env.ILLUCI_GITOPS_TOKEN,
    apiUrl: options.apiUrl,
    fetchImpl: options.fetchImpl,
  });
  const corpus = snapshot?.corpus || await fetchCorpusTokenReadiness({
    repository,
    token: options.corpusToken || env.ILLUCI_GITOPS_CORPUS_TOKEN,
    apiUrl: options.apiUrl,
    fetchImpl: options.fetchImpl,
  });

  const record = buildGitopsTokenReadinessRecord({
    repository,
    baseRef,
    tokenSources,
    policy,
    corpus,
    source: options.source || "illuci.gitops.token-readiness",
  }, options.record || {});

  let trace = null;
  if (options.writeTrace) trace = appendGitopsTokenReadinessTrace(record);
  return { record, trace };
}

export function gitopsTokenReadinessTracePath() {
  return runtimeDataPath("gitops", join("token-readiness", "records.jsonl"));
}

function appendJsonLine(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

export function appendGitopsTokenReadinessTrace(record) {
  const path = gitopsTokenReadinessTracePath();
  appendJsonLine(path, record);
  return {
    ok: true,
    path,
    displayPath: GITOPS_TOKEN_READINESS_RECORDS_RELPATH,
    recordId: record.id,
  };
}

export function formatGitopsTokenReadinessResult(result = {}) {
  const record = result.record || result;
  const subject = record.subject || {};
  const policy = record.policy || record.inputs?.requiredCheckPolicy || {};
  const corpus = record.corpus || {};
  const blockedBy = record.action?.blockedBy || [];
  const lines = [
    `illuci gitops doctor - ${subject.repository || "(repository)"} ${subject.baseRef || "main"}: ${record.action?.outcome || "unknown"}`,
    `  policy: ${policy.status || "unknown"} (${(policy.requiredContexts || []).length} required context(s))`,
    `  corpus: ${corpus.status || "unknown"} (${corpus.writeCapable ? "write evidence present" : "write evidence missing"})`,
    `  mutation-token: ${record.mutation?.ready ? "present" : "missing"}`,
  ];
  if (blockedBy.length) lines.push(`  blocked-by: ${blockedBy.join(", ")}`);
  if (result.trace) lines.push(`  trace: ${result.trace.displayPath}`);
  return `${lines.join("\n")}\n`;
}

export default {
  GITOPS_TOKEN_READINESS_SCHEMA,
  GITOPS_TOKEN_READINESS_RECORDS_RELPATH,
  GITOPS_TOKEN_READINESS_OUTCOMES,
  appendGitopsTokenReadinessTrace,
  buildGitopsTokenReadinessRecord,
  checkGitopsTokenReadiness,
  fetchCorpusTokenReadiness,
  fetchRequiredCheckPolicyReadiness,
  formatGitopsTokenReadinessResult,
  gitopsTokenReadinessTracePath,
};
