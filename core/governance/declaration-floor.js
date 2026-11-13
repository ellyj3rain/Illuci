// The declaration floor — four definitional declaration→consumption checks (DR-190).
//
// WHAT THIS IS (and is deliberately named): `governance:declaration-floor` — an
// interim derived mechanical FLOOR under DR-116's Declaration Contract. It is
// NOT "the declarations gate": it proves STRUCTURAL LINKAGE for exactly four
// classes where consumption evidence is nearly definitional, and nothing more.
// Behavioral correctness, flag dataflow, description semantics, and prose
// capability claims belong to the North-Star agentic consistency probe.
//
// The four v1 classes (the WO-3 arbiter ruling):
//   L1 package scripts   → every path-shaped token resolves to a real file
//   L2 registry bridges  → every model-registry bridge file exists
//   L3 CLI verbs         → every help-declared verb has a dispatch case
//   L4 MCP tools         → every registered tool has a unique name + a handler
//
// Hard constraints (ruled, not optional):
//   - No hand-maintained declaration catalog as authority: every check derives
//     from the runtime structure that would have to load the declared thing.
//   - Exemptions are operator-ratified PINS, printed loudly as PINNED-DARK on
//     every run. A pin whose subject has come alive is a STALE PIN — a gate
//     FAILURE, not a silent pass (a stale pin hiding a live path is a
//     governance lie; treat the pin file as an attack surface).
//   - Kill criteria named at design time: if pins exceed KILL_RATIO of checked
//     surfaces the gate DISARMS BY DESIGN and fails with instructions to log a
//     finding — a floor drowning in exemptions is research data, not a gate.
//     (The ruling's second criterion — the pin file edited in consecutive
//     batches without a fix — is a review obligation recorded in DR-190; its
//     mechanical form needs git-history depth CI can't guarantee, so it is
//     named here rather than silently dropped.)
//   - No warn-only path: the gate is either green or a loud exit 1.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FLOOR_SCHEMA = "illuci.governance.declaration-floor/1";
export const PINS_SCHEMA = "illuci.governance.declaration-floor-pins/1";
export const KILL_RATIO = 0.1; // pins / checked surfaces above this → disarmed-by-design

const CLASSES = Object.freeze(["package-scripts", "registry-bridges", "cli-verbs", "mcp-tools"]);

function repoRootDefault() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// ── pins ───────────────────────────────────────────────────────────────────

export function loadPins(repoRoot) {
  const p = resolve(repoRoot, "core", "governance", "declaration-floor-pins.json");
  if (!existsSync(p)) return { pins: [] };
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  if (parsed?.schema !== PINS_SCHEMA) {
    throw new Error(`declaration-floor: pins schema must be "${PINS_SCHEMA}"`);
  }
  const pins = Array.isArray(parsed.pins) ? parsed.pins : [];
  for (const pin of pins) {
    if (!pin?.subject || !CLASSES.includes(pin?.class) || !pin?.reason || !pin?.ratified) {
      throw new Error(`declaration-floor: every pin needs subject + class (${CLASSES.join("|")}) + reason + ratified`);
    }
  }
  return { pins };
}

// ── L1: package scripts → path-shaped tokens exist ─────────────────────────

const PATHISH = /^[A-Za-z0-9_@][A-Za-z0-9_.@/-]*\.(?:mjs|cjs|js|json|py|sh|ts)$/;

export function checkPackageScripts(repoRoot, { scripts } = {}) {
  const src = scripts ?? JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts ?? {};
  const violations = [];
  let checked = 0;
  for (const [name, cmd] of Object.entries(src)) {
    for (const token of String(cmd).split(/\s+/)) {
      if (!token.includes("/") || token.startsWith("-") || !PATHISH.test(token)) continue;
      checked += 1;
      if (!existsSync(resolve(repoRoot, token))) {
        violations.push({ class: "package-scripts", subject: `${name} → ${token}`, detail: `script "${name}" names ${token}, which does not exist` });
      }
    }
  }
  return { class: "package-scripts", checked, violations };
}

// ── L2: model-registry bridge files exist ──────────────────────────────────

