/**
 * illuci — Fleet Settings store tests (P5 of DR-134).
 *
 * Hermetic: each test redirects the home leaf to a fresh temp dir by setting
 * USERPROFILE/HOME BEFORE importing the module under test. resolveIlluciHomeDir
 * calls os.homedir() at call time, and os.homedir() honors USERPROFILE on
 * Windows / HOME on POSIX, so the store lands under the temp leaf and never
 * touches the real ~/.illuci. _resetFleetSettingsCache() clears the module cache
 * between assertions.
 *
 * Run: node --test illuci/core/config/fleet-settings.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Redirect the home leaf to a throwaway temp dir for the whole file BEFORE the
// module under test is imported (it resolves the path at call time, so this is
// honored on every load()).
const TEMP_HOME = mkdtempSync(join(tmpdir(), "illuci-fleet-settings-"));
process.env.USERPROFILE = TEMP_HOME;
process.env.HOME = TEMP_HOME;

const SETTINGS_FILE = join(TEMP_HOME, ".illuci", "fleet", "settings.json");

const mod = await import("./fleet-settings.js");
const {
  isPruned,
  getFleetSettings,
  listCuratedFleet,
  pruneModel,
  restoreModel,
  _resetFleetSettingsCache,
} = mod;

/** Remove the store file + cache so each test starts from a clean first-load. */
function freshStore() {
  _resetFleetSettingsCache();
  if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
}

test("default seed materializes the operator's named four on first load", () => {
  freshStore();
  const settings = getFleetSettings();
  assert.equal(settings.schemaVersion, 1);
  const pruned = settings.curation.pruned;
  for (const id of ["qwen-code", "qwen3.5", "ollama"]) {
    assert.ok(pruned[id], `expected ${id} in default seed`);
    assert.equal(pruned[id].source, "operator-curation");
  }
  // The seed was persisted to disk (file materialized, never re-seeded later).
  assert.ok(existsSync(SETTINGS_FILE), "seed should be written on first load");
});

test("isPruned canonicalizes any known spelling (alias check)", () => {
  freshStore();
  // glm carries alias "glm-5:cloud" in the registry. Prune by canonical id...
  const res = pruneModel("glm", { reason: "alias test" });
  assert.equal(res.pruned, true);
  assert.equal(res.canonical, "glm");
  // ...and isPruned must resolve the ALIAS to the same canonical answer.
  assert.equal(isPruned("glm-5:cloud"), true, "alias should resolve as pruned");
  assert.equal(isPruned("glm"), true);
  // A non-pruned model (and its alias) reads false.
  assert.equal(isPruned("minimax-m2.7:cloud"), false);
});

test("prune / restore round-trip against the temp leaf persists to disk", () => {
  freshStore();
  // minimax is not in the default seed.
  assert.equal(isPruned("minimax"), false);

  const pr = pruneModel("minimax", { reason: "round-trip" });
  assert.equal(pr.pruned, true);
  assert.equal(isPruned("minimax"), true);

  // Persisted: a fresh cache reads the prune back from disk.
  _resetFleetSettingsCache();
  assert.equal(isPruned("minimax"), true, "prune must survive a cache reset");

  const onDisk = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  assert.equal(onDisk.curation.pruned.minimax.source, "operator-curation");

  const rs = restoreModel("minimax");
  assert.equal(rs.restored, true);
  assert.equal(isPruned("minimax"), false);

  // Restore persisted too.
  _resetFleetSettingsCache();
  assert.equal(isPruned("minimax"), false, "restore must survive a cache reset");
});

test("pruneModel rejects an unknown model id", () => {
  freshStore();
  const res = pruneModel("not-a-real-model");
  assert.ok(res.error, "unknown id should return an error");
  assert.equal(isPruned("not-a-real-model"), false);
});

test("corrupt store file degrades to defaults without clobbering on read", () => {
  freshStore();
  // Write garbage to the store file.
  mkdirSync(join(TEMP_HOME, ".illuci", "fleet"), { recursive: true });
  writeFileSync(SETTINGS_FILE, "{ this is not :: valid json ]]", "utf-8");

  _resetFleetSettingsCache();
  // Degrades to the default seed in memory; isPruned still answers.
  const settings = getFleetSettings();
  assert.equal(settings.schemaVersion, 1);
  assert.ok(settings.curation.pruned["qwen-code"], "should fall back to default seed");
  assert.equal(isPruned("qwen-code"), true);

  // The corrupt file on disk was NOT clobbered by the degrading read.
  assert.equal(readFileSync(SETTINGS_FILE, "utf-8"), "{ this is not :: valid json ]]");
});

test("restoreModel is a no-op for a governance-suspended model", () => {
  freshStore();
  // gemini-3.1-pro is governance-suspended in the registry MODEL_STATUS.
  const res = restoreModel("gemini-3.1-pro");
  assert.equal(res.restored, false);
  assert.match(res.reason, /governance-suspended/);
});

test("listCuratedFleet annotates pruned + suspended + effective", () => {
  freshStore();
  const fleet = listCuratedFleet();
  const byId = Object.fromEntries(fleet.map((e) => [e.id, e]));

  // Seeded prune.
  assert.equal(byId["ollama"].pruned, true);
  assert.equal(byId["ollama"].effective, "pruned");

  // Governance-suspended (registry) — governance wins for the effective label.
  assert.equal(byId["gemini-3.1-pro"].suspended, true);
  assert.equal(byId["gemini-3.1-pro"].effective, "suspended");

  // A plain active model.
  assert.equal(byId["minimax"].pruned, false);
  assert.equal(byId["minimax"].suspended, false);
  assert.equal(byId["minimax"].effective, "active");
});

test("getFleetSettings returns a detached view", () => {
  freshStore();
  const a = getFleetSettings();
  a.curation.pruned["__mutation__"] = { tampered: true };
  const b = getFleetSettings();
  assert.equal(b.curation.pruned["__mutation__"], undefined, "view must be detached");
});

// Best-effort cleanup of the throwaway home leaf.
test.after(() => {
  try {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  } catch {}
});
