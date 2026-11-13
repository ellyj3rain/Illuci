// node:test — the commit-signing gate (DR-121): every post-anchor commit signed,
// verified against the committed registry; the one narrow forge-merge exemption.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCommitSignature,
  classifyCommitEmail,
  checkCommitSigning,
  collectCommitRecords,
  verifyGithubForgeCommit,
  GITHUB_WEB_FLOW_FINGERPRINT,
  loadAllowedEmails,
  SIGNING_POLICY_ANCHOR,
  ALLOWED_SIGNERS_RELPATH,
  ALLOWED_EMAILS_RELPATH,
} from "./commit-signing.js";

const SHA = "a".repeat(40);

test("a verified signature (G) passes", () => {
  const r = classifyCommitSignature({ sha: SHA, parents: "b".repeat(40), subject: "[A31] work", sigStatus: "G" });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "signed-verified");
});

test("an unsigned non-merge commit BLOCKS", () => {
  const r = classifyCommitSignature({ sha: SHA, parents: "b".repeat(40), subject: "[A31] work", sigStatus: "N" });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "unsigned");
});

test("the GitLab MWPS merge commit is exempt (forge-authored; parents carry the signatures)", () => {
  const r = classifyCommitSignature({
    sha: SHA,
    parents: `${"b".repeat(40)} ${"c".repeat(40)}`,
    subject: "Merge branch 'batch/a29-numbering-correction' into 'main'",
    sigStatus: "N",
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "exempt-forge-merge");
});

test("an unsigned merge commit with a NON-GitLab subject BLOCKS (the exemption is narrow)", () => {
  const r = classifyCommitSignature({
    sha: SHA,
    parents: `${"b".repeat(40)} ${"c".repeat(40)}`,
    subject: "Merge remote-tracking branch upstream",
    sigStatus: "N",
  });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "unsigned");
});

test("[A39] a GitLab merge subject with NO visible parents (shallow/graft boundary) exempts DISTINCTLY — parent count unknowable is not parent count 1", () => {
  const r = classifyCommitSignature({ sha: SHA, parents: "", subject: "Merge branch 'batch/a37-email-gate' into 'main'", sigStatus: "N" });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "exempt-forge-merge-parents-unverifiable");
});

test("an unsigned single-parent commit wearing the GitLab merge SUBJECT still BLOCKS (subject alone is not an exemption)", () => {
  const r = classifyCommitSignature({
    sha: SHA,
    parents: "b".repeat(40),
    subject: "Merge branch 'x' into 'main'",
    sigStatus: "N",
  });
  assert.equal(r.ok, false);
});

test("a signature that exists but does not verify BLOCKS fail-closed (unknown signer = finding, not pass)", () => {
  for (const status of ["E", "B", "U", "X", "Y", "R"]) {
    const r = classifyCommitSignature({ sha: SHA, parents: "b".repeat(40), subject: "[A31] work", sigStatus: status });
    assert.equal(r.ok, false, `status ${status} must not pass`);
    assert.equal(r.verdict, "unverified-signature");
  }
});

test("aggregate: mixed set reports the exact violations; clean set passes", () => {
  const bad = checkCommitSigning([
    { sha: "1".repeat(40), parents: "x".repeat(40), subject: "[A31] good", sigStatus: "G" },
    { sha: "2".repeat(40), parents: "x".repeat(40), subject: "[A31] bare", sigStatus: "N" },
    { sha: "3".repeat(40), parents: `${"x".repeat(40)} ${"y".repeat(40)}`, subject: "Merge branch 'b' into 'main'", sigStatus: "N" },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.checked, 3);
  assert.equal(bad.verified, 1);
  assert.equal(bad.exempt, 1);
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0].sha, "2".repeat(40));

  const good = checkCommitSigning([
    { sha: "1".repeat(40), parents: "x".repeat(40), subject: "[A31] good", sigStatus: "G" },
  ]);
  assert.equal(good.ok, true);
});

test("empty range (no post-anchor commits) passes — nothing to gate is not a violation", () => {
  const r = checkCommitSigning([]);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
});