export async function checkRegistryBridges(repoRoot, { entries } = {}) {
  let all = entries;
  if (!all) {
    const mod = await import(pathToFileURL(resolve(repoRoot, "core/bridges/model-registry.js")).href);
    all = [...(mod.MODEL_REGISTRY || []), ...(mod.NVIDIA_NIM_MANIFEST || [])];
  }
  const bridges = new Set();
  const collect = (e) => {
    if (e?.bridge) bridges.add(e.bridge);
    for (const ch of e?.channels || []) if (ch?.bridge) bridges.add(ch.bridge);
  };
  for (const e of all) collect(e);
  const violations = [];
  for (const b of bridges) {
    if (!existsSync(resolve(repoRoot, "core/bridges", b))) {
      violations.push({ class: "registry-bridges", subject: b, detail: `registry names bridge ${b}; core/bridges/${b} does not exist` });
    }
  }
  return { class: "registry-bridges", checked: bridges.size, violations };
}

// ── L3: help-declared CLI verbs → dispatch cases ───────────────────────────

export function checkCliVerbs(repoRoot, { source } = {}) {
  const text = source ?? readFileSync(resolve(repoRoot, "cli/illuci.mjs"), "utf8");
  // Declared surface: EVERY Verbs block — the file-header comment (lines "* illuci <verb>")
  // and the help() template (lines "  illuci <verb>") both declare verbs; both are checked.
  const declared = new Set();
  for (const block of text.matchAll(/Verbs:\n([\s\S]*?)\n\s*\n/g)) {
    for (const line of block[1].split("\n")) {
      const m = line.match(/^\s*(?:\*\s*)?illuci\s+([a-z][a-z0-9-]*)/);
      if (m) declared.add(m[1]);
    }
  }
  if (declared.size === 0) {
    // A silent no-op check is the dishonesty this floor exists to kill: zero
    // derived declarations means the derivation source moved — fail, never pass.
    return { class: "cli-verbs", checked: 0, violations: [{ class: "cli-verbs", subject: "cli/illuci.mjs", detail: "derived ZERO declared verbs — the Verbs-block derivation source moved; update the floor" }] };
  }
  // Consumption: `case "<verb>":` anywhere in the dispatcher (the runtime structure
  // that loads a verb) — plus the TUI launch special-case (bare/`tui` handled pre-switch).
  const cases = new Set();
  for (const m of text.matchAll(/case\s+"([a-z][a-z0-9-]*)"/g)) cases.add(m[1]);
  const special = new Set(["tui"]);
  for (const m of text.matchAll(/verb\s*===\s*"([a-z][a-z0-9-]*)"/g)) special.add(m[1]);
  const violations = [];
  for (const verb of declared) {
    if (!cases.has(verb) && !special.has(verb)) {
      violations.push({ class: "cli-verbs", subject: verb, detail: `help declares "illuci ${verb}" but no dispatch case consumes it` });
    }
  }
  return { class: "cli-verbs", checked: declared.size, violations };
}

// ── L4: MCP registration spread → tool modules with named handlers ─────────

export async function checkMcpTools(repoRoot, { toolSets } = {}) {
  let sets = toolSets;
  if (!sets) {
    const src = readFileSync(resolve(repoRoot, "core/mcp/server.js"), "utf8");
    const spread = src.match(/for \(const tool of \[([^\]]+)\]\)/);
    if (!spread) {
      return { class: "mcp-tools", checked: 0, violations: [{ class: "mcp-tools", subject: "server.js", detail: "could not locate the tool registration spread — the derivation source moved; update the floor" }] };
    }
    const arrayNames = [...spread[1].matchAll(/\.\.\.([A-Z_]+)/g)].map((m) => m[1]);
    const importsOf = {};
    for (const m of src.matchAll(/import \{ ([A-Z_]+) \} from '\.\/([\w.-]+)';/g)) importsOf[m[1]] = m[2];
    sets = [];
    for (const name of arrayNames) {
      const file = importsOf[name];
      if (!file) {
        sets.push({ name, tools: null, error: `registration spreads ${name} but no import binds it` });
        continue;
      }
      const mod = await import(pathToFileURL(resolve(repoRoot, "core/mcp", file)).href);
      sets.push({ name, tools: mod[name] ?? null, error: mod[name] ? null : `${file} does not export ${name}` });
    }
  }
  const violations = [];
  const seen = new Set();
  let checked = 0;
  for (const set of sets) {
    if (set.error || !Array.isArray(set.tools)) {
      violations.push({ class: "mcp-tools", subject: set.name, detail: set.error || `${set.name} is not an array` });
      continue;
    }
    for (const tool of set.tools) {
      checked += 1;
      const label = `${set.name}:${tool?.name ?? "(unnamed)"}`;
      if (!tool?.name || typeof tool.name !== "string") {
        violations.push({ class: "mcp-tools", subject: label, detail: "registered tool has no name" });
        continue;
      }
      if (seen.has(tool.name)) violations.push({ class: "mcp-tools", subject: tool.name, detail: "duplicate tool name in the registration table" });
      seen.add(tool.name);
      if (typeof tool.handler !== "function") {
        violations.push({ class: "mcp-tools", subject: tool.name, detail: "registered tool has no handler function" });
      }
    }
  }
  return { class: "mcp-tools", checked, violations };
}

