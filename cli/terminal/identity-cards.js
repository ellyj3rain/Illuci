import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getEntry, listModels } from "../../core/bridges/model-registry.js";
import { resolveIlluciHomeDir } from "../../core/agents/home-dir.js";
import { modelLabelFor } from "../../core/fleet/model-labels.js";
import { normalizeHexColor } from "./design.js";

export const MODEL_IDENTITY_CARD_SCHEMA = "illuci.terminal.identity-card/1";

function portrait(lines) {
  return lines.join("\n");
}

const BASE_PORTRAITS = Object.freeze({
  claude: portrait(["   /~~~~/", "  | o  o |", "  |  /|  |", "   /_~~_/", "    /||/", "   /_||_/"]),
  codex: portrait(["   <{ }>", "  /|[]|/", " /_|__|_/", "   |  |", "  /____/"]),
  deepseek: portrait(["    .-.", "  .'   ' .", " /  o o  /", " |   ^   |", "  / '-' /", "   '---'"]),
  gemini: portrait(["   *   *", "    / /", "  -- * --", "    / /", "   *   *"]),
  gpt: portrait(["  [====]", "  | () |", "  | <> |", "  [====]", "   /||/"]),
  grok: portrait(["  /^_^/", " ( o.o )", "  > ^ <", " /|___|/", "   / /"]),
  kimi: portrait(["  .----.", " / .--. /", " | '--' |", "  /____/", "   /||/"]),
  ollama: portrait(["  (____)", "  / oo /", " |  --  |", "  /____/", "   /  /"]),
  qwen: portrait(["  .----.", " /|QW|/", " ||__||", " /____/", "  /||/"]),
});
const PROFILE_BY_ID = Object.freeze({
  "claude-opus": { portrait: "claude", color: "#d4a574", strengths: ["strategic synthesis", "careful critique", "long-form reasoning"], weaknesses: ["can over-elaborate", "prefers rich context"], avoidTasks: ["low-context bulk fan-out"], workingStyle: "Patient architect; strongest when the task needs judgment, synthesis, and risk-aware language." },
  "claude-fable": { portrait: "claude", color: "#d4a574", strengths: ["expressive drafting", "conceptual framing", "narrative coherence"], weaknesses: ["explicit-only lane", "credential-sensitive"], avoidTasks: ["automatic fallback"], workingStyle: "Legacy expressive lane; visible as an identity card but not selected implicitly." },
  "claude-sonnet": { portrait: "claude", color: "#d4a574", strengths: ["balanced implementation", "review", "planning"], weaknesses: ["less suited to tiny probes"], avoidTasks: ["latency-sensitive pings"], workingStyle: "Balanced Claude lane for steady build and review work." },
  "claude-haiku": { portrait: "claude", color: "#d4a574", strengths: ["fast triage", "short rewrites", "cheap sanity checks"], weaknesses: ["less depth than frontier lanes"], avoidTasks: ["high-stakes architecture calls"], workingStyle: "Fast Claude lane for compact tasks and bounded checks." },
  "claude-api": { portrait: "claude", color: "#d4a574", strengths: ["API-backed Claude dispatch", "streaming-friendly requests"], weaknesses: ["requires Anthropic API auth"], avoidTasks: ["subscription CLI assumptions"], workingStyle: "Per-token Claude lane; distinct from local CLI and Antigravity routes." },
  "codex-local": { portrait: "codex", color: "#4a6c8c", strengths: ["repo-local edits", "test loops", "tool-grounded reasoning"], weaknesses: ["depends on harness availability"], avoidTasks: ["unbounded external research without setup"], workingStyle: "Implementation-oriented lane for local codebase work and verification loops." },
  deepseek: { portrait: "deepseek", color: "#1e90ff", strengths: ["algorithmic reasoning", "code analysis", "structured decomposition"], weaknesses: ["network lane can fail fast"], avoidTasks: ["silent fallback when fetch fails"], workingStyle: "Precise analytic lane; best with explicit routing and bounded failure reporting." },
  gemini: { portrait: "gemini", color: "#007bff", strengths: ["broad synthesis", "large-context scans", "multimodal-ready planning"], weaknesses: ["route must stay explicit"], avoidTasks: ["legacy Gemini API substitution"], workingStyle: "Antigravity Gemini lane; the bare Gemini id means the live Pro route." },
  "gemini-local": { portrait: "gemini", color: "#007bff", strengths: ["legacy local affordance"], weaknesses: ["retired route"], avoidTasks: ["automatic selection"], workingStyle: "Retained for explicit diagnostics; display remains distinct from the live Gemini Pro lane." },
  "gemini-3.1-pro": { portrait: "gemini", color: "#007bff", strengths: ["API-shaped Gemini semantics"], weaknesses: ["suspended API route"], avoidTasks: ["default Gemini routing"], workingStyle: "API identity kept visible so it is not confused with the default live Gemini lane." },
  "gemini-3.5-flash": { portrait: "gemini", color: "#3aa8ff", strengths: ["fast Gemini semantics"], weaknesses: ["suspended API route"], avoidTasks: ["frontier synthesis"], workingStyle: "Compact Gemini API identity, separate from Antigravity Pro." },
  "gemini-3.1-flash-lite": { portrait: "gemini", color: "#68c7ff", strengths: ["low-latency Gemini semantics"], weaknesses: ["suspended API route"], avoidTasks: ["deep reasoning"], workingStyle: "Lite Gemini API identity, separate from Antigravity Pro." },
  "gpt-oss": { portrait: "gpt", color: "#5a9bff", strengths: ["open-weight frontier reasoning", "portable synthesis", "code planning"], weaknesses: ["provider path must be visible"], avoidTasks: ["ambiguous provider fallback"], workingStyle: "Frontier open model lane; make Antigravity versus Ollama Cloud routing explicit." },
  grok: { portrait: "grok", color: "#00ffcc", strengths: ["direct xAI API route", "sharp critique", "fast ideation"], weaknesses: ["temporarily held API route", "requires API auth when restored"], avoidTasks: ["default subscription routing"], workingStyle: "xAI API identity kept visible for productization; use Grok Build for the active subscription route." },
  "grok-build": { portrait: "grok", color: "#00d6b0", strengths: ["subscription CLI route", "frontier critique", "interactive probes", "build-focused dispatch"], weaknesses: ["CLI availability controls liveness"], avoidTasks: ["generic Grok API routing"], workingStyle: "Canonical Grok Build subscription lane; grok-cli is a compatibility spelling for this route." },
  "grok-composer-2.5-fast": { portrait: "grok", color: "#66ffe8", strengths: ["fast composition", "compact drafting", "low-reasoning passes"], weaknesses: ["not the deep Grok lane"], avoidTasks: ["frontier reasoning decisions"], workingStyle: "Fast Grok composer identity for lightweight composition surfaces." },
  "kimi-local": { portrait: "kimi", color: "#d4a853", strengths: ["long-context drafting", "code-aware synthesis", "CLI subscription route"], weaknesses: ["CLI/network sensitive"], avoidTasks: ["Ollama Cloud substitution"], workingStyle: "Moonshot CLI Kimi lane; keep distinct from kimi-cloud." },
  "kimi-cloud": { portrait: "kimi", color: "#d4a853", strengths: ["Ollama-hosted Kimi", "code synthesis", "cloud frontier lane"], weaknesses: ["fetch failures should fail fast"], avoidTasks: ["Moonshot CLI assumptions"], workingStyle: "Ollama Cloud Kimi lane, visibly separate from the Moonshot CLI route." },
  ollama: { portrait: "qwen", color: "#06b6d4", strengths: ["local Qwen reasoning", "private quick checks", "daemon-backed smoke"], weaknesses: ["daemon and installed model dependent"], avoidTasks: ["frontier-only substitution when frontier lanes are available"], workingStyle: "Local Qwen/Ollama lane for bounded local runs." },
  "qwen-code": { portrait: "qwen", color: "#4a90e2", strengths: ["code generation", "repository edits", "implementation planning"], weaknesses: ["code-oriented defaults"], avoidTasks: ["general Qwen substitution"], workingStyle: "Code-specialized Qwen lane; do not flatten into the general Qwen frontier id." },
  "qwen3.5": { portrait: "qwen", color: "#4a90e2", strengths: ["general frontier reasoning", "broad synthesis", "multilingual analysis"], weaknesses: ["cloud route availability"], avoidTasks: ["qwen-code-only assumptions"], workingStyle: "General Qwen frontier lane, separate from qwen-code." },
  glm: { portrait: "gpt", color: "#b366ff", strengths: ["open frontier reasoning", "structured analysis", "coding support"], weaknesses: ["cloud route availability"], avoidTasks: ["silent retry storms"], workingStyle: "Frontier open model lane; surface bridge errors quickly." },
  gemma4: { portrait: "gemini", color: "#ff8c42", strengths: ["Google-family open model", "general synthesis"], weaknesses: ["cloud route availability"], avoidTasks: ["Gemini Pro substitution"], workingStyle: "Gemma lane remains a separate model identity from Gemini." },
  minimax: { portrait: "gpt", color: "#ff66cc", strengths: ["frontier cloud reasoning", "general drafting"], weaknesses: ["cloud route availability"], avoidTasks: ["implicit fallback"], workingStyle: "MiniMax lane for explicit cloud dispatch." },
});

function asArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function safeFilePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/gu, "_");
}

function generatedCardDir() {
  return resolveIlluciHomeDir("identity-cards");
}

export function generatedIdentityCardPath(modelId) {
  return join(generatedCardDir(), safeFilePart(modelId) + ".json");
}

function freezeCard(raw) {
  return Object.freeze({
    schema: MODEL_IDENTITY_CARD_SCHEMA,
    modelId: String(raw.modelId || "unknown"),
    aliases: Object.freeze(asArray(raw.aliases)),
    displayName: String(raw.displayName || raw.modelId || "Unknown Model"),
    origin: raw.origin || "terminal-design-seed",
    portrait: Object.freeze({
      ascii: String(raw.portrait?.ascii || raw.portrait || "[????]\n |  |\n |__|"),
      color: normalizeHexColor(raw.portrait?.color || raw.color),
    }),
    strengths: Object.freeze(asArray(raw.strengths)),
    weaknesses: Object.freeze(asArray(raw.weaknesses)),
    avoidTasks: Object.freeze(asArray(raw.avoidTasks)),
    workingStyle: String(raw.workingStyle || ""),
  });
}

function seedCardFor(modelId) {
  const profile = PROFILE_BY_ID[modelId];
  if (!profile) return null;
  const label = modelLabelFor(modelId);
  return freezeCard({
    modelId,
    aliases: label.aliases,
    displayName: label.displayName,
    color: profile.color,
    portrait: BASE_PORTRAITS[profile.portrait],
    strengths: profile.strengths,
    weaknesses: profile.weaknesses,
    avoidTasks: profile.avoidTasks,
    workingStyle: profile.workingStyle,
    origin: "terminal-design-seed",
  });
}

