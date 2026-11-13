/**
 * Illuci defaults registry.
 *
 * Anything Illuci does by default must be visible to operators and downstream
 * surfaces. Env-backed defaults derive from the same readers the runtime uses;
 * code-path defaults declare their canonical value here.
 */

import { isDrlEnabled } from "../resilience/config.js";
import { resolvePreflightMode } from "../preflight/config.js";
import { postureProfileSnapshot } from "./posture-profile.js";

export const DEFAULTS_SCHEMA = "illuci.governance.defaults/1";

export const DEFAULTS = Object.freeze([
  {
    id: "resilience-drl",
    title: "Dynamic-Resilience Layer (learned model health)",
    states: ["on", "off"],
    resolve: (env) => (isDrlEnabled(env) ? "on" : "off"),
    since: "A48",
    rationale:
      "Seating ranks live models by observed reliability and demotes lanes that fail hard. On by default so availability reflects what actually works.",
    change: { env: "ILLUCI_DRL_ENABLED=0", run: null, note: "engine-wide posture" },
  },
  {
    id: "preflight",
    title: "Pre-run readiness gate",
    states: ["off", "config", "probe"],
    resolve: (env) => resolvePreflightMode({}, env).mode,
    since: "A49/A50",
    rationale:
      "Config validates presets/topology/budget before step-off; probe also tests seat liveness. Config is default so malformed runs fail early.",
    change: { env: "ILLUCI_PREFLIGHT_ENABLED=0 | ILLUCI_PREFLIGHT_PROBE=1", run: "--preflight off|config|probe", note: "per-run selectable" },
  },
  {
    id: "run-control",
    title: "Run-control envelope",
    states: ["conducted/gated/directed", "derived", "ritual", "blocked", "checkpointed", "governed", "autonomous"],
    resolve: () => "conducted/gated/directed",
    since: "A58",
    rationale:
      "Agenda formation, mutation authority, and tool autonomy compose through one envelope. Defaults use conducted agenda planning, gated mutation authority, and directed tool autonomy.",
    change: { env: null, run: "--run-control JSON | --agenda | --mutation-authority | --tool-autonomy", note: "per-run" },
  },
  {
    id: "posture-profile",
    title: "Posture profile resolution",
    states: ["operatorProfile", "projectPolicy", "agentProfile", "productDefault", "versionBaseline"],
    resolve: (env) => postureProfileSnapshot({ env }).authority,
    since: "A59",
    rationale:
      "Version maturity is evidence, not authority. Illuci resolves justified gradient variables through operator/project/agent profiles before falling back to product defaults and the version baseline; no profile may remove basic agent competence.",
    change: {
      env: "ILLUCI_POSTURE_PROFILE | ILLUCI_PROJECT_POSTURE_POLICY | ILLUCI_AGENT_POSTURE_PROFILE",
      run: "profile/policy payload on the session, project, or selected orchestrator",
      note: "per-operator/project/session",
    },
  },
  {
    id: "adaptive",
    title: "Adaptive control cycle",
    states: ["on (conservative)", "off"],
    resolve: () => "on (conservative)",
    since: "A17.4",
    rationale: "Adaptive-capable by default with conservative bounds; pass adaptive:false to pin a run linear.",
    change: { env: null, run: "--adaptive false | adaptive policy object", note: "per-run" },
  },
  {
    id: "gate-posture",
    title: "Write-gate posture",
    states: ["ask", "accept-edits", "bypass"],
    resolve: () => "ask",
    since: "A58",
    rationale:
      "Gate posture is only approval behavior. Planning and non-mutation belong to run-control, not a separate plan posture.",
    change: { env: "ILLUCI_GATE_MODE", run: "--posture ask|accept-edits|bypass", note: "per-run" },
  },
  {
    id: "capability-floor",
    title: "Capability enforcement floor",
    states: ["enforce", "warn"],
    resolve: (env) => (String(env?.ILLUCI_CAPABILITY_MODE || "").toLowerCase() === "warn" ? "warn" : "enforce"),
    since: "A40",
    rationale: "Deny-by-default for the closed capability vocabulary; warn is the audited rollback hatch.",
    change: { env: "ILLUCI_CAPABILITY_MODE=warn", run: null, note: "engine-wide floor; grants, not code, lift it" },
  },
  {
    id: "genome-precedence",
    title: "Persona-genome composition wiring",
    states: ["off", "seed", "dominant", "pull"],
    resolve: () => "off",
    since: "A80",
    rationale:
      "A seated persona's accrued genome (replay of its sealed bases + ledger) can seat disposition composition. Off by default — dispatch is byte-identical until a run opts in. seed replaces the preset seed and re-applies role/skill pulls; dominant lets ledger-accrued facets win conflicts; pull folds genome deltas onto the live preset.",
    change: {
      env: null,
      run: "illuci run … --genome-project-dir PATH [--genome-precedence seed|dominant|pull] · run_topology_v1 { genome: { projectDir, precedence } } · API dispatchOpts.genome = { projectDir, precedence }",
      note: "per-run; requires a seated agentId (the agents/seatAgents manifest) + a preset seat; mutation itself stays napi-gated (DR-170 D6); run-reachable since A90/A90.1 (DR-183)",
    },
  },
  {
    id: "genome-child-identity",
    title: "Persona-genome child-identity threading",
    states: ["none", "inherit", "derive", "explicit"],
    resolve: () => "none",
    since: "A91",
    rationale:
      "What identity a spawned child run's seats carry — and therefore who learns from the child's work. ALL FOUR constructions are states of this one control (DR-182 D1, operator-ratified: \"All are optimal as options.\"). Default none: arming the parent's learning never silently extends it to children. inherit threads the parent's agents manifest + genome control through every child seam (seat spawn, recurse, company members, static nodes); derive mints a child persona per seated agent (<parentAgentId>-<childSeatId>, genome born from the parent's live compensated profile, genealogy staged into the atomic genesis); explicit accepts identity only from the spawn call's own args (refused under every other state).",
    change: {
      env: null,
      run: "illuci run … --genome-child-identity none|inherit|derive|explicit · run_topology_v1 { genome: { childIdentity } } · API dispatchOpts.genome.childIdentity = none|inherit|derive|explicit",
      note: "rides the genome arm (requires genome.projectDir); validated loudly at arm time and at every seam through one policy module (core/orchestrate/child-identity.js); all four states live since A92 (DR-185)",
    },
  },
  {
    id: "genome-seal-threshold",
    title: "Persona-genome auto-seal threshold",
    states: ["0 (off)", "N deltas"],
    resolve: () => "32",
    since: "A85",
    rationale:
      "When the genome control is on and learning accrues, the active ledger seals into the next immutable base (base/<n+1> = replay(base/<n>, segment)) once it reaches the threshold — opportunistic at the append seam, no worker process. 32 deltas at the 1/32 grade step bounds a single facet's un-sealed drift to one full unit.",
    change: {
      env: null,
      run: "illuci run … --genome-seal-threshold N · run_topology_v1 { genome: { sealThreshold } } · API dispatchOpts.genome.sealThreshold = N (0 disables)",
      note: "per-run; only meaningful when the genome control is on and the mutation kernel is built; run-reachable since A90/A90.1 (DR-183)",
    },
  },
  {
    id: "budget-cascade",
    title: "Token budget cascade (member caps, seat floors/caps, reseat floor)",
    states: ["off (flat company ceiling only)", "member cap", "seat floors + caps", "reseatingMin"],
    resolve: () => "off",
    since: "A96",
    rationale:
      "F-089: token/time budgets were flat — one company ceiling, no company→member(topology)→seat allocation. The WO-2 arbiter ruling's v1 slice (DR-189): an optional MEMBER cap, optional per-SEAT non-borrowable floors (reserved at topology start so a role-critical seat — arbiter, integrator, QA — cannot be starved by siblings that run first) and per-seat caps, plus a reseatingMin the DRL reseat consults (a reseat is blocked when the seat's remaining is below it; no runtime lift). The per-dispatch cap is DERIVED — min(configured, seat, member, company) — not a fourth pool. Weights and work-conserving spillover are deferred to v2 (the ruling: not until there are real starvation repros under armed caps). Per-seat/per-member spend is OBSERVED and emitted on every trace (trace.seatBudget) with zero control effect, configured or not. Default off: byte-identical to the flat-ceiling engine.",
    change: {
      env: null,
      run: "illuci run … --run-control '{\"budget\":{\"member\":{\"cap\":N},\"seats\":{\"<seat>\":{\"floor\":N,\"cap\":N}},\"reseatingMin\":N}}' · run_topology_v1 { runControl: { budget } } · API options.runControl.budget",
      note: "per-run; validated fail-closed by core/throttle/seat-budget.js (a malformed stanza throws, never a silent downgrade); floors that exceed the member cap fail closed at construction",
    },
  },
  {
    id: "genome-grading-sources",
    title: "Persona-genome grading sources (which lenses DIRECT learning)",
    states: ["tension (default)", "salient (opt-in; not attribution-grounded)", "behavioral (opt-in; outcome-grounded)"],
    resolve: () => "tension",
    since: "A101",
    rationale:
      "DR-193/DR-194/DR-195: a BALANCED disposition (zero tension pairs) composes, is measured, passes the DR-176 gates, and derives no delta — because delta DIRECTION came from the tension lens ALONE, though the ratified D3 (DR-170) is multi-lens. This control makes the direction sources explicit. TERMINAL-BY-DEFAULT (operator): default 'tension' only (byte-identical). OPTIONALITY: 'salient' (expressed-pole reinforcement) reinforces even a LOSING disposition — grade-gated, not attribution-grounded (autocatalysis, Rosa's DR-193 ruling); shipped wired + disclosed (DR-194). 'behavioral' ([A102]/DR-195, operator-commissioned per DR-194 §residual) is the outcome-grounded director: it reinforces expressed poles ONLY when the persona's accrued outcomes were substantive + gate-passing, and produces an honest null otherwise (the phase_outcome evidence pipeline it reads was built in the same batch). v1 is disposition-level (capped confidence — correlation, not per-facet causation); per-facet counterfactual discrimination is the disclosed v2 (design/genome-grader-attribution.md).",
    change: {
      env: null,
      run: "illuci run … --genome-grading-sources tension[,salient][,behavioral] · run_topology_v1 { genome: { gradingSources } } · API dispatchOpts.genome.gradingSources",
      note: "per-run; rides the genome arm (requires genome.projectDir); validated fail-closed by core/agents/genome-grading-sources.js; every learned delta carries its directing lenses (genome_appended.lenses), and a behavioral-directed delta carries its capped confidence + method (genome_appended.attribution)",
    },
  },
  {
    id: "cli-lane-sandbox",
    title: "CLI-agent lane workspace grounding (sandbox vs shared)",
    states: ["sandbox (per-dispatch scratch dir)", "shared (the engine workspace)"],
    resolve: (env) => (env.ILLUCI_CLI_LANE_WORKSPACE === "shared" ? "shared" : "sandbox"),
    since: "A108",
    rationale:
      "F-139: the CLI-backed model lanes (claude, grok-cli, gemini, kimi, agy) are AGENTIC HOSTS with their own shell/file tools — several run auto-approving (--yolo / --always-approve / workspace trust) — and those tools ground at the child process's cwd, entirely outside illuci's governed tool surface (which correctly gated its OWN seats while a grok-cli seat wrote scratch files into the engine checkout unobserved). DR-200 (operator-ratified 2026-07-11): every CLI-lane process grounds in a per-dispatch scratch directory by default, so default/relative writes and startup context-scanning cannot touch the engine workspace. Stated honestly: a GROUNDING boundary, not an OS jail — absolute-path writes by a determined agent remain possible; OS-level jailing is a different mechanism, named out of scope in DR-200.",
    change: {
      env: "ILLUCI_CLI_LANE_WORKSPACE=shared",
      run: "API dispatchOpts.cliWorkspace: \"shared\" (per dispatch); an explicit options.cwd on a bridge remains the stronger control where a bridge supports it (gemini)",
      note: "unknown values degrade LOUDLY to sandbox — for a safety boundary the safe side of a typo is isolation, never silent sharing",
    },
  },
  {
    id: "grok-lane-sandbox",
    title: "Grok CLI lane OS sandbox profile (strict vs opt-out)",
    states: ["strict (default; kernel-enforced on linux/macOS)", "workspace|read-only|devbox|<custom>", "off (illuci imposes none)"],
    resolve: (env) => {
      const v = typeof env.ILLUCI_GROK_SANDBOX === "string" ? env.ILLUCI_GROK_SANDBOX.trim().toLowerCase() : "";
      return v.length > 0 ? v : "strict";
    },
    since: "A115",
    rationale:
      "F-141: DR-200's per-dispatch cwd is a GROUNDING boundary, not a jail — a grok-composer dispatcher seat wrote its team's draft INTO the engine checkout via ABSOLUTE paths three session-log-proven times while correctly grounded. DR-202 ([A115], the DR-200 per-lane tool-flag residual, first move JAIL GROK): the grok lane now imposes grok's OWN kernel-enforced sandbox, defaulting to `strict` (read CWD + system paths; write CWD + ~/.grok + temp) — which closes BOTH the absolute-path write escape and the read-scope axis (the checkout and absolute credential stores become unreadable). grok receives context on the PROMPT channel, so strict does not starve it. HONESTY (F-142): grok's sandbox is kernel-enforced ONLY on Linux (Landlock) + macOS (Seatbelt); on Windows the flag is accepted but a SILENT NO-OP (empirically confirmed), so on win32 the only containment remains the DR-200 grounding boundary — the deployed Linux runtime is where the profile bites. The bridge warns once per process when a profile is requested on a non-enforcing platform.",
    change: {
      env: "ILLUCI_GROK_SANDBOX=<profile>  (off = illuci imposes none, grok self-resolves)",
      run: "API dispatchOpts.grokSandbox: \"<profile>\" (per dispatch) — precedence dispatch > env > default strict",
      note: "unsafe/garbage values degrade LOUDLY to strict; a custom profile named in ~/.grok/sandbox.toml passes through and grok fails CLOSED if it is missing, so pass-through cannot silently un-sandbox; enforced only on linux/macOS",
    },
  },
  {
    id: "cli-lane-auto-approve",
    title: "CLI-agent lane tool auto-approve (gated vs writeMode opt-in)",
    states: ["gated (default; no auto-approve flag emitted)", "auto-approve (caller sets writeMode: true)"],
    resolve: () => "gated",
    since: "A117",
    rationale:
      "F-144: gemini.js and kimi.js shipped the INVERTED writeMode test (`!== false`), so any caller that never set writeMode — `illuci chat`, bare API dispatch — spawned a full agentic host with every tool execution auto-approved (--approval-mode=yolo / --yolo). DR-204: auto-approve is OPT-IN on every CLI-agent lane, resolved through the ONE shared resolver (core/bridges/write-mode.js: literal writeMode === true, everything else gated) so the surfaces cannot drift apart again. The default is the gated mode each lane has always used for respond/read phase seats (gemini: --approval-mode=plan; kimi: print mode without --yolo; grok: no --always-approve; agy: --mode plan, opting into --mode accept-edits only under writeMode — [A118]). The topology runner is the one place that opts writers in (write/execute/delegate phases set writeMode: true); MCP dispatch derives it from the posture argument. claude.js needs no flag discipline — it is allowlist-shaped (--allowedTools Read,Glob,Grep unless widened); codex threads its own sandboxMode.",
    change: {
      env: null,
      run: "API dispatchOpts.writeMode: true (per dispatch) · topology write/execute/delegate phase seats (automatic) · MCP dispatch_v1 posture: \"bypass\" | \"accept-edits\"",
      note: "fail-closed: absent/false/garbage writeMode all resolve to gated; only literal true emits the lane's auto-approve flag (agy maps it to --mode accept-edits vs plan; agy's --dangerously-skip-permissions is never emitted)",
    },
  },
  {
    id: "agy-lane-sandbox",
    title: "Antigravity (agy) lane OS sandbox (terminal restrictions on vs off)",
    states: ["on (default; --sandbox: terminal restrictions + sandboxproxy CEL enforcer)", "off (illuci omits the flag)"],
    resolve: (env) => (String(env.ILLUCI_AGY_SANDBOX || "").trim().toLowerCase() === "off" ? "off" : "on"),
    since: "A118",
    rationale:
      "The DR-202 residual's agy slice (DR-205; F-145). agy is a full agentic host (Gemini 3.x / Claude / GPT-OSS via the AI Ultra OAuth) driven headless through a ConPTY, with native terminal + file tools — and the bridge previously spawned it with NO containment flag at all (the six-lane dossier: 'cooperative but pre-DR-200 only, absolute paths, no flags'). agy ships its OWN sandbox: `--sandbox` enables terminal restrictions plus a network sandboxproxy governed by a CEL policy enforcer (strings in the agy binary: sandboxproxy.celEnforcer, SandboxAllowNetwork, 'sandbox with terminal restrictions enabled'). It is an in-process Go subsystem — NOT the kernel-primitive model that makes grok's --sandbox a win32 no-op (F-142) — so it is expected to enforce cross-platform. illuci engages it by default; the disclosed opt-out omits the flag (agy then runs 'with full network and disk access', its own words). HONESTY: agy's --sandbox parses and the lane answers live through the ConPTY under it (proven); exhaustive per-command win32 block-verification was not performed this batch (named residual F-145).",
    change: {
      env: "ILLUCI_AGY_SANDBOX=off  (illuci omits --sandbox; agy runs unsandboxed)",
      run: "API dispatchOpts.agySandbox: \"off\" | false (per dispatch)",
      note: "default-on; the approval posture is the sibling cli-lane-auto-approve row (agy --mode plan|accept-edits, writeMode-gated)",
    },
  },
  {
    id: "worktree-sweep",
    title: "Repo worktree lifecycle sweep (plan vs apply)",
    states: ["plan (report-only)", "apply", "quarantine-and-sweep (dirty targets archived first)", "branches (merged-only cull)"],
    resolve: () => "plan",
    since: "A121",
    rationale:
      "F-148: every agent surface spawns git worktrees of the governed repo (Claude harness, Codex Desktop, JetBrains Air, bare CLI) and none owns a lifecycle — the 2026-07-16 manual sweep found 22 registered worktrees (16 of them 178-472 commits behind the authoritative head), 128 local branches (49 merged), and three hazard classes that make naive cleanup dangerous: junctions from session worktrees into UNRELATED real projects (recursive delete would eat the target), Windows long-path rubble that `git worktree remove` leaves behind, and orphan shells with no owner. DR-208: `illuci worktree sweep` is the governed lifecycle verb — plan by default (apply is explicit), the main/invoking/locked/unmerged worktrees are never swept under any flags, dirty worktrees are kept unless the explicit quarantine control archives their files (manifest + copies, [A116] preserve-the-deliverable) before removal, reparse points are unlinked LINK-ONLY before deletion, removal verifies the directory is actually gone (fs.rm -> win32 robocopy empty-mirror escalation), and the opt-in branch cull is `-d`-only against branches fully merged into the authoritative ref.",
    change: {
      env: null,
      run: "illuci worktree sweep [--apply] [--against REF] [--min-age-days N] [--min-behind N] [--quarantine-and-sweep --quarantine-root DIR] [--branches] [--repo DIR] [--json]",
      note: "per-invocation verb, never scheduled by the engine itself; defaults minAgeDays=7 minBehind=1 keepDirty=true; against resolves zero/main -> origin/main -> main",
    },
  },
]);

