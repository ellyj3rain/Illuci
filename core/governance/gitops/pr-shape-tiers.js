// illuci/core/governance/gitops/pr-shape-tiers.js
//
// [A24.2] PR-shape v1: the closure-based, role-aware staged classifier + the
// tier doctrine (the factory's slice 2; DR-115, implementing the [A27]
// incident-command ruling verbatim):
//
//   "classify every PR by declared dependency closure and validated role tags,
//    exempt structurally-linked companions from raw-count budgets, auto-
//    downgrade coherent low-deviation closures to Tier-2 watch, keep Tier-1
//    ungated, and route only Tier-3 consequential actions through two
//    independent adversarial auditors, a vacuum-run J3RAIN operator-model
//    agent, and an out-of-band isolated 2FA operator release."
//
// The role-blind complaint this closes: the raw budget counted EVERY changed
// file, so a coherent provider lane (bridge + registry + tests + ledgers)
// read as risky size. Here only `intent-surface` + `first-consumer` count
// against the staged budget; companions are exempt ONLY via structural
// linkage to the closure (orphans revert to intent-surface and count).
//
// Exemption is STRUCTURALLY DEDUCED, never declared: a caller-supplied
// `isExempt`/`exempt`/role-override input is not read (the [A27] security
// ruling; the slice-1 manifest border enforces the same on manifests).
//
// Slice-1 consumption: `governanceManifests` (TopologyGovernanceManifest[])
// are validated at the strict slice-1 border — an INVALID manifest is a
// Tier-3 trigger (fail-closed), and an all-sandboxOnly manifest set makes a
// change-set Tier-1-eligible (the [A27] "sandbox" trigger).
//
// Pure and hermetic: facts in, governed verdict out. The tier names the GATE
// LEVEL only — Tier-3's stopgap chain itself lands as slice 3 ([A24.3]).

import { SEVERITIES, makeGovernedVerdict, makeSignal, bool, int, list } from "../classifiers/governed-verdict.js";
import { surfaceClassForPath, PR_SHAPE_DEFAULT_BUDGET } from "./merge-strategy-classifier.js";
import { validateTopologyManifest } from "../../topologies/manifest.js";

export const PR_SHAPE_TIERS_SCHEMA = "illuci.gitops.pr-shape-tiers/1";

/** The [A27] ops role-tag vocabulary. */
export const PR_ROLE_TAGS = Object.freeze([
  "intent-surface",
  "first-consumer",
  "test",
  "ledger-companion",
  "version-companion",
  "infra",
  "docs",
  "generated",
]);

/** Roles that count against the staged budget. */
const COUNTED_ROLES = new Set(["intent-surface", "first-consumer"]);

/** Append-only ledger companions (root files). */
const LEDGER_FILES = new Set(["BATCH_LOG.md", "DECISION_REGISTRY.md", "FINDINGS.md"]);

/** The governed version odometer's companion set. */
const VERSION_FILES = new Set([
  "VERSION",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "core/governance/version-replay.js",
  "core/governance/version-replay.test.js",
]);

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeFiles(input) {
  return list(input)
    .map((entry) => {
      if (typeof entry === "string") return { path: normalizePath(entry), additions: 0, deletions: 0 };
      if (!entry || typeof entry !== "object") return null;
      const path = normalizePath(entry.path || entry.filename || entry.name);
      if (!path) return null;
      return { path, additions: int(entry.additions ?? entry.addedLines, 0), deletions: int(entry.deletions ?? entry.removedLines, 0) };
    })
    .filter((entry) => entry && entry.path);
}

/**
 * Deterministic role tag for one changed file. Precedence is load-bearing:
 * version/ledger companions are recognized BEFORE the generic test/docs reads
 * (version-replay.test.js is a version-companion, not a plain test; BATCH_LOG
 * is a ledger, not docs). `first-consumer` is caller-DECLARED (part of the
 * declared closure) — there is no mechanical inference for it in v1.
 *
 * @param {string} path
 * @param {{firstConsumers?: Set<string>}} closure
 * @returns {string} one of PR_ROLE_TAGS
 */
