// Commit signature and allowed-identity checks for an explicitly selected repository.
// A configured anchor defines a forward range; absent an anchor, check visible history.
// Human SSH signatures use the installation's signer registry. GitHub web-flow
// signatures use the preserved official public key in a temporary keyring.
// GitLab forge merge subjects have the existing narrow signature exemption;
// allowed-email checks still apply to all commits.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COMMIT_SIGNING_SCHEMA = "illuci.governance.commit-signing/1";

// Each installation selects its own policy adoption point.
export const SIGNING_POLICY_ANCHOR = null;

export const ALLOWED_SIGNERS_RELPATH = "core/governance/signing/allowed_signers";
// Official key: https://github.com/web-flow.gpg; current web-flow fingerprint.
export const GITHUB_WEB_FLOW_KEY_RELPATH = "core/governance/signing/github-web-flow.asc";
export const GITHUB_WEB_FLOW_FINGERPRINT = "968479A1AFF927E37D1A566BB5690EEEBB952194";
// Author and committer identities must both be in the configured registry.
export const ALLOWED_EMAILS_RELPATH = "core/governance/signing/allowed_emails";

// The forge-merge subject GitLab writes for MWPS merges — the same shape the
// batch-prefix gate exempts. Narrow on purpose: an unsigned merge commit with
// any other subject is a violation, not an exemption.
const GITLAB_MERGE_SUBJECT = /^Merge branch '.+' into '.+'$/;

// PURE classifier over one commit record {sha, parents, subject, sigStatus}.
// sigStatus is git's %G? letter: G = good, N = none, everything else = a
// signature git could not positively verify.
export function classifyCommitSignature(record) {
  const { sha, parents = "", subject = "", sigStatus = "N" } = record;
  const parentCount = parents.trim() === "" ? 0 : parents.trim().split(/\s+/).length;
  if (sigStatus === "G") {
    return { sha, verdict: "signed-verified", ok: true };
  }
  if (GITLAB_MERGE_SUBJECT.test(subject) && parentCount >= 2) {
    return {
      sha,
      verdict: "exempt-forge-merge",
      ok: true,
      reason: "GitLab-authored MWPS merge commit (server-side; parents carry the signatures)",
    };
  }
  // [A39] Shallow/graft boundary: some CI checkouts hide a boundary commit's
  // parents entirely (%P empty — parent count UNKNOWABLE, not 1). A GitLab
  // merge subject with NO visible parents exempts honestly-but-distinctly —
  // the full-history forges verify the real topology; a forged single-parent
  // lookalike in any non-boundary clone still shows its one parent and BLOCKS.
  if (GITLAB_MERGE_SUBJECT.test(subject) && parents.trim() === "") {
    return {
      sha,
      verdict: "exempt-forge-merge-parents-unverifiable",
      ok: true,
      reason: "GitLab merge subject at a shallow/graft boundary (parents not visible in this clone) — verified fully on the authoritative forge",
    };
  }
  if (sigStatus === "N") {
    return { sha, verdict: "unsigned", ok: false, reason: `no signature on ${sha.slice(0, 12)} — "${subject}"` };
  }
  return {
    sha,
    verdict: "unverified-signature",
    ok: false,
    reason: `signature on ${sha.slice(0, 12)} did not verify against ${ALLOWED_SIGNERS_RELPATH} (git status ${sigStatus}) — "${subject}" — an unknown signer is a finding, not a pass`,
  };
}

// PURE [A37]: classify a commit's identity emails against the committed set.
// Applies to EVERY post-anchor commit — merge commits included (no exemption).
export function classifyCommitEmail(record, allowedEmails) {
  const { sha, authorEmail = "", committerEmail = "", subject = "" } = record;
  const bad = [];
  for (const [label, email] of [["author", authorEmail], ["committer", committerEmail]]) {
    const e = String(email).trim().toLowerCase();
    if (!e || !allowedEmails.has(e)) bad.push(`${label} <${email || "(empty)"}>`);
  }
  if (bad.length === 0) return { sha, verdict: "email-ok", ok: true };
  return {
    sha,
    verdict: "email-outside-allowed-set",
    ok: false,
    reason: `${bad.join(" and ")} on ${String(sha).slice(0, 12)} — "${subject}" — not in ${ALLOWED_EMAILS_RELPATH}; a private or unknown identity never enters the line (F-083)`,
  };
}

// PURE aggregate over a set of commit records. When `allowedEmails` (a Set of
// lowercased addresses) is provided, the email check runs in the same pass.
export function checkCommitSigning(records, { allowedEmails = null } = {}) {
  const results = records.map(classifyCommitSignature);
  const violations = results.filter((r) => !r.ok);
  let emailViolations = [];
  if (allowedEmails) {
    emailViolations = records.map((r) => classifyCommitEmail(r, allowedEmails)).filter((r) => !r.ok);
    violations.push(...emailViolations);
  }
  return {
    ok: violations.length === 0,
    checked: results.length,
    verified: results.filter((r) => r.verdict === "signed-verified").length,
    exempt: results.filter((r) => r.verdict === "exempt-forge-merge").length,
    emailChecked: Boolean(allowedEmails),
    emailViolations: emailViolations.length,
    violations,
  };
}

/** Load the committed email registry as a lowercased Set. Fail-closed: a
 *  missing/unreadable registry is an error, never a silent skip. */
export function loadAllowedEmails(repoRoot) {
  const path = resolve(repoRoot, ALLOWED_EMAILS_RELPATH);
  const text = readFileSync(path, "utf8");
  const set = new Set(
    text
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#")),
  );
  if (set.size === 0) throw new Error(`${ALLOWED_EMAILS_RELPATH} declares no emails — an empty registry is a misconfiguration, not an allow-all`);
  return set;
}

