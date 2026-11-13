import { existsSync } from "node:fs";

import {
  MODEL_STATUS,
  getEntry,
  isSuspended,
  listModels,
  resolveModelId,
} from "../bridges/model-registry.js";
import { getAgyCommand, getClaudeCommand, getGrokCommand, getKimiCommand, resolvesOnPath } from "../bridges/tool-paths.js";
import { detectAuth as detectGeminiApiAuth } from "../bridges/gemini-api.js";
import { probeRoute as probeOllamaRoute } from "../bridges/ollama.js";
import { probeRoute as probeNvidiaRoute } from "../bridges/nvidia-nim.js";
import { getModelRoles, isAvailable } from "../matrix/capability-matrix.js";
import { getProviderResource } from "./resource-gateway.js";
import { modelLabelFor } from "./model-labels.js";
// [A94]/DR-187 (F-129): the doctor must see the SAME env the bridges dispatch
// with — envarapi.env loads through the one explicit seam, not via the
// barrel's import side effect this module never triggered (the NIM
// missing-auth lie: dispatch answered live while the doctor saw a bare env).
import { loadBridgeEnv } from "../bridges/env-load.js";
loadBridgeEnv();

function pathPresent(command) {
  if (!command) return { present: false, command: null };
  const value = String(command);
  const pathLike = value.includes("\\") || value.includes("/") || /^[a-zA-Z]:/.test(value);
  if (pathLike) return { present: existsSync(value), command: value };
  return { present: resolvesOnPath(value), command: value };
}

function envPresence(keys) {
  const names = Array.isArray(keys) ? keys : [keys];
  const present = names.find((key) => !!process.env[key]);
  return { present: !!present, keys: names, source: present || null };
}

function commandPresence(label, commandFn) {
  try {
    const result = pathPresent(commandFn());
    return { kind: "command", label, ...result };
  } catch (err) {
    return { kind: "command", label, present: false, command: null, error: err.message };
  }
}

