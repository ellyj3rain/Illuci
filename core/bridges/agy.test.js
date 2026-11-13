import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgyPrompt, buildAgyArgs, classifyAgyPromptArg, query } from "./agy.js";

// ── [A118]/DR-205 — agy containment: --sandbox default-on, --mode fail-closed ──
// The helper (agy_pty.py) is the first arg; outFile the second; we assert on the
// containment flags that follow, independent of the absolute helper path.
function flagsOf(args) {
  // drop [helperPath, outFile]; return the remaining agy argv
  return args.slice(2);
}

test("buildAgyArgs: default engages --sandbox and fails mode closed to plan", () => {
  const args = buildAgyArgs("out.txt", "hi", "M", "60s", {}, {});
  const f = flagsOf(args);
  assert.ok(f.includes("--sandbox"), "sandbox must be default-on");
  const mi = f.indexOf("--mode");
  assert.equal(f[mi + 1], "plan", "mode must fail closed to plan");
  assert.ok(!f.includes("--dangerously-skip-permissions"), "must never emit the yolo flag");
  // prompt/model/timeout still threaded
  assert.equal(f[f.indexOf("--print") + 1], "hi");
  assert.equal(f[f.indexOf("--model") + 1], "M");
  assert.equal(f[f.indexOf("--print-timeout") + 1], "60s");
});

test("buildAgyArgs: writeMode:true opts into --mode accept-edits (sandbox still on)", () => {
  const f = flagsOf(buildAgyArgs("out.txt", "hi", "M", "60s", { writeMode: true }, {}));
  assert.equal(f[f.indexOf("--mode") + 1], "accept-edits");
  assert.ok(f.includes("--sandbox"));
  assert.ok(!f.includes("--dangerously-skip-permissions"));
});

test("buildAgyArgs: sandbox opt-out omits --sandbox (option and env)", () => {
  assert.ok(!flagsOf(buildAgyArgs("o", "p", "M", "60s", { agySandbox: "off" }, {})).includes("--sandbox"));
  assert.ok(!flagsOf(buildAgyArgs("o", "p", "M", "60s", { agySandbox: false }, {})).includes("--sandbox"));
  assert.ok(!flagsOf(buildAgyArgs("o", "p", "M", "60s", {}, { ILLUCI_AGY_SANDBOX: "off" })).includes("--sandbox"));
  // a dispatch option overrides the env (present option wins)
  assert.ok(flagsOf(buildAgyArgs("o", "p", "M", "60s", { agySandbox: "on" }, { ILLUCI_AGY_SANDBOX: "off" })).includes("--sandbox"));
});

test("buildAgyArgs: explicit mode override + unknown value degrades to plan", () => {
  assert.equal(flagsOf(buildAgyArgs("o", "p", "M", "60s", { agyMode: "accept-edits" }, {}))[
    flagsOf(buildAgyArgs("o", "p", "M", "60s", { agyMode: "accept-edits" }, {})).indexOf("--mode") + 1
  ], "accept-edits");
  const env = flagsOf(buildAgyArgs("o", "p", "M", "60s", {}, { ILLUCI_AGY_MODE: "plan" }));
  assert.equal(env[env.indexOf("--mode") + 1], "plan");
  const bad = flagsOf(buildAgyArgs("o", "p", "M", "60s", { agyMode: "yolo-please" }, {}));
  assert.equal(bad[bad.indexOf("--mode") + 1], "plan", "unknown mode fails closed to plan");
});

test("buildAgyPrompt folds prior session into the single-turn prompt", () => {
  const prompt = buildAgyPrompt("current", {
    sessionState: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
  });

  assert.equal(
    prompt,
    "Prior conversation:\n[user]: hello\n\n[assistant]: world\n\n---\n\nCurrent message:\ncurrent"
  );
});

test("buildAgyPrompt prefixes the system prompt", () => {
  const prompt = buildAgyPrompt("current", { systemPrompt: "system" });

  assert.equal(prompt, "system\n\n---\n\ncurrent");
});

test("classifyAgyPromptArg accepts prompts inside the configured limit", () => {
  assert.deepEqual(classifyAgyPromptArg("abc", { promptArgLimit: 3 }), {
    ok: true,
    length: 3,
    limit: 3,
    reason: null,
  });
});

test("classifyAgyPromptArg reports command-line-limit for oversized prompts", () => {
  assert.deepEqual(classifyAgyPromptArg("abcd", { promptArgLimit: 3 }), {
    ok: false,
    length: 4,
    limit: 3,
    reason: "command-line-limit",
  });
});

test("query fails before spawning when the folded prompt is too large", async () => {
  await assert.rejects(
    () => query("abcd", { promptArgLimit: 3 }),
    (err) => {
      assert.equal(err.code, "AGY_PROMPT_TOO_LONG");
      assert.deepEqual(err.details, {
        ok: false,
        length: 4,
        limit: 3,
        reason: "command-line-limit",
      });
      return true;
    }
  );
});
