/**
 * Illuci capability card / surface-context probe.
 *
 * Illuci self-describes to whatever is driving it — a host agent (Claude, Codex,
 * Grok, Cursor) or a human — over CLI / MCP / API: what Illuci is, what it can do,
 * how to invoke it, and what is gated or off plus the one-line control to turn it
 * on. This is the "smart" layer: it makes a safe-but-dark engine legible and
 * activatable.
 *
 * Grounded only in source-owned catalogs — the surface map (what exists), the
 * defaults registry (run-posture controls), and the feature-gate registry. It
 * fabricates no capability and flips nothing (DR-129/DR-130: legible, disclosed,
 * reversible — never hidden, never auto-activated). OPSEC: the card carries no
 * repository identifiers, absolute paths, or operator data.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listSurfaceMap, summarizeSurfaceMap } from "../governance/surface-map.js";
import { defaultsSnapshot } from "../governance/defaults-registry.js";
import { featureGatesSnapshot } from "./feature-gates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ILLUCI_ROOT = resolve(HERE, "..", "..");

export const CAPABILITY_CARD_SCHEMA = "illuci.surface.capability-card/1";
export const ILLUCI_TAGLINE = "Intelligence, structured for auditable creation.";

function readVersion() {
  try {
    return readFileSync(join(ILLUCI_ROOT, "VERSION"), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Best-effort surface-context probe: which environment is driving Illuci. Every
 * signal is a concrete env marker; when none matches we return "unknown" rather
 * than guess. Extend `candidates` as new host markers are confirmed.
 */
export function detectHost(env = process.env) {
  const has = (k) => typeof env[k] === "string" && env[k] !== "";
  const candidates = [
    { host: "claude-code", surface: "cli/agent", markers: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] },
    { host: "codex", surface: "cli/agent", markers: ["CODEX_SANDBOX", "CODEX_HOME", "CODEX"] },
    { host: "cursor", surface: "editor/agent", markers: ["CURSOR_TRACE_ID"] },
    { host: "grok", surface: "cli/agent", markers: ["GROK_CLI", "GROK"] },
    { host: "mcp-client", surface: "mcp", markers: ["ILLUCI_MCP", "ILLUCI_MCP_TRANSPORT"] },
  ];
  for (const c of candidates) {
    const hit = c.markers.find(has);
    if (hit) return { host: c.host, surface: c.surface, signal: hit, confidence: "marker" };
  }
  if (has("TERM_PROGRAM") || has("TERM")) {
    return { host: "human-terminal", surface: "cli", signal: env.TERM_PROGRAM || "TERM", confidence: "weak" };
  }
  return { host: "unknown", surface: "unknown", signal: null, confidence: "none" };
}

/** How to reach Illuci from a host — the invocation channels. Repo-relative only. */
export function invocationChannels() {
  return {
    cli: {
      how: "node cli/illuci.mjs <verb>  (or the `illuci` bin)",
      discover: "illuci --help ; illuci describe ; illuci surfaces",
      note: "primary local surface",
    },
    mcp: {
      how: "connect Illuci's MCP server; read illuci://surface/capability-card, then call the exposed tools",
      discover: "MCP resource list",
      note: "for agent hosts (Claude / Codex / Grok / Cursor)",
    },
    api: {
      how: "the deployed runtime HTTP surface (/health, /runtime/doctor, /runtime/identity, /runtime/events)",
      discover: "GET /health ; GET /runtime/doctor (bearer)",
      note: "requires a deployed runtime URL (ILLUCI_RUNTIME_URL)",
    },
  };
}

function surfaceState(s) {
  if (s.posture === "live-run-path" && s.readiness === "active") return "on";
  if (s.posture === "gated") return "gated";
  if (s.posture === "dark-forward" || s.readiness === "planned") return "dark";
  if (s.posture === "provenance" || s.readiness === "deprecated" || s.readiness === "extraction-residue") return "context";
  return "on";
}

/**
 * Build the capability card. Read-only and deterministic for a given env; consumes
 * only source-owned catalogs. `includeSurfaces:false` returns a compact card.
 */