function geminiApiPresence() {
  try {
    const auth = detectGeminiApiAuth();
    return { kind: "api-auth", present: true, mode: auth.mode, source: auth.mode === "developer" ? "GEMINI_API_KEY/GOOGLE_API_KEY" : "Vertex ADC" };
  } catch (err) {
    return { kind: "api-auth", present: false, keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT"], error: err.message };
  }
}

function authPresenceFor(providerKey, auth) {
  if (auth === "oauth-ultra" && providerKey === "google-antigravity") return commandPresence("agy", getAgyCommand);
  if (auth === "subscription" && providerKey === "xai-cli") return commandPresence("grok", getGrokCommand);
  if (auth === "subscription" && providerKey === "anthropic") return commandPresence("claude", getClaudeCommand);
  if (auth === "subscription" && providerKey === "moonshot") return commandPresence("kimi", getKimiCommand);
  if (auth === "api-key" && providerKey === "xai-api") return { kind: "env", ...envPresence("XAI_API_KEY") };
  if (auth === "api-key" && providerKey === "anthropic-api") return { kind: "env", ...envPresence("ANTHROPIC_API_KEY") };
  if (auth === "api-key" && providerKey === "nvidia-nim") return { kind: "env", ...envPresence(["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"]) };
  if (auth === "api-key" && providerKey === "google") return geminiApiPresence();
  if (auth === "ollama-cloud") return { kind: "endpoint", present: true, source: process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://localhost:11434" };
  if (auth === "local") return { kind: "local", present: true };
  if (auth === "sdk") return { kind: "sdk", present: true };
  return { kind: auth || "unknown", present: false };
}

function primaryChannelFor(entry) {
  return {
    transport: entry?.transport || null,
    bridge: entry?.bridge || null,
    provider: entry?.provider || null,
    auth: entry?.auth || null,
    model: entry?.model || null,
  };
}

function channelsForEntry(entry) {
  return Array.isArray(entry?.channels) && entry.channels.length > 0 ? entry.channels : [primaryChannelFor(entry)];
}

function isOllamaChannel(entry, channel) {
  return (channel?.transport || entry?.transport) === "ollama" || (channel?.bridge || entry?.bridge) === "ollama.js";
}

function isNvidiaChannel(entry, channel) {
  return (channel?.transport || entry?.transport) === "nvidia" || (channel?.bridge || entry?.bridge) === "nvidia-nim.js";
}

// Channels that carry a live route probe. Ollama probes the local /api/tags; NVIDIA NIM
// probes the hosted /v1/models. Other transports (CLI/SDK/api-key without a probe) fall to
// the static auth pass only.
function isProbeableChannel(entry, channel) {
  return isOllamaChannel(entry, channel) || isNvidiaChannel(entry, channel);
}

async function routeProbeForChannel(entry, channel, options = {}) {
  const probe = isNvidiaChannel(entry, channel)
    ? (options._probeNvidiaRoute || probeNvidiaRoute)
    : (options._probeOllamaRoute || probeOllamaRoute);
  const probeOptions = {
    baseUrl: options.baseUrl,
    endpoint: options.endpoint,
    providerKey: channel.provider || entry.provider || null,
    model: channel.model || entry.model || null,
    noCache: options.noCache,
  };
  if (options.routeProbeTimeoutMs !== undefined) probeOptions.timeoutMs = options.routeProbeTimeoutMs;
  return probe(probeOptions);
}

async function routeProbesForEntry(entry, options = {}) {
  const pairs = await Promise.all(channelsForEntry(entry).map(async (channel, index) => {
    if (!isProbeableChannel(entry, channel)) return null;
    const probe = await routeProbeForChannel(entry, channel, options);
    return [index, probe];
  }));
  return new Map(pairs.filter(Boolean));
}

function routeProbeSuggestion(probe) {
  if (!probe) return null;
  if (probe.status === "model-missing") {
    return `Install or pull ${probe.providerModelString} into the local Ollama endpoint before seating this route.`;
  }
  if (probe.status === "missing-key") {
    return "Set NVIDIA_API_KEY (or NVIDIA_NIM_API_KEY) before seating NVIDIA NIM routes.";
  }
  if (probe.status === "unreachable") {
    if (probe.probe === "nvidia-nim") return "Verify network reachability to https://integrate.api.nvidia.com and the key's validity.";
    return "Start Ollama or set OLLAMA_URL/OLLAMA_HOST to a reachable endpoint before seating Ollama routes.";
  }
  return null;
}

function authWithRouteProbe(auth, probe) {
  if (!probe || probe.staticAvailable !== false) return auth;
  return { ...auth, present: false, error: probe.lastError, routeProbe: probe };
}

function livenessWithRouteProbe(liveness, probe) {
  if (!probe) return liveness;
  if (probe.staticAvailable === false) {
    return {
      // A NIM probe reports "missing-key" when no credential is set — keep that distinct from a
      // genuine route failure (the belt to the static authPresenceFor suspenders).
      status: probe.status === "model-missing" ? "model-missing"
        : probe.status === "missing-key" ? "missing-auth"
        : "route-unavailable",
      staticAvailable: false,
      probe: probe.probe,
      lastError: probe.lastError,
      routeProbe: probe,
    };
  }
  return {
    ...liveness,
    probe: probe.probe,
    routeProbe: probe,
  };
}

function applyRouteProbes(report, routeProbes) {
  if (!routeProbes || routeProbes.size === 0) return report;
  const channels = report.channels.map((channel) => {
    const probe = routeProbes.get(channel.index);
    if (!probe) return channel;
    return {
      ...channel,
      auth: authWithRouteProbe(channel.auth, probe),
      liveness: livenessWithRouteProbe(channel.liveness, probe),
    };
  });
  const primaryProbe = routeProbes.get(0);
  if (!primaryProbe) return { ...report, channels };
  const probeFix = primaryProbe.staticAvailable === false ? routeProbeSuggestion(primaryProbe) : null;
  return {
    ...report,
    auth: authWithRouteProbe(report.auth, primaryProbe),
    availableForAutoSelection: report.availableForAutoSelection && primaryProbe.staticAvailable !== false,
    liveness: livenessWithRouteProbe(report.liveness, primaryProbe),
    suggestedFix: probeFix || report.suggestedFix,
    channels,
  };
}
function statusFor(requested, entry) {
  for (const key of [requested, entry?.id, entry?.model]) {
    const status = key ? MODEL_STATUS[key] : null;
    if (status) return { key, ...status };
  }
  return null;
}

function roleCoverageFor(entry) {
  if (!entry) return { status: "unknown-id", roles: [], roleCount: 0, source: "matrix-compatibility-projection" };
  const roles = getModelRoles(entry.id).map((role) => ({
    role: role.role,
    priority: role.priority,
    concurrent: role.concurrent === true,
  }));
  return {
    status: roles.length ? "role-routable" : "explicit-lineup-only",
    roles,
    roleCount: roles.length,
    source: "matrix-compatibility-projection",
    migration: "model and role seating use the current explicit role/profile contract",
  };
}

function suggestionFor({ entry, requested, status, auth, providerKey }) {
  const id = entry?.id || requested;
  if (!entry) return "Use illuci models --doctor --json to inspect known ids, then select a canonical id or alias from the registry.";
  if (status?.suspended) return status.reason;
  if (id === "claude-fable") return "Use claude-opus for Claude Opus through the default Antigravity path; keep claude-local only for explicit legacy diagnostics.";
  if (id === "claude-opus" && !auth?.present) return "Configure Antigravity (agy) for Claude Opus 4.6 or explicitly pin the Claude CLI channel when that local subscription lane is intended.";
  if (id === "gemini-3.1-pro" || id === "gemini-local" || id === "gemini-3.5-flash" || id === "gemini-3.1-flash-lite") return "Use gemini for Gemini Pro 3.1 through Antigravity unless the API transport is deliberately restored.";
  if (id === "gpt-oss" && !auth?.present) return "Configure Antigravity (agy) for GPT-OSS 120B, or explicitly pin the Ollama Cloud channel when that provider is intended.";
  if (id === "grok" && !auth?.present) return "Set XAI_API_KEY for the xAI API route, or use grok-build for the subscription Grok Build CLI route.";
  if ((id === "grok-build" || id === "grok-composer-2.5-fast") && !auth?.present) return "Set GROK_PATH or install the Grok Build CLI so the subscription route can spawn.";
  if (id === "qwen-code") return "Use qwen-code for code-oriented defaults; use qwen3.5 for the general Qwen frontier lane.";
  if (id === "qwen3.5") return "Use qwen3.5 as the general Qwen frontier lane; do not substitute qwen-code for it.";
  if (providerKey === "ollama-cloud") return "If dispatch reports fetch failed, verify the Ollama endpoint/network and provider availability before running fan-out.";
  return "No immediate fix is known from static routing state; run a bounded live probe if dispatch still fails.";
}

function livenessStatus({ suspended, auth, availableForAutoSelection }) {
  if (suspended) return "suspended";
  if (!auth.present) return "missing-auth";
  if (availableForAutoSelection) return "presence-ok";
  return "explicit-only";
}

function channelReport(entry, channel, index) {
  const providerKey = channel.provider || entry.provider || null;
  const provider = getProviderResource(providerKey);
  const auth = authPresenceFor(providerKey, channel.auth || entry.auth || null);
  const status = statusFor(entry.id, entry);
  const suspended = isSuspended(entry.id);
  return {
    index,
    providerId: provider?.id || null,
    providerKey,
    transport: channel.transport || entry.transport || null,
    bridge: channel.bridge || entry.bridge || null,
    auth,
    providerModelString: channel.model || entry.model || null,
    liveness: {
      status: livenessStatus({ suspended, auth, availableForAutoSelection: !suspended && auth.present }),
      staticAvailable: !suspended && auth.present,
      probe: "not-run",
      lastError: status?.suspended ? status.reason : null,
    },
  };
}

export function modelDoctorReport(requestedId) {
  const requested = String(requestedId || "").trim();
  const entry = getEntry(requested);
  if (!entry) {
    const label = modelLabelFor(requested);
    return {
      requestedId: requested,
      canonicalId: null,
      aliases: [],
      publicModelId: null,
      displayName: label.displayName,
      modelLabel: label,
      graph: label.graph,
      providerId: null,
      providerKey: null,
      providerModelString: null,
      transport: null,
      bridge: null,
      cliId: null,
      auth: { kind: "unknown", present: false },
      availableForAutoSelection: false,
      roleCoverage: roleCoverageFor(null),
      liveness: { status: "unknown-id", staticAvailable: false, probe: "not-run", lastError: `Unknown model id: ${requested}` },
      suggestedFix: suggestionFor({ requested }),
      channels: [],
    };
  }

  const label = modelLabelFor(requested);
  const status = statusFor(requested, entry);
  const providerKey = entry.provider || null;
  const provider = getProviderResource(providerKey);
  const auth = authPresenceFor(providerKey, entry.auth || null);
  const availableForAutoSelection = isAvailable(entry.id);
  const suspended = isSuspended(entry.id);
  const channels = channelsForEntry(entry).map((channel, index) => channelReport(entry, channel, index));

  return {
    requestedId: requested,
    canonicalId: entry.id,
    aliases: [...(entry.aliases || [])],
    publicModelId: label.publicModelId,
    displayName: label.displayName,
    family: label.family,
    variant: label.variant,
    registryId: label.registryId,
    modelLabel: label,
    graph: label.graph,
    providerId: provider?.id || null,
    providerKey,
    providerModelString: label.providerModelString,
    transport: label.transport,
    bridge: label.bridge,
    cliId: label.cliId,
    auth,
    availableForAutoSelection,
    roleCoverage: roleCoverageFor(entry),
    liveness: {
      status: livenessStatus({ suspended, auth, availableForAutoSelection }),
      staticAvailable: availableForAutoSelection,
      probe: "not-run",
      lastError: status?.suspended ? status.reason : null,
    },
    suggestedFix: suggestionFor({ entry, requested, status, auth, providerKey }),
    channels,
  };
}

export function listModelDoctorReports(ids = null) {
  const targets = ids && ids.length ? ids : listModels().map((entry) => entry.id);
  return targets.map((id) => modelDoctorReport(id));
}

export async function modelDoctorReportLive(requestedId, options = {}) {
  const report = modelDoctorReport(requestedId);
  const entry = getEntry(String(requestedId || "").trim());
  if (!entry) return report;
  const routeProbes = await routeProbesForEntry(entry, options);
  return applyRouteProbes(report, routeProbes);
}

export async function listModelDoctorReportsLive(ids = null, options = {}) {
  const targets = ids && ids.length ? ids : listModels().map((entry) => entry.id);
  return Promise.all(targets.map((id) => modelDoctorReportLive(id, options)));
}

export async function describeRoutePreflightFailure(modelId, options = {}) {
  const entry = getEntry(modelId);
  if (!entry || isSuspended(modelId)) return null;
  const channel = options.channel || primaryChannelFor(entry);
  if (!isOllamaChannel(entry, channel)) return null;
  const probe = await routeProbeForChannel(entry, channel, options);
  if (probe.staticAvailable !== false) return null;
  const providerKey = channel.provider || entry.provider || null;
  const provider = getProviderResource(providerKey);
  const suggestedFix = routeProbeSuggestion(probe) || suggestionFor({ entry, requested: modelId, status: null, auth: { present: false }, providerKey });
  return {
    code: "BRIDGE_ROUTE_UNAVAILABLE",
    canonicalId: entry.id,
    requestedId: String(modelId || ""),
    providerId: provider?.id || null,
    providerKey,
    transport: channel.transport || entry.transport || null,
    bridge: channel.bridge || entry.bridge || null,
    providerModelString: channel.model || entry.model || null,
    message: probe.lastError || `${entry.id} route is unavailable`,
    suggestedFix,
    routeProbe: probe,
  };
}
export function describeUnavailableModel(modelId) {
  const entry = getEntry(modelId);
  if (!entry || !isSuspended(modelId)) return null;
  const report = modelDoctorReport(modelId);
  return {
    code: "MODEL_UNAVAILABLE",
    canonicalId: report.canonicalId,
    providerId: report.providerId,
    providerKey: report.providerKey,
    transport: report.transport,
    bridge: report.bridge,
    providerModelString: report.providerModelString,
    message: report.liveness.lastError || `${report.canonicalId} is unavailable`,
    suggestedFix: report.suggestedFix,
  };
}

export function describeBridgeFailure(modelId, error, options = {}) {
  const report = modelDoctorReport(modelId);
  const selected = options.channel || null;
  const providerKey = selected?.provider || report.providerKey;
  const provider = getProviderResource(providerKey);
  return {
    code: report.liveness.status === "suspended" ? "MODEL_UNAVAILABLE" : "BRIDGE_FAILURE",
    canonicalId: report.canonicalId || resolveModelId(modelId) || null,
    requestedId: String(modelId || ""),
    providerId: provider?.id || report.providerId || null,
    providerKey: providerKey || null,
    transport: selected?.transport || report.transport || null,
    bridge: selected?.bridge || report.bridge || null,
    providerModelString: selected?.model || report.providerModelString || null,
    message: error?.message || String(error || "unknown bridge failure"),
    suggestedFix: report.suggestedFix,
  };
}

export default { modelDoctorReport, modelDoctorReportLive, listModelDoctorReports, listModelDoctorReportsLive, describeUnavailableModel, describeRoutePreflightFailure, describeBridgeFailure };