export function defaultsSnapshot(env = process.env) {
  return {
    schema: DEFAULTS_SCHEMA,
    disclosure: "Illuci's active default posture. Each row says what is default, why, and how to change it.",
    controls: DEFAULTS.map((d) => ({
      id: d.id,
      title: d.title,
      current: d.resolve(env),
      states: [...d.states],
      since: d.since,
      rationale: d.rationale,
      change: d.change,
    })),
  };
}

export function renderDefaults(env = process.env) {
  const snap = defaultsSnapshot(env);
  const lines = ["Illuci - active defaults (what runs unless you say otherwise):", ""];
  for (const c of snap.controls) {
    lines.push(`  ${c.title}`);
    lines.push(`    default: ${c.current}    (${c.states.join(" | ")})   [${c.since}]`);
    lines.push(`    why:     ${c.rationale}`);
    const how = c.change.run || c.change.env || c.change.note;
    if (how) lines.push(`    change:  ${how}`);
    lines.push("");
  }
  lines.push("Full detail: illuci defaults --json");
  return lines.join("\n");
}

export function defaultsNotice(env = process.env) {
  const on = defaultsSnapshot(env).controls.filter((c) => !["off", "conducted/gated/directed"].includes(c.current));
  return `Illuci defaults active: ${on.map((c) => `${c.id}=${c.current}`).join(", ")}. Run \`illuci defaults\` to see why and how to change each.`;
}

export const NOTICE_INTERVAL_MS = 24 * 3600 * 1000;

export function shouldShowNotice({ lastShownMs, now, quiet = false, intervalMs = NOTICE_INTERVAL_MS } = {}) {
  if (quiet) return false;
  if (!Number.isFinite(lastShownMs)) return true;
  return now - lastShownMs >= intervalMs;
}

export default { DEFAULTS, DEFAULTS_SCHEMA, defaultsSnapshot, renderDefaults, defaultsNotice };
