#!/usr/bin/env node
/**
 * illuci CLI shim
 *
 * Command-line entry into the dedicated ILLUCI runtime. Slash commands and
 * external drivers invoke this shim for runnable end-to-end orchestration.
 *
 * Verbs:
 *   illuci decisions [--type X] [--last N] [--source seed|runtime|all] [--sources] [--json]
 *                                                   - read decision seed/runtime logs
 *   illuci chat <model[,model2,...]> "<msg>"          - governed streaming dispatch (NDJSON)
 *   illuci run <topology> "<task>"                    - dispatch a topology (requires provider keys)
 *   illuci pipeline <list|plan|run> ...                - inspect or run pipeline compositions
 *   illuci gitops doctor --repo owner/name [--json]   - verify optional GitOps token readiness
 *   illuci gitops mirrors [--primary zero] [--mirrors enterprise,origin] [--json]
 *                                                   - inspect governed publication mirror posture
 *   illuci sandbox sweep [--older-than-hours N] [--dry-run] [--json] - prune aged CLI-lane sandboxes
 *   illuci worktree sweep [--apply] [--branches] [...] - lifecycle-sweep stale registered git worktrees (DR-208)
 *   illuci infrastructure doctor [--platform github,gitlab,vercel,supabase,obsidian] [--json]
 *                                                   - inspect hosted/local infrastructure account posture
 *   illuci pr classify [--base origin/main] [--json]  - classify PR shape/readiness/merge strategy
 *   illuci pr auto-merge <number|url> --repo owner/name - request governed squash auto-merge
 *   illuci pr outcome <collect|backfill> ...          - collect PR outcome corpus records
 *   illuci surfaces [--posture X] [--readiness X] [--all] [--json]
 *                                                   - inspect surface posture/readiness diagnostics
 *   illuci council <preset> "<task>"                  - dispatch a council preset
 *   illuci project <assess|create|integrate|substrate|plan-reorg|execute-reorg> - standards, substrate, and reorg verbs
 *   illuci --help                                     - this message
 *
 * Run via: node illuci/cli/illuci.mjs <verb> [args]
 *
 * Status: `decisions` reads the live log; `chat` streams through the governed
 * dispatch path; `run` dispatches real topologies through the runner; `pipeline`
 * composes named pipeline stages through the existing runner; `company`
 * composes multiple topologies behind its feature flag; `flow` remains a stub.
 */
import { decisionLogSources, readDecisions, recentDecisions } from "../core/decisions/logger.js";
import { buildCliSeatDispositions, collectTopologySeatIds, collectTopologySeatIdsByIds } from "./disposition-flags.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const verb = args[0];

function help() {
  console.log(`illuci CLI shim (dedicated ILLUCI runtime)

Verbs:
  illuci tui                                        launch the interactive Terminal UI
  illuci decisions [--type X] [--last N] [--source seed|runtime|all] [--sources] [--json]
                                                 read decision seed/runtime logs
  illuci chat <model[,model2,...]> "<msg>"          governed streaming dispatch (NDJSON)
  illuci models [--provider ID] [--diagnostics] [--doctor] [--route-probe-timeout MS] [--identity-card ID] [--generate-card ID] [--json] list curated model resources
  illuci providers [--diagnostics] [--json]          list managed provider resources
  illuci topologies [--json] [--curation]          the topology registry (seats + relationship edges)
  illuci dispositions [--json]                      list disposition schema and presets
  illuci genome <status|profile> <slug> [--project-dir PATH] [--json]
                                                 read-only persona-genome HEAD status / live-profile fold (reads never birth)
  illuci presets <list|create|validate|resolve|plan|run|materialize-topology> ... graph-spine presets
  illuci matrix [--json]                            the role->model capability matrix (routing)
  illuci run <topology> "<task>"                    dispatch a topology
  illuci pipeline <list|plan|run> ...                inspect or run pipeline compositions
  illuci gitops doctor --repo owner/name [--base main] [--json] [--write-trace]
                                                 verify optional GitOps token readiness without exposing token values
  illuci gitops mirrors [--primary zero] [--mirrors enterprise,origin] [--branch main] [--json]
                                                 inspect governed publication mirrors without mutating remote refs
  illuci sandbox sweep [--older-than-hours N] [--dry-run] [--json]
                                                 prune aged CLI-lane sandbox scratch directories (DR-200 lifecycle)
  illuci worktree sweep [--apply] [--against REF] [--min-age-days N] [--min-behind N] [--branches] [--quarantine-and-sweep] [--quarantine-root DIR] [--repo DIR] [--json]
                                                 lifecycle-sweep stale registered git worktrees — plan by default, quarantine before delete (DR-208 lifecycle)
  illuci infrastructure doctor [--platform github,gitlab,vercel,supabase,obsidian] [--json] [--write-trace]
                                                 inspect hosted/local infrastructure account posture
  illuci pr classify [--base origin/main] [--json] [--write-trace] classify PR shape, readiness, merge strategy
  illuci pr auto-merge <number|url> --repo owner/name [--dry-run] [--json] [--write-trace]
                                                 request governed squash auto-merge when PR checks/classifiers allow it
  illuci pr outcome collect <number|url> --repo owner/name [--json] [--write-trace] [--promote-corpus] [--dry-run]
  illuci pr outcome backfill --repo owner/name --terminal [--json] [--write-trace] [--promote-corpus] [--dry-run]
  illuci pr outcome audit --repo owner/name [--json] [--terminal-file path] [--corpus-root path]
                                                 collect replayable PR outcome corpus records
  illuci surfaces [--posture X] [--readiness X] [--all] [--json] inspect source-owned surface posture/readiness diagnostics
  illuci describe [--json]                          self-describe for a host agent/human: what illuci is, how to invoke it (CLI/MCP/API), what's on/off + how to turn it on
  illuci company <topo[,topo...]> "<prompt>"        run topologies concurrently on one bus (gated: ILLUCI_COMPANY_ENABLED)
  illuci council <preset> "<task>"                  dispatch a council preset
  illuci project <assess|create|integrate|substrate|plan-reorg|execute-reorg> standards, substrate, and reorg verbs
  illuci --help, -h                                 this message

chat flags:
  --raw                 skip the governance preamble (plain chat)
  --text                stream answer text to stdout instead of NDJSON (single model)
  --temp N              temperature        --num-ctx N      context window (native)
  --num-predict N       max output tokens  --top-p N --top-k N --seed N
  --repeat-penalty N    --min-p N          --stop a,b,c     stop sequences
  --keep-alive 5m       model VRAM residency (native)       --think / --no-think
  --api native|openai   force the wire (native = full Ollama options)
  --endpoint URL        per-call endpoint (local vs cloud vs remote)
  --params '<json>'     full granular param object (merged over the shortcuts)

Examples:
  illuci chat deepseek "Explain MVCC in one paragraph"
  illuci chat deepseek,glm,kimi-cloud "Compare your takes"      # ollama-cloud fan-out
  illuci chat ollama "hello" --temp 0.2 --num-ctx 8192 --keep-alive 30m
  illuci chat qwen-code "refactor this" --params '{"temperature":0.4,"num_ctx":16384,"seed":7}'
  illuci models --provider provider.ollama.cloud
  illuci models --diagnostics --endpoint http://localhost:11434 --json
  illuci models --doctor grok-build,kimi-cloud,glm,deepseek,gemini,claude-opus,gpt-oss,qwen3.5 --json
  illuci models --identity-card grok-build
  illuci models --generate-card <model-id>   # explicit; asks that model to create its display card
  illuci providers --json
  illuci presets list --json
`);
}

function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const raw = a.slice(2);
      const eq = raw.indexOf("=");
      if (eq !== -1) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const key = raw;
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const SEAT_DISPOSITION_VALUE_FLAG = /-(preset|role|skills|profile)$/;

function enforceFlagValueContract(flags, label, { valueFlags = [], booleanFlags = [], allowDynamicValueFlags = false } = {}) {
  const values = new Set(valueFlags);
  const booleans = new Set(booleanFlags);
  for (const [key, value] of Object.entries(flags)) {
    const flag = `--${key}`;
    const takesValue = values.has(key) || SEAT_DISPOSITION_VALUE_FLAG.test(key);
    if (booleans.has(key) && value !== true) {
      console.error(`${label}: ${flag} does not take a value`);
      process.exit(1);
    }
    if ((takesValue || (allowDynamicValueFlags && !booleans.has(key))) && (value === true || value === "")) {
      console.error(`${label}: ${flag} requires a value`);
      process.exit(1);
    }
  }
}

function cmdDecisions(rest) {
  const { flags } = parseFlags(rest);
  const source = flags.source || "all";
  if (!["all", "seed", "runtime"].includes(source)) {
    console.error(`Invalid decision source: ${source}. Use seed, runtime, or all.`);
    process.exitCode = 1;
    return;
  }

  const filter = { source, includeSource: !!flags.sources };
  if (flags.type) filter.type = flags.type;
  const records = flags.last
    ? recentDecisions(parseInt(flags.last, 10), filter)
    : readDecisions(filter);
  const sources = flags.sources ? decisionLogSources() : null;

  if (flags.json) {
    console.log(JSON.stringify(flags.sources ? { sources, records } : records, null, 2));
    return;
  }

  if (sources) {
    console.log("Decision log sources:");
    for (const item of sources) {
      console.log(`  ${item.kind}: ${item.exists ? item.count : 0} record(s) at ${item.path}${item.exists ? "" : " (missing)"}`);
    }
    console.log("");
  }

  if (records.length === 0) {
    console.log("No decisions logged yet.");
    return;
  }
  for (const r of records) {
    const models = r.modelStatus.map((m) => `${m.model || "?"}:${m.role || m.seat || "?"}`).join(", ");
    console.log(`${r.timestamp} | ${r.humanStatus} | ${r.type} | ${r.decision}`);
    console.log(`  models: ${models}`);
    console.log(`  context: ${r.context}`);
    if (r._source) console.log(`  source: ${r._source.kind} (${r._source.path})`);
    console.log("");
  }
}

/**
 * Build an Ollama generation-param bag from CLI flags. Recognized shortcuts plus
 * a `--params '<json>'` escape hatch for the full surface. Native-only params
 * (num_ctx, keep_alive, …) auto-select the native /api/chat endpoint in the bridge.
 */
function buildParamsFromFlags(flags) {
  const params = {};
  const num = (name, key) => {
    if (flags[name] !== undefined && flags[name] !== true) {
      const n = Number(flags[name]);
      if (!Number.isNaN(n)) params[key] = n;
    }
  };
  num("temp", "temperature"); num("temperature", "temperature");
  num("num-ctx", "num_ctx"); num("ctx", "num_ctx");
  num("num-predict", "num_predict"); num("max-tokens", "num_predict");
  num("top-p", "top_p"); num("top-k", "top_k");
  num("seed", "seed"); num("repeat-penalty", "repeat_penalty"); num("min-p", "min_p");
  if (flags["keep-alive"] !== undefined && flags["keep-alive"] !== true) params.keep_alive = flags["keep-alive"];
  if (flags.stop !== undefined && flags.stop !== true) params.stop = String(flags.stop).split(",");
  if (flags.think === true) params.think = true;
  if (flags["no-think"] === true) params.think = false;
  if (flags.params && flags.params !== true) {
    try { Object.assign(params, JSON.parse(flags.params)); }
    catch { console.error("illuci chat: --params must be valid JSON; ignored."); }
  }
  return params;
}

/** Assemble per-call dispatch options (raw + granular Ollama controls) from flags. */

function thinkingFlagFromFlags(flags) {
  if (flags.think === true) return true;
  if (flags["no-think"] === true) return false;
  return null;
}

function buildRunParamsFromFlags(flags) {
  const params = {};
  if (flags["num-predict"] && flags["num-predict"] !== true) {
    const n = parseInt(String(flags["num-predict"]), 10);
    if (Number.isFinite(n) && n > 0) params.num_predict = n;
  }
  const thinking = thinkingFlagFromFlags(flags);
  if (thinking !== null) params.think = thinking;
  return params;
}
function buildChatOptions(flags) {
  const opts = { raw: !!flags.raw };
  const params = buildParamsFromFlags(flags);
  if (Object.keys(params).length) opts.params = params;
  if (flags.api === "native" || flags.api === "openai") opts.api = flags.api;
  const baseUrl = flags.endpoint || flags["base-url"];
  if (baseUrl && baseUrl !== true) opts.baseUrl = baseUrl;
  return opts;
}

/**
 * Apply illuci's per-agent disposition variables to a chat
 * message as a prepended [Behavioral Disposition] block, via the same disposition
 * resolver the topology runner uses. --preset <id> / --profile '<json>' drive the
 * dimensional engine; --role <hint> prepends a role-context line. Returns the
 * message unchanged when no agent variables are set.
 */
async function applyChatDisposition(message, flags) {
  let preset = flags.preset && flags.preset !== true ? String(flags.preset) : null;
  const role = flags.role && flags.role !== true ? String(flags.role) : null;
  const skills = flags.skills && flags.skills !== true ? String(flags.skills).split(',') : [];
  let profile = null;
  if (flags.profile && flags.profile !== true) {
    try { 
      profile = JSON.parse(flags.profile); 
    } catch { 
      // If it's not valid JSON, OTL might be passing the preset ID as `--profile`.
      if (!preset) {
        preset = String(flags.profile);
      } else {
        console.error("illuci chat: --profile must be valid JSON; ignored."); 
      }
    }
  }
  if (!preset && !profile && !role && skills.length === 0) return message;

  let block = "";
  if (preset || profile || role || skills.length) {
    try {
      const { composeBehavioralDisposition } = await import("../core/composition/disposition-resolver.js");
      const seatDispositions = {
        chat: { 
          ...(preset ? { presetId: preset } : {}), 
          ...(profile ? { profile } : {}),
          ...(role ? { role } : {}),
          ...(skills.length ? { skills } : {})
        },
      };
      const res = await composeBehavioralDisposition({
        modelId: "chat", seatId: "chat", seatDef: {}, dispatchOpts: { seatDispositions },
      });
      block = res.block || "";
    } catch (err) {
      console.error(`illuci chat: disposition failed: ${err.message}`);
    }
  }
  const roleLine = role ? `You are acting in the role of: ${role}.` : "";
  const prefix = [roleLine, block].filter(Boolean).join("\n\n");
  return prefix ? `${prefix}\n\n${message}` : message;
}

/**
 * illuci dispositions - export illuci's disposition schema and presets for UI controls.
 */
async function cmdDispositions(rest) {
  const { flags } = parseFlags(rest);
  const dims = await import("../core/agents/disposition-dimensions.js");
  const presetsMod = await import("../core/agents/disposition-presets.js");

  const schema = {
    neoDomains: dims.NEO_PI_R_DOMAINS,
    neoFacets: dims.NEO_PI_R_FACETS,
    darkTriad: dims.SD3_SUBSCALES,
    pid5Domains: dims.PID_5_DOMAINS,
    pid5Facets: dims.PID_5_FACETS,
    values: dims.SCHWARTZ_VALUES,
    valueClusters: dims.SCHWARTZ_CLUSTERS,
    enneagramCores: dims.ENNEAGRAM_CORES,
    enneagramInstincts: dims.ENNEAGRAM_INSTINCTS,
  };
  const { bandProfile, computeSalience } = await import("../core/agents/disposition-identity.js");
  const presets = Object.entries(presetsMod.DISPOSITION_PRESETS).map(([id, p]) => ({
    id, source: p.source, fingerprint: p.fingerprint,
    salience: computeSalience(bandProfile(p.profile), { topN: 4 }), profile: p.profile,
  }));
  // Roles are a PRESET LIBRARY, not user-defined semantics — the distinct roleHints across
  // the capability matrix. A consumer UI offers these in a dropdown (never a free-text role).
  const { getRoles } = await import("../core/matrix/capability-matrix.js");
  const roles = getRoles();

  if (flags.json) {
    console.log(JSON.stringify({ schema, presets, roles }, null, 2));
    return;
  }
  console.log("illuci disposition dimensions:");
  console.log(`  NEO-PI-R taxonomy: ${Object.keys(schema.neoFacets).length} facets / ${Object.keys(schema.neoDomains).length} domains`);
  console.log(`  Dark Triad:     ${Object.keys(schema.darkTriad).length} (SD3)`);
  console.log(`  PID-5:          ${Object.keys(schema.pid5Facets).length} facets / ${Object.keys(schema.pid5Domains).length} domains`);
  console.log(`  Schwartz values:${Object.keys(schema.values).length} / ${Object.keys(schema.valueClusters).length} clusters`);
  console.log(`  Enneagram:      ${Object.keys(schema.enneagramCores).length} cores / ${Object.keys(schema.enneagramInstincts).length} instincts`);
  console.log(`\nPresets (${presets.length}): ${presets.map((p) => p.id).join(", ")}`);
  console.log(`Roles (${roles.length}, preset library): ${roles.join(", ")}`);
}

/**
 * illuci genome — read-only persona-genome surfaces (DR-181, the CLI half).
 * status = the raw validated HEAD projection ([A80] genomeStatus); profile =
 * the canonical crashed-seal-compensated fold ([A87] readLiveProfile) with
 * the unsealed ledger + run provenance. A CLI read never births a genome (a
 * missing genome is data, exit 0). --project-dir defaults to the operator's
 * cwd — the project-assess precedent; the machine surfaces (MCP/REST) keep
 * projectDir explicit.
 */
async function cmdGenome(rest) {
  const sub = rest[0];
  if (sub === "status" || sub === "profile") {
    const { flags, positional } = parseFlags(rest.slice(1));
    const slug = positional[0];
    if (!slug) {
      console.error(`usage: illuci genome ${sub} <slug> [--project-dir PATH] [--json]`);
      process.exit(1);
    }
    const projectDir = flags["project-dir"] && flags["project-dir"] !== true ? String(flags["project-dir"]) : process.cwd();
    const { genomeStatus, readLiveProfile } = await import("../core/agents/persona-memory.js");
    const status = genomeStatus(projectDir, slug);
    if (sub === "status") {
      if (flags.json) {
        console.log(JSON.stringify({ schema: "illuci.genome.status/1", slug, projectDir, ...status }, null, 2));
        return;
      }
      if (!status.exists) {
        console.log(`genome: none for "${slug}" under ${projectDir} (reads never birth a genome)`);
        return;
      }
      console.log(`genome ${slug} @ ${projectDir}`);
      console.log(`  baseRef ${status.baseRef}   unsealed deltas ${status.activeLedgerLen}${status.lastSealAt ? `   last seal ${status.lastSealAt}` : ""}`);
      return;
    }
    if (!status.exists) {
      if (flags.json) {
        console.log(JSON.stringify({ schema: "illuci.genome.profile/1", slug, projectDir, exists: false }, null, 2));
        return;
      }
      console.log(`genome: none for "${slug}" under ${projectDir} (reads never birth a genome)`);
      return;
    }
    // The genome exists, so the presetless read is pure — no genesis reachable.
    const live = readLiveProfile(projectDir, slug);
    const payload = {
      schema: "illuci.genome.profile/1",
      slug,
      projectDir,
      exists: true,
      profile: live.profile,
      ledger: live.ledger,
      baseRef: live.baseRef,
      activeLedgerLen: live.activeLedgerLen,
      compensated: live.compensated,
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`genome ${slug} @ ${projectDir} — baseRef ${live.baseRef}, unsealed ${live.activeLedgerLen}${live.compensated ? " (seal-window compensated)" : ""}`);
    console.log(`  facets ${Object.keys(live.profile.facets || {}).length}; unsealed pulls:`);
    if (live.ledger.length === 0) console.log("    (none)");
    for (const d of live.ledger) console.log(`    ${JSON.stringify(d.pulls)}${d.runId ? `  (run ${d.runId})` : ""}`);
    return;
  }
  console.error(`Unknown genome subcommand: ${sub || "(none)"}. Try: illuci genome <status|profile> <slug> [--project-dir PATH] [--json]`);
  process.exit(1);
}

/**
 * illuci compose — exposes the composition algebra to UI surfaces.
 * Evaluates preset + role + skills into a unified ComposedDisposition profile.
 */
