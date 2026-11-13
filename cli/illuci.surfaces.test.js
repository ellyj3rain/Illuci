import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function runIlluci(args) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("surfaces CLI exposes diagnostic advisory view by default", () => {
  const payload = JSON.parse(runIlluci(["surfaces", "--json"]));
  const ids = payload.surfaces.map((entry) => entry.id);

  assert.equal(payload.schema, "illuci.governance.surface-map/1");
  assert.equal(payload.mode, "diagnostic-advisory");
  assert.ok(ids.includes("github-ci-security-automation"));
  assert.ok(ids.includes("product-forward-scaffold"));
  assert.equal(ids.includes("agent-runtime-sdk"), false);
  assert.ok(payload.summary.listed.byPosture["dark-forward"] >= 1);
});

test("surfaces CLI can include the full map and filter by posture", () => {
  const all = JSON.parse(runIlluci(["surfaces", "--all", "--json"]));
  assert.ok(all.surfaces.some((entry) => entry.id === "agent-runtime-sdk"));
  assert.ok(all.summary.listed.byVisibility.primary >= 1);
  assert.ok(all.readinessLevels.includes("extraction-residue"));
  assert.ok(all.summary.listed.byReadiness.active >= 1);

  const dark = JSON.parse(runIlluci(["surfaces", "--posture", "dark-forward", "--json"]));
  assert.ok(dark.surfaces.length >= 1);
  assert.ok(dark.surfaces.every((entry) => entry.posture === "dark-forward"));
});

test("surfaces CLI can filter the core prune readiness audit", () => {
  const active = JSON.parse(runIlluci(["surfaces", "--readiness", "active", "--json"]));
  assert.equal(active.mode, "all");
  assert.ok(active.surfaces.some((entry) => entry.id === "agent-runtime-sdk"));
  assert.ok(active.surfaces.every((entry) => entry.readiness === "active"));

  const deprecated = JSON.parse(runIlluci(["surfaces", "--readiness", "deprecated", "--json"]));
  assert.ok(deprecated.surfaces.some((entry) => entry.id === "legacy-anthropology-retirements"));
  assert.ok(deprecated.surfaces.every((entry) => entry.readiness === "deprecated"));

  const residue = JSON.parse(runIlluci(["surfaces", "--readiness", "extraction-residue", "--json"]));
  const ids = residue.surfaces.map((entry) => entry.id);
  assert.ok(ids.includes("marshmallow-musings-residue"));
  assert.ok(residue.surfaces.every((entry) => entry.pruneAction));
});

test("surfaces CLI rejects unknown posture filters", () => {
  const result = spawnSync(process.execPath, [cliPath, "surfaces", "--posture", "not-real"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown posture/);
});

test("surfaces CLI rejects unknown readiness filters", () => {
  const result = spawnSync(process.execPath, [cliPath, "surfaces", "--readiness", "not-real"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown readiness/);
});
