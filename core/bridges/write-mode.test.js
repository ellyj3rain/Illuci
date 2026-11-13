// DR-204/F-144 — CLI-agent lane auto-approve is opt-in, fail-closed.
// Unit surface + the source-grep guard (the F-138 lesson: guard the seam where
// it lives, so the inverted `writeMode !== false` form can never come back).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { autoApproveEnabled } from "./write-mode.js";
import { DEFAULTS } from "../governance/defaults-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test("autoApproveEnabled: only literal true opts in — everything else is gated", () => {
  assert.equal(autoApproveEnabled({ writeMode: true }), true);
  assert.equal(autoApproveEnabled({ writeMode: false }), false);
  assert.equal(autoApproveEnabled({}), false);
  assert.equal(autoApproveEnabled(), false);
  assert.equal(autoApproveEnabled({ writeMode: undefined }), false);
  assert.equal(autoApproveEnabled({ writeMode: null }), false);
  assert.equal(autoApproveEnabled({ writeMode: "true" }), false);
  assert.equal(autoApproveEnabled({ writeMode: 1 }), false);
});

// ── SOURCE-GREP GUARD: the flag-emitting CLI bridges resolve auto-approve through
// the ONE shared resolver, and no CLI bridge carries the inverted fail-open form. ──
const FLAG_BRIDGES = ["gemini.js", "kimi.js", "grok-cli.js", "agy.js"];
const ALL_CLI_BRIDGES = [...FLAG_BRIDGES, "claude.js", "codex.js"];

test("GUARD: gemini/kimi/grok/agy resolve auto-approve via autoApproveEnabled(options)", () => {
  for (const rel of FLAG_BRIDGES) {
    const src = readFileSync(join(HERE, rel), "utf8");
    assert.match(
      src,
      /autoApproveEnabled\(options\)/,
      `${rel} must resolve its auto-approve flag through the shared DR-204 resolver`,
    );
  }
});

test("GUARD: no CLI bridge carries the inverted fail-open writeMode test", () => {
  for (const rel of ALL_CLI_BRIDGES) {
    const src = readFileSync(join(HERE, rel), "utf8");
    assert.doesNotMatch(
      src,
      /writeMode\s*!==?\s*false/,
      `${rel}: \`writeMode !== false\` is the F-144 fail-open inversion — auto-approve must require === true`,
    );
  }
});

test("GUARD: claude.js keeps its read-only allowlist default", () => {
  const src = readFileSync(join(HERE, "claude.js"), "utf8");
  assert.match(
    src,
    /options\.allowedTools \|\| "Read,Glob,Grep"/,
    "claude.js is allowlist-shaped: read-only unless the caller widens (the dossier's self-jailed verdict)",
  );
});

test("the posture is a disclosed defaults-registry row (DR-130)", () => {
  const row = DEFAULTS.find((d) => d.id === "cli-lane-auto-approve");
  assert.ok(row, "cli-lane-auto-approve must be a disclosed defaults-registry row");
  assert.equal(row.resolve({}), "gated");
  assert.match(row.change.run, /writeMode/);
});