export function roleForFile(path, closure = {}) {
  const normalized = normalizePath(path);
  if (closure.firstConsumers?.has(normalized)) return "first-consumer";
  if (VERSION_FILES.has(normalized)) return "version-companion";
  if (LEDGER_FILES.has(normalized) && !normalized.includes("/")) return "ledger-companion";
  const surfaceClass = surfaceClassForPath(normalized);
  if (surfaceClass === "generated-output" || surfaceClass === "local-state" || surfaceClass === "governance-corpus") return "generated";
  if (surfaceClass === "test") return "test";
  if (surfaceClass === "ci" || surfaceClass === "tooling" || normalized === ".gitlab-ci.yml" || normalized.startsWith("deploy/")) return "infra";
  if (surfaceClass === "docs" || surfaceClass === "governance-doc" || surfaceClass === "constitutional-mirror") return "docs";
  return "intent-surface";
}

function declaredClosure(input) {
  const closure = input && typeof input.closure === "object" ? input.closure : {};
  return {
    firstConsumers: new Set(list(closure.firstConsumers).map(normalizePath)),
  };
}

function validateManifests(input) {
  const supplied = list(input.governanceManifests);
  const valid = [];
  const invalid = [];
  for (const manifest of supplied) {
    const verdict = validateTopologyManifest(manifest);
    if (verdict.ok) valid.push(verdict.value);
    else invalid.push({ id: manifest?.id ?? null, errors: verdict.errors.slice(0, 3) });
  }
  return { supplied: supplied.length, valid, invalid };
}

/**
 * The [A24.2] classifier: role tags → structural exemption → role-aware staged
 * budget → tier. Consumes the same fact shape classifyPrShape does; never
 * reads a declared exemption.
 *
 * @param {object} input - { changedFiles, closure?, governanceManifests?,
 *   productionTarget?, unauthorizedProvenance?, operatorRatifiedMissingCompanions?,
 *   operatorRatifiedLargeDiff?, diffSizeBudget? }
 * @returns {object} governed verdict: decision "tier-1|2|3", dimensions carry
 *   roles/counted/exempt/orphansReverted/budget/manifests, watch on tier 2
 */
