/**
 * illuci fleet resource gateway.
 *
 * The bridge registry owns dispatch targets: provider keys, bridge modules, CLI
 * model strings, and channel quirks. This gateway owns the consumer contract
 * above it: stable Illuci-native provider/model resources, clean presentation
 * labels, capability summaries, and the one place that compiles a selected
 * resource down to a bridge dispatch target.
 */

import { MODEL_REGISTRY, MODEL_STATUS, NVIDIA_NIM_MANIFEST, getEntry, isSuspended, listModels, resolveModelId } from "../bridges/model-registry.js";
import { getCapabilities } from "../bridges/capabilities.js";
import { resolve as resolveModelSelection } from "../model-resource.js";

const PROVIDER_PROFILES = Object.freeze({
  "ollama-local": { id: "provider.ollama.local", label: "Ollama Local", organization: "Ollama", class: "local-daemon", auth: "local" },
  "ollama-cloud": { id: "provider.ollama.cloud", label: "Ollama Cloud", organization: "Ollama", class: "managed-cloud", auth: "ollama-cloud" },
  "google-antigravity": { id: "provider.google.antigravity", label: "Google Antigravity", organization: "Google", class: "oauth-cli", auth: "oauth-ultra" },
  google: { id: "provider.google.api", label: "Google AI API", organization: "Google", class: "api", auth: "api-key-or-oauth" },
  "xai-cli": { id: "provider.xai.cli", label: "xAI Grok CLI", organization: "xAI", class: "subscription-cli", auth: "subscription" },
  "xai-api": { id: "provider.xai.api", label: "xAI API", organization: "xAI", class: "api", auth: "api-key" },
  anthropic: { id: "provider.anthropic.cli", label: "Anthropic Claude CLI", organization: "Anthropic", class: "subscription-cli", auth: "subscription" },
  "anthropic-api": { id: "provider.anthropic.api", label: "Anthropic API", organization: "Anthropic", class: "api", auth: "api-key" },
  openai: { id: "provider.openai.sdk", label: "OpenAI Codex SDK", organization: "OpenAI", class: "sdk", auth: "sdk" },
  moonshot: { id: "provider.moonshot.cli", label: "Moonshot Kimi CLI", organization: "Moonshot", class: "subscription-cli", auth: "subscription" },
  "nvidia-nim": { id: "provider.nvidia.nim", label: "NVIDIA NIM", organization: "NVIDIA", class: "api", auth: "api-key" },
});

// NVIDIA NIM model profiles, DERIVED from NVIDIA_NIM_MANIFEST (the single source) so
// adding a NIM model is still one manifest line — no hand-written rows here. shortId
// drops the "nim-" prefix; the public id is "model.nvidia.<shortId>".
const NIM_MODEL_PROFILES = Object.fromEntries(
  NVIDIA_NIM_MANIFEST.map((m) => [m.id, {
    id: "model.nvidia." + m.id.replace(/^nim-/, ""),
    label: m.label,
    tier: m.tier,
    modality: m.modality,
    fleetUse: m.fleetUse || "seat",
    capabilityLanes: [...(m.capabilityLanes || [])],
  }]),
);

const MODEL_PROFILES = Object.freeze({
  ollama: { id: "model.qwen.local", label: "Qwen Local", tier: "local" },
  deepseek: { id: "model.deepseek.frontier", label: "DeepSeek Frontier", tier: "frontier" },
  "gpt-oss": { id: "model.gpt-oss.frontier", label: "GPT-OSS Frontier", tier: "frontier" },
  "qwen-code": { id: "model.qwen.code", label: "Qwen Code", tier: "code-focused" },
  "qwen3.5": { id: "model.qwen.frontier", label: "Qwen Frontier", tier: "frontier" },
  gemma4: { id: "model.gemma.frontier", label: "Gemma Frontier", tier: "frontier" },
  glm: { id: "model.glm.frontier", label: "GLM Frontier", tier: "frontier" },
  minimax: { id: "model.minimax.frontier", label: "MiniMax Frontier", tier: "frontier" },
  "kimi-cloud": { id: "model.kimi.ollama", label: "Kimi via Ollama", tier: "frontier" },
  grok: { id: "model.grok.api", label: "Grok API", tier: "frontier" },
  "grok-build": { id: "model.grok.build", label: "Grok Build", tier: "builder" },
  "grok-composer-2.5-fast": { id: "model.grok.composer-fast", label: "Grok Composer", tier: "fast-composer" },
  "codex-local": { id: "model.codex.local", label: "Codex", tier: "harness" },
  "gemini-local": { id: "model.gemini.legacy-cli", label: "Gemini Legacy CLI", tier: "legacy" },
  "gemini-3.5-flash": { id: "model.gemini.flash", label: "Gemini Flash", tier: "fast" },
  "gemini-3.1-pro": { id: "model.gemini.pro-api", label: "Gemini Pro API", tier: "frontier" },
  "gemini-3.1-flash-lite": { id: "model.gemini.flash-lite", label: "Gemini Flash Lite", tier: "fast" },
  gemini: { id: "model.gemini.pro", label: "Gemini Pro", tier: "frontier" },
  "kimi-local": { id: "model.kimi.moonshot", label: "Kimi via Moonshot", tier: "subscription" },
  "claude-fable": { id: "model.claude.fable", label: "Claude Fable", tier: "frontier" },
  "claude-opus": { id: "model.claude.opus", label: "Claude Opus", tier: "frontier" },
  "claude-sonnet": { id: "model.claude.sonnet", label: "Claude Sonnet", tier: "balanced" },
  "claude-haiku": { id: "model.claude.haiku", label: "Claude Haiku", tier: "fast" },
  "claude-api": { id: "model.claude.api", label: "Claude API", tier: "frontier" },
  ...NIM_MODEL_PROFILES,
});

