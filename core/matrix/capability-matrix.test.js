/**
 * Illuci — Capability Matrix Mode Support Tests
 *
 * Tests for execution mode capability checking (supportsMode, getModelsForMode).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MODEL_CAPABILITIES,
  supportsMode,
  getModelsForMode,
  MODELS,
  getModelRoles,
  resolveRole,
} from "./capability-matrix.js";

describe("mode capability detection", () => {
  it("all models support respond mode", () => {
    for (const model of MODELS) {
      assert.ok(supportsMode(model, "respond"), `${model} should support respond`);
    }
  });

  it("all models support read mode", () => {
    for (const model of MODELS) {
      assert.ok(supportsMode(model, "read"), `${model} should support read`);
    }
  });

  it("frontier tier supports write mode", () => {
    const writeCapable = ["claude-local", "codex-local", "gemini-local", "kimi-cloud", "grok-build"];
    for (const model of writeCapable) {
      assert.ok(supportsMode(model, "write"), `${model} should support write`);
    }
  });

  it("base tier models may not support write mode", () => {
    const notWriteCapable = ["grok", "deepseek"];
    for (const model of notWriteCapable) {
      assert.ok(!supportsMode(model, "write"), `${model} should not support write`);
    }
  });

  it("frontier tier supports execute mode", () => {
    const executeCapable = ["claude-local", "codex-local", "gemini-local", "grok", "kimi-cloud", "grok-build"];
    for (const model of executeCapable) {
      assert.ok(supportsMode(model, "execute"), `${model} should support execute`);
    }
  });

  it("only codex supports delegate mode", () => {
    assert.ok(supportsMode("codex-local", "delegate"), "codex-local should support delegate");
    
    // All other models should not support delegate
    const nonDelegate = MODELS.filter(m => m !== "codex-local");
    for (const model of nonDelegate) {
      assert.ok(!supportsMode(model, "delegate"), `${model} should not support delegate`);
    }
  });

  it("getModelsForMode returns correct sets", () => {
    const respondModels = getModelsForMode("respond");
    const writeModels = getModelsForMode("write");
    const delegateModels = getModelsForMode("delegate");

    // All models support respond
    assert.equal(respondModels.length, MODELS.length);

    // Write is subset of all models
    assert.ok(writeModels.length < MODELS.length);
    assert.ok(writeModels.includes("codex-local"));
    assert.ok(writeModels.includes("claude-local"));

    // Only codex supports delegate
    assert.equal(delegateModels.length, 1);
    assert.equal(delegateModels[0], "codex-local");
  });
});

describe("mode capability edge cases", () => {
  it("returns false for unknown model", () => {
    assert.ok(!supportsMode("unknown-model", "respond"));
    assert.ok(!supportsMode("unknown-model", "write"));
    assert.ok(!supportsMode("unknown-model", "delegate"));
  });

  it("returns false for unknown mode", () => {
    assert.ok(!supportsMode("claude-local", "unknown-mode"));
  });
});


describe("fleet routing policy", () => {
  it("does not carry methodology prompt fields in matrix role entries", () => {
    for (const [model, roles] of Object.entries(MODEL_CAPABILITIES)) {
      for (const [role, entry] of Object.entries(roles)) {
        assert.ok(!Object.hasOwn(entry, "promptFile"), `${model}/${role} should not carry promptFile`);
        assert.ok(!Object.hasOwn(entry, "prompt"), `${model}/${role} should not carry prompt`);
      }
    }
  });

  it("makes Grok, Composer, and Ollama Kimi role-routable", () => {
    for (const model of ["grok-cli", "grok-build", "grok-composer-2.5-fast", "kimi-cloud"]) {
      assert.ok(getModelRoles(model).length > 0, model + " should have role coverage");
    }

    assert.equal(getModelRoles("kimi-local").length, 0, "Moonshot Kimi stays explicit-lineup only");
    assert.ok(resolveRole("analyst").some((candidate) => candidate.model === "kimi-cloud"));
    assert.ok(!resolveRole("analyst").some((candidate) => candidate.model === "qwen-code"), "Qwen Code should not be a general analyst default");
  });
});


function withFakeAgy(fn) {
  const prior = process.env.AGY_PATH;
  const dir = mkdtempSync(join(tmpdir(), "illuci-matrix-agy-"));
  const fakeAgy = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(fakeAgy, "");
  process.env.AGY_PATH = fakeAgy;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("routing availability honesty", () => {
  it("does not auto-select legacy claude-local when Claude is requested by role", () => withFakeAgy(() => {
    const architects = resolveRole("architect").map((candidate) => candidate.model);

    assert.ok(architects.includes("claude-opus"));
    assert.ok(!architects.includes("claude-local"));
  }));

  it("keeps general Qwen separate from Qwen Code in role coverage", () => {
    assert.ok(getModelRoles("qwen3.5").some((entry) => entry.role === "analyst"));
    assert.ok(!resolveRole("analyst").some((candidate) => candidate.model === "qwen-code"));
    assert.ok(resolveRole("analyst").some((candidate) => candidate.model === "qwen3.5"));
  });
});