async function cmdCompose(rest) {
  const { flags } = parseFlags(rest);
  if (!flags.preset) {
    console.error("illuci compose: --preset is required");
    process.exit(1);
  }
  
  const { composeDispositionForRoleIntent } = await import("../core/composition/role-composition.js");
  const roleId = flags.role && flags.role !== true ? String(flags.role) : null;
  const skills = flags.skills && flags.skills !== true ? String(flags.skills).split(",") : [];

  try {
    const { composed } = composeDispositionForRoleIntent(String(flags.preset), roleId, skills);
    console.log(JSON.stringify(composed, null, 2));
  } catch (err) {
    console.error("Composition error:", err.message);
    process.exit(1);
  }
}

/**
 * illuci topologies — the topology registry as data (read-out, no dispatch).
 *
 * Topologies are structural patterns: named seats with relationship edges
 * (parent-of, adversarial-to, peer-of, mentors, precedes, …), ordered phases,
 * and roleHints that auto-fill from the capability matrix. A consumer (OTL's
 * Workstation mode) reads this to render the seat/edge graph and assign models
 * per seat; the operator fills every seat. Read-only — `illuci run` dispatches.
 */
async function cmdTopologies(rest) {
  const { flags } = parseFlags(rest);
  const { TOPOLOGIES } = await import("../core/topologies/index.js");

  if (flags.curation) {
    const { listCuratedTopologies } = await import("../core/topologies/curation.js");
    const rows = listCuratedTopologies({
      includeAdvanced: Boolean(flags["include-advanced"] || flags.all),
      includeSandbox: Boolean(flags["include-sandbox"] || flags.all),
    });
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(`illuci topologies (${rows.length}) - curated structural patterns:`);
    for (const t of rows) {
      const seats = Array.isArray(t.seats) ? t.seats.length : 0;
      const phases = Array.isArray(t.phases) ? t.phases.length : 0;
      const state = `${t.curation.status}/${t.curation.visibility}`;
      console.log(`  ${t.id.padEnd(20)} ${state.padEnd(24)} ${seats} seat(s), ${phases} phase(s) - ${t.curation.divergence}`);
    }
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify(TOPOLOGIES, null, 2));
    return;
  }
  const ids = Object.keys(TOPOLOGIES);
  console.log(`illuci topologies (${ids.length}) - structural patterns with assignable seats:`);
  for (const id of ids) {
    const t = TOPOLOGIES[id];
    const seats = Array.isArray(t.seats) ? t.seats.length : 0;
    const phases = Array.isArray(t.phases) ? t.phases.length : 0;
    const seatConstraints = Array.isArray(t.seats)
      ? t.seats.map((seat) => `${seat.id} ${seat.min}..${seat.max}`).join(", ")
      : "";
    console.log(`  ${id.padEnd(16)} ${seats} seat(s), ${phases} phase(s) - ${t.description ?? ""}`);
    if (seatConstraints) console.log(`    seats: ${seatConstraints}`);
  }
}
/**
 * illuci matrix — the role->model capability matrix as data (read-out, no dispatch).
 *
 * MODEL_CAPABILITIES maps each model to the roles it can take, with a TOS-based
 * priority (1 = takes point, 2 = concurrent amplifier, 3 = fallback) and a
 * `concurrent` flag. A consumer (OTL's Workstation routing) inverts this
 * (role -> models by priority) to default-fill a topology's seats from a seat's
 * roleHint. Read-only.
 */
function readCliJsonText(raw, label) {
  if (typeof raw !== "string" || raw.trim() === "") {
    console.error(`${label}: expected a JSON string`);
    process.exit(1);
  }
  if (raw.startsWith("@")) {
    const file = raw.slice(1);
    if (!file) {
      console.error(`${label}: expected a path after @`);
      process.exit(1);
    }
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      console.error(`${label}: cannot read JSON file "${file}" - ${err.message}`);
      process.exit(1);
    }
  }
  return raw;
}

function normalizeCliJsonText(text) {
  return String(text).replace(/^\uFEFF/, "");
}

function parseCliJson(raw, label) {
  const text = normalizeCliJsonText(readCliJsonText(raw, label));
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`${label}: invalid JSON - ${err.message}`);
    process.exit(1);
  }
}

function parseCliJsonFlag(flags, key, label) {
  const fileKey = `${key}-file`;
  const hasInline = flags[key] && flags[key] !== true;
  const hasFile = flags[fileKey] && flags[fileKey] !== true;
  if (hasInline && hasFile) {
    console.error(`${label}: use --${key} or --${fileKey}, not both`);
    process.exit(1);
  }
  if (hasFile) return parseCliJson("@" + String(flags[fileKey]), `${label} --${fileKey}`);
  return parseCliJson(flags[key], `${label} --${key}`);
}

function hasCliJsonFlag(flags, key) {
  return (flags[key] && flags[key] !== true) || (flags[`${key}-file`] && flags[`${key}-file`] !== true);
}

function buildRunControlFromFlags(flags, label) {
  let runControl = hasCliJsonFlag(flags, "run-control") ? parseCliJsonFlag(flags, "run-control", label) : {};
  if (!runControl || typeof runControl !== "object" || Array.isArray(runControl)) {
    console.error(`${label}: --run-control must be a JSON object`);
    process.exit(1);
  }
  runControl = { ...runControl };
  if (flags.agenda && flags.agenda !== true) {
    runControl.agenda = { ...(runControl.agenda || {}), strategy: String(flags.agenda) };
  }
  if (flags["mutation-authority"] && flags["mutation-authority"] !== true) {
    runControl.execution = { ...(runControl.execution || {}), mutationAuthority: String(flags["mutation-authority"]) };
  }
  if (flags["tool-autonomy"] && flags["tool-autonomy"] !== true) {
    runControl.tools = { ...(runControl.tools || {}), autonomy: String(flags["tool-autonomy"]) };
  }
  return runControl;
}

function printPresetResult(result, flags = {}) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}


function parsePresetLineupFlags(flags) {
  const lineupFlags = { ...flags };
  // [A106] the five genome flags are RESERVED out of the dynamic --<seat>
  // lineup exactly as `illuci run` and `illuci company` reserve them — otherwise an
  // armed invocation leaks phantom seats (including a machine-absolute
  // project path) into every member lineup and the persisted run record.
  for (const key of [
    "json", "kind", "spec", "spec-file", "record", "root-node", "rootNodeId",
    "genome-project-dir", "genome-precedence", "genome-seal-threshold", "genome-child-identity", "genome-grading-sources",
  ]) delete lineupFlags[key];
  return parsePipelineLineup(lineupFlags);
}

function printPresetPlan(result, flags = {}) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.planned) {
    console.log("preset plan failed: " + (result.reason || "unknown"));
    for (const error of result.errors || []) console.log("  " + error);
    return;
  }
  console.log("illuci preset plan: " + result.presetId);
  console.log("  root: " + result.rootKind + " " + result.rootNodeId);
  console.log("  nodes: " + result.summary.nodeCount + " (" + result.summary.topologyCount + " topology, " + result.summary.companyCount + " company, " + result.summary.pipelineCount + " pipeline)");
  console.log("  lineup defaults: " + Object.keys(result.defaultLineup || {}).length);
  console.log("  lineup resolved: " + Object.keys(result.resolvedLineup || {}).length);
  console.log("  record: " + (result.record?.id || "not written"));
}

function printPresetRun(result, flags = {}) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.ran) {
    console.log("preset run refused: " + (result.reason || "unknown"));
    if (result.requiredEnv) console.log("  required: " + result.requiredEnv);
    for (const error of result.errors || []) console.log("  " + error);
    return;
  }
  console.log("illuci preset run: " + result.presetId);
  console.log("  status: " + result.resultSummary.status);
  console.log("  kind: " + (result.resultSummary.kind || result.plan?.rootKind || "unknown"));
  console.log("  session: " + (result.resultSummary.sessionId || "n/a"));
  console.log("  record: " + (result.record?.id || "not written"));
  if (result.record?.tracePath) {
    const kb = Math.max(1, Math.round((result.record.traceBytes || 0) / 1024));
    console.log(`  transcript: ${result.record.tracePath} (${kb} KB, full trace)`);
  } else if (result.record) {
    console.log("  transcript: not written (--record-trace false)");
  }
}

