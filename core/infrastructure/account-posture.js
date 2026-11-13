import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { runtimeDataPath } from "../data/paths.js";

export const INFRASTRUCTURE_ACCOUNT_POSTURE_SCHEMA = "illuci.infrastructure.account-posture/1";
export const INFRASTRUCTURE_ACCOUNT_POSTURE_SET_SCHEMA = "illuci.infrastructure.account-posture-set/1";
export const INFRASTRUCTURE_ACCOUNT_POSTURE_RECORDS_RELPATH = ".illuci/data/infrastructure/account-posture/records.jsonl";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_GITLAB_API_URL = "https://gitlab.com/api/v4";
const DEFAULT_VERCEL_API_URL = "https://api.vercel.com";
const DEFAULT_SUPABASE_API_URL = "https://api.supabase.com";

function freeze(value) {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) value[key] = freeze(child);
    return Object.freeze(value);
  }
  return value;
}

export const INFRASTRUCTURE_ACCOUNT_ADAPTERS = freeze({
  github: {
    id: "github",
    label: "GitHub",
    family: "gitops",
    substrateClass: "source-control-and-ci",
    tokenEnv: ["ILLUCI_GITHUB_ACCOUNT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "ILLUCI_GITOPS_TOKEN"],
    apiBaseEnv: "GITHUB_API_URL",
    defaultApiBase: DEFAULT_GITHUB_API_URL,
    ui: {
      account: "https://github.com/settings/profile",
      billing: "https://github.com/settings/billing/plans",
      actions: "https://github.com/settings/billing/summary",
    },
    surfaces: ["repositories", "pull-requests", "checks", "actions", "billing", "plans"],
    apiProbes: ["identity", "actions-billing"],
  },
  gitlab: {
    id: "gitlab",
    label: "GitLab",
    family: "gitops",
    substrateClass: "source-control-ci-and-self-managed-runners",
    tokenEnv: ["ILLUCI_GITLAB_TOKEN", "GITLAB_TOKEN", "GL_TOKEN", "GITLAB_PRIVATE_TOKEN", "ILLUCI_GITOPS_GITLAB_TOKEN", "CI_JOB_TOKEN"],
    apiBaseEnv: "GITLAB_API_URL",
    defaultApiBase: DEFAULT_GITLAB_API_URL,
    ui: {
      account: "https://gitlab.com/-/profile",
      projects: "https://gitlab.com/dashboard/projects",
      runners: "https://gitlab.com/admin/runners",
      subscription: "https://gitlab.com/admin/subscription",
    },
    surfaces: ["repositories", "merge-requests", "pipelines", "jobs", "artifacts", "runners", "subscription", "admin"],
    apiProbes: ["identity", "version", "runners", "license"],
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    family: "deployment-hosting",
    substrateClass: "serverless-and-edge-hosting",
    tokenEnv: ["VERCEL_TOKEN"],
    apiBaseEnv: "VERCEL_API_URL",
    defaultApiBase: DEFAULT_VERCEL_API_URL,
    ui: {
      account: "https://vercel.com/account",
      billing: "https://vercel.com/account/billing",
      usage: "https://vercel.com/account/usage",
    },
    surfaces: ["teams", "projects", "deployments", "domains", "usage", "billing"],
    apiProbes: ["identity"],
  },
  supabase: {
    id: "supabase",
    label: "Supabase",
    family: "managed-data-platform",
    substrateClass: "postgres-auth-storage-edge-functions",
    tokenEnv: ["SUPABASE_ACCESS_TOKEN"],
    apiBaseEnv: "SUPABASE_API_URL",
    defaultApiBase: DEFAULT_SUPABASE_API_URL,
    ui: {
      account: "https://supabase.com/dashboard/account/me",
      billing: "https://supabase.com/dashboard/org/_/billing",
      projects: "https://supabase.com/dashboard/projects",
    },
    surfaces: ["organizations", "projects", "postgres", "auth", "storage", "edge-functions", "billing"],
    apiProbes: ["projects"],
  },
  obsidian: {
    id: "obsidian",
    label: "Obsidian",
    family: "knowledge-vault",
    substrateClass: "local-knowledge-and-sync",
    tokenEnv: ["OBSIDIAN_API_KEY", "OBSIDIAN_REST_API_KEY"],
    apiBaseEnv: "OBSIDIAN_REST_API_URL",
    defaultApiBase: null,
    ui: {
      account: "https://obsidian.md/account",
      vault: "obsidian://open",
      sync: "https://obsidian.md/sync",
    },
    surfaces: ["local-vaults", "sync", "publish", "local-rest-plugin", "mcp"],
    apiProbes: ["local-rest"],
  },
});

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || "").trim();
}