export function classifyPrShapeTiers(input = {}) {
  const files = normalizeFiles(input.changedFiles);
  const closure = declaredClosure(input);
  const budget = {
    maxFiles: int(input.diffSizeBudget?.maxFiles, PR_SHAPE_DEFAULT_BUDGET.maxFiles),
    maxChangedLines: int(input.diffSizeBudget?.maxChangedLines, PR_SHAPE_DEFAULT_BUDGET.maxChangedLines),
    operatorFiles: int(input.diffSizeBudget?.operatorFiles, PR_SHAPE_DEFAULT_BUDGET.operatorFiles),
    operatorChangedLines: int(input.diffSizeBudget?.operatorChangedLines, PR_SHAPE_DEFAULT_BUDGET.operatorChangedLines),
  };

  // ── 1. Role tags. ──
  const byFile = files.map((file) => ({ ...file, role: roleForFile(file.path, closure) }));
  const withRole = (role) => byFile.filter((file) => file.role === role);

  // ── 2. Structural exemption. Companions are exempt only while a counted
  //    closure exists for them to accompany. A change-set with NO intent
  //    surface has its content companions (test/docs/infra) REVERTED to
  //    intent-surface — the diff's real subject counts. Ledger/version
  //    companions revert only when they are the ENTIRE change-set (a
  //    ledger-only diff is its own intent). ──
  const orphansReverted = [];
  let counted = byFile.filter((file) => COUNTED_ROLES.has(file.role));
  if (counted.length === 0) {
    const contentOrphans = byFile.filter((file) => ["test", "docs", "infra"].includes(file.role));
    if (contentOrphans.length > 0) {
      for (const file of contentOrphans) {
        orphansReverted.push({ path: file.path, from: file.role });
        file.role = "intent-surface";
      }
    } else if (byFile.length > 0 && byFile.every((file) => file.role === "ledger-companion" || file.role === "version-companion")) {
      for (const file of byFile) {
        orphansReverted.push({ path: file.path, from: file.role });
        file.role = "intent-surface";
      }
    }
    counted = byFile.filter((file) => COUNTED_ROLES.has(file.role));
  }
  const exempt = byFile.filter((file) => !COUNTED_ROLES.has(file.role));

  // ── 3. Role-aware staged budget (counted files only). ──
  const countedLines = counted.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const overHard = counted.length > budget.operatorFiles || countedLines > budget.operatorChangedLines;
  const overCaution = counted.length > budget.maxFiles || countedLines > budget.maxChangedLines;
  const budgetVerdict = overHard && !bool(input.operatorRatifiedLargeDiff) ? "over-hard" : overCaution ? "caution" : "within";

  // ── 4. Slice-1 manifest border (fail-closed). ──
  const manifests = validateManifests(input);
  const allSandbox = manifests.valid.length > 0 && manifests.invalid.length === 0 && manifests.valid.every((m) => m.invariants.sandboxOnly === true);

  // ── 5. Tier triggers ([A27] §2). ──
  const signals = [];
  const trigger = (code, evidence, data) =>
    signals.push(makeSignal({ code, severity: SEVERITIES.OPERATOR, dimension: "tier-doctrine", evidence, next: "route-tier-3-stopgap", data }));

  const generatedInSource = withRole("generated").filter((file) => {
    const surfaceClass = surfaceClassForPath(file.path);
    return surfaceClass === "generated-output" || surfaceClass === "local-state";
  });
  if (generatedInSource.length > 0) {
    trigger("tier3-generated-or-secret-surface", `${generatedInSource.length} generated/local-state file(s) in source shape`, {
      files: generatedInSource.map((file) => file.path).slice(0, 10),
    });
  }
  if (budgetVerdict === "over-hard") {
    trigger("tier3-over-hard-ceiling", `counted closure exceeds the hard ceiling (${counted.length} file(s), ${countedLines} line(s))`, {
      counted: counted.length,
      countedLines,
      budget,
    });
  }
  const hasLedgerCompanion = byFile.some((file) => file.role === "ledger-companion");
  if (counted.length > 0 && !hasLedgerCompanion && !bool(input.operatorRatifiedMissingCompanions)) {
    trigger("tier3-missing-companions", "a counted closure carries no append-only ledger companion", {
      counted: counted.map((file) => file.path).slice(0, 10),
    });
  }
  if (bool(input.productionTarget)) trigger("tier3-production-target", "the change-set targets a production/CD surface", {});
  if (bool(input.unauthorizedProvenance)) trigger("tier3-unauthorized-provenance", "the change-set carries unauthorized provenance", {});
  if (manifests.invalid.length > 0) {
    trigger("tier3-invalid-governance-manifest", `${manifests.invalid.length} supplied manifest(s) failed the strict slice-1 border`, {
      invalid: manifests.invalid,
    });
  }

  // ── 6. The tier. ──
  let tier;
  let reason;
  if (signals.length > 0) {
    tier = 3;
    reason = signals[0].code;
  } else if (counted.length === 0) {
    tier = 1;
    reason = "no-intent-bearing-surface";
  } else if (allSandbox) {
    tier = 1;
    reason = "sandbox-only-manifests";
  } else {
    tier = 2;
    reason = budgetVerdict === "caution" ? "coherent-closure-over-caution" : "coherent-closure-within-tolerance";
    signals.push(makeSignal({
      code: "tier2-watch",
      severity: SEVERITIES.WATCH,
      dimension: "tier-doctrine",
      evidence: `coherent closure (${counted.length} counted file(s), ${exempt.length} exempt companion(s)) auto-downgraded to watch`,
      next: "proceed-under-watch",
      data: { counted: counted.length, countedLines, budgetVerdict },
    }));
  }

  const roleCounts = {};
  for (const file of byFile) roleCounts[file.role] = (roleCounts[file.role] || 0) + 1;

  return makeGovernedVerdict({
    classifier: "illuci.gitops.pr-shape-tiers",
    subject: input.subject || "pull-request",
    decision: `tier-${tier}`,
    allowed: tier !== 3,
    requiresOperator: tier === 3,
    code: reason,
    evidence:
      tier === 3
        ? "a Tier-3 trigger routes this change-set to the full stopgap chain"
        : tier === 2
          ? "coherent closure under Tier-2 watch (companions structurally exempt)"
          : "no gate applies (Tier-1 ungated)",
    next: tier === 3 ? "route-tier-3-stopgap" : tier === 2 ? "proceed-under-watch" : "proceed-ungated",
    dimensions: {
      schema: PR_SHAPE_TIERS_SCHEMA,
      tier,
      watch: tier === 2,
      roles: { byFile: byFile.map((file) => ({ path: file.path, role: file.role })), counts: roleCounts },
      counted: { files: counted.length, lines: countedLines },
      exempt: { files: exempt.length },
      orphansReverted,
      budget: { ...budget, verdict: budgetVerdict },
      manifests: { supplied: manifests.supplied, valid: manifests.valid.length, invalid: manifests.invalid, allSandbox },
    },
    signals,
  });
}

export default { PR_SHAPE_TIERS_SCHEMA, PR_ROLE_TAGS, roleForFile, classifyPrShapeTiers };