// ── git plumbing (the impure edge, kept thin) ─────────────────────────────────

// Unit separator: the format token git EMITS and the byte JS splits on.
const FIELD_SEP_FMT = "%x1f";
const FIELD_SEP = "\x1f";

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

// The existing signature collector also owns GitHub's authorized squash route.
// A forge-looking subject or identity grants nothing: the selected commit must
// verify against the pinned official key. The isolated public-key ring needs
// no owner trust, network request, or private key. Unknown signatures fail closed.
export function verifyGithubForgeCommit(repoRoot, record, { keyPath = resolve(repoRoot, GITHUB_WEB_FLOW_KEY_RELPATH) } = {}) {
  if (record.committerName !== "GitHub" || record.committerEmail !== "noreply@github.com" ||
      record.signingKey !== GITHUB_WEB_FLOW_FINGERPRINT.slice(-16)) return false;
  const keyring = mkdtempSync(join(tmpdir(), "illuci-forge-signature-"));
  try {
    // Git for Windows carries MSYS gpg outside the host PATH.
    const bundled = process.platform === "win32"
      ? resolve(git(repoRoot, ["--exec-path"]).trim(), "..", "..", "..", "usr", "bin", "gpg.exe") : null;
    const hasBundled = bundled && existsSync(bundled);
    const gpg = hasBundled ? bundled : "gpg";
    const home = hasBundled ? keyring.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : keyring;
    execFileSync(gpg, ["--no-options", "--batch", "--homedir", home, "--import"], {
      input: readFileSync(keyPath), stdio: ["pipe", "pipe", "pipe"],
    });
    const result = spawnSync("git", ["-C", repoRoot, "-c", `gpg.program=${gpg}`,
      "-c", `gpg.openpgp.program=${gpg}`, "verify-commit", "--raw", record.sha], {
      env: { ...process.env, GNUPGHOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const fingerprint = /(?:^|\n)\[GNUPG:\] VALIDSIG ([0-9A-F]+)/.exec(result.stderr || "")?.[1];
    return result.status === 0 && fingerprint === GITHUB_WEB_FLOW_FINGERPRINT;
  } catch {
    return false;
  } finally {
    rmSync(keyring, { recursive: true, force: true });
  }
}

// Collect {sha, parents, subject, sigStatus} for the gated range. If the anchor
// is not present in the clone (shallow CI checkout), fall back to every commit
// the clone can see — in a shallow window everything visible is post-anchor
// once history has grown past the depth, and a smaller checked set is reported
// honestly, never silently widened into a pass.
export function collectCommitRecords(repoRoot, { anchor = SIGNING_POLICY_ANCHOR, head = "HEAD" } = {}) {
  const allowedSigners = resolve(repoRoot, ALLOWED_SIGNERS_RELPATH);
  let range = head;
  let anchorPresent = false;
  if (anchor !== null) {
    try {
      git(repoRoot, ["cat-file", "-e", `${anchor}^{commit}`]);
      anchorPresent = true;
      range = `${anchor}..${head}`;
    } catch { /* An unavailable anchor leaves only the visible history qualified. */ }
  }
  const out = git(repoRoot, [
    "-c",
    `gpg.ssh.allowedSignersFile=${allowedSigners}`,
    "log",
    `--format=%H${FIELD_SEP_FMT}%P${FIELD_SEP_FMT}%G?${FIELD_SEP_FMT}%ae${FIELD_SEP_FMT}%ce${FIELD_SEP_FMT}%cn${FIELD_SEP_FMT}%GK${FIELD_SEP_FMT}%s`,
    range,
  ]);
  const records = out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [sha, parents, sigStatus, authorEmail, committerEmail, committerName, signingKey, subject] = l.split(FIELD_SEP);
      const record = { sha, parents, sigStatus, authorEmail, committerEmail, committerName, signingKey, subject };
      if (sigStatus !== "G" && verifyGithubForgeCommit(repoRoot, record)) {
        record.sigStatus = "G";
        record.verificationSource = "committed-github-web-flow-key";
      }
      return record;
    });
  return { records, anchorPresent, range };
}

// ── CLI: `node core/governance/commit-signing.js [--range a..b]` ──────────────
function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rangeIdx = process.argv.indexOf("--range");
  const override = rangeIdx !== -1 ? process.argv[rangeIdx + 1] : null;

  const { records, anchorPresent, range } = override
    ? collectCommitRecords(repoRoot, { anchor: override.split("..")[0], head: override.split("..")[1] || "HEAD" })
    : collectCommitRecords(repoRoot);

  const r = checkCommitSigning(records, { allowedEmails: loadAllowedEmails(repoRoot) });
  const window = anchorPresent ? range : `${range} (anchor not in this clone — shallow window checked)`;
  if (r.ok) {
    console.log(
      `commit-signing gate: OK — ${r.checked} commit(s) in ${window}: ${r.verified} verified, ${r.exempt} forge-merge exempt, emails all in the committed set`,
    );
    return 0;
  }
  console.error(`commit-signing gate: BLOCKED — ${r.violations.length} violation(s) in ${window}:`);
  for (const v of r.violations) console.error(`  - [${v.verdict}] ${v.reason}`);
  console.error(
    "Every post-anchor source commit must be SSH-signed by a key in " +
      ALLOWED_SIGNERS_RELPATH +
      " (git config commit.gpgsign true; gpg.format ssh), or cryptographically verified as GitHub web-flow with the committed public key. DR-121.",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
