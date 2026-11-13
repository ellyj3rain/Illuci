#!/usr/bin/env node
/**
 * Gemini API capability-matrix smoke test (task #12).
 *
 * Two layers:
 *
 *  1. STRUCTURAL (always runs, no credential needed) — asserts the three
 *     transport-"api" Gemini ids are wired into capability-matrix.js exactly
 *     like gemini-local: present in MODELS, role-routable, and included in the
 *     write + execute mode predicates. Pure node:test + node:assert; no vitest
 *     (vitest is NOT installed in this worktree — capability-matrix.test.js
 *     imports it and cannot run here).
 *
 *  2. LIVE (gated on GEMINI_API_KEY / Vertex creds) — when a credential is
 *     present, isAvailable() flips true for the three ids and they appear in
 *     resolveRole()/getMatrix(). The actual HTTP completion is exercised by the
 *     post-key one-liner documented at the bottom of this file, since billing +
 *     network are operator-gated.
 *
 * Run:  node illuci/core/matrix/gemini-api-capability.smoke.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODELS,
  MODEL_CAPABILITIES,
  supportsMode,
  getModelsForMode,
  getModelRoles,
  isAvailable,
  resolveRole,
} from "./capability-matrix.js";

const API_IDS = ["gemini-3.5-flash", "gemini-3.1-pro", "gemini-3.1-flash-lite"];

test("the three api ids are registered in MODELS", () => {
  for (const id of API_IDS) {
    assert.ok(MODELS.includes(id), `${id} should be in MODELS`);
    assert.ok(MODEL_CAPABILITIES[id], `${id} should have a role table`);
  }
});

test("api ids are role-routable, mirroring gemini-local", () => {
  const localRoles = Object.keys(MODEL_CAPABILITIES["gemini-local"]).sort();
  for (const id of API_IDS) {
    const apiRoles = getModelRoles(id).map((r) => r.role).sort();
    assert.deepEqual(
      apiRoles,
      localRoles,
      `${id} should fill the same roles as gemini-local`,
    );
  }
});

test("api ids are in the write predicate", () => {
  const writers = getModelsForMode("write");
  for (const id of API_IDS) {
    assert.ok(supportsMode(id, "write"), `${id} should support write`);
    assert.ok(writers.includes(id), `${id} should be in getModelsForMode('write')`);
  }
});

test("api ids are in the execute predicate", () => {
  const exec = getModelsForMode("execute");
  for (const id of API_IDS) {
    assert.ok(supportsMode(id, "execute"), `${id} should support execute`);
    assert.ok(exec.includes(id), `${id} should be in getModelsForMode('execute')`);
  }
});

test("api ids do read/respond (any model) but never delegate (codex-only)", () => {
  for (const id of API_IDS) {
    assert.ok(supportsMode(id, "respond"), `${id} respond`);
    assert.ok(supportsMode(id, "read"), `${id} read`);
    assert.ok(!supportsMode(id, "delegate"), `${id} must NOT delegate`);
  }
});

test("availability tracks credential presence; live routing when keyed", () => {
  const keyed = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  for (const id of API_IDS) {
    assert.equal(
      isAvailable(id),
      keyed,
      `isAvailable('${id}') should equal credential-present=${keyed}`,
    );
  }
  if (keyed) {
    // With a credential, the api ids must surface as concurrent candidates for
    // a gemini role (analyst is priority-1 for the whole family).
    const analystModels = resolveRole("analyst").map((c) => c.model);
    for (const id of API_IDS) {
      assert.ok(analystModels.includes(id), `${id} should route for analyst when keyed`);
    }
    console.log("[smoke] GEMINI credential detected — api ids are live-routable.");
  } else {
    console.log("[smoke] no GEMINI credential — structural wiring verified; live routing gated.");
  }
});

/*
 * ─── POST-KEY LIVE SMOKE TEST (operator-gated on GEMINI_API_KEY) ───
 *
 * After setting a credential, run any/all of the 3-tag confirmation to prove
 * each registry id reaches the HTTP bridge and returns a real completion:
 *
 *   $env:GEMINI_API_KEY = "<key>"   # PowerShell  (bash: export GEMINI_API_KEY=...)
 *
 *   node illuci/cli/illuci.mjs run direct "ok" --model gemini-3.5-flash      --mutation-authority blocked
 *   node illuci/cli/illuci.mjs run direct "ok" --model gemini-3.1-pro        --mutation-authority blocked
 *   node illuci/cli/illuci.mjs run direct "ok" --model gemini-3.1-flash-lite --mutation-authority blocked
 *
 * Then re-run THIS harness with the key set to confirm isAvailable() flips and
 * the ids appear in resolveRole('analyst'):
 *
 *   node illuci/core/matrix/gemini-api-capability.smoke.mjs
 */
