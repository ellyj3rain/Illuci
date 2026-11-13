/**
 * illuci — Governance Prompt Injector
 *
 * Prepends the governance preamble to every model query that
 * passes through dispatch. This ensures every model knows:
 *   - It's operating within illuci
 *   - It has a structural role to execute
 *   - Its own model identity within the platform
 *   - Who its peers are in the current lineup
 *   - The behavioral rules it must follow
 *
 * The source-owned preamble is cached in-process and injected into governed dispatches unless explicitly marked raw.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { resolveIlluciHomeDir } from "../agents/home-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolveIlluciHomeDir("agents");
const DEFAULT_GOVERNANCE_PREAMBLE = [
  "You are operating within illuci, the portable model-agnostic agentic harness and governed orchestration engine.",
  "Answer naturally and directly while honoring the structural seat, topology, model identity, peer context, and carried governance obligations supplied with this dispatch.",
  "Do not fabricate capabilities, provenance, or repository state. Treat governance as coordination and accountability, not as a reason to hide useful work.",
  "Before acting on shared multi-agent work, exchange current source, revision, ownership, contract, and gaps with the owning department and its existing lead through the established channel. An unanswered message or old fixture is insufficient; hold that cross-department action while independent authorized work continues.",
].join("\n");

let _preamble = null;
const _identityCache = new Map();

// The carried tier of the compiled Bill: obligations that ride every governed (non-raw) dispatch's
// operating context (operate doc-first, scope-carried, operate see-and-verify, ...). Read once from
// the compiler's sync manifest and cached. Absent manifest (the Bill not yet compiled) -> empty, so
// a dispatch is never broken by a missing Bill.
const CARRIED_MANIFEST = resolve(__dirname, "compiled", "carried-manifest.json");
let _carried = null;
function carriedObligations() {
  if (_carried !== null) return _carried;
  try {
    _carried = JSON.parse(readFileSync(CARRIED_MANIFEST, "utf-8"));
  } catch {
    _carried = [];
  }
  return _carried;
}
function carriedBlock() {
  const obs = carriedObligations();
  if (!obs.length) return "";
  return "Carried obligations (the compiled Bill):\n" + obs.map((o) => "- " + o.preamble).join("\n");
}

function loadPreamble() {
  if (_preamble !== null) return _preamble;
  _preamble = DEFAULT_GOVERNANCE_PREAMBLE;
  return _preamble;
}

/**
 * Load a model's identity card (cached).
 * Returns a one-line self-description or null.
 */
function loadIdentitySummary(modelId) {
  if (_identityCache.has(modelId)) return _identityCache.get(modelId);

  const cardPath = join(AGENTS_DIR, modelId, "identity.json");
  let summary = null;

  try {
    if (existsSync(cardPath)) {
      const card = JSON.parse(readFileSync(cardPath, "utf-8"));
      const style = card.selfAssessment?.workingStyle || "";
      const strengths = (card.selfAssessment?.strengths || []).slice(0, 3).join(", ");
      if (style || strengths) {
        summary = [strengths, style].filter(Boolean).join(" — ");
      }
    }
  } catch {}

  _identityCache.set(modelId, summary);
  return summary;
}

/**
 * Inject governance preamble into a message.
 *
 * @param {string} message — the user/phase message
 * @param {object} options
 * @param {boolean} options.raw — skip injection (for direct/passthrough)
 * @param {string} options.seat — the seat this model occupies
 * @param {string} options.topology — the topology name
 * @param {string} options.modelId — the model being queried
 * @param {string[]} options.peerIds — other models in the current lineup
 * @param {string} options.projectId — active project context
 * @returns {string} The message with governance preamble prepended
 */
export function injectGovernance(message, options = {}) {
  if (options.raw) return message;

  const preamble = loadPreamble();
  if (!preamble) return message;

  const parts = [preamble];

  // Model identity block
  if (options.modelId) {
    parts.push(`\nModel: ${options.modelId}`);
    const identity = options.skipIdentitySummary === true ? null : loadIdentitySummary(options.modelId);
    if (identity) {
      parts.push(`Identity: ${identity}`);
    }
  }
  if (options.topology) {
    parts.push(`Topology: ${options.topology}`);
  }
  if (options.seat) {
    parts.push(`Seat: ${options.seat}`);
  }
  if (options.peerIds && options.peerIds.length > 0) {
    parts.push(`Peers: ${options.peerIds.join(", ")}`);
  }
  if (options.projectId) {
    parts.push(`Project: ${options.projectId}`);
  }

  const carried = carriedBlock();
  if (carried) parts.push("\n" + carried);

  parts.push("\n---\n");
  parts.push(message);

  return parts.join("\n");
}

/** Reload the source-owned preamble into the process cache. */
export function reloadPreamble() {
  _preamble = null;
  return loadPreamble();
}

/** Clear identity cache (e.g., after identity regeneration) */
export function clearIdentityCache() {
  _identityCache.clear();
}

export default { injectGovernance, reloadPreamble, clearIdentityCache };