/** illuci presets - graph-spine preset authoring, planning, and execution. */
async function cmdPresets(rest) {
  const subverb = rest[0] || "list";
  const { flags, positional } = parseFlags(rest.slice(1));

  const usage = () => {
    console.error("usage: illuci presets <list|create|validate|resolve|plan|run|materialize-topology> ...");
    console.error("  illuci presets list [--json] [--include-hidden]");
    console.error("  illuci presets create <id> --spec '{json}|@file' [--spec-file path] [--json]");
    console.error("  illuci presets create <id> --kind pipeline|company --spec '{json}|@file' [--spec-file path] [--json]");
    console.error("  illuci presets validate <id> [--json]");
    console.error("  illuci presets validate --spec '{json}|@file' [--spec-file path] [--json]");
    console.error("  illuci presets resolve <id> [--json]");
    console.error("  illuci presets plan <presetId> \"prompt\" [--lineup '{json}|@file'] [--lineup-file path] [--<seat> model] [--json]");
    console.error("  illuci presets run <presetId> \"prompt\" [--lineup '{json}|@file'] [--lineup-file path] [--<seat> model] [--genome-project-dir path [--genome-precedence seed|dominant|pull] [--genome-seal-threshold N] [--genome-child-identity none|inherit|derive|explicit] [--genome-grading-sources list]] [--json]");
    console.error("  illuci presets materialize-topology <presetId> [nodeId] [--json]");
  };

  switch (subverb) {
    case "list": {
      const { listGraphPresets } = await import("../core/composition/graph-preset-store.js");
      const presets = listGraphPresets({ includeHidden: Boolean(flags["include-hidden"]) });
      if (flags.json) {
        console.log(JSON.stringify(presets, null, 2));
        return;
      }
      console.log("illuci graph presets (" + presets.length + ")");
      for (const preset of presets) {
        const source = preset.provenance?.source || "unknown";
        console.log("  " + preset.id.padEnd(24) + " " + preset.graphStatus.padEnd(10) + " " + source.padEnd(8) + " " + (preset.presentation?.label || preset.id));
      }
      return;
    }
    case "create": {
      const [id] = positional;
      if (!id || (!flags.spec && !flags["spec-file"])) { usage(); process.exit(1); }
      const spec = parseCliJsonFlag(flags, "spec", "illuci presets create");
      const { createRuntimeGraphPreset } = await import("../core/composition/graph-preset-store.js");
      let preset = { ...spec, id };
      if (flags.kind) {
        const { scaffoldRuntimeGraphPreset } = await import("../core/composition/graph-preset-scaffold.js");
        preset = scaffoldRuntimeGraphPreset(id, String(flags.kind), spec);
      }
      const result = createRuntimeGraphPreset(preset);
      printPresetResult(result, flags);
      if (!result.created) process.exit(1);
      return;
    }
    case "validate": {
      const { validateGraphPresetById } = await import("../core/composition/graph-preset-store.js");
      const { validateGraphPreset } = await import("../core/composition/graph-preset.js");
      const result = (flags.spec || flags["spec-file"])
        ? validateGraphPreset(parseCliJsonFlag(flags, "spec", "illuci presets validate"))
        : validateGraphPresetById(positional[0]);
      printPresetResult(result, flags);
      if (!result.valid) process.exit(1);
      return;
    }
    case "resolve": {
      const [id] = positional;
      if (!id) { usage(); process.exit(1); }
      const { resolveGraphPresetById } = await import("../core/composition/graph-preset-store.js");
      const result = resolveGraphPresetById(id);
      printPresetResult(result, flags);
      if (result.telemetry?.status !== "resolved") process.exit(1);
      return;
    }
    case "plan":
    case "run": {
      const [presetId, ...promptParts] = positional;
      const prompt = promptParts.join(" ").replace(/^"|"$/g, "");
      if (!presetId || !prompt) { usage(); process.exit(1); }
      const { dispatchIdForPublicModel } = await import("../core/fleet/resource-gateway.js");
      const lineup = normalizePipelineLineup(parsePresetLineupFlags(flags), dispatchIdForPublicModel);
      const rootNodeId = flags["root-node"] || flags.rootNodeId || null;
      if (subverb === "plan") {
        const { planGraphPreset } = await import("../core/composition/graph-preset-runner.js");
        const result = planGraphPreset(presetId, { prompt, lineup, rootNodeId, record: flags.record !== "false" });
        printPresetPlan(result, flags);
        if (!result.planned) process.exit(1);
        return;
      }
      const { runGraphPreset } = await import("../core/composition/graph-preset-runner.js");
      // [A106]/DR-199 — genome parity with run/company through the ONE shared
      // parser: the arm crosses runGraphPreset -> runNode ctx -> the [A91]
      // childIdentity carry. Unarmed stays byte-identical.
      const genome = await parseGenomeFlagsCli(flags, "illuci presets run");
      const result = await runGraphPreset(presetId, {
        prompt, lineup, rootNodeId, record: flags.record !== "false",
        // [A116]/DR-203 — the full run trace persists to a per-run transcript
        // file by default (recoverable deliverable); `--record-trace false`
        // opts out. The heavy result trace lived only in the returned envelope
        // before this and died with the process (F-143).
        recordTrace: flags["record-trace"] !== "false",
        ...(genome ? { genome } : {}),
      });
      printPresetRun(result, flags);
      if (!result.ran || result.resultSummary?.ok === false) process.exit(1);
      return;
    }
    case "materialize-topology": {
      const [presetId, nodeId] = positional;
      if (!presetId) { usage(); process.exit(1); }
      const { materializeTopologyFromGraphPreset } = await import("../core/composition/graph-preset-topology.js");
      const result = materializeTopologyFromGraphPreset(presetId, nodeId || null);
      printPresetResult(result, flags);
      if (!result.created) process.exit(1);
      return;
    }
    default:
      usage();
      process.exit(1);
  }
}
async function cmdSurfaces(rest) {
  const { flags } = parseFlags(rest);
  const surfaceMap = await import("../core/governance/surface-map.js");
  const posture = flags.posture && flags.posture !== true ? String(flags.posture) : null;
  if (posture && !surfaceMap.SURFACE_POSTURES.includes(posture)) {
    console.error("illuci surfaces: unknown posture " + posture);
    console.error("known postures: " + surfaceMap.SURFACE_POSTURES.join(", "));
    process.exit(1);
  }
  const readiness = flags.readiness && flags.readiness !== true ? String(flags.readiness) : null;
  if (readiness && !surfaceMap.SURFACE_READINESS_LEVELS.includes(readiness)) {
    console.error("illuci surfaces: unknown readiness " + readiness);
    console.error("known readiness levels: " + surfaceMap.SURFACE_READINESS_LEVELS.join(", "));
    process.exit(1);
  }

  let loadBearing = null;
  if (flags["load-bearing"] !== undefined) {
    if (flags["load-bearing"] === true) loadBearing = true;
    else if (["true", "1", "yes"].includes(String(flags["load-bearing"]).toLowerCase())) loadBearing = true;
    else if (["false", "0", "no"].includes(String(flags["load-bearing"]).toLowerCase())) loadBearing = false;
    else {
      console.error("illuci surfaces: --load-bearing must be true or false");
      process.exit(1);
    }
  }

  const includeAll = Boolean(flags.all || readiness);
  const surfaces = surfaceMap.listDiagnosticSurfaces({ includeAll, posture, readiness, loadBearing });
  const allSurfaces = surfaceMap.listDiagnosticSurfaces({ includeAll: true });
  const payload = {
    schema: surfaceMap.SURFACE_MAP_SCHEMA,
    mode: includeAll ? "all" : "diagnostic-advisory",
    postures: surfaceMap.SURFACE_POSTURES,
    visibilityLevels: surfaceMap.SURFACE_VISIBILITY_LEVELS,
    readinessLevels: surfaceMap.SURFACE_READINESS_LEVELS,
    summary: {
      listed: surfaceMap.summarizeSurfaceMap(surfaces),
      catalog: surfaceMap.summarizeSurfaceMap(allSurfaces),
    },
    surfaces,
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("illuci surfaces - " + payload.mode + " view");
  console.log("  listed: " + payload.summary.listed.total + " / catalog: " + payload.summary.catalog.total);
  console.log("  postures: " + Object.entries(payload.summary.listed.byPosture).map(([k, v]) => k + "=" + v).join(", "));
  console.log("  readiness: " + Object.entries(payload.summary.listed.byReadiness).map(([k, v]) => k + "=" + v).join(", "));
  for (const entry of surfaces) {
    const bearing = entry.loadBearing ? "load-bearing" : "advisory";
    console.log("  " + entry.id + " [" + entry.posture + ", " + entry.readiness + ", " + bearing + "]");
    console.log("    visibility: " + entry.visibility);
    console.log("    paths: " + entry.paths.join(", "));
    console.log("    evidence: " + entry.evidence);
    console.log("    pruneAction: " + entry.pruneAction);
    if (entry.next) console.log("    next: " + entry.next);
  }
}

// [surface-context probe / capability card] illuci self-describes to a host agent
// (Claude/Codex/Grok/Cursor) or human: what it is, how to invoke it over CLI/MCP/API,
// and what is gated/off plus the one-line control to turn it on. Disclosure only —
// it flips nothing and grounds entirely in source-owned catalogs.
async function cmdDescribe(rest) {
  const wantJson = rest.includes("--json");
  const mod = await import("../core/surface/capability-card.js");
  if (wantJson) {
    console.log(JSON.stringify(mod.buildCapabilityCard(), null, 2));
    return;
  }
  console.log(mod.renderCapabilityCard());
}

function cliGit(args, label = "git") {
  const result = spawnSync("git", args, { encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${label} failed`).trim());
  }
  return result.stdout;
}

function splitCsv(value) {
  if (!value || value === true) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function numberFlag(flags, key, fallback = 0) {
  if (flags[key] === undefined || flags[key] === true) return fallback;
  const n = Number(flags[key]);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function optionalFlag(flags, key) {
  return flags[key] && flags[key] !== true ? String(flags[key]) : null;
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(String(path), "utf8"));
  } catch (err) {
    console.error(`${label}: ${err.message}`);
    process.exit(1);
  }
}

async function cmdPrClassify(rest) {
  const { flags } = parseFlags(rest);
  const base = optionalFlag(flags, "base") || "origin/main";
  const diffOutput = flags["numstat-file"] && flags["numstat-file"] !== true
    ? readFileSync(String(flags["numstat-file"]), "utf8")
    : cliGit(["diff", "--numstat", "--find-renames", `${base}...HEAD`], "illuci pr classify diff");
  const {
    appendPrClassificationTrace,
    buildPrClassificationRecord,
    parseNumstat,
  } = await import("../core/governance/gitops/pr-classification.js");

  const record = buildPrClassificationRecord({
    source: "illuci.cli.pr.classify",
    prNumber: optionalFlag(flags, "pr-number"),
    title: optionalFlag(flags, "title"),
    url: optionalFlag(flags, "url"),
    repository: optionalFlag(flags, "repository"),
    baseRef: optionalFlag(flags, "base-ref"),
    headRef: optionalFlag(flags, "head-ref"),
    baseSha: optionalFlag(flags, "base-sha"),
    headSha: optionalFlag(flags, "head-sha"),
    labels: [...splitCsv(flags.labels), ...splitCsv(flags.label)],
    changedFiles: parseNumstat(diffOutput),
    mergeStateStatus: optionalFlag(flags, "merge-state"),
    requestedStrategy: optionalFlag(flags, "requested-strategy"),
    isDraftPr: Boolean(flags.draft),
    pendingCheckCount: numberFlag(flags, "pending-checks", 0),
    failingCheckCount: numberFlag(flags, "failing-checks", 0),
    reviewUnitCount: numberFlag(flags, "review-units", 1),
    batchCount: numberFlag(flags, "batches", 1),
    localBranchAheadOfRemote: numberFlag(flags, "local-ahead", 0),
    hasUnpushedLocalCommits: Boolean(flags["unpushed-local"]),
    operatorRatifiedLargeDiff: Boolean(flags["ratify-large-diff"]),
    operatorRatifiedSurfaceSpan: Boolean(flags["ratify-surface-span"]),
    operatorRatifiedMissingCompanions: Boolean(flags["ratify-missing-companions"]),
    operatorRatifiedTestGap: Boolean(flags["ratify-test-gap"]),
    operatorRatifiedAggregate: Boolean(flags["ratify-aggregate"]),
    operatorRatifiedStrategy: Boolean(flags["ratify-strategy"]),
    commitsAreIndependentlyReviewable: Boolean(flags["independent-commits"]),
    preserveCommitSeries: Boolean(flags["preserve-commit-series"]),
    repositoryAllowsSquash: flags["no-squash"] ? false : true,
    repositoryAllowsRebase: flags["no-rebase"] ? false : true,
    repositoryAllowsMergeCommit: Boolean(flags["allow-merge-commit"]),
  });

  let trace = null;
  if (flags["write-trace"] || flags.trace) trace = appendPrClassificationTrace(record);

  if (flags.json) {
    console.log(JSON.stringify(trace ? { ...record, trace } : record, null, 2));
    return;
  }

  console.log("illuci pr classify - " + (record.subject.prNumber ? `PR #${record.subject.prNumber}` : "working diff"));
  console.log("  shape: " + record.verdicts.prShape.code + " / " + record.verdicts.prShape.riskBand);
  console.log("  readiness: " + record.verdicts.mergeReadiness.code + " / " + record.verdicts.mergeReadiness.riskBand);
  console.log("  strategy: " + record.verdicts.mergeStrategy.strategy + " / " + record.verdicts.mergeStrategy.code);
  console.log("  auto-merge: " + (record.automation.eligible ? `eligible (${record.automation.strategy})` : `blocked (${record.automation.blockedBy.join(", ") || "none"})`));
  console.log("  next: " + record.outcome.next);
  if (trace) console.log("  trace: " + trace.displayPath);
}

async function cmdPrAutoMerge(rest) {
  const { flags, positional } = parseFlags(rest);
  const snapshotPath = optionalFlag(flags, "snapshot-file");
  const snapshot = snapshotPath ? readJsonFile(snapshotPath, "illuci pr auto-merge --snapshot-file") : null;
  const prInput = positional[0] || optionalFlag(flags, "pr") || optionalFlag(flags, "number") || optionalFlag(flags, "url");
  const repository = optionalFlag(flags, "repo") || optionalFlag(flags, "repository") || process.env.GITHUB_REPOSITORY || snapshot?.repository?.nameWithOwner;
  const {
    formatPrAutomationResult,
    parsePullRequestNumber,
    requestPrAutoMerge,
  } = await import("../core/governance/gitops/pr-automation.js");

  const prNumber = snapshot?.pullRequest?.number || parsePullRequestNumber(prInput);
  if (!snapshot && (!repository || !prNumber)) {
    console.error("usage: illuci pr auto-merge <number|url> --repo owner/name [--dry-run] [--json] [--write-trace]");
    process.exit(1);
  }

  const result = await requestPrAutoMerge({
    snapshot,
    repository,
    prNumber,
    token: optionalFlag(flags, "token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    policyToken: process.env.ILLUCI_GITOPS_TOKEN || optionalFlag(flags, "token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    apiUrl: optionalFlag(flags, "api-url") || process.env.GITHUB_API_URL,
    graphqlUrl: optionalFlag(flags, "graphql-url") || process.env.GITHUB_GRAPHQL_URL,
    dryRun: Boolean(flags["dry-run"]),
    writeTrace: Boolean(flags["write-trace"] || flags.trace),
    source: "illuci.cli.pr.auto-merge",
  });

  if (flags.json) {
    console.log(JSON.stringify(result.trace ? { ...result.record, trace: result.trace } : result.record, null, 2));
    return;
  }

  console.log(formatPrAutomationResult(result).trimEnd());
}

async function cmdPrOutcome(rest) {
  const subverb = rest[0] || "collect";
  const { flags, positional } = parseFlags(rest.slice(1));
  const {
    auditPrOutcomeCorpusContinuity,
    backfillPrOutcomes,
    collectPrOutcome,
    formatPrOutcomeCorpusContinuity,
    formatPrOutcomeResult,
    parseOutcomePrNumber,
  } = await import("../core/governance/gitops/pr-outcome.js");

  const snapshotPath = optionalFlag(flags, "snapshot-file");
  const snapshot = snapshotPath ? readJsonFile(snapshotPath, "illuci pr outcome --snapshot-file") : null;
  const repository = optionalFlag(flags, "repo") || optionalFlag(flags, "repository") || process.env.GITHUB_REPOSITORY || snapshot?.repository?.nameWithOwner;
  const token = optionalFlag(flags, "token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const policyToken = process.env.ILLUCI_GITOPS_TOKEN || token;
  const shared = {
    repository,
    token,
    policyToken,
    apiUrl: optionalFlag(flags, "api-url") || process.env.GITHUB_API_URL,
    graphqlUrl: optionalFlag(flags, "graphql-url") || process.env.GITHUB_GRAPHQL_URL,
    writeTrace: Boolean(flags["write-trace"] || flags.trace),
    promoteCorpus: Boolean(flags["promote-corpus"]),
    dryRun: Boolean(flags["dry-run"]),
    source: "illuci.cli.pr.outcome",
  };

  if (subverb === "collect") {
    const prInput = positional[0] || optionalFlag(flags, "pr") || optionalFlag(flags, "number") || optionalFlag(flags, "url");
    const prNumber = snapshot?.pullRequest?.number || parseOutcomePrNumber(prInput);
    if (!snapshot && (!repository || !prNumber)) {
      console.error("usage: illuci pr outcome collect <number|url> --repo owner/name [--json] [--write-trace] [--promote-corpus] [--dry-run]");
      process.exit(1);
    }
    const result = await collectPrOutcome({
      ...shared,
      snapshot,
      prNumber,
      sourceEvent: optionalFlag(flags, "source-event") || "cli",
      attemptKey: optionalFlag(flags, "attempt-key") || null,
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatPrOutcomeResult(result).trimEnd());
    return;
  }

  if (subverb === "backfill") {
    if (!flags.terminal) {
      console.error("usage: illuci pr outcome backfill --repo owner/name --terminal [--json] [--write-trace] [--promote-corpus] [--dry-run]");
      process.exit(1);
    }
    if (!repository) {
      console.error("illuci pr outcome backfill: --repo owner/name is required");
      process.exit(1);
    }
    const prs = optionalFlag(flags, "terminal-file")
      ? readJsonFile(optionalFlag(flags, "terminal-file"), "illuci pr outcome backfill --terminal-file")
      : null;
    const result = await backfillPrOutcomes({
      ...shared,
      snapshot,
      prs,
      sourceEvent: "cli-backfill",
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`illuci pr outcome backfill: ${result.total} terminal PR(s), ${result.outcomes.length} outcome record(s)`);
    return;
  }

  if (subverb === "audit") {
    const prs = optionalFlag(flags, "terminal-file")
      ? readJsonFile(optionalFlag(flags, "terminal-file"), "illuci pr outcome audit --terminal-file")
      : null;
    if (!prs && !repository) {
      console.error("usage: illuci pr outcome audit --repo owner/name [--json] [--terminal-file path] [--corpus-root path]");
      process.exit(1);
    }
    if (!prs && !token) {
      console.error("illuci pr outcome audit: GITHUB_TOKEN, GH_TOKEN, or --token is required for live terminal PR lookup");
      process.exit(1);
    }
    const result = await auditPrOutcomeCorpusContinuity({
      ...shared,
      prs,
      corpusRoot: optionalFlag(flags, "corpus-root") || undefined,
      source: "illuci.cli.pr.outcome.audit",
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatPrOutcomeCorpusContinuity(result).trimEnd());
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.error("usage: illuci pr outcome <collect|backfill|audit> ...");
  process.exit(1);
}

async function cmdGitopsDoctor(rest) {
  const { flags } = parseFlags(rest);
  const snapshotPath = optionalFlag(flags, "snapshot-file");
  const snapshot = snapshotPath ? readJsonFile(snapshotPath, "illuci gitops doctor --snapshot-file") : null;
  const repository = optionalFlag(flags, "repo") ||
    optionalFlag(flags, "repository") ||
    process.env.GITHUB_REPOSITORY ||
    snapshot?.repository?.nameWithOwner ||
    snapshot?.repository ||
    snapshot?.subject?.repository;
  if (!repository) {
    console.error("usage: illuci gitops doctor --repo owner/name [--base main] [--json] [--write-trace]");
    process.exit(1);
  }

  const {
    checkGitopsTokenReadiness,
    formatGitopsTokenReadinessResult,
  } = await import("../core/governance/gitops/token-readiness.js");

  const result = await checkGitopsTokenReadiness({
    snapshot,
    repository,
    baseRef: optionalFlag(flags, "base") || optionalFlag(flags, "base-ref") || "main",
    policyToken: process.env.ILLUCI_GITOPS_TOKEN,
    corpusToken: process.env.ILLUCI_GITOPS_CORPUS_TOKEN,
    mutationToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    apiUrl: optionalFlag(flags, "api-url") || process.env.GITHUB_API_URL,
    writeTrace: Boolean(flags["write-trace"] || flags.trace),
    source: "illuci.cli.gitops.doctor",
  });

  if (flags.json) {
    console.log(JSON.stringify(result.trace ? { ...result.record, trace: result.trace } : result.record, null, 2));
  } else {
    console.log(formatGitopsTokenReadinessResult(result).trimEnd());
  }

  if (!result.record.action.ready) process.exitCode = 2;
}

function gitOutput(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (allowFailure) return null;
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout.trimEnd();
}

function gitOk(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function cleanRefSegment(value) {
  return String(value || "mirror")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "mirror";
}

function remoteNames() {
  const out = gitOutput(["remote"], { allowFailure: true });
  return out ? out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function parseMirrorSpec(spec) {
  const raw = String(spec || "").trim();
  const eq = raw.indexOf("=");
  if (eq > 0) {
    return {
      name: raw.slice(0, eq).trim(),
      target: raw.slice(eq + 1).trim(),
    };
  }
  return { name: raw, target: raw };
}

function remoteUrlFor(target) {
  return gitOutput(["remote", "get-url", target], { allowFailure: true }) || target;
}

function lsRemoteHead(target, branch) {
  const out = gitOutput(["ls-remote", target, `refs/heads/${branch}`], { allowFailure: true });
  const first = out ? out.split(/\r?\n/).find(Boolean) : "";
  const sha = first.split(/\s+/)[0] || "";
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
}

function fetchMirrorRef(target, branch, refName) {
  const refspec = `+refs/heads/${branch}:${refName}`;
  const out = gitOutput(["fetch", target, refspec], { allowFailure: true });
  return out !== null;
}

function revParse(ref) {
  const out = gitOutput(["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
  return out && /^[0-9a-f]{7,40}$/i.test(out.trim()) ? out.trim().toLowerCase() : null;
}

function revCount(range) {
  const out = gitOutput(["rev-list", "--count", range], { allowFailure: true });
  const n = Number(out);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function shortLog(range, maxCommits) {
  const out = gitOutput(["log", "--oneline", `-${maxCommits}`, range], { allowFailure: true });
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([0-9a-f]{7,40})\s+(.*)$/i);
    return match ? { sha: match[1].toLowerCase(), subject: match[2] } : { sha: null, subject: line };
  });
}

function readMirrorSnapshot({ name, target, branch, fetch }) {
  const safeName = cleanRefSegment(name);
  const safeBranch = cleanRefSegment(branch);
  const localRef = `refs/illuci/mirror-reconciliation/${safeName}/${safeBranch}`;
  const remoteUrl = remoteUrlFor(target);
  const fetched = fetch ? fetchMirrorRef(target, branch, localRef) : false;
  const fetchedHead = fetched ? revParse(localRef) : null;
  const remoteHead = fetchedHead || lsRemoteHead(target, branch);
  return {
    name,
    ref: branch,
    remoteUrl,
    headSha: remoteHead,
    localRef: fetchedHead ? localRef : null,
    gitEvidenceAvailable: Boolean(fetchedHead),
  };
}

function addMirrorRelationshipFacts(authoritative, mirror, maxCommits) {
  if (!authoritative.localRef || !mirror.localRef) {
    return {
      ...mirror,
      gitEvidenceAvailable: false,
    };
  }
  const authorityRef = authoritative.localRef;
  const mirrorRef = mirror.localRef;
  return {
    ...mirror,
    gitEvidenceAvailable: true,
    isAncestorOfAuthoritative: gitOk(["merge-base", "--is-ancestor", mirrorRef, authorityRef]),
    authoritativeIsAncestorOfMirror: gitOk(["merge-base", "--is-ancestor", authorityRef, mirrorRef]),
    isTreeEquivalentToAuthoritative: gitOk(["diff", "--quiet", `${authorityRef}..${mirrorRef}`]),
    uniqueMirrorCommitCount: revCount(`${authorityRef}..${mirrorRef}`),
    uniqueAuthoritativeCommitCount: revCount(`${mirrorRef}..${authorityRef}`),
    uniqueMirrorCommits: shortLog(`${authorityRef}..${mirrorRef}`, maxCommits),
    uniqueAuthoritativeCommits: shortLog(`${mirrorRef}..${authorityRef}`, maxCommits),
  };
}

async function cmdGitopsMirrors(rest) {
  const { flags } = parseFlags(rest);
  const branch = optionalFlag(flags, "branch") || optionalFlag(flags, "ref") || "main";
  const primarySpec = parseMirrorSpec(optionalFlag(flags, "primary") || optionalFlag(flags, "authoritative") || "zero");
  const configuredRemotes = remoteNames();
  const mirrorSpecText = optionalFlag(flags, "mirrors") || optionalFlag(flags, "mirror");
  const mirrorSpecs = (mirrorSpecText
    ? splitCsv(mirrorSpecText)
    : configuredRemotes.filter((remote) => remote !== primarySpec.target && remote !== primarySpec.name)
  ).map(parseMirrorSpec);
  const fetch = !flags["no-fetch"];
  const maxCommits = Math.max(1, Math.min(100, Number(optionalFlag(flags, "max-commits") || 12) || 12));

  const {
    classifyMirrorSet,
    formatMirrorSet,
  } = await import("../core/governance/gitops/mirror-reconciliation.js");

  const authoritative = readMirrorSnapshot({
    name: primarySpec.name,
    target: primarySpec.target,
    branch,
    fetch,
  });
  const mirrors = mirrorSpecs.map((spec) => {
    const snapshot = readMirrorSnapshot({
      name: spec.name,
      target: spec.target,
      branch,
      fetch,
    });
    return addMirrorRelationshipFacts(authoritative, snapshot, maxCommits);
  });
  const report = classifyMirrorSet({ authoritative, mirrors });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMirrorSet(report).trimEnd());
  }
  if (!["aligned", "content-current"].includes(report.summary.status)) process.exitCode = 2;
}

async function cmdGitops(rest) {
  const subverb = rest[0];
  if (subverb === "doctor") return cmdGitopsDoctor(rest.slice(1));
  if (subverb === "mirrors" || subverb === "mirror") return cmdGitopsMirrors(rest.slice(1));
  console.error("usage: illuci gitops <doctor|mirrors> ...");
  process.exit(1);
}

async function cmdSandbox(rest) {
  const subverb = rest[0];
  if (subverb === "sweep") return cmdSandboxSweep(rest.slice(1));
  console.error("usage: illuci sandbox <sweep> ...");
  process.exit(1);
}

async function cmdSandboxSweep(rest) {
  const { flags } = parseFlags(rest);
  const unknownFlag = Object.keys(flags).find(
    (name) => !["older-than-hours", "dry-run", "json"].includes(name),
  );
  if (unknownFlag) {
    console.error(`unknown option: --${unknownFlag}`);
    process.exit(1);
  }
  enforceFlagValueContract(flags, "illuci sandbox sweep", {
    valueFlags: ["older-than-hours"],
    booleanFlags: ["dry-run", "json"],
  });

  const {
    CLI_SANDBOX_SWEEP_DEFAULT_OLDER_THAN_MS,
    defaultCliSandboxRoot,
    sweepCliLaneSandboxes,
  } = await import("../core/bridges/cli-sandbox.js");

  const rawOlderThanHours = optionalFlag(flags, "older-than-hours");
  let olderThanMs = CLI_SANDBOX_SWEEP_DEFAULT_OLDER_THAN_MS;
  if (rawOlderThanHours !== null) {
    const hours = Number(rawOlderThanHours);
    const converted = hours * 60 * 60 * 1000;
    if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(converted) || converted <= 0) {
      console.error("--older-than-hours requires a finite number greater than 0");
      process.exit(1);
    }
    olderThanMs = converted;
  }

  const dryRun = Boolean(flags["dry-run"]);
  const json = Boolean(flags.json);

  // CLI intentionally has no root override; production uses the default root.
  // Tests remap the spawned process's OS temp variables before CLI load,
  // so defaultCliSandboxRoot() resolves inside the isolated fixture.
  const root = defaultCliSandboxRoot();
  const result = sweepCliLaneSandboxes({ olderThanMs, dryRun });
  const output = {
    schema: "illuci.cli.sandbox-sweep/1",
    root,
    olderThanMs,
    dryRun,
    swept: result.swept,
    kept: result.kept,
    errors: result.errors,
  };

  if (json) {
    console.log(JSON.stringify(output));
  } else {
    console.log(
      `Sandbox sweep${dryRun ? " (dry run)" : ""}: ${output.swept.length} swept, ${output.kept.length} kept, ${output.errors.length} errors.`,
    );
    for (const error of output.errors) {
      console.error(`${error.name}: ${error.message}`);
    }
  }

  process.exitCode = output.errors.length > 0 ? 1 : 0;
}

async function cmdWorktree(rest) {
  const subverb = rest[0];
  if (subverb === "sweep") return cmdWorktreeSweep(rest.slice(1));
  console.error("usage: illuci worktree <sweep> ...");
  process.exit(1);
}

async function cmdWorktreeSweep(rest) {
  const { flags } = parseFlags(rest);
  const known = ["repo", "against", "min-age-days", "min-behind", "apply", "quarantine-and-sweep", "quarantine-root", "branches", "json"];
  const unknownFlag = Object.keys(flags).find((name) => !known.includes(name));
  if (unknownFlag) {
    console.error(`unknown option: --${unknownFlag}`);
    process.exit(1);
  }
  enforceFlagValueContract(flags, "illuci worktree sweep", {
    valueFlags: ["repo", "against", "min-age-days", "min-behind", "quarantine-root"],
    booleanFlags: ["apply", "quarantine-and-sweep", "branches", "json"],
  });

  const { WORKTREE_SWEEP_DEFAULTS, sweepWorktrees } = await import(
    "../core/governance/gitops/worktree-sweep.js"
  );

  const numericFlag = (name, fallback) => {
    const raw = optionalFlag(flags, name);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`--${name} requires a finite number >= 0`);
      process.exit(1);
    }
    return n;
  };

  const report = sweepWorktrees({
    repoDir: optionalFlag(flags, "repo") || process.cwd(),
    againstRef: optionalFlag(flags, "against") || undefined,
    minAgeDays: numericFlag("min-age-days", WORKTREE_SWEEP_DEFAULTS.minAgeDays),
    minBehind: numericFlag("min-behind", WORKTREE_SWEEP_DEFAULTS.minBehind),
    apply: Boolean(flags.apply),
    quarantineAndSweep: Boolean(flags["quarantine-and-sweep"]),
    quarantineRoot: optionalFlag(flags, "quarantine-root") || undefined,
    branches: Boolean(flags.branches),
  });

  if (flags.json) {
    console.log(JSON.stringify(report));
  } else {
    const label = report.mode === "apply" ? "" : " (plan — pass --apply to execute)";
    console.log(`Worktree sweep against ${report.againstRef ?? "?"}${label}:`);
    for (const e of report.entries) {
      const where = e.branch ? ` [${e.branch}]` : e.detached ? " (detached)" : "";
      console.log(`  ${e.verdict.padEnd(16)} ${e.name}${where} — ${e.reasons.join("; ")}`);
    }
    const planned = report.entries.filter((e) => e.verdict === "sweep" || e.verdict === "quarantine-sweep").length;
    console.log(
      `  ${report.mode === "apply" ? "swept" : "sweepable"}: ${report.mode === "apply" ? report.swept.length : planned}, quarantined: ${report.quarantined.length}, links unlinked: ${report.reparseUnlinked.length}, branches ${report.mode === "apply" ? "deleted" : "cullable"}: ${report.branchesDeleted.length}, errors: ${report.errors.length}`,
    );
    for (const error of report.errors) console.error(`  ${error.name}: ${error.message}`);
  }
  process.exitCode = report.errors.length > 0 ? 1 : 0;
}

async function cmdInfrastructureDoctor(rest) {
  const { flags } = parseFlags(rest);
  const snapshotPath = optionalFlag(flags, "snapshot-file");
  const snapshot = snapshotPath ? readJsonFile(snapshotPath, "illuci infrastructure doctor --snapshot-file") : null;
  const platform = optionalFlag(flags, "platform") || optionalFlag(flags, "platforms") || (flags.all ? "all" : "github");
  const {
    checkInfrastructureAccountPosture,
    formatInfrastructureAccountPostureResult,
  } = await import("../core/infrastructure/account-posture.js");

  const result = await checkInfrastructureAccountPosture({
    snapshot,
    platforms: platform,
    writeTrace: Boolean(flags["write-trace"] || flags.trace),
    source: "illuci.cli.infrastructure.doctor",
    githubBillingAccount: optionalFlag(flags, "github-billing-account") || optionalFlag(flags, "account"),
    githubBillingKind: optionalFlag(flags, "github-billing-kind") || optionalFlag(flags, "account-kind"),
    githubApiUrl: optionalFlag(flags, "github-api-url") || optionalFlag(flags, "api-url") || process.env.GITHUB_API_URL,
    gitlabApiUrl: optionalFlag(flags, "gitlab-api-url") || process.env.GITLAB_API_URL || process.env.ILLUCI_GITLAB_API_URL,
    vercelApiUrl: optionalFlag(flags, "vercel-api-url") || process.env.VERCEL_API_URL,
    supabaseApiUrl: optionalFlag(flags, "supabase-api-url") || process.env.SUPABASE_API_URL,
    obsidianApiUrl: optionalFlag(flags, "obsidian-api-url") || process.env.OBSIDIAN_REST_API_URL,
  });

  const printable = { ...result };
  delete printable.recordsByPlatform;
  if (flags.json) {
    console.log(JSON.stringify(printable, null, 2));
  } else {
    console.log(formatInfrastructureAccountPostureResult(result).trimEnd());
  }
  if (!result.ok) process.exitCode = 2;
}

async function cmdInfrastructure(rest) {
  const subverb = rest[0];
  if (subverb === "doctor") return cmdInfrastructureDoctor(rest.slice(1));
  console.error("usage: illuci infrastructure doctor [--platform github,gitlab,vercel,supabase,obsidian|--all] [--json] [--write-trace]");
  process.exit(1);
}

async function cmdPr(rest) {
  const subverb = rest[0];
  if (subverb === "classify") return cmdPrClassify(rest.slice(1));
  if (subverb === "auto-merge" || subverb === "automerge") return cmdPrAutoMerge(rest.slice(1));
  if (subverb === "outcome") return cmdPrOutcome(rest.slice(1));
  console.error("usage: illuci pr <classify|auto-merge|outcome> ...");
  process.exit(1);
}

// [A50]/DR-130: the proactive default-disclosure reminder for `illuci run`. Marker
// under ILLUCI_DATA_HOME so the cadence (onboarding once + then daily) survives
// across invocations; failures are swallowed (a notice must never break a run).
async function maybeShowDefaultsNotice() {
  try {
    if (String(process.env.ILLUCI_QUIET_DEFAULTS || "").trim() === "1") return;
    const { join, dirname } = await import("node:path");
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { defaultsNotice, shouldShowNotice } = await import("../core/governance/defaults-registry.js");
    const dataHome = process.env.ILLUCI_DATA_HOME || join(homedir(), ".illuci", "data");
    const marker = join(dataHome, ".defaults-notice-shown");
    let lastShownMs = NaN;
    if (existsSync(marker)) { const n = Number(readFileSync(marker, "utf-8").trim()); if (Number.isFinite(n)) lastShownMs = n; }
    if (!shouldShowNotice({ lastShownMs, now: Date.now() })) return;
    console.error(defaultsNotice());
    try { mkdirSync(dirname(marker), { recursive: true }); writeFileSync(marker, String(Date.now())); } catch { /* best-effort */ }
  } catch { /* a disclosure notice never blocks a run */ }
}

// [A50]/DR-130: `illuci defaults` — disclose Illuci's active default posture (what runs
// unless you say otherwise, why, and how to change each). The disclosure surface
// the DR-130 law requires; also carried in the runtime capability response.
async function cmdDefaults(rest) {
  const { flags } = parseFlags(rest);
  const { defaultsSnapshot, renderDefaults } = await import("../core/governance/defaults-registry.js");
  if (flags.json) {
    console.log(JSON.stringify(defaultsSnapshot(), null, 2));
    return;
  }
  console.log(renderDefaults());
}

async function cmdMatrix(rest) {
  const { flags } = parseFlags(rest);
  const { MODEL_CAPABILITIES, getRoles } = await import("../core/matrix/capability-matrix.js");
  const models = Object.keys(MODEL_CAPABILITIES);
  const roles = getRoles();

  if (flags.json) {
    console.log(JSON.stringify({ models, roles, capabilities: MODEL_CAPABILITIES }, null, 2));
    return;
  }
  console.log(
    `illuci capability matrix — ${models.length} models × ${roles.length} roles ` +
      `(priority 1=point, 2=amplifier, 3=fallback):`,
  );
  for (const m of models) {
    console.log(`  ${m.padEnd(16)} ${Object.keys(MODEL_CAPABILITIES[m]).length} role(s)`);
  }
}

/**
 * illuci chat — REAL governed streaming dispatch.
 *
 * Single model:   illuci chat deepseek "message"          → streams that model
 * Concurrent:     illuci chat deepseek,glm,kimi "message"  → fans out (ollama-cloud
 *                 parallelization), NDJSON events interleaved + tagged by model
 *
 * Output is NDJSON on stdout (one JSON object per line) for machine consumption
 * (this is what OTL spawns + parses): { type:"start" } then { type:"delta",
 * model, text, reasoning } per token, then { type:"final", model, usage,
 * latency } (or { type:"error", model, error }). With --text and a single
 * model, the raw answer text is streamed instead (human use at a terminal).
 *
 * Routes through queryModelStream → governance + throttle → bridge.queryStream.
 */
async function cmdChat(rest) {
  const { flags, positional } = parseFlags(rest);
  const [modelArg, ...msgParts] = positional;
  if (!modelArg) {
    console.error('usage: illuci chat <model[,model2,...]> "<message>" [--raw] [--text]');
    console.error("models: deepseek | glm | kimi-cloud | qwen-code | gpt-oss | minimax | ollama | ...");
    process.exit(1);
  }
  const message = msgParts.join(" ").replace(/^"|"$/g, "");
  if (!message) {
    console.error("illuci chat: empty message");
    process.exit(1);
  }

  const models = modelArg.split(",").map((m) => m.trim()).filter(Boolean);
  const dispatchOpts = buildChatOptions(flags);
  // Apply illuci's per-agent disposition variables as a prepended
  // [Behavioral Disposition] block — the dimensional surface, not raw generation params.
  const sendMsg = await applyChatDisposition(message, flags);
  // --text only makes sense for a single stream; multi-model forces NDJSON so
  // interleaved tokens stay attributable.
  const textMode = !!flags.text && models.length === 1;

  const { queryModelStream } = await import("../core/dispatch/dispatch.js");

  const emit = (obj) => {
    if (textMode) {
      if (obj.type === "delta" && !obj.reasoning) process.stdout.write(obj.text);
    } else {
      process.stdout.write(JSON.stringify(obj) + "\n");
    }
  };

  if (models.length === 1) {
    const model = models[0];
    emit({ type: "start", model });
    let answerChars = 0;
    let sawError = false;
    for await (const ev of queryModelStream(model, sendMsg, dispatchOpts)) {
      if (ev.type === "delta" && !ev.reasoning) answerChars += String(ev.text || "").length;
      if (ev.type === "error" || ev.failed) sawError = true;
      emit({ ...ev, model });
    }
    // [A94]/DR-187 (F-130): an empty answer is a FAILURE shape, never a silent
    // success — the F-084 boundary-honesty law at the chat surface (live
    // repro: a model absent from the local daemon streamed nothing, exit 0).
    if (answerChars === 0) {
      if (textMode) process.stdout.write("\n");
      console.error(`illuci chat: ${model} returned no answer text${sawError ? " (the stream reported an error)" : ""} — empty output is a failure, not a success (F-130)`);
      process.exit(1);
    }
  } else {
    // Concurrent fan-out — the operator's "ollama-cloud parallelization". Each
    // model streams independently; events carry the requested alias so a
    // consumer can demultiplex.
    emit({ type: "start", models });
    await Promise.all(
      models.map(async (model) => {
        try {
          for await (const ev of queryModelStream(model, sendMsg, dispatchOpts)) {
            emit({ ...ev, model });
          }
        } catch (err) {
          emit({ type: "error", model, error: err.message });
        }
      }),
    );
  }

  if (textMode) process.stdout.write("\n");
}

/**
 * illuci models - gateway-backed model resource readout. Default output is
 * consumer-facing; --diagnostics includes raw Ollama backend inventory.
 * With --running, diagnostics include currently-loaded models (`/api/ps`).
 */
/**
 * illuci capabilities — the model-family capability spine for UI surfaces.
 * Lists every family with its selectable sub-models, reasoning/speed tier sets,
 * streaming + native-tool support, context window, and ultra/effort surface.
 * `--model <id>` returns the single resolved descriptor instead.
 */
async function cmdCapabilities(rest) {
  const { flags } = parseFlags(rest);
  const cap = await import("../core/bridges/capabilities.js");

  if (flags.model && flags.model !== true) {
    const desc = cap.getCapabilities(String(flags.model));
    if (flags.json) { console.log(JSON.stringify(desc, null, 2)); return; }
    console.log(`${desc.modelId} (${desc.family})`);
    console.log(`  streaming: ${desc.streaming}  nativeTools: ${desc.nativeTools}  context: ${desc.contextWindow}`);
    console.log(`  reasoning: ${desc.reasoning.supported ? desc.reasoning.tiers.join(" / ") + `  (default ${desc.reasoning.default}, via ${desc.reasoning.control})` : "—"}`);
    console.log(`  speed:     ${desc.speed.supported ? desc.speed.tiers.join(" / ") + `  (default ${desc.speed.default})` : "—"}`);
    if (desc.ultra?.available) console.log(`  ultra:     ${desc.ultra.label}`);
    return;
  }

  const families = cap.listFamilies();
  if (flags.json) { console.log(JSON.stringify({ families }, null, 2)); return; }
  for (const f of families) {
    console.log(`\n${f.label} (${f.family})`);
    console.log(`  streaming ${f.streaming} · nativeTools ${f.nativeTools} · context ${f.contextWindow}`);
    if (f.reasoning?.supported) console.log(`  reasoning: ${f.reasoning.tiers.join(" / ")}  (default ${f.reasoning.default}, via ${f.reasoning.control})`);
    if (f.speed?.supported) console.log(`  speed: ${f.speed.tiers.join(" / ")}`);
    if (f.ultra?.available) console.log(`  ultra: ${f.ultra.label}`);
    console.log(`  sub-models: ${f.subModels.map((s) => s.id).join(", ")}`);
  }
}

function formatModelResource(fleet, resource, diagnostics = false, identity = null) {
  const registryId = resource.diagnostics.registryId;
  const providers = resource.channels
    .map((channel) => fleet.getProviderResource(channel.providerResourceId)?.label || channel.providerResourceId)
    .filter((label, index, all) => label && all.indexOf(label) === index);
  const card = identity ? identity.modelIdentityCardFor(registryId) : null;
  return {
    id: resource.id,
    registryId,
    label: resource.label,
    family: resource.family,
    tier: resource.tier,
    modality: resource.modality || null,
    fleetUse: resource.fleetUse || null,
    capabilityLanes: [...(resource.capabilityLanes || [])],
    providers,
    identityCard: card ? identity.summarizeIdentityCard(card) : undefined,
    reasoning: resource.capabilities.reasoning?.default || null,
    controls: resource.controls || null,
    diagnostics: diagnostics ? {
      registryId,
      providerModel: resource.diagnostics.providerModel,
      providerKey: resource.diagnostics.providerKey,
      channels: resource.channels.map((channel) => ({
        id: channel.id,
        providerResourceId: channel.providerResourceId,
        bridge: channel.bridge,
        transport: channel.transport,
        providerModel: channel.diagnostics.providerModel,
      })),
    } : undefined,
  };
}

function doctorProbeOptions(flags) {
  const opts = {};
  const baseUrl = flags.endpoint || flags["base-url"];
  if (baseUrl && baseUrl !== true) opts.baseUrl = baseUrl;
  const timeout = flags["route-probe-timeout"] || flags["probe-timeout"];
  if (timeout && timeout !== true) {
    const parsed = Number(timeout);
    if (Number.isFinite(parsed) && parsed > 0) opts.routeProbeTimeoutMs = parsed;
  }
  return opts;
}
function formatDoctorLine(report) {
  const auth = report.auth?.present ? "auth ok" : "auth missing";
  const roles = report.roleCoverage?.roleCount ? report.roleCoverage.roleCount + " roles" : report.roleCoverage?.status || "no roles";
  return [
    report.requestedId + " -> " + (report.canonicalId || "unknown"),
    report.providerId || report.providerKey || "no-provider",
    report.transport || "no-transport",
    auth,
    report.liveness?.status || "unknown",
    roles,
  ].join(" | ");
}

async function cmdModelDoctor(flags, positional) {
  const { listModelDoctorReportsLive } = await import("../core/fleet/model-doctor.js");
  const rawTargets = positional.filter((item) => item !== "doctor");
  const flagTarget = flags.doctor && flags.doctor !== true ? String(flags.doctor) : null;
  const modelFlag = flags.model && flags.model !== true ? String(flags.model) : null;
  const targets = [...rawTargets, flagTarget, modelFlag]
    .filter(Boolean)
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  const reports = await listModelDoctorReportsLive(targets.length ? targets : null, doctorProbeOptions(flags));
  if (flags.json) {
    console.log(JSON.stringify({ models: reports }, null, 2));
    return;
  }
  console.log("Model routing doctor (" + reports.length + "):");
  for (const report of reports) {
    console.log("  " + formatDoctorLine(report));
    if (report.liveness?.lastError) console.log("    last: " + report.liveness.lastError);
    console.log("    fix: " + report.suggestedFix);
  }
}

async function cmdModelIdentity(flags, positional) {
  const identity = await import("./terminal/identity-cards.js");
  const design = await import("./terminal/design.js");
  const generateFlag = flags["generate-card"] || flags["generate-identity-card"];
  const cardFlag = flags["identity-card"] || flags.card;
  const fromFlag = generateFlag && generateFlag !== true ? generateFlag : cardFlag && cardFlag !== true ? cardFlag : null;
  const target = fromFlag || positional.find((item) => item !== "doctor" && item !== "identity-card" && item !== "generate-card");
  if (!target) {
    console.error("Usage: illuci models --identity-card <model-id> [--json] or illuci models --generate-card <model-id> [--force]");
    process.exit(1);
  }
  const card = generateFlag
    ? await identity.generateIdentityCardFor(target, { force: !!flags.force })
    : identity.modelIdentityCardFor(target, { preferGenerated: !!flags.generated });
  if (flags.json) {
    console.log(JSON.stringify({ identityCard: identity.summarizeIdentityCard(card), route: {
      requestedId: card.requestedId,
      canonicalId: card.canonicalId,
      publicModelId: card.publicModelId,
      providerId: card.providerId,
      provider: card.provider,
      transport: card.transport,
    } }, null, 2));
    return;
  }
  console.log(design.renderCompactModelCard(card, { color: process.stdout.isTTY }));
  if (generateFlag) console.log("\nSaved: " + identity.generatedIdentityCardPath(card.modelId));
}

async function cmdModels(rest) {
  const { flags, positional } = parseFlags(rest);
  if (flags.doctor || positional[0] === "doctor") return cmdModelDoctor(flags, positional);
  if (flags["identity-card"] || flags.card || flags["generate-card"] || flags["generate-identity-card"] || positional[0] === "identity-card") return cmdModelIdentity(flags, positional);
  const ollama = await import("../core/bridges/ollama.js");
  const fleet = await import("../core/fleet/resource-gateway.js");
  const identity = await import("./terminal/identity-cards.js");
  const design = await import("./terminal/design.js");
  const doctor = await import("../core/fleet/model-doctor.js");
  const includeDiagnostics = !!flags.diagnostics || !!flags.running || !!flags.endpoint || !!flags["base-url"];
  const opts = { running: !!flags.running };
  const baseUrl = flags.endpoint || flags["base-url"];
  if (baseUrl && baseUrl !== true) opts.baseUrl = baseUrl;

  const providerFlag = flags.provider || flags["provider-resource"];
  const provider = providerFlag && providerFlag !== true ? fleet.getProviderResource(providerFlag) : null;
  if (providerFlag && providerFlag !== true && !provider) {
    console.error("Unknown provider resource: " + providerFlag);
    process.exit(1);
  }

  const filter = provider ? { providerResourceId: provider.id } : {};
  const curated = fleet.listModelResources(filter).map((resource) => formatModelResource(fleet, resource, !!flags.diagnostics, identity));
  const doctorReports = includeDiagnostics
    ? await doctor.listModelDoctorReportsLive(curated.map((model) => model.registryId), doctorProbeOptions(flags))
    : doctor.listModelDoctorReports(curated.map((model) => model.registryId));
  const doctorById = new Map(doctorReports.map((report) => [report.canonicalId || report.requestedId, report]));

  let result = { models: [], curated };
  const shouldQueryOllama = includeDiagnostics && (!provider || provider.id.startsWith("provider.ollama.") || !!baseUrl || !!flags.running);
  if (shouldQueryOllama) {
    try {
      const live = await ollama.models(opts);
      result = { ...live, curated };
    } catch (err) {
      // Daemon asleep/unreachable - curated resources are still valid (no daemon needed).
      result.error = err.message;
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(includeDiagnostics ? result : { curated }, null, 2));
    return;
  }
  const label = provider ? provider.label : "All providers";
  console.log("Curated model resources (" + curated.length + ") - " + label + ":");
  for (const c of curated) {
    const card = identity.modelIdentityCardFor(c.registryId);
    const report = doctorById.get(c.registryId);
    const needsFix = report?.liveness?.status && report.liveness.status !== "presence-ok";
    console.log(design.renderCompactModelCard(card, {
      provider: report?.providerId || c.providers.join(", "),
      transport: report?.transport,
      liveness: report?.liveness?.status,
      suggestedFix: needsFix ? report.suggestedFix : null,
      color: process.stdout.isTTY,
    }).split("\n").map((line) => "  " + line).join("\n"));
    const details = [c.id, c.tier, c.reasoning ? "reasoning " + c.reasoning : null].filter(Boolean).join("  |  ");
    console.log("    resource: " + details);
    if (flags.diagnostics && c.diagnostics) {
      console.log("    dispatch " + c.diagnostics.registryId + " -> " + (c.diagnostics.providerModel || "provider-default"));
      for (const channel of c.diagnostics.channels) {
        console.log("    channel " + channel.id + " -> " + (channel.bridge || "?") + " / " + (channel.providerModel || "provider-default"));
      }
    }
  }
  console.log("");
  if (!includeDiagnostics) return;
  if (result.error) {
    console.log("Ollama daemon not reachable: " + result.error);
    return;
  }
  if (!result.models.length) {
    console.log("No models installed (or Ollama not reachable at this endpoint).");
    return;
  }
  const gb = (n) => (n ? (n / 1e9).toFixed(1) + "GB" : "?");
  console.log("Installed Ollama backend models (" + result.models.length + "):");
  for (const m of result.models) {
    console.log("  " + m.name + "  [" + m.alias + "]  " + (m.parameterSize || "?") + " " + (m.quantization || "") + "  " + gb(m.size));
  }
  if (result.running?.length) {
    console.log("\nLoaded now (" + result.running.length + "):");
    for (const m of result.running) {
      console.log("  " + m.name + "  vram=" + gb(m.sizeVram) + "  expires=" + (m.expiresAt || "?"));
    }
  }
}

async function cmdProviders(rest) {
  const { flags } = parseFlags(rest);
  const fleet = await import("../core/fleet/resource-gateway.js");
  const providers = fleet.listProviderResources().map((provider) => ({
    id: provider.id,
    label: provider.label,
    organization: provider.organization,
    class: provider.class,
    auth: provider.auth,
    modelCount: provider.modelCount,
    channelCount: provider.channelCount,
    diagnostics: flags.diagnostics ? { providerKey: provider.providerKey } : undefined,
  }));
  if (flags.json) {
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }
  console.log("Provider resources (" + providers.length + "):");
  for (const p of providers) {
    const details = [p.label + "  [" + p.id + "]", p.class, p.auth, "models " + p.modelCount, "channels " + p.channelCount].filter(Boolean).join("  |  ");
    console.log("  " + details);
    if (flags.diagnostics && p.diagnostics) console.log("    provider key " + (p.diagnostics.providerKey || "n/a"));
  }
}

/**
 * illuci runtime [identity|capability|doctor] — [A22.1] Illuci Runtime service introspection.
 *
 * Answers "what runtime am I connected to / what can I call / is it current" deterministically,
 * for a client that need not hold a local checkout. No secrets cross this surface (auth MODES only).
 */
async function cmdGrants(rest) {
  // CAP-1 (DR-125): first-class capability-grant records — issue / list / verify /
  // revoke, every mutating act SSH-signed against the committed allowed_signers registry.
  const sub = rest[0] && !rest[0].startsWith("-") ? rest[0] : "list";
  const { flags } = parseFlags(rest);
  const mgr = await import("../core/governance/grants/manager.js");

  if (sub === "add") {
    const rec = mgr.issueGrant({
      layer: flags.layer,
      subjectId: flags.subject,
      capability: flags.capability,
      grantorName: flags["grantor-name"] || "operator",
      grantorPrincipal: flags["grantor-principal"] || "contributor@example.com",
      expiresAt: typeof flags.expires === "string" ? flags.expires : null,
      polarity: flags.deny ? "deny" : "grant",
    });
    console.log(flags.json ? JSON.stringify(rec, null, 2) : `Granted ${rec.id}  ${rec.layer}/${rec.subject.id}  ${rec.capability}  [signed:${rec.signature.kind}]`);
    return;
  }
  if (sub === "revoke") {
    const id = rest[1] && !rest[1].startsWith("-") ? rest[1] : null;
    if (!id) { console.error("usage: illuci grants revoke <grant-id> --reason \"...\" [--by <who>]"); process.exit(2); }
    const rec = mgr.revokeGrant(id, { revokedBy: flags.by || "operator", reason: flags.reason });
    console.log(flags.json ? JSON.stringify(rec, null, 2) : `Revoked ${rec.id}  (${rec.revocation.reason})  [signed:${rec.revocation.signature.kind}]`);
    return;
  }
  if (sub === "verify") {
    const id = rest[1] && !rest[1].startsWith("-") ? rest[1] : null;
    const { findGrant } = await import("../core/governance/grants/store.js");
    const rec = id ? findGrant(id) : null;
    if (!rec) { console.error(`grant ${id || "(missing id)"} not found`); process.exit(2); }
    const v = mgr.verifyGrant(rec);
    console.log(flags.json ? JSON.stringify({ id: rec.id, ...v }, null, 2) : `${rec.id}  grant:${v.grantSignature}  revocation:${v.revocationSignature}`);
    if (v.grantSignature !== "verified") process.exit(1);
    return;
  }
  // list (default)
  const { summarizeGrant } = await import("../core/governance/grants/registry.js");
  const grants = mgr.listGrants({
    layer: typeof flags.layer === "string" ? flags.layer : undefined,
    subjectId: typeof flags.subject === "string" ? flags.subject : undefined,
    capability: typeof flags.capability === "string" ? flags.capability : undefined,
  });
  if (flags.json) { console.log(JSON.stringify(grants, null, 2)); return; }
  if (grants.length === 0) { console.log("No capability grants recorded."); return; }
  for (const g of grants) console.log(summarizeGrant(g));
}

async function cmdRuntime(rest) {
  const sub = rest[0] && !rest[0].startsWith("-") ? rest[0] : "doctor";
  const { flags } = parseFlags(rest);

  if (sub === "serve") {
    // [A22.2] start the runtime as a remotely-reachable HTTP service.
    const { startHttpTransport } = await import("../core/runtime/http-transport.js");
    const port = Number(flags.port) || Number(process.env.ILLUCI_RUNTIME_PORT) || 7473;
    const token = typeof flags.token === "string" ? flags.token : (process.env.ILLUCI_RUNTIME_TOKEN || null);
    const tenant = typeof flags.tenant === "string" ? flags.tenant : "default";
    // [A22.6] --host binds the listener for off-box reach (deploy needs LAN, e.g. 0.0.0.0);
    // default stays 127.0.0.1 (loopback) so an accidental serve is never exposed.
    const host = typeof flags.host === "string" ? flags.host : (process.env.ILLUCI_RUNTIME_HOST || "127.0.0.1");
    if (host !== "127.0.0.1" && host !== "localhost" && !token) {
      console.error(`refusing to bind a non-loopback host (${host}) with auth=OPEN — pass --token or ILLUCI_RUNTIME_TOKEN so the exposed service is not credential-free.`);
      process.exit(2);
    }
    const svc = await startHttpTransport({ port, host, tenantId: tenant, token });
    console.log(`Illuci runtime service on ${svc.url}  (host=${host}, tenant=${tenant}, auth=${token ? "bearer-token" : "OPEN dev-mode"})`);
    console.log(`  GET ${svc.url}/runtime/{identity,capability,doctor}  |  POST ${svc.url}/mcp  |  GET ${svc.url}/health`);
    const stop = () => { svc.close().then(() => process.exit(0)); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return new Promise(() => {}); // run until signalled
  }

  if (sub === "connect") {
    // [A22.3.3] configure your own auth: illuci runtime connect list|add|revoke
    const mgr = await import("../core/connections/manager.js");
    const action = rest[1] && !rest[1].startsWith("-") ? rest[1] : "list";
    const tenant = typeof flags.tenant === "string" ? flags.tenant : null;
    if (action === "add") {
      const conn = mgr.addConnection({
        connectionId: flags["connection-id"], tenant, provider: flags.provider,
        authMethod: flags.auth || "api-key", secretRef: flags["secret-ref"],
        sshIdentityRef: flags["ssh-ref"], scopes: flags.scopes ? String(flags.scopes).split(",") : undefined,
      });
      console.log(flags.json ? JSON.stringify(conn, null, 2) : `Added ${conn.connectionId}  ${conn.provider}  ${conn.authMethod}  [${conn.status}]`);
      return;
    }
    if (action === "revoke") {
      const conn = mgr.revokeTenantConnection(flags["connection-id"]);
      console.log(flags.json ? JSON.stringify(conn, null, 2) : `Revoked ${conn.connectionId}  [${conn.status}]`);
      return;
    }
    const conns = mgr.listTenantConnections(tenant);
    if (flags.json) { console.log(JSON.stringify({ connections: conns }, null, 2)); return; }
    console.log(`Connections${tenant ? " for tenant=" + tenant : ""} (${conns.length}):`);
    for (const c of conns) console.log(`  ${c.connectionId}  ${c.provider}  ${c.authMethod}  [${c.status}]`);
    return;
  }

  const { getRuntimeIdentity } = await import("../core/runtime/identity.js");
  const { getRuntimeCapability } = await import("../core/runtime/capability.js");
  const { runtimeDoctor } = await import("../core/runtime/doctor.js");

  const out = sub === "identity" ? getRuntimeIdentity()
    : sub === "capability" ? getRuntimeCapability()
    : runtimeDoctor();

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (sub === "identity") {
    console.log(`Illuci runtime ${out.runtimeId}  v${out.version}  (schema ${out.schemaVersion})`);
    console.log(`  source: ${out.source.rev || "n/a"} [${out.source.from}]${out.source.dirty ? " (dirty)" : ""}`);
  } else if (sub === "capability") {
    const c = out.counts;
    console.log(`Illuci runtime capability (schema ${out.schema}):`);
    console.log(`  providers ${c.providers} | models ${c.models} | topologies ${c.topologies} | roles ${c.roles} | skill-frameworks ${c.skillFrameworks}`);
    console.log(`  auth modes: ${out.authModes.join(", ")}`);
  } else {
    console.log(`Illuci runtime doctor: ${out.status.toUpperCase()}  (${out.identity.runtimeId} v${out.identity.version})`);
    for (const ck of out.checks) console.log(`  ${ck.ok ? "ok " : "XX "} ${ck.name}${ck.detail ? "  — " + ck.detail : ""}`);
    console.log(`  source: ${out.current.rev || "n/a"} [${out.current.sourceFrom}]${out.current.dirty ? " (dirty)" : ""}`);
  }
}

/**
 * illuci run — REAL topology dispatch.
 *
 * Drives the topology runner: seats models into a topology, runs its phases
 * (respond / write / read / execute) through the gated tool bridge, returns a
 * full execution trace. Models come from the operator's fleet (Ollama cloud +
 * local, gemini-local CLI); the harness is illuci's own — NOT a wrapped third-party
 * agent.
 *
 * Lineup sources (merged): --lineup '{json}', per-seat flags (--architect gemini-local
 * --implementer kimi-cloud,...). Empty seats auto-fill from the capability matrix.
 */
async function cmdRun(rest) {
  const { flags, positional } = parseFlags(rest);
  const [topology, ...taskParts] = positional;
  if (!topology) {
    console.error('usage: illuci run <topology> "<task>" [--<seat> model[,model]] [--lineup \'{json}\'] [--agents \'{json}\'] [--run-control \'{json}\'] [--agenda conducted|derived|ritual] [--mutation-authority gated|blocked] [--tool-autonomy directed|checkpointed|governed|autonomous] [--workspace-context auto|minimal|off] [--genome-project-dir PATH] [--genome-precedence seed|dominant|pull] [--genome-seal-threshold N] [--genome-child-identity none|inherit|derive|explicit] [--genome-grading-sources tension[,salient][,behavioral]] [--num-predict N] [--timeout MS] [--reasoning TIER] [--think|--no-think] [--cognitive-controls] [--harness-model MODEL] [--prefer-harness] [--json]');
    console.error('  empty lineup -> seats auto-fill from the capability matrix');
    console.error('  --run-control   canonical run-control envelope: agenda, execution mutation authority, and tool autonomy');
    console.error('  --mutation-authority blocked  runs mutating phase effects as non-mutating council output');
    console.error('  --tool-autonomy L  directed (default) | checkpointed | governed | autonomous');
    console.error('  --workspace-context MODE  seat prompt access posture: auto (default) | minimal | off');
    console.error('  --preflight M   readiness gate: off | config (validate presets/budget) | probe (also test each seat is live) ([A49]/DR-129)');
    console.error('  --genome-project-dir PATH  arm the persona-genome (DR-182): seated agents compose from + learn into <PATH>/.illuci/data/memory/personas/<agentId>; requires --agents (or an org manifest) seating durable agentIds on preset seats');
    console.error('  --genome-child-identity S  what spawned children carry (DR-184/185): none (default) | inherit (manifest + genome thread) | derive (child personas fork from the parent persona) | explicit (spawn args carry their own identity)');
    console.error('  --num-predict N  lift the per-call completion cap (council deep-deliberation; default endpoint caps at 4096)');
    console.error('  --timeout MS     override the per-dispatch timeout race (default 180000 for "high" reasoning)');
    console.error('  example: illuci run dev-team "add a /health route" --architect gemini-local --implementer kimi-cloud --reviewer glm --qa deepseek');
    process.exit(1);
  }
  const task = taskParts.join(" ").replace(/^"|"$/g, "");
  if (!task) {
    console.error("illuci run: empty task");
    process.exit(1);
  }
  enforceFlagValueContract(flags, "illuci run", {
    valueFlags: [
      "lineup", "lineup-file", "agents", "agents-file", "permits", "permits-file",
      "run-control", "run-control-file", "agenda", "mutation-authority", "tool-autonomy",
      "workspace-context", "num-predict", "timeout", "reasoning", "harness-model",
      "preset", "profile", "role", "skills", "preflight",
      "genome-project-dir", "genome-precedence", "genome-seal-threshold", "genome-child-identity", "genome-grading-sources",
    ],
    booleanFlags: [
      "json", "raw", "yes", "y", "require-work-permit", "work-permit-required",
      "think", "no-think", "cognitive-controls", "prefer-harness", "no-workspace-context",
    ],
    allowDynamicValueFlags: true,
  });

  // [A50]/DR-130: the proactive default-disclosure reminder — at onboarding and
  // periodically (once/day), to stderr so it never pollutes --json output.
  // Suppressed by ILLUCI_QUIET_DEFAULTS=1. The user is made aware of the active
  // posture wherever they drive Illuci, without a nag on every run.
  await maybeShowDefaultsNotice();

  const { runTopology } = await import("../core/topologies/runner.js");
  const { TOPOLOGIES } = await import("../core/topologies/index.js");

  if (!TOPOLOGIES[topology]) {
    console.error(`illuci run: unknown topology "${topology}".`);
    console.error(`available: ${Object.keys(TOPOLOGIES).join(", ")}`);
    process.exit(1);
  }

  // Build the lineup (seat → model | [models]). --lineup JSON first, then per-seat
  // flags override. Seat ids are topology-specific; reserved flags are excluded.
  let lineup = {};
  if ((flags.lineup && flags.lineup !== true) || (flags["lineup-file"] && flags["lineup-file"] !== true)) {
    lineup = parseCliJsonFlag(flags, "lineup", "illuci run");
  }
  const RESERVED = new Set(["lineup", "lineup-file", "agents", "agents-file", "permits", "permits-file", "run-control", "run-control-file", "agenda", "mutation-authority", "tool-autonomy", "require-work-permit", "work-permit-required", "json", "raw", "yes", "y", "num-predict", "timeout", "reasoning", "think", "no-think", "cognitive-controls", "harness-model", "prefer-harness", "preset", "profile", "role", "skills", "workspace-context", "no-workspace-context", "preflight", "genome-project-dir", "genome-precedence", "genome-seal-threshold", "genome-child-identity", "genome-grading-sources"]);
  for (const [k, v] of Object.entries(flags)) {
    if (RESERVED.has(k) || v === true) continue;
    if (/-(preset|role|skills|profile)$/.test(k)) continue;
    const val = String(v);
    lineup[k] = val.includes(",") ? val.split(",").map((s) => s.trim()).filter(Boolean) : val;
  }

  // Generation + dispatch controls (council deep-deliberation surface).
  // The bridges already accept these; this exposes them through `illuci run`:
  //   --num-predict N  -> params.num_predict. The Ollama OpenAI-compat endpoint
  //                      defaults max_tokens to 4096, which truncates deep-reasoning
  //                      council runs (reasoning consumes the budget, answer empties).
  //                      Passing num_predict both lifts the cap AND auto-selects the
  //                      native endpoint (no 4096 default).
  //   --timeout MS     -> timeoutMs. Overrides the per-dispatch reasoning-tier timeout
  //                      race (default 180000 for "high"), which otherwise aborts long
  //                      reasoning. Also flows to the bridge fetch's AbortSignal.
  //   --reasoning TIER -> reasoning tier override (off|minimal|low|medium|high|xhigh|max; ultra aliases to max).
  // All optional; absent means prior behavior unchanged.
  const genParams = buildRunParamsFromFlags(flags);
  const thinkingControl = thinkingFlagFromFlags(flags);
  const tmo = (flags.timeout && flags.timeout !== true) ? parseInt(String(flags.timeout), 10) : NaN;
  const dispatchTimeoutMs = Number.isFinite(tmo) && tmo > 0 ? tmo : null;
  const reasoningTier = (flags.reasoning && flags.reasoning !== true) ? String(flags.reasoning) : null;
  const runControl = buildRunControlFromFlags(flags, "illuci run");
  const workspaceContext = flags["no-workspace-context"] === true
    ? false
    : (flags["workspace-context"] && flags["workspace-context"] !== true ? String(flags["workspace-context"]) : undefined);
  if (workspaceContext && !["auto", "minimal", "off"].includes(workspaceContext)) {
    console.error("illuci run: --workspace-context must be one of: auto, minimal, off");
    process.exit(1);
  }
  const harnessModelResource = (flags["harness-model"] && flags["harness-model"] !== true) ? String(flags["harness-model"]) : null;
  const preferHarnessInference = !!flags["prefer-harness"];
  const agentManifest = hasCliJsonFlag(flags, "agents") ? parseCliJsonFlag(flags, "agents", "illuci run") : null;
  const workPermits = hasCliJsonFlag(flags, "permits") ? parseCliJsonFlag(flags, "permits", "illuci run") : null;
  const workPermitRequired = flags["require-work-permit"] === true || flags["work-permit-required"] === true;

  // [A90.1]/DR-183 (+[A99]/DR-192: shared with `illuci company`): the genome
  // control per its defaults-registry disclosure — --genome-project-dir arms
  // it; the companion flags refine it and are loud without the arm.
  const genome = await parseGenomeFlagsCli(flags, "illuci run");

  // Build the per-seat disposition config for every topology seat, including
  // seats that will be auto-filled later from the capability matrix.
  let seatDispositions = {};
  try {
    const dispositionSeats = [...new Set([...collectTopologySeatIds(TOPOLOGIES[topology]), ...Object.keys(lineup)])];
    seatDispositions = buildCliSeatDispositions(flags, dispositionSeats);
  } catch (err) {
    console.error("illuci run: " + err.message);
    process.exit(1);
  }

  // Bridge mode (spawned by a driver such as the OTL IDE): pipe lifecycle events to
  // stdout as wrapped NDJSON so the driver can stream the run, alongside the
  // gate_request lines the bridge gate transport emits. The final trace is one
  // NDJSON line. Activated by ILLUCI_GATE_MODE=bridge; non-bridge output is unchanged.
  const bridgeMode = process.env.ILLUCI_GATE_MODE === "bridge";
  let unsubBridge = null;
  if (bridgeMode) {
    const { onEvent } = await import("../core/events/emitter.js");
    unsubBridge = onEvent((event) => {
      try { process.stdout.write(JSON.stringify({ type: "event", event }) + "\n"); } catch {}
    });
  }
  const closeBridgeIfNeeded = async () => {
    if (!bridgeMode) return;
    if (unsubBridge) unsubBridge();
    try {
      const { closeBridge } = await import("../core/gates/bridge-gate.js");
      closeBridge();
    } catch {}
  };

  // ── Resolve the dispatched repo lineage (A28.4) ──
  // Carry the actual repo context (canonical root, branch, worktree, remote) as
  // mandate.repo.lineage so the Std-12 repo-authority gate can verify the running
  // context against what was dispatched. Read-only git; every probe is wrapped so
  // a git failure degrades to null (unverifiable) rather than aborting the run.
  let lineage = null;
  try {
    const { resolveGovernanceTarget } = await import("../core/governance/target.js");
    const tgt = resolveGovernanceTarget(null);
    if (tgt.gitRoot) {
      const root = tgt.repoRoot;
      const readGit = (gitArgs) => {
        try {
          return execFileSync("git", ["-C", root, ...gitArgs], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
          }).trim();
        } catch {
          return null;
        }
      };
      const rawBranch = readGit(["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = rawBranch === "HEAD" ? null : (rawBranch || null); // 'HEAD' => detached => null
      const worktreePath = readGit(["rev-parse", "--show-toplevel"]) || null;
      const remote = readGit(["remote", "get-url", "origin"]) || "origin";
      lineage = { canonicalRoot: root, branch, worktreePath, remote };
    }
  } catch {
    lineage = null;
  }

  let trace;
  try {
    trace = await runTopology(topology, lineup, task, {
      humanStatus: "operator-initiated",
      context: `illuci run: ${topology}`,
      repoLineage: lineage,
      runControl,
      // [A49]/DR-129: the readiness gate (off|config|probe). Explicit beats the
      // ILLUCI_PREFLIGHT_* env defaults; an invalid mode fails closed in the runner.
      ...(typeof flags.preflight === "string" ? { preflight: flags.preflight } : {}),
      params: Object.keys(genParams).length ? genParams : null,
      timeoutMs: dispatchTimeoutMs,
      reasoning: reasoningTier,
      ...(thinkingControl !== null ? { thinking: thinkingControl } : {}),
      cognitiveControlsEnabled: flags["cognitive-controls"] === true,
      seatDispositions: Object.keys(seatDispositions).length ? seatDispositions : null,
      agents: agentManifest,
      ...(genome ? { genome } : {}),
      workPermits,
      workPermitRequired,
      harnessModelResource,
      preferHarnessInference,
      workspaceRoot: process.cwd(),
      ...(workspaceContext !== undefined ? { workspaceContext } : {}),
    });
  } catch (err) {
    if (bridgeMode) {
      process.stdout.write(JSON.stringify({ type: "run_error", message: err.message }) + "\n");
      await closeBridgeIfNeeded();
      process.exit(1);
    }
    console.error(`illuci run: ${err.message}`);
    process.exit(1);
  }

  if (bridgeMode) {
    process.stdout.write(JSON.stringify({ type: "trace", trace }) + "\n");
    await closeBridgeIfNeeded();
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify(trace, null, 2));
    return;
  }

  // Human-readable trace
  const phaseCount = Object.keys(trace.phases).length;
  console.log(`\n=== ${trace.topologyName} — ${phaseCount} phase(s), ${trace.totalLatency}ms ===`);
  for (const [phaseId, phase] of Object.entries(trace.phases)) {
    const n = phase.responses?.length || 0;
    console.log(`\n── ${phaseId} (${n} response${n === 1 ? "" : "s"}) ──`);
    for (const r of phase.responses || []) {
      const runtime = r.modelRuntime || null;
      const controls = runtime?.controls ? Object.entries(runtime.controls).map(([key, value]) => `${key}=${value}`).join(",") : "";
      const runtimeSuffix = runtime
        ? ` [${runtime.modelResourceId || runtime.dispatchId || "model"}${runtime.transport ? " via " + runtime.transport : ""}${controls ? "; " + controls : ""}]`
        : "";
      const who = `[${r.model}${r.seat ? " - " + r.seat : ""}]${runtimeSuffix}`;
      if (r.error) console.log(`${who} ERROR: ${r.error}`);
      else console.log(`${who}\n${(r.response || "").trim()}`);
    }
    const art = phase.artifact;
    if (art?.type === "files") {
      console.log(`  files: ${(art.files || []).map((f) => `${f.operation} ${f.path} — ${f.success ? "ok" : f.error}`).join("; ")}`);
    } else if (art?.type === "commands") {
      console.log(`  commands: ${(art.commands || []).map((c) => `${c.cmd} (exit ${c.exitCode})`).join("; ")}`);
    }
  }
  if (trace.halted) console.log(`\n[halted at ${trace.haltedAt}: ${trace.haltReason}]`);
}

async function cmdPipeline(rest) {
  const { flags, positional } = parseFlags(rest);
  const [subcommand, compositionId, ...promptParts] = positional;

  const usage = () => {
    console.error("usage: illuci pipeline <list|plan|run> [composition] [\"prompt\"] [--lineup '{json}'] [--agents '{json}'] [--stage-map '{json}'] [--run-control '{json}'] [--agenda conducted|derived|ritual] [--mutation-authority gated|blocked] [--tool-autonomy directed|checkpointed|governed|autonomous] [--<seat> model[,model]] [--num-predict N] [--timeout MS] [--reasoning TIER] [--think|--no-think] [--cognitive-controls] [--harness-model MODEL] [--prefer-harness] [--json]");
    console.error("  examples:");
    console.error("    illuci pipeline list");
    console.error("    illuci pipeline plan standard --json");
    console.error("    illuci pipeline run standard \"assess the repo\" --architect codex-local --json");
  };
  enforceFlagValueContract(flags, "illuci pipeline", {
    valueFlags: [
      "lineup", "lineup-file", "agents", "agents-file", "stage-map", "stage-map-file",
      "permits", "permits-file", "run-control", "run-control-file", "agenda",
      "mutation-authority", "tool-autonomy", "num-predict", "timeout", "reasoning",
      "harness-model", "preset", "profile", "role", "skills",
    ],
    booleanFlags: [
      "json", "raw", "yes", "y", "require-work-permit", "work-permit-required",
      "think", "no-think", "cognitive-controls", "prefer-harness", "awareness",
    ],
    allowDynamicValueFlags: subcommand === "plan" || subcommand === "run",
  });

  const {
    buildPipelinePlan,
    listPipelineCompositions,
    resolvePipelineComposition,
  } = await import("../core/pipelines/compositions.js");

  if (!subcommand || subcommand === "list") {
    const rows = listPipelineCompositions().map((composition) => ({
      id: composition.id,
      name: composition.name,
      description: composition.description,
      stageCount: composition.stages.length,
      stages: composition.stages.map((stage, index) => ({
        sequence: index,
        topologyId: stage.topologyId,
        label: stage.label,
        phase: stage.phase || null,
        runWhen: stage.runWhen || null,
      })),
    }));
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log("illuci pipeline compositions:");
    for (const row of rows) {
      console.log("  " + row.id.padEnd(22) + " " + String(row.stageCount).padStart(2) + " stage(s)  " + row.name);
      console.log("    " + row.description);
    }
    return;
  }

  if (!["plan", "run"].includes(subcommand)) {
    console.error("illuci pipeline: unknown subcommand \"" + subcommand + "\"");
    usage();
    process.exit(1);
  }


  if (!compositionId) {
    usage();
    process.exit(1);
  }

  const composition = resolvePipelineComposition(compositionId);
  if (!composition) {
    const available = listPipelineCompositions().map((c) => c.id).join(", ");
    console.error("illuci pipeline: unknown composition \"" + compositionId + "\"");
    console.error("available: " + available);
    process.exit(1);
  }

  const { dispatchIdForPublicModel } = await import("../core/fleet/resource-gateway.js");
  const lineup = normalizePipelineLineup(parsePipelineLineup(flags), dispatchIdForPublicModel);
  const runControl = buildRunControlFromFlags(flags, "illuci pipeline");
  const plan = buildPipelinePlan({ type: composition.id, lineup, options: { runControl } });
  const planSummary = summarizePipelinePlan(plan);

  if (subcommand === "plan") {
    if (flags.json) {
      console.log(JSON.stringify(planSummary, null, 2));
      return;
    }
    printPipelinePlan(planSummary);
    return;
  }

  const prompt = promptParts.join(" ").replace(/^"|"$/g, "");
  if (!prompt) {
    console.error("illuci pipeline run: empty prompt");
    process.exit(1);
  }

  let seatDispositions = {};
  try {
    const { TOPOLOGIES } = await import("../core/topologies/index.js");
    const topologyIds = [...new Set(plan.stages.map((stage) => stage.topologyId).filter(Boolean))];
    const dispositionSeats = [...new Set([...collectTopologySeatIdsByIds(TOPOLOGIES, topologyIds), ...Object.keys(lineup)])];
    seatDispositions = buildCliSeatDispositions(flags, dispositionSeats);
  } catch (err) {
    console.error("illuci pipeline run: " + err.message);
    process.exit(1);
  }

  const genParams = buildRunParamsFromFlags(flags);
  const thinkingControl = thinkingFlagFromFlags(flags);
  const tmo = (flags.timeout && flags.timeout !== true) ? parseInt(String(flags.timeout), 10) : NaN;
  const dispatchTimeoutMs = Number.isFinite(tmo) && tmo > 0 ? tmo : null;
  const reasoningTier = (flags.reasoning && flags.reasoning !== true) ? String(flags.reasoning) : null;
  const harnessModelResource = (flags["harness-model"] && flags["harness-model"] !== true) ? String(flags["harness-model"]) : null;
  const preferHarnessInference = !!flags["prefer-harness"];
  const awareness = flags.awareness === true ? true : undefined;
  const agentManifest = hasCliJsonFlag(flags, "agents") ? parseCliJsonFlag(flags, "agents", "illuci pipeline") : null;
  const stageMap = hasCliJsonFlag(flags, "stage-map") ? parseCliJsonFlag(flags, "stage-map", "illuci pipeline") : null;
  const workPermits = hasCliJsonFlag(flags, "permits") ? parseCliJsonFlag(flags, "permits", "illuci pipeline") : null;
  const workPermitRequired = flags["require-work-permit"] === true || flags["work-permit-required"] === true;

  const options = {
    ...(Object.keys(genParams).length ? { params: genParams } : {}),
    ...(dispatchTimeoutMs != null ? { timeoutMs: dispatchTimeoutMs } : {}),
    ...(reasoningTier ? { reasoning: reasoningTier } : {}),
    ...(thinkingControl !== null ? { thinking: thinkingControl } : {}),
    ...(flags["cognitive-controls"] === true ? { cognitiveControlsEnabled: true } : {}),
    ...(harnessModelResource ? { harnessModelResource } : {}),
    ...(preferHarnessInference ? { preferHarnessInference } : {}),
    ...(awareness !== undefined ? { awareness } : {}),
    ...(Object.keys(seatDispositions).length ? { seatDispositions } : {}),
    ...(agentManifest ? { agents: agentManifest } : {}),
    ...(stageMap ? { stageMap } : {}),
    ...(workPermits ? { workPermits } : {}),
    ...(workPermitRequired ? { workPermitRequired } : {}),
    runControl,
    workingDir: process.cwd(),
  };

  // Hermetic CLI test seam. This requires an explicit ILLUCI_PIPELINE_TEST_STUB
  // and routes through the same pipeline runner injection point used by core tests.
  if (process.env.ILLUCI_PIPELINE_TEST_STUB === "1") {
    options._runNode = async (node, ctx) => {
      if (process.env.ILLUCI_PIPELINE_TEST_FAIL === "1") {
        throw new Error("stub pipeline failure");
      }
      return {
        runId: "stub-" + (node.topologyId || node.id || "node"),
        phases: {
          final: {
            responses: [{
              response: (node.topologyId || node.id) + " output",
              seat: "stub-seat",
              model: "stub-model",
              usage: { total_tokens: 0 },
            }],
          },
        },
        totalLatency: 0,
        budget: { spent: 0 },
        halted: false,
        ctx,
      };
    };
  }

  const { runPipeline } = await import("../core/pipelines/index.js");
  const pipeline = await runPipelineWithJsonIsolation(flags.json, async () => {
    if (process.env.ILLUCI_PIPELINE_TEST_LOG_NOISE === "1") {
      console.log("[illuci pipeline test log noise]");
    }
    return await runPipeline({
      type: composition.id,
      prompt,
      lineup,
      options,
    });
  }, (value, writeStdout) => {
    writeStdout(JSON.stringify(value, null, 2));
  });

  if (flags.json) {
    if (pipelineRunFailed(pipeline)) process.exitCode = 1;
    return;
  }

  console.log("\n=== pipeline " + composition.id + " - " + pipeline.status + " (" + pipeline.stages.length + " stage(s), " + pipeline.artifacts.length + " artifact(s)) ===");
  for (const stage of pipeline.stages) {
    console.log("  [" + stage.sequence + "] " + stage.topologyId + " - " + stage.status + " - " + stage.label);
    if (stage.error) console.log("      " + (stage.error.message || stage.error));
  }
  if (pipeline.error) console.log("\n[pipeline error: " + (pipeline.error.message || pipeline.error) + "]");
  if (pipelineRunFailed(pipeline)) process.exitCode = 1;
}

function parsePipelineLineup(flags) {
  let lineup = {};
  if ((flags.lineup && flags.lineup !== true) || (flags["lineup-file"] && flags["lineup-file"] !== true)) {
    lineup = parseCliJsonFlag(flags, "lineup", "illuci pipeline");
  }
  const reserved = new Set(["lineup", "lineup-file", "agents", "agents-file", "stage-map", "stage-map-file", "permits", "permits-file", "require-work-permit", "work-permit-required", "run-control", "run-control-file", "agenda", "mutation-authority", "tool-autonomy", "json", "raw", "yes", "y", "num-predict", "timeout", "reasoning", "think", "no-think", "cognitive-controls", "harness-model", "prefer-harness", "preset", "profile", "role", "skills", "awareness"]);
  for (const [key, value] of Object.entries(flags)) {
    if (reserved.has(key) || value === true) continue;
    if (/-(preset|role|skills|profile)$/.test(key)) continue;
    const val = String(value);
    lineup[key] = val.includes(",") ? val.split(",").map((item) => item.trim()).filter(Boolean) : val;
  }
  return lineup;
}

function normalizePipelineLineup(lineup, resolvePublicModel) {
  const normalizeValue = (value) => {
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (typeof value !== "string") return value;
    return resolvePublicModel(value) || value;
  };
  return Object.fromEntries(
    Object.entries(lineup).map(([seatId, value]) => [seatId, normalizeValue(value)]),
  );
}

async function runPipelineWithJsonIsolation(enabled, fn, writeResult = null) {
  if (!enabled) return await fn();
  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    console.log = (...args) => console.error(...args);
    console.warn = (...args) => console.error(...args);
    const value = await fn();
    if (writeResult) writeResult(value, originalLog);
    await new Promise((resolve) => setImmediate(resolve));
    return value;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function pipelineRunFailed(pipeline) {
  if (!pipeline) return true;
  return pipeline.status !== "completed";
}

function summarizePipelinePlan(plan) {
  return {
    id: plan.composition?.id || plan.pipelineType,
    name: plan.composition?.name || plan.pipelineType,
    description: plan.composition?.description || null,
    stageCount: plan.stages.length,
    stages: plan.stages.map((stage, index) => ({
      sequence: stage.sequence ?? index,
      topologyId: stage.topologyId,
      label: stage.label || null,
      phase: stage.phase || null,
      runWhen: stage.runWhen || null,
      kind: stage.kind || "topology",
      lineup: stage.lineup || null,
    })),
  };
}

function printPipelinePlan(plan) {
  console.log("illuci pipeline plan: " + plan.id + " (" + plan.stageCount + " stage(s))");
  if (plan.description) console.log("  " + plan.description);
  for (const stage of plan.stages) {
    const phase = stage.phase ? " phase=" + stage.phase : "";
    const runWhen = stage.runWhen ? " when=" + stage.runWhen : "";
    console.log("  [" + stage.sequence + "] " + stage.topologyId + " - " + (stage.label || stage.kind) + phase + runWhen);
  }
}

/**
 * Is the `illuci company` verb enabled? Feature-flagged OFF by default so this slice
 * ships dark — nothing new is live until the operator opts in. Read order:
 *   1. ILLUCI_COMPANY_ENABLED env  ("1" / "true" / "on" → enabled)
 *   2. companyEnabled config key (illuci.config.json, or ILLUCI_CFG_COMPANY_ENABLED)
 * Absent both ⇒ FALSE. The config read is lazy + fail-safe: a config-service fault
 * never enables the verb (fails closed to disabled).
 */
async function companyEnabled() {
  const raw = process.env.ILLUCI_COMPANY_ENABLED;
  const env = String(raw ?? "").toLowerCase();
  if (env === "1" || env === "true" || env === "on") return true;
  if (env === "0" || env === "false" || env === "off") return false;
  // The env var is PRESENT (set to "" or some other value) — treat that as an explicit,
  // silent OFF. Only a genuinely UNSET env var falls through to the config-service, so the
  // default refusal path never initializes config (and never emits a stray [Config Service]
  // log line). The config-key (companyEnabled) path stays live for the truly-unset case.
  if (raw !== undefined) return false;
  try {
    const { getConfig } = await import("../core/config/config-service.js");
    const v = getConfig("companyEnabled", false);
    return v === true || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "1" || String(v).toLowerCase() === "on";
  } catch {
    return false; // fail closed — a config fault must never enable a gated verb
  }
}

/**
 * [A90.1]/[A91.1]/[A99]: the ONE genome flag parser both `illuci run` and
 * `illuci company` use — the arm (--genome-project-dir), its refinements
 * (--genome-precedence seed|dominant|pull, --genome-seal-threshold N,
 * --genome-child-identity via the child-identity policy module), and the
 * loud refinement-without-arm law. `label` keeps error messages honest per
 * surface ("illuci run: ..." / "illuci company: ...").
 * @returns {Promise<object|null>} the genome control, or null when unarmed
 */
async function parseGenomeFlagsCli(flags, label) {
  let genome = null;
  if (flags["genome-project-dir"] && flags["genome-project-dir"] !== true) {
    genome = { projectDir: String(flags["genome-project-dir"]) };
    if (flags["genome-precedence"] && flags["genome-precedence"] !== true) {
      const precedence = String(flags["genome-precedence"]);
      if (!["seed", "dominant", "pull"].includes(precedence)) {
        console.error(`${label}: --genome-precedence must be one of: seed, dominant, pull`);
        process.exit(1);
      }
      genome.precedence = precedence;
    }
    if (flags["genome-seal-threshold"] && flags["genome-seal-threshold"] !== true) {
      const threshold = parseInt(String(flags["genome-seal-threshold"]), 10);
      if (!Number.isFinite(threshold) || threshold < 0) {
        console.error(`${label}: --genome-seal-threshold must be a non-negative integer (0 disables)`);
        process.exit(1);
      }
      genome.sealThreshold = threshold;
    }
    // [A91.1]/DR-184: the childIdentity state, validated through the ONE
    // policy module — unknown values exit 1 loudly here.
    if (flags["genome-child-identity"] && flags["genome-child-identity"] !== true) {
      genome.childIdentity = String(flags["genome-child-identity"]);
      try {
        const { normalizeChildIdentity } = await import("../core/orchestrate/child-identity.js");
        normalizeChildIdentity(genome);
      } catch (err) {
        console.error(`${label}: ` + err.message);
        process.exit(1);
      }
    }
    // [A101]/DR-194: which lenses DIRECT learning. Default ["tension"] when
    // absent (byte-identical); "salient" is the disclosed opt-in. Validated
    // fail-closed at the arm through the ONE grading-sources policy module.
    if (flags["genome-grading-sources"] && flags["genome-grading-sources"] !== true) {
      try {
        const { normalizeGradingSources } = await import("../core/agents/genome-grading-sources.js");
        genome.gradingSources = [...normalizeGradingSources(String(flags["genome-grading-sources"]))];
      } catch (err) {
        console.error(`${label}: ` + err.message);
        process.exit(1);
      }
    }
  } else if ((flags["genome-precedence"] && flags["genome-precedence"] !== true) || (flags["genome-seal-threshold"] && flags["genome-seal-threshold"] !== true) || (flags["genome-child-identity"] && flags["genome-child-identity"] !== true) || (flags["genome-grading-sources"] && flags["genome-grading-sources"] !== true)) {
    console.error(`${label}: --genome-precedence / --genome-seal-threshold / --genome-child-identity / --genome-grading-sources require --genome-project-dir (the genome arm)`);
    process.exit(1);
  }
  return genome;
}

/**
 * illuci company — the GOVERNED operator verb over the company layer (Option 2).
 *
 * Runs a SET of topologies concurrently on one shared awareness bus via the
 * governed orchestrate() entrypoint (core/orchestrate/orchestrate.js), which arms
 * the dispatch enforcement posture before the run. This is the CLI front for the
 * primitive that previously had no verb — the gap /_compose.mjs documents by hand.
 *
 * Usage:
 *   illuci company <topology[,topology...]> "<prompt>" [--<seat> model[,model]]
 *               [--<seat>-preset presetId] [--awareness] [--reasoning T]
 *               [--num-predict N] [--timeout MS] [--concurrency N] [--json]
 *
 * The per-seat lineup + seatDispositions parsing mirrors `illuci run` exactly; the
 * lineup is applied to every member topology. Per-member lineup control belongs
 * at the driver layer; this CLI verb runs a uniform lineup across the set.
 *
 * GATED: refuses (non-zero exit) unless company-enabled is on. Default OFF.
 */
async function cmdCompany(rest) {
  if (!(await companyEnabled())) {
    console.error("illuci company: company-enabled is off.");
    console.error("  This verb is feature-flagged OFF by default. To enable it, set");
    console.error("  ILLUCI_COMPANY_ENABLED=1 (or companyEnabled:true in illuci.config.json).");
    process.exit(1);
  }

  const { flags, positional } = parseFlags(rest);
  const [topologyArg, ...promptParts] = positional;
  enforceFlagValueContract(flags, "illuci company", {
    valueFlags: [
      "lineup", "lineup-file", "run-control", "run-control-file", "agenda",
      "mutation-authority", "tool-autonomy", "num-predict", "timeout", "reasoning",
      "preset", "profile", "role", "skills", "concurrency",
      // [A99]/DR-192: genome + agents parity with `illuci run`.
      "agents", "genome-project-dir", "genome-precedence", "genome-seal-threshold", "genome-child-identity", "genome-grading-sources",
    ],
    booleanFlags: [
      "json", "raw", "yes", "y", "think", "no-think", "cognitive-controls", "awareness",
    ],
    allowDynamicValueFlags: true,
  });
  if (!topologyArg) {
    console.error('usage: illuci company <topology[,topology...]> "<prompt>" [--<seat> model[,model]] [--<seat>-preset presetId] [--agents JSON] [--genome-project-dir PATH] [--genome-precedence seed|dominant|pull] [--genome-seal-threshold N] [--genome-child-identity none|inherit|derive|explicit] [--genome-grading-sources tension[,salient][,behavioral]] [--awareness] [--run-control \'{json}\'] [--agenda conducted|derived|ritual] [--mutation-authority gated|blocked] [--tool-autonomy directed|checkpointed|governed|autonomous] [--reasoning T] [--num-predict N] [--timeout MS] [--cognitive-controls] [--concurrency N] [--json]');
    console.error('  runs the named topologies CONCURRENTLY on one shared awareness bus (the company layer)');
    console.error('  example: illuci company judiciary,legislature "what should illuci build next?" --prosecutor grok-build --awareness');
    process.exit(1);
  }
  const prompt = promptParts.join(" ").replace(/^"|"$/g, "");
  if (!prompt) {
    console.error("illuci company: empty prompt");
    process.exit(1);
  }

  const topologyIds = String(topologyArg).split(",").map((s) => s.trim()).filter(Boolean);
  if (topologyIds.length === 0) {
    console.error("illuci company: no topologies named");
    process.exit(1);
  }

  const { TOPOLOGIES } = await import("../core/topologies/index.js");
  const unknown = topologyIds.filter((t) => !TOPOLOGIES[t]);
  if (unknown.length) {
    console.error(`illuci company: unknown topolog${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}`);
    console.error(`available: ${Object.keys(TOPOLOGIES).join(", ")}`);
    process.exit(1);
  }

  // Shared per-seat lineup. Mirrors cmdRun's parsing:
  // --lineup JSON first, then per-seat flags override; reserved flags excluded.
  let lineup = {};
  if ((flags.lineup && flags.lineup !== true) || (flags["lineup-file"] && flags["lineup-file"] !== true)) {
    lineup = parseCliJsonFlag(flags, "lineup", "illuci company");
  }
  const RESERVED = new Set(["lineup", "lineup-file", "json", "raw", "yes", "y", "num-predict", "timeout", "reasoning", "think", "no-think", "cognitive-controls", "run-control", "run-control-file", "agenda", "mutation-authority", "tool-autonomy", "preset", "profile", "role", "skills", "awareness", "concurrency", "agents", "genome-project-dir", "genome-precedence", "genome-seal-threshold", "genome-child-identity", "genome-grading-sources"]);
  for (const [k, v] of Object.entries(flags)) {
    if (RESERVED.has(k) || v === true) continue;
    if (/-(preset|role|skills|profile)$/.test(k)) continue;
    const val = String(v);
    lineup[k] = val.includes(",") ? val.split(",").map((s) => s.trim()).filter(Boolean) : val;
  }

  // Generation + dispatch controls (identical surface to `illuci run`).
  const genParams = buildRunParamsFromFlags(flags);
  const thinkingControl = thinkingFlagFromFlags(flags);
  const tmo = (flags.timeout && flags.timeout !== true) ? parseInt(String(flags.timeout), 10) : NaN;
  const dispatchTimeoutMs = Number.isFinite(tmo) && tmo > 0 ? tmo : null;
  const reasoningTier = (flags.reasoning && flags.reasoning !== true) ? String(flags.reasoning) : null;
  const conc = (flags.concurrency && flags.concurrency !== true) ? parseInt(String(flags.concurrency), 10) : NaN;
  const concurrency = Number.isFinite(conc) && conc > 0 ? conc : null;
  const awareness = flags.awareness !== false; // default true; --awareness is the explicit affirm
  const runControl = buildRunControlFromFlags(flags, "illuci company");

  // [A99]/DR-192: genome + agents parity with `illuci run` — the same manifest
  // and the same fail-closed genome arm, through the same parsers, so a
  // persona-seated genome-armed company is one CLI line on either surface.
  const agentManifest = hasCliJsonFlag(flags, "agents") ? parseCliJsonFlag(flags, "agents", "illuci company") : null;
  const genome = await parseGenomeFlagsCli(flags, "illuci company");

  // Build the per-seat disposition config for every member topology seat, including
  // seats that will be auto-filled later from the capability matrix.
  let seatDispositions = {};
  try {
    const dispositionSeats = [...new Set([...collectTopologySeatIdsByIds(TOPOLOGIES, topologyIds), ...Object.keys(lineup)])];
    seatDispositions = buildCliSeatDispositions(flags, dispositionSeats);
  } catch (err) {
    console.error("illuci company: " + err.message);
    process.exit(1);
  }

  // The shared member options every topology in the set carries (mirrors cmdRun's options).
  const memberOptions = {
    humanStatus: "operator-initiated",
    context: `illuci company: ${topologyIds.join("+")}`,
    ...(Object.keys(genParams).length ? { params: genParams } : {}),
    ...(dispatchTimeoutMs != null ? { timeoutMs: dispatchTimeoutMs } : {}),
    ...(reasoningTier ? { reasoning: reasoningTier } : {}),
    ...(thinkingControl !== null ? { thinking: thinkingControl } : {}),
    ...(flags["cognitive-controls"] === true ? { cognitiveControlsEnabled: true } : {}),
    runControl,
    ...(Object.keys(seatDispositions).length ? { seatDispositions } : {}),
    // [A99]/DR-192: every member arms the same manifest + genome the operator
    // named — explicit member options, valid under every childIdentity state.
    ...(agentManifest ? { agents: agentManifest } : {}),
    ...(genome ? { genome } : {}),
  };

  // Build the company config: one member spec per named topology, all sharing the
  // company-default lineup (applied by orchestrate's `lineup`) and member options.
  const topologies = topologyIds.map((topologyId) => ({ topologyId, options: memberOptions }));
  const companyConfig = {
    topologies,
    prompt,
    lineup: Object.keys(lineup).length ? lineup : null,
    awareness,
    ...(concurrency != null ? { concurrency } : {}),
    // [A99]/DR-192: the company-level carry — under childIdentity=inherit the
    // members' children receive these through carryChildIdentity (A91).
    ...(agentManifest ? { agents: agentManifest } : {}),
    ...(genome ? { genome } : {}),
  };

  // TEST-ONLY hermetic seam: gated behind BOTH the enabled flag (already checked) AND
  // an explicit ILLUCI_COMPANY_TEST_STUB, so it can never fire on a real operator run. It
  // echoes the CONSTRUCTED company config as JSON and skips dispatch — proving the verb
  // parses + builds the config correctly without needing live models.
  if (process.env.ILLUCI_COMPANY_TEST_STUB === "1") {
    console.log(JSON.stringify({ __stub: true, config: companyConfig }, null, 2));
    return;
  }

  const { orchestrate } = await import("../core/orchestrate/orchestrate.js");

  let result;
  try {
    result = await orchestrate(companyConfig);
  } catch (err) {
    console.error(`illuci company: ${err.message}`);
    process.exit(1);
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n=== company ${topologyIds.join(" + ")} — ${result.status} (session ${result.sessionId}) ===`);
  const c = result.counts || {};
  console.log(`members: ${c.total ?? 0} total — ${c.ok ?? 0} ok, ${c.errored ?? 0} errored, ${c.halted ?? 0} halted, ${c.aborted ?? 0} aborted`);
  for (const m of result.members || []) {
    const head = `── [${m.index}] ${m.topologyId} (${m.status})${m.runId ? " run=" + m.runId : ""} ──`;
    console.log(`\n${head}`);
    if (m.error) console.log(`  ${m.error}`);
    const phases = m.trace?.phases ? Object.keys(m.trace.phases) : [];
    if (phases.length) console.log(`  phases: ${phases.join(", ")}`);
    if (m.trace?.halted) console.log(`  [halted at ${m.trace.haltedAt}: ${m.trace.haltReason}]`);
  }
}

/**
 * Is the `illuci company-rounds` verb enabled? Feature-flagged OFF by default — the
 * heterogeneous-adversarial loop ships dark, exactly like `illuci company`. Read order:
 *   1. ILLUCI_COMPANY_ROUNDS_ENABLED env ("1" / "true" / "on" → enabled)
 *   2. companyRoundsEnabled config key (illuci.config.json, or ILLUCI_CFG_COMPANY_ROUNDS_ENABLED)
 * Absent both ⇒ FALSE. Mirrors companyEnabled()'s lazy + fail-closed posture exactly.
 */
async function companyRoundsEnabled() {
  const raw = process.env.ILLUCI_COMPANY_ROUNDS_ENABLED;
  const env = String(raw ?? "").toLowerCase();
  if (env === "1" || env === "true" || env === "on") return true;
  if (env === "0" || env === "false" || env === "off") return false;
  // A PRESENT-but-other env value is an explicit silent OFF; only a genuinely UNSET var
  // falls through to the config-service (so the default refusal never initializes config).
  if (raw !== undefined) return false;
  try {
    const { getConfig } = await import("../core/config/config-service.js");
    const v = getConfig("companyRoundsEnabled", false);
    return v === true || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "1" || String(v).toLowerCase() === "on";
  } catch {
    return false; // fail closed — a config fault must never enable a gated verb
  }
}

/**
 * illuci company-rounds — the GOVERNED heterogeneous-adversarial company LOOP (company-rounds).
 *
 * Runs two adversarial bodies (commune + devStructure) as a company over the governed
 * orchestrate() entrypoint, ROUND after ROUND, until a PURE brake halts the loop (the round
 * ceiling, the session token budget, or the no-progress triple-gate). Each round assembles a
 * DETERMINISTIC clash artifact (the diff between the two bodies); the default round ceiling is
 * 1, so a bare invocation is one round — byte-identical to a `illuci company` of the two bodies.
 *
 * Usage:
 *   illuci company-rounds <commune> <devStructure> "<prompt>"
 *       [--max-rounds N] [--token-ceiling N] [--min-collision-hunks N]
 *       [--max-token-overlap R] [--stall-rounds N] [--evaluator <topology>]
 *       [--commune-lineup JSON] [--dev-lineup JSON] [--json]
 *
 * GATED: refuses (non-zero exit) unless company-rounds-enabled is on. Default OFF.
 */
async function cmdCompanyRounds(rest) {
  if (!(await companyRoundsEnabled())) {
    console.error("illuci company-rounds: company-rounds-enabled is off.");
    console.error("  This verb is feature-flagged OFF by default. To enable it, set");
    console.error("  ILLUCI_COMPANY_ROUNDS_ENABLED=1 (or companyRoundsEnabled:true in illuci.config.json).");
    process.exit(1);
  }

  const { flags, positional } = parseFlags(rest);
  const [communeId, devId, ...promptParts] = positional;
  if (!communeId || !devId || promptParts.length === 0) {
    console.error('usage: illuci company-rounds <commune> <devStructure> "<prompt>" [--max-rounds N] [--token-ceiling N] [--min-collision-hunks N] [--max-token-overlap R] [--stall-rounds N] [--evaluator <topology>] [--commune-lineup JSON] [--dev-lineup JSON] [--json]');
    console.error('  runs the two adversarial bodies as a company, ROUND after round, until a brake halts the loop');
    console.error('  example: illuci company-rounds research-swarm devops-pipeline "design the rounds API" --max-rounds 3 --awareness');
    process.exit(1);
  }
  const prompt = promptParts.join(" ").replace(/^"|"$/g, "");
  if (!prompt) { console.error("illuci company-rounds: empty prompt"); process.exit(1); }

  const intFlag = (name) => {
    if (!flags[name] || flags[name] === true) return undefined;
    const n = parseInt(String(flags[name]), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const floatFlag = (name) => {
    if (!flags[name] || flags[name] === true) return undefined;
    const n = parseFloat(String(flags[name]));
    return Number.isFinite(n) ? n : undefined;
  };
  const jsonFlag = (name) => {
    if (!flags[name] || flags[name] === true) return undefined;
    try { return JSON.parse(String(flags[name])); }
    catch { console.error(`illuci company-rounds: --${name} must be valid JSON`); process.exit(1); }
  };

  const adversarialConfig = {
    commune: { topologyId: communeId, ...(jsonFlag("commune-lineup") ? { lineup: jsonFlag("commune-lineup") } : {}) },
    devStructure: { topologyId: devId, ...(jsonFlag("dev-lineup") ? { lineup: jsonFlag("dev-lineup") } : {}) },
    roundCeiling: { kind: "RoundCeiling", maxRounds: intFlag("max-rounds") ?? 1 },
    stopCondition: {
      kind: "StopCondition",
      tokenCeiling: intFlag("token-ceiling") ?? null,
      minCollisionHunks: intFlag("min-collision-hunks") ?? 1,
      maxTokenOverlap: floatFlag("max-token-overlap") ?? 0.85,
      stallRounds: intFlag("stall-rounds") ?? 1,
    },
    ...(flags.evaluator && flags.evaluator !== true ? { evaluator: { topologyId: String(flags.evaluator) } } : {}),
  };

  // TEST-ONLY hermetic seam (mirrors cmdCompany): gated behind the enabled flag AND an
  // explicit ILLUCI_COMPANY_ROUNDS_TEST_STUB, so it can never fire on a real operator run.
  if (process.env.ILLUCI_COMPANY_ROUNDS_TEST_STUB === "1") {
    console.log(JSON.stringify({ __stub: true, config: adversarialConfig }, null, 2));
    return;
  }

  const { runCompanyRounds } = await import("../core/orchestrate/orchestrate.js");

  let result;
  try {
    result = await runCompanyRounds(prompt, adversarialConfig);
  } catch (err) {
    console.error(`illuci company-rounds: ${err.message}`);
    process.exit(1);
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { renderMarkdown } = await import("../core/orchestrate/clash-artifact.js");
  console.log(`\n=== company-rounds ${communeId} vs ${devId} — ${result.status} ===`);
  console.log(`rounds run: ${result.clashHistory.length}`);
  const b = result.runBudget || {};
  if (b.tokenCeiling != null) console.log(`budget: ${b.tokensSpent}/${b.tokenCeiling} tokens${b.halted ? " (EXHAUSTED)" : ""}`);
  for (const clash of result.clashHistory) {
    console.log(`\n${renderMarkdown(clash)}`);
  }
}

async function cmdCouncil(rest) {
  const [preset, ...taskParts] = rest;
  if (!preset) {
    console.error("usage: illuci council <preset> \"<task>\"");
    console.error("presets: judiciary | adversarial-debate | peer-review-ring | war-room | research-swarm | sanhedrin | conclave");
    process.exit(1);
  }
  console.log(`illuci council ${preset} — dispatching ${preset} preset`);
  await cmdRun([preset, ...taskParts]);
}

function collectIdeProfiles(flags) {
  const value = flags.ide && flags.ide !== true ? flags.ide : flags.profile && flags.profile !== true ? flags.profile : null;
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function substrateCliOptions(flags, profile = "attach") {
  return {
    profile,
    apply: Boolean(flags.apply),
    hooks: Boolean(flags.hooks),
    ide: !flags["no-ide"],
    git: !flags["no-git"],
    governancePack: profile === "create" || Boolean(flags["governance-pack"]),
    name: flags.name && flags.name !== true ? String(flags.name) : undefined,
    ideProfiles: collectIdeProfiles(flags),
    ideHostFiles: Boolean(flags["host-files"] || flags["write-idea"] || flags["write-host-files"]),
    sandboxPrune: Boolean(flags["prune-sandboxes"] || flags["sandbox-prune"]),
    sandboxPruneMergedBranches: Boolean(flags["merged-branches"] || flags["prune-merged-branches"]),
    // Consume a deployed Illuci Runtime: IDE/bridge MCP emissions point at URL+token.
    // Local stdio is an explicit single-machine dev mode, not the default.
    runtimeUrl: flags["runtime-url"] && flags["runtime-url"] !== true ? String(flags["runtime-url"]) : undefined,
    runtimeTokenEnv: flags["runtime-token-env"] && flags["runtime-token-env"] !== true ? String(flags["runtime-token-env"]) : undefined,
    localRuntime: Boolean(flags["local-runtime"] || flags["local-stdio"] || flags["dev-stdio-runtime"]),
  };
}

function targetFromFlags(flags, positional) {
  return flags.target && flags.target !== true ? flags.target : positional[0];
}

function parsePayload(raw, label = "payload") {
  if (raw == null || raw === true || raw === "") return {};
  const text = normalizeCliJsonText(readCliJsonText(String(raw), label));
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error("invalid JSON payload: " + err.message);
  }
}

function resolveRecordPayload(flags, positional) {
  const hasInline = flags.payload && flags.payload !== true;
  const hasFile = flags["payload-file"] && flags["payload-file"] !== true;
  const hasPositional = positional[1] != null;
  const sources = [hasInline, hasFile, hasPositional].filter(Boolean).length;
  if (sources > 1) {
    throw new Error("illuci project substrate record: use positional payload, --payload, or --payload-file, not more than one");
  }
  if (hasFile) return parsePayload("@" + String(flags["payload-file"]), "illuci project substrate record --payload-file");
  if (hasInline) return parsePayload(flags.payload, "illuci project substrate record --payload");
  return parsePayload(positional[1], "illuci project substrate record payload");
}

function printCaptureResult(capture) {
  if (!capture) return;
  const status = capture.ok ? capture.landingZone : capture.reason || "unavailable";
  console.log("  capture: " + status + (capture.path ? " -> " + capture.path : ""));
}

function printDoctorResult(result, flags) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("illuci project substrate doctor - " + result.status.toUpperCase());
  console.log("  root: " + result.target.repoRoot);
  if (result.findings.length === 0) console.log("  no findings");
  for (const f of result.findings) console.log("  [" + f.severity + "] " + f.code + ": " + f.message);
  printCaptureResult(result.capture);
}

function printDataResult(result, flags, fallbackLabel = "records") {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.record) {
    console.log("illuci project substrate data - " + result.record.id);
    console.log("  lane: " + result.record.lane);
    console.log("  type: " + result.record.type);
    printCaptureResult(result.capture);
    return;
  }
  const records = result.records || [];
  console.log("illuci project substrate data - " + records.length + " " + fallbackLabel);
  for (const r of records) console.log("  " + r.id + " | " + r.lane + " | " + r.type + " | " + r.timestamp);
  for (const err of result.errors || []) console.log("  [error] " + err.path + ":" + err.line + " " + err.message);
  printCaptureResult(result.capture);
}

function summarizeForCapture(result, operation, extra = {}) {
  const summary = { operation, ok: result?.ok !== false, ...extra };
  if (result?.plan) {
    summary.profile = result.plan.profile;
    summary.scope = result.plan.scope;
    summary.apply = result.plan.apply;
    summary.blocked = result.plan.blocked;
    summary.actionCount = result.plan.actions?.length || 0;
    if (result.result) {
      summary.resultOk = result.result.ok;
      summary.applied = result.result.applied?.length || 0;
      summary.skipped = result.result.skipped?.length || 0;
    }
  } else if (result?.schema === "illuci.project.substrate.doctor/1") {
    summary.status = result.status;
    summary.findingCount = result.findings?.length || 0;
  } else if (result?.record) {
    summary.recordId = result.record.id;
    summary.lane = result.record.lane;
    summary.type = result.record.type;
  } else if (Array.isArray(result?.records)) {
    summary.recordCount = result.records.length;
    summary.errorCount = result.errors?.length || 0;
    summary.lanes = result.lanes || [];
  }
  return summary;
}

function withSubstrateCapture(substrate, result, targetArg, operation, flags, extra = {}) {
  if (flags["no-capture"]) return result;
  const capture = substrate.captureProjectSubstrateObservation(targetArg, operation, summarizeForCapture(result, operation, extra));
  return { ...result, capture };
}

function printProjectSubstrateResult(result, flags) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const plan = result.plan;
  console.log(`illuci project ${plan.profile === "create" ? "create" : "integrate"} - ${result.result ? "APPLIED" : "PLAN"}`);
  console.log("  root: " + plan.target.repoRoot);
  console.log("  profile: " + plan.profile);
  console.log("  actions: " + plan.actions.length);
  if (plan.blocked) {
    for (const f of plan.target.findings) console.log("  [" + f.severity + "] " + f.code + ": " + f.message);
    printCaptureResult(result.capture);
    return;
  }
  const counts = plan.actions.reduce((acc, step) => {
    acc[step.kind] = (acc[step.kind] || 0) + 1;
    return acc;
  }, {});
  for (const [kind, count] of Object.entries(counts)) console.log(`  ${kind}: ${count}`);
  if (!result.result) console.log("  dry run; re-run with --apply to materialize the substrate");
  else console.log("  applied: " + result.result.applied.length + ", skipped: " + result.result.skipped.length);
  printCaptureResult(result.capture);
}

async function runProjectSubstrate(rest, profile) {
  const { flags, positional } = parseFlags(rest);
  const targetArg = targetFromFlags(flags, positional);
  const substrate = await import("../core/projects/substrate.js");
  let result = substrate.materializeProjectSubstrate(targetArg, substrateCliOptions(flags, profile));
  result = withSubstrateCapture(substrate, result, targetArg, profile === "create" ? "create" : "integrate", flags);
  printProjectSubstrateResult(result, flags);
  if (result.plan.blocked) process.exit(1);
}

async function runProjectSubstrateNamespace(rest) {
  const subverb = rest[0];
  const { flags, positional } = parseFlags(rest.slice(1));
  const targetArg = targetFromFlags(flags, positional);
  const substrate = await import("../core/projects/substrate.js");
  switch (subverb) {
    case "plan": {
      let result = substrate.materializeProjectSubstrate(targetArg, { ...substrateCliOptions(flags, "attach"), apply: false });
      result = withSubstrateCapture(substrate, result, targetArg, "plan", flags);
      printProjectSubstrateResult(result, flags);
      if (result.plan.blocked) process.exit(1);
      break;
    }
    case "refresh": {
      let result = substrate.materializeProjectSubstrate(targetArg, substrateCliOptions(flags, "attach"));
      result = withSubstrateCapture(substrate, result, targetArg, "refresh", flags);
      printProjectSubstrateResult(result, flags);
      if (result.plan.blocked || result.result?.ok === false) process.exit(1);
      break;
    }
    case "prune": {
      let result = substrate.materializeProjectSubstrate(targetArg, {
        ...substrateCliOptions(flags, "attach"),
        scope: "hygiene",
        ide: false,
        sandboxPrune: true,
      });
      result = withSubstrateCapture(substrate, result, targetArg, "prune", flags, {
        mergedBranches: Boolean(flags["merged-branches"] || flags["prune-merged-branches"]),
      });
      printProjectSubstrateResult(result, flags);
      if (result.plan.blocked || result.result?.ok === false) process.exit(1);
      break;
    }
    case "emit-ide": {
      const profile = flags.profile && flags.profile !== true ? String(flags.profile) : flags.ide && flags.ide !== true ? String(flags.ide) : positional[0];
      if (!profile) {
        console.error("usage: illuci project substrate emit-ide --profile <codex|vscode|cursor|windsurf|jetbrains> [--target PATH] [--apply] [--host-files] [--json] [--runtime-url URL | --local-runtime]");
        process.exit(1);
      }
      const explicitTarget = flags.target && flags.target !== true
        ? flags.target
        : (flags.profile || flags.ide ? positional[0] : positional[1]);
      let result = substrate.materializeProjectSubstrate(explicitTarget, {
        ...substrateCliOptions(flags, "attach"),
        scope: "ide",
        ideProfiles: [profile],
      });
      result = withSubstrateCapture(substrate, result, explicitTarget, "emit-ide", flags, { ideProfile: profile });
      printProjectSubstrateResult(result, flags);
      if (result.plan.blocked || result.result?.ok === false) process.exit(1);
      break;
    }
    case "doctor": {
      let result = substrate.doctorProjectSubstrate(targetArg, { ...substrateCliOptions(flags, "attach"), ideProfiles: collectIdeProfiles(flags) });
      result = withSubstrateCapture(substrate, result, targetArg, "doctor", flags);
      printDoctorResult(result, flags);
      if (result.status === "fail") process.exit(1);
      break;
    }
    case "record": {
      const lane = positional[0] || flags.lane;
      if (!lane) {
        console.error("usage: illuci project substrate record <lane> [json-payload] [--payload JSON|@file] [--payload-file PATH] [--target PATH] [--json]");
        process.exit(1);
      }
      let payload;
      try {
        payload = resolveRecordPayload(flags, positional);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      const dataTarget = flags.target && flags.target !== true ? flags.target : undefined;
      let result = substrate.recordProjectData(dataTarget, lane, payload, { type: flags.type });
      result = withSubstrateCapture(substrate, result, dataTarget, "record", flags, { lane });
      printDataResult(result, flags, "records");
      if (!result.ok) process.exit(1);
      break;
    }
    case "list": {
      const lane = positional[0] || (flags.lane && flags.lane !== true ? flags.lane : null);
      const dataTarget = flags.target && flags.target !== true ? flags.target : undefined;
      let result = substrate.listProjectData(dataTarget, { lane, type: flags.type, limit: flags.limit });
      result = withSubstrateCapture(substrate, result, dataTarget, "list", flags, { lane });
      printDataResult(result, flags, "records");
      if (!result.ok) process.exit(1);
      break;
    }
    case "read": {
      const id = positional[0] || flags.id;
      if (!id) {
        console.error("usage: illuci project substrate read <record-id> [--lane LANE] [--target PATH] [--json]");
        process.exit(1);
      }
      const dataTarget = flags.target && flags.target !== true ? flags.target : undefined;
      let result = substrate.readProjectData(dataTarget, id, { lane: flags.lane && flags.lane !== true ? flags.lane : null });
      result = withSubstrateCapture(substrate, result, dataTarget, "read", flags, { id });
      printDataResult(result, flags, "records");
      if (!result.ok || !result.record) process.exit(1);
      break;
    }
    default:
      console.error("usage: illuci project substrate <plan|doctor|refresh|prune|emit-ide|record|list|read> [--target PATH] [--apply] [--json] [--runtime-url URL | --local-runtime] [--runtime-token-env NAME]");
      process.exit(1);
  }
}

async function cmdProject(rest) {
  const subverb = rest[0];
  switch (subverb) {
    case "assess": {
      // The engine-side governance evaluation primitive (illuci/core/governance/assess.js).
      // Pure + callable on purpose: the same module is what MC's sense layer and Devise
      // invoke for real-time governance feedback during illuci development.
      const { assessProject } = await import("../core/governance/assess.js");
      const { resolveGovernanceTarget, targetIsBlocked } = await import("../core/governance/target.js");
      const { flags, positional } = parseFlags(rest.slice(1));
      const targetArg = flags.target && flags.target !== true ? flags.target : positional[0];
      const target = resolveGovernanceTarget(targetArg);
      if (targetIsBlocked(target)) {
        const payload = {
          schema: "illuci.project.assess/1",
          target,
          verdict: "blocked",
          findings: target.findings,
        };
        if (flags.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.error("illuci project assess - BLOCKED");
          for (const f of target.findings) console.error("  [" + f.severity + "] " + f.code + ": " + f.message);
        }
        process.exit(1);
      }
      const result = { ...assessProject(target.repoRoot), target };
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      console.log("illuci project assess - " + result.verdict.toUpperCase());
      console.log("  target: " + target.mode + (target.requestedPath ? " (" + target.requestedPath + ")" : ""));
      console.log("  root: " + result.repoRoot);
      console.log("  VERSION: " + (result.version ?? "(none)"));
      if (result.odometer) {
        const o = result.odometer;
        console.log(
          "  odometer: MINOR " + o.minor + "/" + o.minorCap + ", PATCH " + o.patch + "/" + o.patchCap +
            ", ceiling " + o.ceiling + " - " + (o.legal ? "legal" : "ILLEGAL"),
        );
      }
      for (const f of target.findings) console.log("  [" + f.severity + "] " + f.code + ": " + f.message);
      if (result.findings.length === 0) console.log("  no findings");
      for (const f of result.findings) console.log("  [" + f.severity + "] " + f.code + ": " + f.message);
      break;
    }
    case "create":
      await runProjectSubstrate(rest.slice(1), "create");
      break;
    case "integrate":
      await runProjectSubstrate(rest.slice(1), "attach");
      break;
    case "substrate":
      await runProjectSubstrateNamespace(rest.slice(1));
      break;
    case "plan-reorg":
      console.log("illuci project plan-reorg - generates a deterministic move-map.");
      break;
    case "execute-reorg":
      console.log("illuci project execute-reorg - governed executor; dry-run first.");
      break;
    default:
      console.error("usage: illuci project <assess|create|integrate|substrate|plan-reorg|execute-reorg> [target|--target PATH] [--apply] [--hooks] [--json]");
      process.exit(1);
  }
}
async function main() {
  if (!verb) {
    if (process.stdin.isTTY) {
      try {
        const { startTUI } = await import("./tui/app.js");
        await startTUI();
        process.exit(0);
      } catch (err) {
        if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("ink")) {
          console.log("TUI unavailable (ink not installed). Displaying help:\n");
          help();
          process.exit(0);
        }
        throw err;
      }
    } else {
      help();
      process.exit(0);
    }
  }

  if (verb === "tui" || verb === "--tui") {
    try {
      const { startTUI } = await import("./tui/app.js");
      await startTUI();
      process.exit(0);
    } catch (err) {
      console.error("Failed to start TUI:", err.message);
      process.exit(1);
    }
  }

  if (verb === "--help" || verb === "-h") {
    help();
    process.exit(0);
  }

  const rest = args.slice(1);
  switch (verb) {
    case "decisions":
      cmdDecisions(rest);
      break;
    case "chat":
      await cmdChat(rest);
      break;
    case "models":
      await cmdModels(rest);
      break;
    case "providers":
      await cmdProviders(rest);
      break;
    case "dispositions": return cmdDispositions(rest);
    case "genome":        return cmdGenome(rest);
    case "capabilities":  return cmdCapabilities(rest);
    case "compose":       return cmdCompose(rest);
    case "topologies":
      await cmdTopologies(rest);
      break;
    case "presets":
      await cmdPresets(rest);
      break;
    case "matrix":        return cmdMatrix(rest);
    case "defaults":      return cmdDefaults(rest);
    case "runtime":       return cmdRuntime(rest);
    case "grants":        return cmdGrants(rest);
    case "run":
      await cmdRun(rest);
      break;
    case "pipeline":
      await cmdPipeline(rest);
      break;
    case "sandbox":
      await cmdSandbox(rest);
      break;
    case "worktree":
      await cmdWorktree(rest);
      break;
    case "gitops":
      await cmdGitops(rest);
      break;
    case "infrastructure":
      await cmdInfrastructure(rest);
      break;
    case "pr":
      await cmdPr(rest);
      break;
    case "surfaces":
      await cmdSurfaces(rest);
      break;
    case "describe":
      await cmdDescribe(rest);
      break;
    case "company":
      await cmdCompany(rest);
      break;
    case "company-rounds":
      await cmdCompanyRounds(rest);
      break;
    case "council":
      await cmdCouncil(rest);
      break;
    case "project":
      await cmdProject(rest);
      break;
    case "gate":
      await cmdGate(rest);
      break;
    case "traces":
      await cmdTraces(rest);
      break;
    case "datastore":
      await cmdDatastore(rest);
      break;
    default:
      console.error(`Unknown verb: ${verb}`);
      help();
      process.exit(1);
  }
}

// `illuci gate compile` - compile the governance Bill into armed enforcers (the governance compiler).
// Runs from the repo root (process.cwd, how illuci is invoked). The floor pass and dispatch seam
// load the emitted compiled/ tree; this is how an operator regenerates it after editing the Bill.
async function cmdGate(rest) {
  const sub = rest[0];
  if (sub === "compile") {
    const { compile } = await import("../core/governance/compiler/index.js");
    const res = compile({ force: rest.includes("--force"), batch: process.env.GZDS_CURRENT_BATCH || null });
    if (res.phase === "parse") {
      console.error("gate compile: PARSE FAILED");
      for (const e of res.errors) console.error("  - " + e);
      process.exit(1);
    }
    const s = (res.gir && res.gir.stats) || {};
    console.log(res.cached
      ? `gate compile: cached - ${s.total_obligations} obligations`
      : `gate compile: ${s.total_obligations} obligations -> ${s.emitted} enforcers (hard ${s.hard}, carried ${s.carried}, soft ${s.soft}, human ${s.human})`);
    if (res.gaps && res.gaps.length) console.log(`  promise-gaps: ${res.gaps.length} (${s.failing_gaps || 0} failing)`);
    if (!res.ok) { console.error("gate compile: FAILED (promise-gap)"); process.exit(2); }
    console.log("gate compile: OK");
    return;
  }
  console.error(`Unknown gate subcommand: ${sub || "(none)"}. Try: illuci gate compile [--force]`);
  process.exit(1);
}

// `illuci datastore` — query the unified event-sourced datastore (read-only). Indexes the
// .illuci/data lanes into the trunk on demand (index-then-query), then serves SQL + canned
// queries over the trunk and its projections. Writes always go through the normal lane
// writers; this surface never mutates.
async function cmdDatastore(rest) {
  const subverb = rest[0];
  const { flags, positional } = parseFlags(rest.slice(1));
  const { openDatastore, datastoreEnabled } = await import("../core/datastore/index.js");
  if (!datastoreEnabled()) {
    console.error("illuci datastore: disabled. Set ILLUCI_DATASTORE_ENABLED=1 (with a SQLite backend) to use it.");
    process.exit(2);
  }
  const store = openDatastore();
  try { store.indexLanes(); } catch { /* index is best-effort; query whatever is present */ }

  const emit = (data) => {
    if (flags.json) console.log(JSON.stringify(data, null, 2));
    else printDatastoreTable(data);
  };

  switch (subverb) {
    case "query":
    case "sql": {
      const sql = positional.join(" ").trim() || (typeof flags.sql === "string" ? flags.sql : "");
      if (!sql) { console.error('usage: illuci datastore query "SELECT ... FROM records ..." [--json]'); process.exit(1); }
      try { emit(runDatastoreSql(store, sql)); }
      catch (err) { console.error("illuci datastore query: " + err.message); process.exit(1); }
      break;
    }
    case "by-run": {
      const runId = positional[0] || (flags.run && flags.run !== true ? flags.run : null);
      if (!runId) { console.error("usage: illuci datastore by-run <runId> [--json]"); process.exit(1); }
      emit(store.trunk.byRun(runId));
      break;
    }
    case "cost-by-model":
      emit(await store.registry.costByModel());
      break;
    case "graph-reach": {
      const rootId = positional[0] || (flags.root && flags.root !== true ? flags.root : null);
      if (!rootId) { console.error("usage: illuci datastore graph-reach <rootId> [--node-type TYPE] [--json]"); process.exit(1); }
      emit(store.registry.reach(rootId, { nodeType: flags["node-type"] && flags["node-type"] !== true ? flags["node-type"] : undefined }));
      break;
    }
    case "vector-search": {
      const text = positional.join(" ").trim() || (typeof flags.text === "string" ? flags.text : "");
      if (!text) { console.error("usage: illuci datastore vector-search <text...> [--k N] [--json]"); process.exit(1); }
      emit(await store.registry.search(text, Number(flags.k) || 5));
      break;
    }
    case "health":
      emit({ count: store.trunk.count(), latestSeq: store.trunk.latestSeq(), projections: store.registry.health() });
      break;
    default:
      console.error("usage: illuci datastore <query|by-run|cost-by-model|graph-reach|vector-search|health> [args] [--json]");
      process.exit(1);
  }
}

// Read-only SQL over the datastore: reject any mutating/DDL statement, prefer the DuckDB
// analytics projection (it attaches the trunk READ_ONLY) when available, else the trunk driver.
function runDatastoreSql(store, sql) {
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex)\b/i.test(sql) || /pragma\s+[\w.]+\s*=/i.test(sql)) {
    throw new Error("read-only: only SELECT / PRAGMA-read queries are allowed");
  }
  // Run against the SQLite trunk (always present; holds records + projection tables).
  // The read-only guard above is the safety net; this path only issues SELECT/PRAGMA-read.
  return store.driver.prepare(sql).all();
}

// Compact table for array-of-object results (records or arbitrary SQL columns).
function printDatastoreTable(data) {
  if (data == null) { console.log("(no result)"); return; }
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) { console.log("(0 rows)"); return; }
  if (typeof rows[0] !== "object" || rows[0] === null) { for (const r of rows) console.log(String(r)); return; }
  const preferred = ["seq", "ts", "kind", "type", "id", "runId", "modelId", "source"];
  const present = preferred.filter((k) => k in rows[0]);
  // Use the compact record columns only for record-shaped rows; arbitrary SQL results
  // (e.g. GROUP BY aggregates) keep all their own columns.
  const cols = present.length >= 3 ? present : Object.keys(rows[0]).slice(0, 8);
  const cell = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 48);
  const widths = cols.map((c) => Math.max(c.length, ...rows.slice(0, 200).map((r) => cell(r[c]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => cell(r[c]))));
  console.log(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

// `illuci traces organize` - sweep loose run-artifacts (pipeline traces, result/spec dumps) at the
// repo root into .illuci/data/traces/<initiative-tag>/, derived from each artifact's metadata. The durable
// counterpart to a pipeline writing via traces/organizer.writeTrace at birth.
async function cmdTraces(rest) {
  const sub = rest[0];
  if (sub === "organize") {
    const { organizeLoose } = await import("../core/traces/organizer.js");
    const dirArg = rest.find((a) => a.startsWith("--dir="));
    const r = organizeLoose(process.cwd(), { dir: dirArg ? dirArg.slice("--dir=".length) : undefined });
    console.log(`traces organize: ${r.moved.length} artifact(s) filed` + (r.skipped.length ? `, ${r.skipped.length} skipped (name collision)` : ""));
    for (const [tag, n] of Object.entries(r.byTag).sort()) console.log(`  ${tag}: ${n}`);
    return;
  }
  console.error(`Unknown traces subcommand: ${sub || "(none)"}. Try: illuci traces organize [--dir=.]`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
