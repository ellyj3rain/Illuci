import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  REQUIRED_PUBLIC_SURFACE_PATHS,
  SURFACE_MAP,
  SURFACE_POSTURES,
  SURFACE_READINESS_LEVELS,
  SURFACE_VISIBILITY_LEVELS,
  assertSurfaceMapCoverage,
  classifySurfacePath,
  getSurfaceEntry,
  listDiagnosticSurfaces,
  listSurfaceMap,
  summarizeSurfaceMap,
} from "./surface-map.js";

function trackedPaths() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

test("surface map records use stable ids and valid postures", () => {
  const ids = SURFACE_MAP.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const entry of SURFACE_MAP) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(SURFACE_POSTURES.includes(entry.posture), `${entry.id} has invalid posture ${entry.posture}`);
    assert.ok(SURFACE_READINESS_LEVELS.includes(entry.readiness), `${entry.id} has invalid readiness ${entry.readiness}`);
    assert.ok(SURFACE_VISIBILITY_LEVELS.includes(entry.visibility), `${entry.id} has invalid visibility ${entry.visibility}`);
    assert.equal(Array.isArray(entry.paths), true, `${entry.id} paths must be an array`);
    assert.ok(entry.paths.length > 0, `${entry.id} must map at least one path`);
    assert.equal(typeof entry.loadBearing, "boolean", `${entry.id} loadBearing must be boolean`);
    assert.equal(typeof entry.pruneAction, "string", `${entry.id} pruneAction must be string`);
    assert.ok(entry.pruneAction.length > 0, `${entry.id} pruneAction must not be empty`);
    assert.equal(typeof entry.evidence, "string", `${entry.id} must carry evidence`);
    assert.ok(entry.evidence.length > 0, `${entry.id} evidence must not be empty`);
  }
});

test("map helper returns defensive copies", () => {
  const entries = listSurfaceMap();
  entries[0].paths.push("not-real/");

  assert.equal(SURFACE_MAP[0].paths.includes("not-real/"), false);
  assert.deepEqual(getSurfaceEntry(SURFACE_MAP[0].id), listSurfaceMap()[0]);
});

test("diagnostic surface helpers expose gated and dark-forward posture without primary-only entries", () => {
  const diagnostic = listDiagnosticSurfaces();
  const ids = diagnostic.map((entry) => entry.id);
  const summary = summarizeSurfaceMap(diagnostic);

  assert.ok(ids.includes("github-ci-security-automation"));
  assert.ok(ids.includes("product-forward-scaffold"));
  assert.equal(ids.includes("agent-runtime-sdk"), false);
  assert.ok(summary.byPosture.gated >= 1);
  assert.ok(summary.byPosture["dark-forward"] >= 1);
  assert.equal(summary.byVisibility["diagnostic-advisory"], diagnostic.length);

  const full = listDiagnosticSurfaces({ includeAll: true });
  assert.ok(full.some((entry) => entry.visibility === "primary"));
});

test("all tracked top-level core directories and public surfaces are represented", () => {
  const coverage = assertSurfaceMapCoverage(trackedPaths());

  assert.deepEqual(coverage.duplicateIds, []);
  assert.deepEqual(coverage.invalidPostures, []);
  assert.deepEqual(coverage.invalidVisibility, []);
  assert.deepEqual(coverage.invalidReadiness, []);
  assert.deepEqual(coverage.missingPruneAction, []);
  assert.deepEqual(coverage.missingCoreDirectories, []);
  assert.deepEqual(coverage.missingPublicSurfaces, []);
  assert.deepEqual(coverage.missingMappedPaths, []);
  assert.equal(coverage.ok, true);
});

test("required public surfaces include CLI, TUI, workflows, root docs, package metadata, and runtime entrypoints", () => {
  for (const path of [
    "cli/illuci.mjs",
    "cli/tui/",
    ".github/workflows/ci-verify.yml",
    ".github/workflows/dependency-scan.yml",
    ".github/workflows/gitops-token-doctor.yml",
    ".github/workflows/generate-docs.yml",
    "README.md",
    "PROVIDERS.md",
    "COMPONENTS.md",
    "ARCHITECTURE.md",
    "GOVERNANCE.md",
    "ROADMAP.md",
    "SESSION_STATE.md",
    "BATCH_LOG.md",
    "DECISION_REGISTRY.md",
    "VERSION",
    "package.json",
    "package-lock.json",
    "core/model-resource.js",
    "core/model-resource-reasoning-map.js",
  ]) {
    assert.ok(REQUIRED_PUBLIC_SURFACE_PATHS.includes(path), `${path} should be required`);
    assert.ok(classifySurfacePath(path).length > 0, `${path} should classify through the surface map`);
  }
});

test("constitutional context is represented as downstream provenance", () => {
  const entry = getSurfaceEntry("constitutional-context-mirror");
  assert.ok(entry);
  assert.deepEqual(entry.paths, ["constitutional/"]);
  assert.equal(entry.posture, "provenance");
  assert.equal(entry.visibility, "diagnostic-advisory");
  assert.equal(entry.loadBearing, false);
});

test("infrastructure account posture doctor is represented as live diagnostic surface", () => {
  const entry = getSurfaceEntry("infrastructure-account-posture-doctor");
  assert.ok(entry);
  assert.equal(entry.posture, "live-run-path");
  assert.equal(entry.visibility, "diagnostic-advisory");
  assert.equal(entry.loadBearing, true);
  assert.ok(entry.paths.includes("core/infrastructure/account-posture.js"));
  assert.ok(classifySurfacePath("core/infrastructure/account-posture.js").some((record) => record.id === entry.id));
});

test("security engine adapter contract is represented as live diagnostic surface", () => {
  const entry = getSurfaceEntry("security-engine-adapter-contract");
  assert.ok(entry);
  assert.equal(entry.posture, "live-run-path");
  assert.equal(entry.visibility, "diagnostic-advisory");
  assert.equal(entry.loadBearing, true);
  assert.deepEqual(entry.paths, ["core/security/"]);
  assert.ok(classifySurfacePath("core/security/engine-adapter.js").some((record) => record.id === entry.id));
});

test("core prune readiness separates deprecated and extraction-residue surfaces", () => {
  const deprecated = listDiagnosticSurfaces({ readiness: "deprecated" });
  const extractionResidue = listDiagnosticSurfaces({ readiness: "extraction-residue" });
  const extractionIds = extractionResidue.map((entry) => entry.id);

  assert.ok(deprecated.some((entry) => entry.id === "legacy-anthropology-retirements"));
  assert.ok(extractionIds.includes("marshmallow-musings-residue"));
  assert.ok(extractionResidue.every((entry) => entry.pruneAction.includes("audit") || entry.pruneAction.includes("relocate")));
});

test("generated-local entries may map support code without asserting generated payload existence", () => {
  const coverage = assertSurfaceMapCoverage(["core/agent/index.js"]);

  assert.equal(
    coverage.missingMappedPaths.some((missing) => missing.id === "generated-local-trace-surface"),
    false
  );
});

test("runtime service is represented as a primary live-run surface", () => {
  const entry = getSurfaceEntry("illuci-runtime-service");
  assert.ok(entry);
  assert.equal(entry.posture, "live-run-path");
  assert.equal(entry.visibility, "primary");
  assert.equal(entry.loadBearing, true);
  assert.deepEqual(entry.paths, ["core/runtime/", "core/connections/"]);
  assert.ok(classifySurfacePath("core/runtime/http-transport.js").some((record) => record.id === entry.id));
});