test("policy defaults have no inherited private-history anchor; registry paths are explicit", () => {
  assert.equal(SIGNING_POLICY_ANCHOR, null);
  assert.equal(ALLOWED_SIGNERS_RELPATH, "core/governance/signing/allowed_signers");
});

// ── [A37] the email gate (F-083: the GH007 faucet class) ─────────────────────

const ALLOWED = new Set(["contributor@example.com", "forge-user@example.invalid"]);

test("email gate: allowed author+committer pass; a private/unknown email BLOCKS", () => {
  const ok = classifyCommitEmail(
    { sha: SHA, authorEmail: "contributor@example.com", committerEmail: "forge-user@example.invalid", subject: "x" },
    ALLOWED,
  );
  assert.equal(ok.ok, true);
  const bad = classifyCommitEmail(
    { sha: SHA, authorEmail: "someone@proton.me", committerEmail: "contributor@example.com", subject: "leak" },
    ALLOWED,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.verdict, "email-outside-allowed-set");
  assert.ok(bad.reason.includes("author"));
});

test("email gate: NO forge-merge exemption — a GitLab merge commit with a bad email BLOCKS (the exact F-083 hole)", () => {
  const record = {
    sha: SHA,
    parents: `${"b".repeat(40)} ${"c".repeat(40)}`,
    subject: "Merge branch 'batch/x' into 'main'",
    sigStatus: "N",
    authorEmail: "private-address@proton.me",
    committerEmail: "private-address@proton.me",
  };
  // signature-wise: exempt (forge merge). email-wise: BLOCKED. aggregate: BLOCKED.
  assert.equal(classifyCommitSignature(record).ok, true);
  assert.equal(classifyCommitEmail(record, ALLOWED).ok, false);
  const agg = checkCommitSigning([record], { allowedEmails: ALLOWED });
  assert.equal(agg.ok, false);
  assert.equal(agg.emailViolations, 1);
});

test("email gate: case-insensitive; empty email blocks; no allowedEmails param = signature-only (back-compat)", () => {
  const rec = { sha: SHA, authorEmail: "CONTRIBUTOR@EXAMPLE.COM", committerEmail: "", subject: "x", sigStatus: "G", parents: "b".repeat(40) };
  const r = classifyCommitEmail(rec, ALLOWED);
  assert.equal(r.ok, false, "empty committer email must block even when the author is allowed (case-folded)");
  assert.ok(r.reason.includes("committer"));
  assert.equal(checkCommitSigning([rec]).ok, true, "without allowedEmails the aggregate stays signature-only");
});

test("loadAllowedEmails reads explicit synthetic registry and refuses an empty one", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "illuci-signing-fixture-"));
  try {
    const path = join(root, ALLOWED_EMAILS_RELPATH); mkdirSync(dirname(path), { recursive:true });
    writeFileSync(path, "# Synthetic identity\ncontributor@example.com\n");
    assert.deepEqual([...loadAllowedEmails(root)], ["contributor@example.com"]);
    writeFileSync(path, "# No configured identity\n");
    assert.throws(() => loadAllowedEmails(root), /declares no emails/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test("an actual unsigned commit with a forge identity and claimed key cannot pass cryptographic verification", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const repo = mkdtempSync(join(tmpdir(), "illuci-unsigned-forge-"));
  try {
    const run = (args, input = "") => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", input, env: {
      ...process.env, GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com",
      GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com",
    } }).trim();
    run(["init", "--quiet"]);
    const tree = run(["mktree"]);
    const sha = run(["-c", "commit.gpgsign=false", "commit-tree", tree], "[A121.3] Forge lookalike\n");
    const record = { sha, committerName: "GitHub", committerEmail: "noreply@github.com", signingKey: GITHUB_WEB_FLOW_FINGERPRINT.slice(-16) };
    assert.equal(verifyGithubForgeCommit(repo, record, { keyPath: resolve(root, "core/governance/signing/github-web-flow.asc") }), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