const RESOURCE_ID_TO_DISPATCH_ID = (() => {
  const map = new Map(Object.entries(MODEL_PROFILES).map(([dispatchId, profile]) => [profile.id, dispatchId]));
  map.set("model.grok.frontier", "grok-build");
  return map;
})();

function safePart(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown";
}

function titleFromKey(key) {
  return String(key || "unknown").split(/[-_.]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "Unknown";
}

function profileForProvider(providerKey, channel = {}) {
  const key = providerKey || channel.provider || "unknown";
  const profile = PROVIDER_PROFILES[key] || {
    id: "provider." + safePart(key),
    label: titleFromKey(key),
    organization: titleFromKey(key),
    class: channel.transport || "unknown",
    auth: channel.auth || "unknown",
  };
  return { providerKey: key, ...profile };
}

function profileForModel(entry) {
  return MODEL_PROFILES[entry.id] || {
    id: "model." + safePart(entry.family) + "." + safePart(entry.variant || entry.id),
    label: entry.label || titleFromKey(entry.variant || entry.family || entry.id),
    tier: entry.tier || entry.reasoning || "standard",
  };
}

function statusForEntry(entry) {
  for (const key of [entry?.id, entry?.model]) {
    if (key && MODEL_STATUS[key]) return MODEL_STATUS[key];
  }
  return null;
}

function routeStatusFor(entry) {
  const status = statusForEntry(entry);
  const suspended = isSuspended(entry?.id);
  return {
    routeStatus: suspended ? "suspended" : "available",
    routeStatusReason: status?.reason || null,
    routeStatusSource: status?.source || null,
  };
}

function primaryChannel(entry) {
  return {
    transport: entry.transport || null,
    bridge: entry.bridge || null,
    provider: entry.provider || null,
    auth: entry.auth || null,
    model: entry.model || null,
  };
}

function channelsFor(entry) {
  return Array.isArray(entry.channels) && entry.channels.length > 0 ? entry.channels : [primaryChannel(entry)];
}

function channelResource(entry, channel, index = 0) {
  const model = profileForModel(entry);
  const provider = profileForProvider(channel.provider || entry.provider, channel);
  const routeStatus = routeStatusFor(entry);
  return {
    id: model.id + ".channel." + safePart(provider.id.replace(/^provider\./, "")) + "." + safePart(channel.transport || entry.transport || "dispatch"),
    label: provider.label + " " + titleFromKey(channel.transport || entry.transport || "dispatch"),
    modelResourceId: model.id,
    providerResourceId: provider.id,
    dispatchId: entry.id,
    bridge: channel.bridge || entry.bridge || null,
    transport: channel.transport || entry.transport || null,
    auth: channel.auth || entry.auth || null,
    isDefault: index === 0,
    diagnostics: {
      providerKey: channel.provider || entry.provider || null,
      providerModel: channel.model || entry.model || null,
      registryId: entry.id,
      ...routeStatus,
    },
  };
}

function capabilitySummary(entry) {
  const cap = getCapabilities(entry.id);
  return {
    family: cap.family || entry.family || null,
    streaming: !!cap.streaming,
    nativeTools: !!cap.nativeTools,
    contextWindow: cap.contextWindow || null,
    reasoning: cap.reasoning || null,
    speed: cap.speed || null,
    ultra: cap.ultra || null,
  };
}

function controlSummary(capabilities) {
  const reasoning = capabilities?.reasoning || { supported: false };
  const speed = capabilities?.speed || { supported: false };
  const thinkingControl = reasoning.supported && ["thinking", "think"].includes(reasoning.control)
    ? { supported: true, values: [true, false], control: reasoning.control }
    : { supported: false };
  return {
    reasoning,
    thinking: thinkingControl,
    speed,
  };
}

export function listProviderResources() {
  const resources = new Map();
  for (const profile of Object.values(PROVIDER_PROFILES)) {
    resources.set(profile.id, { ...profile, providerKey: null, modelCount: 0, channelCount: 0 });
  }
  for (const entry of MODEL_REGISTRY) {
    const seenForEntry = new Set();
    for (const channel of channelsFor(entry)) {
      const provider = profileForProvider(channel.provider || entry.provider, channel);
      const current = resources.get(provider.id) || { ...provider, modelCount: 0, channelCount: 0 };
      current.providerKey = current.providerKey || provider.providerKey;
      current.channelCount += 1;
      if (!seenForEntry.has(provider.id)) {
        current.modelCount += 1;
        seenForEntry.add(provider.id);
      }
      resources.set(provider.id, current);
    }
  }
  return [...resources.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function getProviderResource(providerIdOrKey) {
  const all = listProviderResources();
  return all.find((p) => p.id === providerIdOrKey || p.providerKey === providerIdOrKey) || null;
}

export function modelResourceForEntry(entry) {
  if (!entry) return null;
  const profile = profileForModel(entry);
  const channels = channelsFor(entry).map((channel, index) => channelResource(entry, channel, index));
  const defaultChannel = channels.find((channel) => channel.isDefault) || channels[0] || null;
  const capabilities = capabilitySummary(entry);
  const routeStatus = routeStatusFor(entry);
  return {
    id: profile.id,
    registryId: entry.id,
    label: profile.label,
    tier: profile.tier,
    modality: profile.modality || entry.modality || null,
    fleetUse: profile.fleetUse || entry.fleetUse || null,
    capabilityLanes: [...(profile.capabilityLanes || entry.capabilityLanes || [])],
    family: entry.family || null,
    defaultProviderResourceId: defaultChannel?.providerResourceId || null,
    defaultChannelId: defaultChannel?.id || null,
    channels,
    routeStatus: routeStatus.routeStatus,
    capabilities,
    controls: controlSummary(capabilities),
    diagnostics: {
      registryId: entry.id,
      providerKey: entry.provider || null,
      providerModel: entry.model || null,
      ...routeStatus,
    },
  };
}

export function listModelResources(filter = {}) {
  let resources = listModels().map(modelResourceForEntry).filter(Boolean);
  if (filter.providerResourceId) {
    resources = resources.filter((resource) => resource.channels.some((channel) => channel.providerResourceId === filter.providerResourceId));
  }
  if (filter.family) resources = resources.filter((resource) => resource.family === filter.family);
  return resources.sort((a, b) => a.label.localeCompare(b.label));
}

export function getModelResource(input) {
  if (!input) return null;
  const requested = String(input);
  const fromResource = RESOURCE_ID_TO_DISPATCH_ID.get(requested);
  const entry = fromResource ? getEntry(fromResource) : getEntry(requested);
  return entry ? modelResourceForEntry(entry) : null;
}

function normalizeSelectionInput(selection) {
  if (typeof selection !== "string") return selection;
  return dispatchIdForPublicModel(selection) || selection;
}

export function compileDispatchTarget(selection, deps = {}) {
  const normalized = normalizeSelectionInput(selection);
  const resolved = normalized?.entry ? normalized : resolveModelSelection(normalized, deps);
  const entry = resolved.entry;
  const model = profileForModel(entry);
  const channel = resolved.channel || primaryChannel(entry);
  const compiledChannel = channelResource(entry, channel, 0);
  return {
    modelResourceId: model.id,
    providerResourceId: compiledChannel.providerResourceId,
    channelId: compiledChannel.id,
    dispatchId: entry.id,
    bridge: channel.bridge || entry.bridge || null,
    transport: channel.transport || entry.transport || null,
    providerModel: channel.model || entry.model || null,
    diagnostics: {
      registryId: entry.id,
      providerKey: channel.provider || entry.provider || null,
      auth: channel.auth || entry.auth || null,
      ...routeStatusFor(entry),
    },
  };
}

export function resolveModelResource(selection, deps = {}) {
  const resolved = resolveModelSelection(normalizeSelectionInput(selection), deps);
  return {
    selection: resolved.selection,
    model: modelResourceForEntry(resolved.entry),
    dispatchTarget: compileDispatchTarget(resolved, deps),
    params: resolved.params || {},
  };
}

export function publicModelIdFor(dispatchIdOrAlias) {
  const entry = getEntry(dispatchIdOrAlias);
  return entry ? profileForModel(entry).id : null;
}

export function dispatchIdForPublicModel(publicModelId) {
  const direct = RESOURCE_ID_TO_DISPATCH_ID.get(publicModelId);
  if (direct) return direct;
  return resolveModelId(publicModelId);
}

export default {
  listProviderResources,
  getProviderResource,
  listModelResources,
  getModelResource,
  resolveModelResource,
  compileDispatchTarget,
  publicModelIdFor,
  dispatchIdForPublicModel,
};