export function buildCapabilityCard({ env = process.env, includeSurfaces = true } = {}) {
  const surfaces = listSurfaceMap();
  const defaults = defaultsSnapshot(env);
  const gates = featureGatesSnapshot(env);

  const capabilities = surfaces.map((s) => ({
    id: s.id,
    what: s.evidence,
    posture: s.posture,
    state: surfaceState(s),
    loadBearing: s.loadBearing === true,
    paths: [...s.paths],
  }));

  const on = capabilities.filter((c) => c.state === "on").length;
  const gated = capabilities.filter((c) => c.state === "gated").length;
  const dark = capabilities.filter((c) => c.state === "dark").length;
  const gatesOff = gates.off.length;

  const card = {
    schema: CAPABILITY_CARD_SCHEMA,
    illuci: {
      name: "illuci",
      title: "governed agentic harness + orchestration engine — a meta-layer for safer, structured, auditable agentic work",
      tagline: ILLUCI_TAGLINE,
      version: readVersion(),
      whatItIsFor:
        "Illuci holds your projects as configuration, governs and orchestrates agentic work over them, probes and structures them, and keeps the whole trail auditable. Capabilities are legible controls you opt into — never hidden.",
    },
    host: detectHost(env),
    invocation: invocationChannels(),
    controls: {
      runPosture: defaults.controls, // disclosed defaults (DR-129/DR-130) + how to change each
      featureGates: gates.gates, // opt-in gates + the one-line control to turn each on
    },
    activation: {
      summary: `${on} capabilities on, ${gated} gated, ${dark} dark-forward; ${gatesOff} feature gate(s) off.`,
      turnOnFeatureGate: "set the gate's env control to 1 (e.g. ILLUCI_DATASTORE_ENABLED=1), then re-invoke",
      changeRunPosture: "illuci defaults  (see each default, why, and how to change it)",
      offer:
        gatesOff > 0 || dark > 0
          ? 'Illuci has capabilities that are off. A host may ask the operator: "want to turn any of these on?" — each is a disclosed, reversible control, not a hidden switch.'
          : "All disclosed capabilities are active.",
    },
    summary: {
      surfaces: summarizeSurfaceMap(surfaces),
      on,
      gated,
      dark,
      featureGatesOff: gatesOff,
    },
  };
  if (includeSurfaces) card.capabilities = capabilities;
  return card;
}

/** Human-readable render of the card (the CLI default view). */
export function renderCapabilityCard(env = process.env) {
  const c = buildCapabilityCard({ env });
  const L = [];
  L.push(`illuci — ${c.illuci.title}`);
  L.push(`  "${c.illuci.tagline}"${c.illuci.version ? "   " + c.illuci.version : ""}`);
  L.push(`  host: ${c.host.host} (${c.host.surface}${c.host.signal ? ", via " + c.host.signal : ""})`);
  L.push("");
  L.push("Invocation:");
  L.push(`  CLI  ${c.invocation.cli.how}   — discover: ${c.invocation.cli.discover}`);
  L.push(`  MCP  ${c.invocation.mcp.how}`);
  L.push(`  API  ${c.invocation.api.how}`);
  L.push("");
  L.push(`Capabilities: ${c.summary.on} on · ${c.summary.gated} gated · ${c.summary.dark} dark-forward`);
  L.push("");
  L.push("Run-posture defaults (what runs unless you say otherwise):");
  for (const d of c.controls.runPosture) {
    const how = d.change?.run || d.change?.env || d.change?.note || "";
    L.push(`  ${d.title}: ${d.current}${how ? "   change: " + how : ""}`);
  }
  L.push("");
  L.push("Feature gates (off unless turned on):");
  for (const g of c.controls.featureGates) {
    L.push(`  ${g.unlocks}`);
    L.push(`    ${g.current}   turn on: ${g.turnOn}`);
  }
  L.push("");
  L.push(c.activation.offer);
  return L.join("\n");
}

export default {
  CAPABILITY_CARD_SCHEMA,
  ILLUCI_TAGLINE,
  buildCapabilityCard,
  renderCapabilityCard,
  detectHost,
  invocationChannels,
};