const CARD_BY_ID = new Map(Object.keys(PROFILE_BY_ID).map((id) => [id, seedCardFor(id)]));

export function validateIdentityCard(card) {
  const problems = [];
  if (card?.schema !== MODEL_IDENTITY_CARD_SCHEMA) problems.push("schema");
  if (!card?.modelId) problems.push("modelId");
  if (!card?.displayName) problems.push("displayName");
  if (!card?.portrait?.ascii) problems.push("portrait.ascii");
  if (!/^#[0-9a-f]{6}$/u.test(card?.portrait?.color || "")) problems.push("portrait.color");
  for (const field of ["strengths", "weaknesses", "avoidTasks"]) {
    if (!Array.isArray(card?.[field])) problems.push(field);
  }
  return problems;
}

function fallbackCard(requestedId) {
  const label = modelLabelFor(requestedId);
  return freezeCard({
    modelId: label.canonicalId || label.requestedId || "unknown",
    aliases: label.aliases || [],
    displayName: label.displayName,
    color: "#cccccc",
    portrait: "[????]\n |  |\n |__|",
    strengths: label.known ? ["registered model resource"] : ["unregistered model spelling"],
    weaknesses: label.known ? ["no identity card yet"] : ["no registry match"],
    avoidTasks: label.known ? [] : ["dispatch without resolving the id"],
    workingStyle: label.known ? "Registered model without a terminal identity card yet." : "Unknown model id; resolve against the model registry before dispatch.",
    origin: "registry-fallback",
  });
}

function enrichCard(card, requestedId) {
  const label = modelLabelFor(requestedId || card.modelId);
  return Object.freeze({
    ...card,
    requestedId: String(requestedId || card.modelId),
    canonicalId: label.canonicalId || null,
    publicModelId: label.publicModelId,
    providerId: label.providerId,
    providerLabel: label.providerLabel,
    provider: label.providerKey,
    transport: label.transport,
    graph: label.graph,
  });
}

export function loadGeneratedIdentityCard(requestedId) {
  const entry = getEntry(requestedId);
  const id = entry?.id || requestedId;
  const file = generatedIdentityCardPath(id);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const card = freezeCard({ ...parsed, modelId: id, origin: parsed.origin || "model-generated" });
    return validateIdentityCard(card).length ? null : enrichCard(card, requestedId || id);
  } catch {
    return null;
  }
}

