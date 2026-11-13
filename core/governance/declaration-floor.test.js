// node:test — the declaration floor (DR-190): four definitional classes, loud
// pins, stale-pin failure, kill criteria, and the zero-derived honesty guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KILL_RATIO,
  loadPins,
  checkPackageScripts,
  checkRegistryBridges,
  checkCliVerbs,
  checkMcpTools,
  runFloor,
} from "./declaration-floor.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── live-repo proof: the shipped tree passes its own floor ─────────────────

test("live: all four classes derive real surfaces and pass", async () => {
  const r = await runFloor({ repoRoot });
  assert.equal(r.code, "clean");
  assert.equal(r.ok, true);
  for (const c of r.results) {
    assert.ok(c.checked > 0, `${c.class}: derived ${c.checked} surfaces (a zero-derived class is a silent no-op)`);
  }
  assert.deepEqual(r.pinnedDark, [], "v1 ships with zero pins");
});

test("live: the pins file loads and is empty (zero exemptions at v1)", () => {
  assert.deepEqual(loadPins(repoRoot).pins, []);
});

// ── L1 package scripts ─────────────────────────────────────────────────────

test("L1: a script naming a missing file is a violation; flags and bare words are not path tokens", () => {
  const r = checkPackageScripts(repoRoot, {
    scripts: {
      good: "node core/governance/declaration-floor.js --check",
      bad: "node scripts/does-not-exist.mjs",
      flags: "vitest run --config nope.config.js.disabled --reporter=dot",
    },
  });
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].subject, /bad → scripts\/does-not-exist\.mjs/);
});

// ── L2 registry bridges ────────────────────────────────────────────────────

test("L2: a registry entry (or channel) naming a missing bridge file fails", async () => {
  const r = await checkRegistryBridges(repoRoot, {
    entries: [
      { id: "x", bridge: "ollama.js" },
      { id: "y", bridge: "ghost-bridge.js", channels: [{ bridge: "phantom.js" }] },
    ],
  });
  assert.equal(r.violations.length, 2);
  const subjects = r.violations.map((v) => v.subject).sort();
  assert.deepEqual(subjects, ["ghost-bridge.js", "phantom.js"]);
});

// ── L3 CLI verbs ───────────────────────────────────────────────────────────

test("L3: a help-declared verb with no dispatch case is a violation", () => {
  const src = `/* header */\nfunction help() {\n  console.log(\`x\nVerbs:\n  illuci real ...\n  illuci phantom ...\n\n\`);\n}\nswitch (verb) {\n  case "real": break;\n}\n`;
  const r = checkCliVerbs(repoRoot, { source: src });
  assert.equal(r.checked, 2);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].subject, "phantom");
});

test("L3: comment-block Verbs lines (* illuci x) are declarations too", () => {
  const src = `/*\nVerbs:\n *   illuci commented ...\n\n*/\nswitch (v) { case "other": break; }\n`;
  const r = checkCliVerbs(repoRoot, { source: src });
  assert.equal(r.checked, 1);
  assert.equal(r.violations[0].subject, "commented");
});

test("L3: zero derived declarations FAILS (the silent no-op guard)", () => {
  const r = checkCliVerbs(repoRoot, { source: "switch (v) { case \"a\": break; }" });
  assert.equal(r.checked, 0);
  assert.match(r.violations[0].detail, /derived ZERO/);
});

// ── L4 MCP tools ───────────────────────────────────────────────────────────

test("L4: unnamed, duplicate, and handlerless tools are violations", async () => {
  const r = await checkMcpTools(repoRoot, {
    toolSets: [
      { name: "GOOD_TOOLS", tools: [{ name: "a_v1", handler: () => {} }] },
      { name: "BAD_TOOLS", tools: [{ handler: () => {} }, { name: "a_v1", handler: () => {} }, { name: "b_v1" }] },
    ],
  });
  const details = r.violations.map((v) => v.detail).join("\n");
  assert.match(details, /no name/);
  assert.match(details, /duplicate tool name/);
  assert.match(details, /no handler function/);
});

// ── pins: loud, stale-failing, kill-bounded ────────────────────────────────

// 12 checked surfaces so ONE pin (1/12 ≈ 8%) sits under KILL_RATIO and the
// pin/stale logic is exercised; TWO pins (17%) trip the kill criterion.
const FIX_INJECT = {
  scripts: {
    bad: "node scripts/gone.mjs",
    ok1: "node core/governance/declaration-floor.js",
    ok2: "node core/governance/design-index.js",
    ok3: "node core/governance/readme-freshness.js",
  },
  entries: [{ id: "x", bridge: "ollama.js" }],
  source: "Verbs:\n  illuci real ...\n\nswitch (v) { case \"real\": break; }",
  toolSets: [{ name: "T", tools: Array.from({ length: 6 }, (_, i) => ({ name: `t${i}_v1`, handler: () => {} })) }],
};

test("a ratified pin suppresses its violation LOUDLY (PINNED-DARK), gate green", async () => {
  const r = await runFloor({
    repoRoot,
    inject: { ...FIX_INJECT, pins: [{ class: "package-scripts", subject: "bad → scripts/gone.mjs", reason: "fixture", ratified: "operator 2026-07-10" }] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.pinnedDark.length, 1);
  assert.equal(r.pinnedDark[0].reason, "fixture");
});

test("a STALE pin (subject no longer violating) FAILS the gate", async () => {
  // The bad script is FIXED (removed) but its pin remains — the pin is now stale.
  const { bad, ...fixedScripts } = FIX_INJECT.scripts;
  const r = await runFloor({
    repoRoot,
    inject: { ...FIX_INJECT, scripts: fixedScripts, pins: [{ class: "package-scripts", subject: "bad → scripts/gone.mjs", reason: "fixture", ratified: "operator" }] },
  });
  assert.equal(r.ok, false);
  assert.match(r.violations[0].detail, /STALE PIN/);
});

test("kill criterion: pins over KILL_RATIO of checked surfaces disarms by design", async () => {
  const pins = Array.from({ length: 2 }, (_, i) => ({ class: "package-scripts", subject: `p${i}`, reason: "x", ratified: "op" }));
  const r = await runFloor({ repoRoot, inject: { ...FIX_INJECT, pins } });
  // FIX_INJECT derives few surfaces; 2 pins exceed 10% of them.
  assert.equal(r.code, "disarmed-by-design");
  assert.equal(r.ok, false);
  assert.ok(KILL_RATIO === 0.1, "the named threshold is part of the design");
});