// ── the floor ──────────────────────────────────────────────────────────────

export async function runFloor({ repoRoot = repoRootDefault(), inject = {} } = {}) {
  const { pins } = inject.pins ? { pins: inject.pins } : loadPins(repoRoot);
  const results = [
    checkPackageScripts(repoRoot, inject),
    await checkRegistryBridges(repoRoot, inject),
    checkCliVerbs(repoRoot, inject),
    await checkMcpTools(repoRoot, inject),
  ];
  const checked = results.reduce((s, r) => s + r.checked, 0);

  // Kill criterion 1 (mechanical): pins may not exceed KILL_RATIO of checked surfaces.
  if (checked > 0 && pins.length / checked > KILL_RATIO) {
    return {
      ok: false,
      code: "disarmed-by-design",
      checked,
      pinnedDark: [],
      violations: [{ class: "kill-criteria", subject: "pins", detail: `${pins.length} pins over ${checked} checked surfaces exceeds KILL_RATIO ${KILL_RATIO} — the floor is drowning in exemptions; log a FINDING and redesign, do not keep exempting` }],
      results,
    };
  }

  const pinKey = (c, s) => `${c}\0${s}`;
  const pinned = new Map(pins.map((p) => [pinKey(p.class, p.subject), p]));
  const consumedPins = new Set();
  const live = [];
  const pinnedDark = [];
  for (const r of results) {
    for (const v of r.violations) {
      const pin = pinned.get(pinKey(v.class, v.subject));
      if (pin) {
        consumedPins.add(pinKey(v.class, v.subject));
        pinnedDark.push({ ...v, reason: pin.reason, ratified: pin.ratified });
      } else {
        live.push(v);
      }
    }
  }

  // STALE PINS: a pin with no matching violation means its subject came alive
  // without re-ratification — that is a FAILURE (the ruling's attack-surface law).
  for (const p of pins) {
    if (!consumedPins.has(pinKey(p.class, p.subject))) {
      live.push({ class: p.class, subject: p.subject, detail: `STALE PIN: the pinned subject no longer violates — it is alive; remove the pin (re-ratify reality), do not let a dead exemption shadow a live path` });
    }
  }

  return { ok: live.length === 0, code: live.length ? "violations" : "clean", checked, pinnedDark, violations: live, results };
}

// ── CLI: `node core/governance/declaration-floor.js [--check]` ─────────────
async function main() {
  const r = await runFloor({});
  for (const p of r.pinnedDark) {
    console.log(`PINNED-DARK [${p.class}] ${p.subject} — ${p.reason} (ratified: ${p.ratified})`);
  }
  const byClass = r.results.map((x) => `${x.class}:${x.checked}`).join(" ");
  if (r.ok) {
    console.log(`declaration-floor: OK (${r.checked} surfaces — ${byClass}${r.pinnedDark.length ? `; ${r.pinnedDark.length} PINNED-DARK` : ""})`);
    return 0;
  }
  console.error(`declaration-floor: ${r.code === "disarmed-by-design" ? "DISARMED-BY-DESIGN" : "FAIL"} — ${r.violations.length} violation(s):`);
  for (const v of r.violations) console.error(`  - [${v.class}] ${v.subject}: ${v.detail}`);
  console.error("A declaration must be consumed by the structure that loads it, pinned (operator-ratified, loud), or removed.");
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