export function modelIdentityCardFor(requestedId, options = {}) {
  const requested = String(requestedId || "").trim();
  const entry = getEntry(requested);
  const id = entry?.id || requested;
  const generated = loadGeneratedIdentityCard(id);
  const card = options.preferGenerated && generated ? generated : CARD_BY_ID.get(id) || generated || fallbackCard(id);
  return enrichCard(card, requested || id);
}

export function listModelIdentityCards(ids = null) {
  const targets = ids && ids.length ? ids : listModels().map((entry) => entry.id);
  return targets.map((id) => modelIdentityCardFor(id));
}

export function summarizeIdentityCard(card) {
  return {
    schema: card.schema,
    modelId: card.modelId,
    displayName: card.displayName,
    color: card.portrait.color,
    aliases: [...card.aliases],
    strengths: [...card.strengths],
    weaknesses: [...card.weaknesses],
    avoidTasks: [...card.avoidTasks],
    workingStyle: card.workingStyle,
    origin: card.origin,
  };
}

export function identityCardGenerationPrompt(modelId) {
  const label = modelLabelFor(modelId);
  return [
    "Create your own terminal identity card for illuci's model fleet display.",
    "This card is user-facing display metadata only. It does not grant routing, permission, or selection status.",
    "Return JSON only, with no markdown fence and no commentary.",
    "Use this exact schema:",
    JSON.stringify({
      schema: MODEL_IDENTITY_CARD_SCHEMA,
      modelId: label.canonicalId || modelId,
      displayName: label.displayName,
      portrait: { ascii: "3-6 lines of compact ASCII self-portrait", color: "#00ffcc" },
      strengths: ["three short strengths"],
      weaknesses: ["one to three honest limits"],
      avoidTasks: ["zero to three task shapes to avoid"],
      workingStyle: "one sentence about how you work best",
    }, null, 2),
  ].join("\n\n");
}

export function extractIdentityCardJson(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Identity-card response did not contain a JSON object.");
  return JSON.parse(raw.slice(start, end + 1));
}

export function normalizeGeneratedIdentityCard(raw, modelId) {
  const label = modelLabelFor(modelId);
  const card = freezeCard({
    schema: MODEL_IDENTITY_CARD_SCHEMA,
    modelId: label.canonicalId || modelId,
    aliases: label.aliases,
    displayName: raw.displayName || label.displayName,
    portrait: raw.portrait,
    strengths: raw.strengths,
    weaknesses: raw.weaknesses,
    avoidTasks: raw.avoidTasks,
    workingStyle: raw.workingStyle,
    origin: "model-generated",
  });
  const problems = validateIdentityCard(card);
  if (problems.length) throw new Error("Generated identity card is invalid: " + problems.join(", "));
  return card;
}

export function saveGeneratedIdentityCard(card) {
  mkdirSync(generatedCardDir(), { recursive: true });
  const file = generatedIdentityCardPath(card.modelId);
  writeFileSync(file, JSON.stringify(card, null, 2) + "\n", "utf8");
  return file;
}

export async function generateIdentityCardFor(requestedId, options = {}) {
  const entry = getEntry(requestedId);
  if (!entry) throw new Error("Cannot generate identity card for unknown model id: " + requestedId);
  if (!options.force && CARD_BY_ID.has(entry.id)) return modelIdentityCardFor(entry.id);
  const cached = loadGeneratedIdentityCard(entry.id);
  if (!options.force && cached) return cached;
  const { queryModel } = await import("../../core/dispatch/dispatch.js");
  const result = await queryModel(entry.id, identityCardGenerationPrompt(entry.id), {
    projectId: "illuci-terminal-identity-card",
    seat: "identity-card",
    reasoning: options.reasoning || "medium",
    timeoutMs: options.timeoutMs || 120000,
  });
  if (result?.error) throw new Error(result.error);
  const parsed = extractIdentityCardJson(result?.response || result?.text || "");
  const card = normalizeGeneratedIdentityCard(parsed, entry.id);
  saveGeneratedIdentityCard(card);
  return enrichCard(card, entry.id);
}

export default {
  MODEL_IDENTITY_CARD_SCHEMA,
  extractIdentityCardJson,
  generateIdentityCardFor,
  generatedIdentityCardPath,
  identityCardGenerationPrompt,
  listModelIdentityCards,
  loadGeneratedIdentityCard,
  modelIdentityCardFor,
  normalizeGeneratedIdentityCard,
  saveGeneratedIdentityCard,
  summarizeIdentityCard,
  validateIdentityCard,
};