function bool(value) {
  return value === true;
}

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniq(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function recordId(timestamp, options = {}) {
  if (options.id) return options.id;
  const stamp = Date.parse(timestamp) || Date.now();
  return `infrastructure-account-posture-${stamp}-${randomUUID().slice(0, 8)}`;
}

export function listInfrastructureAccountAdapters() {
  return Object.values(INFRASTRUCTURE_ACCOUNT_ADAPTERS).map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    family: adapter.family,
    substrateClass: adapter.substrateClass,
    tokenEnv: [...adapter.tokenEnv],
    surfaces: [...adapter.surfaces],
    apiProbes: [...adapter.apiProbes],
    ui: { ...adapter.ui },
  }));
}

export function adapterForInfrastructurePlatform(platform) {
  return INFRASTRUCTURE_ACCOUNT_ADAPTERS[clean(platform).toLowerCase()] || null;
}

function authFromInput(input = {}, adapter = {}) {
  const source = input.auth || {};
  const tokenNames = uniq(source.tokenNames || source.tokenName ? [source.tokenName, ...(source.tokenNames || [])] : []);
  const tokenPresent = source.tokenPresent === undefined
    ? tokenNames.length > 0 || bool(source.present)
    : bool(source.tokenPresent);
  return {
    tokenPresent,
    tokenNames,
    tokenName: tokenNames[0] || null,
    requiredTokenEnv: [...(adapter.tokenEnv || [])],
    scopeEvidence: uniq(source.scopeEvidence || source.scopes || []),
    source: source.source || (tokenPresent ? "environment" : "none"),
  };
}

function normalizedProbe(probe = {}) {
  return {
    id: probe.id || probe.name || null,
    surface: probe.surface || null,
    status: probe.status || (probe.ok === true ? "available" : probe.ok === false ? "unavailable" : "unknown"),
    ok: probe.ok === undefined ? probe.status === "available" : bool(probe.ok),
    statusCode: probe.statusCode || probe.status_code || null,
    source: probe.source || "api",
    evidence: probe.evidence || null,
    summary: probe.summary || null,
    error: probe.error || null,
  };
}

function quotaFromInput(input = {}) {
  const quota = input.quota || {};
  const included = quota.included ?? quota.includedMinutes ?? quota.limit ?? null;
  const used = quota.used ?? quota.usedMinutes ?? quota.totalMinutesUsed ?? null;
  const remaining = quota.remaining ?? (included != null && used != null ? Number(included) - Number(used) : null);
  let posture = clean(quota.posture || quota.status);
  if (!posture && included != null && used != null) {
    const includedNum = Number(included);
    const usedNum = Number(used);
    if (Number.isFinite(includedNum) && includedNum > 0 && Number.isFinite(usedNum)) {
      const ratio = usedNum / includedNum;
      posture = ratio >= 1 ? "exhausted" : ratio >= 0.8 ? "limited" : "available";
    }
  }
  return {
    posture: posture || "unknown",
    included,
    used,
    remaining,
    unit: quota.unit || "unknown",
    source: quota.source || null,
  };
}

function quotaFromGitHubBillingPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const included = payload.included_minutes ?? payload.includedMinutes ?? null;
  const used = payload.total_minutes_used ?? payload.totalMinutesUsed ?? null;
  if (included == null && used == null) return null;
  return {
    included,
    used,
    unit: "github-actions-minutes",
    source: "github-actions-billing-api",
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function executionFromInput(input = {}) {
  const execution = input.execution || {};
  return {
    requested: bool(execution.requested),
    substrate: execution.substrate || null,
    runnerPosture: execution.runnerPosture || execution.runner || null,
    source: execution.source || null,
  };
}

function accountFromInput(input = {}) {
  const account = input.account || {};
  return {
    kind: account.kind || input.accountKind || "unknown",
    id: account.id || null,
    login: account.login || account.slug || input.account || null,
    label: account.label || account.name || account.login || input.account || null,
    plan: account.plan || null,
    tier: account.tier || null,
  };
}

function guiFromInput(input = {}, adapter = {}) {
  const gui = input.gui || {};
  const supported = adapter.ui && Object.keys(adapter.ui).length > 0;
  return {
    supported,
    status: gui.status || (supported ? "available" : "unsupported"),
    required: bool(gui.required),
    checked: bool(gui.checked),
    urls: { ...(adapter.ui || {}), ...(gui.urls || {}) },
    source: gui.source || null,
  };
}

function classifyExecutionPosture({ adapter, auth, apiEvidence, quota, gui, execution }) {
  const runnerProbe = apiEvidence.find((probe) => probe.id === "runners" || probe.surface === "runners");
  const runnerTotal = numberOrNull(runnerProbe?.evidence?.total);
  const runnerVisible = Boolean(runnerProbe?.ok && (runnerTotal == null || runnerTotal > 0));
  const runnerEmpty = Boolean(runnerProbe?.ok && runnerTotal === 0);
  const runnerPermissionLimited = Boolean(runnerProbe && !runnerProbe.ok && [401, 403].includes(Number(runnerProbe.statusCode)));
  const isSelfManagedGitLab = adapter.id === "gitlab";

  if (quota.posture === "exhausted") {
    return {
      executionSubstratePosture: "hosted-execution-blocked",
      runnerPosture: "not-applicable",
      executionAction: "pause-hosted-execution",
      executionEvidence: "quota-exhausted",
    };
  }

  if (isSelfManagedGitLab) {
    if (runnerVisible) {
      return {
        executionSubstratePosture: "self-managed-runner-visible",
        runnerPosture: "visible",
        executionAction: "use-self-managed-runner",
        executionEvidence: "gitlab-runners-api",
      };
    }
    if (runnerEmpty) {
      return {
        executionSubstratePosture: "self-managed-runner-unregistered",
        runnerPosture: "not-registered",
        executionAction: "verify-runner",
        executionEvidence: "gitlab-runners-api-empty",
      };
    }
    if (runnerPermissionLimited) {
      return {
        executionSubstratePosture: "self-managed-runner-permission-limited",
        runnerPosture: "permission-limited",
        executionAction: gui.checked ? "verify-runner" : "verify-frontend",
        executionEvidence: "gitlab-runners-api-permission-limited",
      };
    }
    if (auth.tokenPresent) {
      return {
        executionSubstratePosture: "self-managed-runner-verification-required",
        runnerPosture: "verification-required",
        executionAction: "verify-runner",
        executionEvidence: runnerProbe ? "gitlab-runners-api-unavailable" : "gitlab-account-api",
      };
    }
    return {
      executionSubstratePosture: "self-managed-runner-auth-required",
      runnerPosture: "unknown",
      executionAction: "require-auth",
      executionEvidence: "token-missing",
    };
  }

  if (execution.substrate || execution.runnerPosture) {
    return {
      executionSubstratePosture: execution.substrate || "operator-specified",
      runnerPosture: execution.runnerPosture || "operator-specified",
      executionAction: "verify",
      executionEvidence: execution.source || "input",
    };
  }

  return {
    executionSubstratePosture: "unknown",
    runnerPosture: "unknown",
    executionAction: "verify",
    executionEvidence: "none",
  };
}

function classifyPosture({ adapter, auth, apiEvidence, quota, gui, account, execution }) {
  const apiAvailable = apiEvidence.some((probe) => probe.ok);
  const apiUnavailable = apiEvidence.some((probe) => probe.ok === false);
  const executionPosture = classifyExecutionPosture({ adapter, auth, apiEvidence, quota, gui, execution });
  const hasFrontendAccountSurface = gui.supported && (adapter.surfaces || []).some((surface) => {
    return ["billing", "plans", "usage", "sync", "publish", "runners", "subscription", "admin"].includes(surface);
  });
  const frontendFeatureVerificationNeeded = apiAvailable
    && hasFrontendAccountSurface
    && !gui.checked
    && !account.plan
    && !account.tier
    && quota.posture === "unknown";
  const authPosture = auth.tokenPresent ? apiUnavailable && !apiAvailable ? "token-present-unverified" : "authorized" : "missing";
  let accountPosture = "unknown";
  if (apiAvailable) accountPosture = "api-confirmed";
  else if (adapter.id === "obsidian" && !auth.tokenPresent) accountPosture = "local-plugin-required";
  else if (gui.supported) accountPosture = "frontend-verification-required";

  let featureDiscovery = "unknown";
  if (frontendFeatureVerificationNeeded) featureDiscovery = "api-plus-frontend-required";
  else if (apiAvailable && gui.supported) featureDiscovery = "api-plus-frontend";
  else if (apiAvailable) featureDiscovery = "api-supported";
  else if (adapter.id === "obsidian") featureDiscovery = "local-plugin-or-frontend";
  else if (gui.supported) featureDiscovery = "frontend-required";

  let action = "verify";
  if (!auth.tokenPresent && adapter.id !== "obsidian") action = "require-auth";
  else if (quota.posture === "exhausted") action = "pause-hosted-execution";
  else if (adapter.id === "gitlab" && executionPosture.executionAction === "use-self-managed-runner") action = "use-self-managed-runner";
  else if (adapter.id === "gitlab" && executionPosture.executionAction === "verify-runner") action = "verify-runner";
  else if (adapter.id === "gitlab" && executionPosture.executionAction === "verify-frontend") action = "verify-frontend";
  else if (frontendFeatureVerificationNeeded) action = "verify-frontend";
  else if (accountPosture === "api-confirmed" && quota.posture !== "exhausted") action = "proceed";
  else if (accountPosture === "frontend-verification-required" || accountPosture === "local-plugin-required") action = "verify-frontend";

  return {
    platformFamily: adapter.family,
    substrateClass: adapter.substrateClass,
    authPosture,
    accountPosture,
    quotaPosture: quota.posture,
    featureDiscoveryPosture: featureDiscovery,
    frontendPosture: gui.checked ? "checked" : gui.supported ? "checkable" : "unsupported",
    executionSubstratePosture: executionPosture.executionSubstratePosture,
    runnerPosture: executionPosture.runnerPosture,
    executionAction: executionPosture.executionAction,
    executionEvidence: executionPosture.executionEvidence,
    action,
    accountPlanKnown: Boolean(account.plan || account.tier),
  };
}

export function buildInfrastructureAccountPosture(input = {}, options = {}) {
  const timestamp = options.timestamp || input.timestamp || nowIso();
  const platform = clean(input.platform || input.id || "unknown").toLowerCase();
  const adapter = adapterForInfrastructurePlatform(platform) || {
    id: platform || "unknown",
    label: input.label || platform || "Unknown",
    family: "unknown",
    substrateClass: "unknown",
    tokenEnv: [],
    surfaces: [],
    apiProbes: [],
    ui: {},
  };
  const account = accountFromInput(input);
  const auth = authFromInput(input, adapter);
  const probeInputs = Array.isArray(input.apiEvidence) ? input.apiEvidence : Array.isArray(input.probes) ? input.probes : [];
  const apiEvidence = probeInputs.map(normalizedProbe);
  const githubBillingProbe = apiEvidence.find((probe) => probe.id === "actions-billing" && probe.evidence);
  const quota = quotaFromInput({
    quota: input.quota || quotaFromGitHubBillingPayload(githubBillingProbe?.evidence),
  });
  const gui = guiFromInput(input, adapter);
  const execution = executionFromInput(input);
  const dimensions = classifyPosture({ adapter, auth, apiEvidence, quota, gui, account, execution });
  return {
    schema: INFRASTRUCTURE_ACCOUNT_POSTURE_SCHEMA,
    id: recordId(timestamp, options),
    timestamp,
    source: input.source || options.source || "illuci.infrastructure.account-posture",
    subject: {
      kind: "infrastructure-platform",
      platform: adapter.id,
      label: adapter.label,
      family: adapter.family,
      substrateClass: adapter.substrateClass,
      account,
    },
    adapter: {
      id: adapter.id,
      label: adapter.label,
      family: adapter.family,
      substrateClass: adapter.substrateClass,
      surfaces: [...(adapter.surfaces || [])],
      apiProbes: [...(adapter.apiProbes || [])],
    },
    inputs: {
      auth,
      apiEvidence,
      gui,
      execution,
    },
    quota,
    dimensions,
    action: {
      outcome: ["proceed", "verify", "verify-frontend", "verify-runner", "use-self-managed-runner"].includes(dimensions.action) ? "ready" : "blocked",
      recommendation: dimensions.action,
      blockedBy: blockedReasons(dimensions),
    },
  };
}

function blockedReasons(dimensions = {}) {
  const out = [];
  if (dimensions.authPosture === "missing") out.push("account-token-missing");
  if (dimensions.quotaPosture === "exhausted") out.push("hosted-quota-exhausted");
  if (dimensions.accountPosture === "frontend-verification-required") out.push("frontend-account-verification-required");
  if (dimensions.accountPosture === "local-plugin-required") out.push("local-plugin-or-vault-verification-required");
  if (dimensions.executionSubstratePosture === "self-managed-runner-auth-required") out.push("self-managed-runner-auth-required");
  return uniq(out);
}

function tokenFromEnv(env = {}, names = []) {
  for (const name of names) {
    if (clean(env[name])) return { name, value: clean(env[name]) };
  }
  return { name: null, value: null };
}

async function fetchJson(url, { token, fetchImpl = fetch, headers = {} } = {}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false, statusCode: null, error: "fetch unavailable", data: null };
  }
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
    let data = null;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return {
      ok: Boolean(response.ok),
      statusCode: response.status || null,
      data,
      error: response.ok ? null : data?.message || response.statusText || `HTTP ${response.status}`,
    };
  } catch (err) {
    return { ok: false, statusCode: null, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function platformList(input) {
  if (Array.isArray(input)) return input.map(clean).filter(Boolean);
  const text = clean(input);
  if (!text || text === "all") return Object.keys(INFRASTRUCTURE_ACCOUNT_ADAPTERS);
  return text.split(",").map(clean).filter(Boolean);
}

function rootUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}${path}`;
}

function gitLabApiBaseFrom(value) {
  const text = clean(value);
  if (!text) return null;
  const trimmed = text.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v4")) return trimmed;
  return `${trimmed}/api/v4`;
}

function gitLabAuthHeaders(token = {}) {
  if (!token.value) return {};
  if (token.name === "CI_JOB_TOKEN") return { "job-token": token.value };
  if (token.name === "GITLAB_OAUTH_TOKEN") return { authorization: `Bearer ${token.value}` };
  return { "private-token": token.value };
}

async function probeGitHub({ adapter, env, fetchImpl, account, options }) {
  const token = tokenFromEnv(env, adapter.tokenEnv);
  const apiBase = clean(options.githubApiUrl || env[adapter.apiBaseEnv]) || adapter.defaultApiBase;
  const probes = [];
  let resolvedAccount = account;
  if (token.value) {
    const identity = await fetchJson(rootUrl(apiBase, "/user"), {
      token: token.value,
      fetchImpl,
      headers: { "x-github-api-version": "2022-11-28" },
    });
    probes.push(normalizedProbe({
      id: "identity",
      surface: "account",
      ok: identity.ok,
      statusCode: identity.statusCode,
      evidence: identity.ok ? { login: identity.data?.login || null, plan: identity.data?.plan?.name || null } : null,
      error: identity.error,
    }));
    if (identity.ok && !resolvedAccount?.login) {
      resolvedAccount = { ...(resolvedAccount || {}), kind: "user", login: identity.data?.login || null, plan: identity.data?.plan?.name || null };
    }
    const billingAccount = clean(options.githubBillingAccount || env.ILLUCI_GITHUB_BILLING_ACCOUNT || resolvedAccount?.login);
    const billingKind = clean(options.githubBillingKind || env.ILLUCI_GITHUB_BILLING_KIND || resolvedAccount?.kind || "user");
    if (billingAccount) {
      const path = billingKind === "organization"
        ? `/orgs/${encodeURIComponent(billingAccount)}/settings/billing/actions`
        : `/users/${encodeURIComponent(billingAccount)}/settings/billing/actions`;
      const billing = await fetchJson(rootUrl(apiBase, path), {
        token: token.value,
        fetchImpl,
        headers: { "x-github-api-version": "2022-11-28" },
      });
      probes.push(normalizedProbe({
        id: "actions-billing",
        surface: "actions",
        ok: billing.ok,
        statusCode: billing.statusCode,
        evidence: billing.ok ? billing.data : null,
        error: billing.error,
      }));
    }
  }
  return buildInfrastructureAccountPosture({
    platform: adapter.id,
    account: resolvedAccount,
    auth: {
      tokenPresent: Boolean(token.value),
      tokenNames: token.name ? [token.name] : [],
      source: token.name ? "environment" : "none",
    },
    apiEvidence: probes,
    source: options.source,
  }, options.record || {});
}

async function probeGitLab({ adapter, env, fetchImpl, account, options }) {
  const token = tokenFromEnv(env, adapter.tokenEnv);
  const configuredBase = options.gitlabApiUrl || env[adapter.apiBaseEnv] || env.ILLUCI_GITLAB_API_URL;
  const apiBase = gitLabApiBaseFrom(configuredBase || env.GITLAB_URL || env.CI_SERVER_URL) || adapter.defaultApiBase;
  const authHeaders = gitLabAuthHeaders(token);
  const probes = [];
  let resolvedAccount = account;

  if (apiBase && (token.value || configuredBase || env.GITLAB_URL || env.CI_SERVER_URL)) {
    const version = await fetchJson(rootUrl(apiBase, "/version"), {
      fetchImpl,
      headers: authHeaders,
    });
    probes.push(normalizedProbe({
      id: "version",
      surface: "server",
      ok: version.ok,
      statusCode: version.statusCode,
      evidence: version.ok ? { version: version.data?.version || null, revision: version.data?.revision || null, apiBase } : null,
      error: version.error,
    }));
  }

  if (token.value) {
    const identity = await fetchJson(rootUrl(apiBase, "/user"), {
      fetchImpl,
      headers: authHeaders,
    });
    probes.push(normalizedProbe({
      id: "identity",
      surface: "account",
      ok: identity.ok,
      statusCode: identity.statusCode,
      evidence: identity.ok ? {
        id: identity.data?.id || null,
        username: identity.data?.username || null,
        name: identity.data?.name || null,
        is_admin: Boolean(identity.data?.is_admin),
      } : null,
      error: identity.error,
    }));
    if (identity.ok) {
      resolvedAccount = {
        ...(resolvedAccount || {}),
        kind: identity.data?.is_admin ? "admin-or-user" : "user",
        id: identity.data?.id || null,
        login: identity.data?.username || null,
        label: identity.data?.name || identity.data?.username || null,
      };
    }

    const runners = await fetchJson(rootUrl(apiBase, "/runners"), {
      fetchImpl,
      headers: authHeaders,
    });
    probes.push(normalizedProbe({
      id: "runners",
      surface: "runners",
      ok: runners.ok,
      statusCode: runners.statusCode,
      evidence: runners.ok ? {
        total: Array.isArray(runners.data) ? runners.data.length : null,
        active: Array.isArray(runners.data) ? runners.data.filter((runner) => runner.active !== false).length : null,
      } : null,
      error: runners.error,
    }));

    const license = await fetchJson(rootUrl(apiBase, "/license"), {
      fetchImpl,
      headers: authHeaders,
    });
    probes.push(normalizedProbe({
      id: "license",
      surface: "subscription",
      ok: license.ok,
      statusCode: license.statusCode,
      evidence: license.ok ? {
        plan: license.data?.plan || license.data?.licensee?.Plan || null,
        expiresAt: license.data?.expires_at || license.data?.expiresAt || null,
        userLimit: license.data?.user_limit || null,
      } : null,
      error: license.error,
    }));
  }

  return buildInfrastructureAccountPosture({
    platform: adapter.id,
    account: resolvedAccount,
    auth: {
      tokenPresent: Boolean(token.value),
      tokenNames: token.name ? [token.name] : [],
      source: token.name ? "environment" : "none",
    },
    apiEvidence: probes,
    gui: {
      urls: configuredBase || env.GITLAB_URL || env.CI_SERVER_URL ? {
        account: String(configuredBase || env.GITLAB_URL || env.CI_SERVER_URL).replace(/\/api\/v4\/?$/, "/-/profile"),
      } : {},
    },
    source: options.source,
  }, options.record || {});
}

async function probeVercel({ adapter, env, fetchImpl, account, options }) {
  const token = tokenFromEnv(env, adapter.tokenEnv);
  const apiBase = clean(options.vercelApiUrl || env[adapter.apiBaseEnv]) || adapter.defaultApiBase;
  const probes = [];
  let resolvedAccount = account;
  if (token.value) {
    const identity = await fetchJson(rootUrl(apiBase, "/v2/user"), { token: token.value, fetchImpl });
    probes.push(normalizedProbe({
      id: "identity",
      surface: "account",
      ok: identity.ok,
      statusCode: identity.statusCode,
      evidence: identity.ok ? { id: identity.data?.user?.id || identity.data?.id || null, username: identity.data?.user?.username || identity.data?.username || null } : null,
      error: identity.error,
    }));
    if (identity.ok) {
      resolvedAccount = {
        ...(resolvedAccount || {}),
        kind: "user-or-team",
        id: identity.data?.user?.id || identity.data?.id || null,
        login: identity.data?.user?.username || identity.data?.username || null,
      };
    }
  }
  return buildInfrastructureAccountPosture({
    platform: adapter.id,
    account: resolvedAccount,
    auth: {
      tokenPresent: Boolean(token.value),
      tokenNames: token.name ? [token.name] : [],
      source: token.name ? "environment" : "none",
    },
    apiEvidence: probes,
    source: options.source,
  }, options.record || {});
}

async function probeSupabase({ adapter, env, fetchImpl, account, options }) {
  const token = tokenFromEnv(env, adapter.tokenEnv);
  const apiBase = clean(options.supabaseApiUrl || env[adapter.apiBaseEnv]) || adapter.defaultApiBase;
  const probes = [];
  if (token.value) {
    const projects = await fetchJson(rootUrl(apiBase, "/v1/projects"), { token: token.value, fetchImpl });
    probes.push(normalizedProbe({
      id: "projects",
      surface: "projects",
      ok: projects.ok,
      statusCode: projects.statusCode,
      evidence: projects.ok ? { total: Array.isArray(projects.data) ? projects.data.length : null } : null,
      error: projects.error,
    }));
  }
  return buildInfrastructureAccountPosture({
    platform: adapter.id,
    account: account || { kind: "organization-or-project" },
    auth: {
      tokenPresent: Boolean(token.value),
      tokenNames: token.name ? [token.name] : [],
      source: token.name ? "environment" : "none",
    },
    apiEvidence: probes,
    source: options.source,
  }, options.record || {});
}

async function probeObsidian({ adapter, env, fetchImpl, account, options }) {
  const token = tokenFromEnv(env, adapter.tokenEnv);
  const base = clean(options.obsidianApiUrl || env[adapter.apiBaseEnv]);
  const probes = [];
  if (base) {
    const local = await fetchJson(rootUrl(base, "/"), { token: token.value, fetchImpl });
    probes.push(normalizedProbe({
      id: "local-rest",
      surface: "local-vaults",
      ok: local.ok,
      statusCode: local.statusCode,
      evidence: local.ok ? { endpoint: base } : null,
      error: local.error,
    }));
  }
  return buildInfrastructureAccountPosture({
    platform: adapter.id,
    account: account || { kind: "local-vault" },
    auth: {
      tokenPresent: Boolean(token.value || base),
      tokenNames: token.name ? [token.name] : [],
      source: token.name ? "environment" : base ? "local-endpoint" : "none",
    },
    apiEvidence: probes,
    source: options.source,
  }, options.record || {});
}

async function probePlatform(platform, context) {
  const adapter = adapterForInfrastructurePlatform(platform);
  if (!adapter) {
    return buildInfrastructureAccountPosture({
      platform,
      source: context.options.source,
      gui: { status: "unsupported" },
    }, context.options.record || {});
  }
  if (context.snapshot?.recordsByPlatform?.[adapter.id]) {
    return buildInfrastructureAccountPosture(context.snapshot.recordsByPlatform[adapter.id], context.options.record || {});
  }
  if (context.snapshot?.[adapter.id]) {
    return buildInfrastructureAccountPosture(context.snapshot[adapter.id], context.options.record || {});
  }
  const common = {
    adapter,
    env: context.env,
    fetchImpl: context.fetchImpl,
    account: context.options.account,
    options: context.options,
  };
  switch (adapter.id) {
    case "github":
      return probeGitHub(common);
    case "gitlab":
      return probeGitLab(common);
    case "vercel":
      return probeVercel(common);
    case "supabase":
      return probeSupabase(common);
    case "obsidian":
      return probeObsidian(common);
    default:
      return buildInfrastructureAccountPosture({ platform: adapter.id, source: context.options.source }, context.options.record || {});
  }
}

export async function checkInfrastructureAccountPosture(options = {}) {
  const env = options.env || process.env;
  const platforms = platformList(options.platforms || options.platform || "github");
  const snapshot = options.snapshot || null;
  const records = [];
  const recordsByPlatform = {};
  for (const platform of platforms) {
    const record = await probePlatform(platform, {
      env,
      fetchImpl: options.fetchImpl || fetch,
      options: {
        ...options,
        source: options.source || "illuci.infrastructure.account-posture",
      },
      snapshot,
    });
    records.push(record);
    recordsByPlatform[record.subject.platform] = record;
  }
  const set = {
    schema: INFRASTRUCTURE_ACCOUNT_POSTURE_SET_SCHEMA,
    timestamp: options.timestamp || nowIso(),
    source: options.source || "illuci.infrastructure.account-posture",
    platforms: records.map((record) => record.subject.platform),
    ok: records.every((record) => record.action.outcome === "ready"),
    records,
  };
  let trace = null;
  if (options.writeTrace) {
    trace = appendInfrastructureAccountPostureTrace(records);
    set.trace = trace;
  }
  return { ...set, recordsByPlatform };
}

export function infrastructureAccountPostureTracePath() {
  return runtimeDataPath("infrastructure", join("account-posture", "records.jsonl"));
}

function appendJsonLine(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

export function appendInfrastructureAccountPostureTrace(records) {
  const path = infrastructureAccountPostureTracePath();
  const list = Array.isArray(records) ? records : [records];
  for (const record of list) appendJsonLine(path, record);
  return {
    ok: true,
    path,
    displayPath: INFRASTRUCTURE_ACCOUNT_POSTURE_RECORDS_RELPATH,
    recordIds: list.map((record) => record.id),
  };
}

export function formatInfrastructureAccountPostureResult(result = {}) {
  const records = Array.isArray(result.records) ? result.records : [result.record || result].filter(Boolean);
  const lines = ["illuci infrastructure doctor:"];
  for (const record of records) {
    const platform = record.subject?.platform || "unknown";
    const family = record.subject?.family || "unknown";
    const action = record.action?.recommendation || "unknown";
    const quota = record.quota?.posture || "unknown";
    lines.push(`  ${platform}: ${action} family=${family} quota=${quota}`);
    if (record.action?.blockedBy?.length) lines.push(`    blocked-by: ${record.action.blockedBy.join(", ")}`);
  }
  if (result.trace) lines.push(`  trace: ${result.trace.displayPath}`);
  return `${lines.join("\n")}\n`;
}

export default {
  INFRASTRUCTURE_ACCOUNT_ADAPTERS,
  INFRASTRUCTURE_ACCOUNT_POSTURE_SCHEMA,
  INFRASTRUCTURE_ACCOUNT_POSTURE_SET_SCHEMA,
  INFRASTRUCTURE_ACCOUNT_POSTURE_RECORDS_RELPATH,
  adapterForInfrastructurePlatform,
  appendInfrastructureAccountPostureTrace,
  buildInfrastructureAccountPosture,
  checkInfrastructureAccountPosture,
  formatInfrastructureAccountPostureResult,
  infrastructureAccountPostureTracePath,
  listInfrastructureAccountAdapters,
};
