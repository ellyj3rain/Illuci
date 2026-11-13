import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function text(path) {
  return readFileSync(path, "utf8");
}

function yamlBlock(source, label) {
  const marker = `${label}:\n`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n[^\s][^:\n]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("CI governance workflows expose the required check names", () => {
  assert.equal(existsSync(".github/workflows/ci.yml"), false);
  // codeql + secret-scan removed in [A23]/DR-097 (GHAS / gitleaks-license gated, redundant with GitLab); they must stay gone.
  assert.equal(existsSync(".github/workflows/codeql.yml"), false);
  assert.equal(existsSync(".github/workflows/secret-scan.yml"), false);
  for (const file of ["ci-verify", "dependency-scan", "generate-docs", "cd-dry-run"]) {
    assert.equal(existsSync(".github/workflows/" + file + ".yml"), true);
  }
  assert.equal(text(".github/workflows/ci-verify.yml").includes("name: ci-verify"), true);
  assert.equal(text(".github/workflows/dependency-scan.yml").includes("name: dependency-scan"), true);
  assert.equal(text(".github/workflows/cd-dry-run.yml").includes("name: cd-dry-run"), true);
});

test("CI verification keeps illuci governance gates and avoids repository-root artifact upload", () => {
  const ci = text(".github/workflows/ci-verify.yml");
  assert.equal(ci.includes("--allow-github-merge-body"), true);
  assert.equal(ci.includes("npm run ci:hygiene"), true);
  assert.equal(ci.includes("floor-check-cli.mjs"), true);
  assert.equal(ci.includes("ceiling-check-cli.mjs"), true);
  // [A111]/DR-201: the mid-section (test/smoke/verify:protocol/verify:runtime-deploy
  // AND the previously-absent lint + governance:* gates) is now the ONE composite
  // step — the authoritative 14-step parity boundary that closes the DR-197
  // oppositional-CI asymmetry. verify:protocol / verify:runtime-deploy run INSIDE it.
  assert.equal(ci.includes("npm run ci:verify"), true);
  assert.equal(ci.includes("node .github/scripts/fail-on-audit.js"), true);
  assert.equal(ci.includes("if-no-files-found: ignore"), true);
  assert.equal(ci.includes("continue-on-error: true"), true);
  assert.equal(ci.includes("\n            .\n"), false);
});

test("CI base fetches preserve the complete history needed by signing controls", () => {
  const ci = text(".github/workflows/ci-verify.yml");
  assert.match(ci, /fetch-depth: 0/);
  const fetches = [...ci.matchAll(/^\s*git fetch origin "\$\{BASE_REF\}"([^\n]*)/gm)];
  assert.ok(fetches.length > 0, "exercise the workflow's actual base fetch commands");
  const fixture = mkdtempSync(join(tmpdir(), "illuci-ci-fetch-history-"));
  const origin = join(fixture, "origin");
  const clone = join(fixture, "clone");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    for (const subject of ["historical signing proof", "intermediate work", "current base"]) {
      git(origin, "-c", "commit.gpgsign=false", "-c", "user.name=CI fixture",
        "-c", "user.email=ci@example.invalid", "commit", "--quiet", "--allow-empty", "-m", subject);
    }
    const historical = git(origin, "rev-parse", "HEAD~2");
    git(fixture, "clone", "--quiet", pathToFileURL(origin).href, clone);
    for (const [, suffix] of fetches) {
      const flags = suffix.replace(/\|\|\s*true\s*$/, "").trim().split(/\s+/).filter(Boolean);
      git(clone, "fetch", "origin", "main", ...flags);
      assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "false",
        "a helper fetch must preserve the initial full checkout");
      git(clone, "merge-base", "--is-ancestor", historical, "HEAD");
    }
    // The prior command hides the historical proof even after a full clone.
    git(clone, "fetch", "origin", "main", "--depth=1");
    assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true");
    assert.equal(git(clone, "rev-list", "HEAD").split("\n").includes(historical), false);
  } finally {
    assert.equal(dirname(fixture), tmpdir());
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("GitLab CI avoids duplicate branch pipelines and keeps governance setup right-sized", () => {
  const gitlab = text(".gitlab-ci.yml");
  const duplicatePushSkip = 'if: \'$CI_PIPELINE_SOURCE == "push" && $CI_OPEN_MERGE_REQUESTS\'';
  const ordinaryPush = 'if: \'$CI_PIPELINE_SOURCE == "push"\'';
  assert.notEqual(gitlab.indexOf(duplicatePushSkip), -1);
  assert.notEqual(gitlab.indexOf(ordinaryPush), -1);
  assert.ok(
    gitlab.indexOf(duplicatePushSkip) < gitlab.indexOf(ordinaryPush),
    "open-MR duplicate push suppression must run before the ordinary push rule",
  );
  assert.equal(gitlab.includes("when: never"), true);

  const floor = yamlBlock(gitlab, "governance-floor");
  assert.notEqual(floor, "", "governance-floor must exist");
  assert.equal(floor.includes("before_script: []"), true, "floor must not inherit Node dependency bootstrap");
  assert.equal(floor.includes("npm run deps:install"), false, "floor must stay dependency-free");
  assert.equal(floor.includes("npm run deps:verify"), false, "floor must stay dependency-free");

  const ceiling = yamlBlock(gitlab, "governance-ceiling");
  assert.notEqual(ceiling, "", "governance-ceiling must exist");
  assert.equal(ceiling.includes("npm run deps:install"), true, "ceiling imports dependency-backed topology manifest code");
  assert.equal(ceiling.includes("npm run deps:verify"), false, "ceiling must avoid the full dependency verification bootstrap");
});

test("dependency-scan workflow uses current action shape and default-branch issue policy", () => {
  // SAST (codeql) + secret detection (gitleaks) moved to the GitLab pipeline ([A23]/DR-097);
  // dependency-scan remains on GitHub (free, npm-audit based).
  const deps = text(".github/workflows/dependency-scan.yml");
  assert.equal(deps.includes("node .github/scripts/audit-report.js"), true);
  assert.equal(deps.includes("continue-on-error: true"), true);
  assert.equal(deps.includes("failure() && github.event_name == 'schedule'"), true);
});


test("runtime deploy verifier uses a repo-local npm cache for local runs", () => {
  const script = text("scripts/verify-runtime-deploy.mjs");
  assert.equal(script.includes("ILLUCI_DEPLOY_VERIFY_NPM_CACHE"), true);
  assert.equal(script.includes('join(checkoutRoot, ".illuci", "cache", "npm")'), true);
  assert.equal(script.includes('const installCacheRoot = isolatedNpmCache ? cacheRoot : configuredNpmCache'), true);
  assert.equal(script.includes("ILLUCI_NPM_CACHE_ROOT"), true);
  assert.equal(script.includes('["scripts/hydrate-npm-cache.mjs", "--clean"]'), true);
  assert.equal(script.includes("ILLUCI_DEPLOY_VERIFY_ISOLATED_NPM_CACHE"), true);
  assert.equal(script.includes('"--offline"'), true);
  assert.equal(script.includes('"--prefer-offline"'), true);
  assert.equal(script.includes('"--no-audit"'), true);
  assert.equal(script.includes('"--fund=false"'), true);
});

test("CD dry-run workflow verifies and packages without publishing", () => {
  const workflow = text(".github/workflows/cd-dry-run.yml");
  const script = text("scripts/run-cd-dry-run.mjs");
  assert.equal(workflow.includes("workflow_dispatch:"), true);
  assert.equal(workflow.includes("npm run ci:verify"), true);
  assert.equal(workflow.includes("npm run cd:dry-run -- --skip-ci"), true);
  assert.equal(workflow.includes("actions/upload-artifact@v5"), true);
  assert.equal(workflow.includes("npm publish"), false);
  assert.equal(script.includes("publishAttempted: false"), true);
  assert.equal(script.includes('"npm-pack-dry-run.json"'), true);
  assert.equal(script.includes('"pack", "--dry-run", "--json"'), true);
});
