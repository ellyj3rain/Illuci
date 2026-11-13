/**
 * illuci - provider health monitor.
 *
 * Presence-grade, non-token checks for the fleet provider resources. Model-level
 * reachability remains owned by model-discovery/preflight; this surface answers
 * whether the provider/channel prerequisite is present enough to be considered
 * usable by UI and operator diagnostics.
 */

import { existsSync } from "fs";
import { createRequire } from "module";
import { getProviderResource, listProviderResources } from "../fleet/resource-gateway.js";
import { detectAuth as detectGeminiApiAuth } from "../bridges/gemini-api.js";
import {
  getAgyCommand,
  getClaudeCommand,
  getGrokCommand,
  isKimiInstalled,
  resolvesOnPath,
} from "../bridges/tool-paths.js";

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const DEFAULT_BURP_URL = process.env.BURP_BRIDGE_URL || "http://localhost:9001";
const requireFromHere = createRequire(import.meta.url);

export const PROVIDERS = Object.freeze(listProviderResources().map((provider) => provider.id));
export const SERVICES = Object.freeze(["service.burp"]);
export const HEALTH_RESOURCES = Object.freeze([...PROVIDERS, ...SERVICES]);

const state = Object.fromEntries(HEALTH_RESOURCES.map((id) => [id, unknownRow(id)]));

function nowMs(deps = {}) {
  return typeof deps.now === "function" ? deps.now() : Date.now();
}

function providerMeta(id) {
  const provider = getProviderResource(id);
  if (!provider) return null;
  return {
    id: provider.id,
    label: provider.label,
    kind: "provider",
    class: provider.class,
    auth: provider.auth,
    modelCount: provider.modelCount,
    channelCount: provider.channelCount,
    providerKey: provider.providerKey,
  };
}

function serviceMeta(id) {
  if (id !== "service.burp") return null;
  return {
    id,
    label: "Burp Bridge",
    kind: "service",
    class: "local-http-service",
    auth: "local",
    modelCount: 0,
    channelCount: 0,
    providerKey: null,
  };
}

function metaFor(id) {
  return providerMeta(id) || serviceMeta(id) || {
    id,
    label: id,
    kind: "unknown",
    class: "unknown",
    auth: "unknown",
    modelCount: 0,
    channelCount: 0,
    providerKey: null,
  };
}

function unknownRow(id) {
  return {
    ...metaFor(id),
    status: "unknown",
    lastCheck: null,
    error: null,
    detail: null,
  };
}

function row(id, status, deps = {}, extra = {}) {
  return {
    ...metaFor(id),
    status,
    lastCheck: nowMs(deps),
    error: extra.error || null,
    detail: extra.detail || null,
  };
}

function commandPresent(commandPath) {
  if (!commandPath) return false;
  if (commandPath.includes("\\") || commandPath.includes("/")) return existsSync(commandPath);
  return resolvesOnPath(commandPath);
}

function envHasAny(env, keys) {
  return keys.some((key) => !!env[key]);
}

function codexSdkPresent() {
  try {
    requireFromHere.resolve("@openai/codex-sdk");
    return true;
  } catch {
    return false;
  }
}

async function fetchOk(url, deps = {}, timeoutMs = 5000) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, error: "fetch unavailable" };
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: !!response.ok, status: response.status || null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkProvider(id, deps = {}) {
  const env = deps.env || process.env;
  switch (id) {
    case "provider.ollama.local":
    case "provider.ollama.cloud": {
      const baseUrl = env.OLLAMA_URL || DEFAULT_OLLAMA_URL;
      const result = await fetchOk(baseUrl.replace(/\/+$/, "") + "/api/tags", deps, deps.timeoutMs || 5000);
      return row(id, result.ok ? "up" : "down", deps, {
        error: result.ok ? null : result.error || (result.status ? "HTTP " + result.status : "Ollama endpoint unavailable"),
        detail: baseUrl,
      });
    }
    case "provider.xai.api":
      return row(id, envHasAny(env, ["XAI_API_KEY"]) ? "up" : "down", deps, {
        error: env.XAI_API_KEY ? null : "XAI_API_KEY not set",
      });
    case "provider.anthropic.api":
      return row(id, envHasAny(env, ["ANTHROPIC_API_KEY"]) ? "up" : "down", deps, {
        error: env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY not set",
      });
    case "provider.google.api": {
      try {
        const auth = detectGeminiApiAuth(env);
        return row(id, "up", deps, { detail: auth.mode });
      } catch (err) {
        return row(id, "down", deps, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    case "provider.google.antigravity": {
      const present = commandPresent(getAgyCommand());
      return row(id, present ? "up" : "down", deps, { error: present ? null : "agy CLI not found" });
    }
    case "provider.anthropic.cli": {
      const present = commandPresent(getClaudeCommand());
      return row(id, present ? "up" : "down", deps, { error: present ? null : "Claude CLI not found" });
    }
    case "provider.xai.cli": {
      const present = commandPresent(getGrokCommand());
      return row(id, present ? "up" : "down", deps, { error: present ? null : "Grok CLI not found" });
    }
    case "provider.moonshot.cli": {
      const present = isKimiInstalled();
      return row(id, present ? "up" : "down", deps, { error: present ? null : "Kimi CLI (Moonshot) not installed" });
    }
    case "provider.openai.sdk": {
      const present = codexSdkPresent();
      return row(id, present ? "up" : "down", deps, { error: present ? null : "@openai/codex-sdk not resolvable" });
    }
    default:
      return row(id, "unknown", deps, { error: "No provider health check registered" });
  }
}

async function checkService(id, deps = {}) {
  if (id !== "service.burp") return row(id, "unknown", deps, { error: "No service health check registered" });
  const baseUrl = (deps.env || process.env).BURP_BRIDGE_URL || DEFAULT_BURP_URL;
  const result = await fetchOk(baseUrl.replace(/\/+$/, "") + "/health", deps, deps.timeoutMs || 5000);
  return row(id, result.ok ? "up" : "down", deps, {
    error: result.ok ? null : result.error || (result.status ? "HTTP " + result.status : "Burp bridge unavailable"),
    detail: baseUrl,
  });
}

async function checkResource(id, deps = {}) {
  if (PROVIDERS.includes(id)) return checkProvider(id, deps);
  if (SERVICES.includes(id)) return checkService(id, deps);
  return row(id, "unknown", deps, { error: "Unknown health resource" });
}

export async function checkAll(options = {}) {
  const includeServices = options.includeServices !== false;
  const ids = includeServices ? HEALTH_RESOURCES : PROVIDERS;
  const entries = await Promise.allSettled(ids.map((id) => checkResource(id, options)));
  for (const result of entries) {
    if (result.status === "fulfilled") state[result.value.id] = result.value;
  }
  return getStatus({ includeServices });
}

export function getStatus(options = {}) {
  const includeServices = options.includeServices !== false;
  const ids = includeServices ? HEALTH_RESOURCES : PROVIDERS;
  return Object.fromEntries(ids.map((id) => [id, state[id] || unknownRow(id)]));
}

export function isUp(id) {
  const provider = getProviderResource(id);
  const key = provider?.id || id;
  return state[key]?.status === "up";
}

export default { checkAll, getStatus, isUp, PROVIDERS, SERVICES, HEALTH_RESOURCES };
