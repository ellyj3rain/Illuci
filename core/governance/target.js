import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const TARGET_SCHEMA = "illuci.governance.target/1";

function safeRealpath(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function isDirectory(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function gitRootFor(targetPath) {
  try {
    return execFileSync("git", ["-C", targetPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function marker(targetPath) {
  return existsSync(targetPath);
}

/**
 * Resolve the repository target that a governance-aware command should inspect.
 * The default is the caller's current working tree. An explicit path points the
 * same command at another governed checkout without changing illuci's engine root.
 */
export function resolveGovernanceTarget(input = null, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const requested = input == null || input === "" ? null : String(input);
  const candidate = requested ? resolve(cwd, requested) : cwd;
  const candidateExists = existsSync(candidate);
  const candidateIsDirectory = candidateExists && isDirectory(candidate);
  const candidateRoot = candidateExists ? safeRealpath(candidate) : resolve(candidate);
  const gitRoot = candidateIsDirectory ? gitRootFor(candidateRoot) : null;
  const repoRoot = safeRealpath(gitRoot || candidateRoot);

  const markers = {
    versionFile: marker(join(repoRoot, "VERSION")),
    packageJson: marker(join(repoRoot, "package.json")),
    illuciProjectConfig: marker(join(repoRoot, ".illuci", "project.json")),
    governanceManifest: marker(join(repoRoot, "illuci-governance.json")),
    gitWorktree: Boolean(gitRoot),
  };

  const governed = markers.versionFile || markers.illuciProjectConfig || markers.governanceManifest;
  const findings = [];
  if (!candidateExists) {
    findings.push({
      severity: "blocking",
      code: "target-missing",
      message: "target path does not exist: " + candidate,
    });
  } else if (!candidateIsDirectory) {
    findings.push({
      severity: "blocking",
      code: "target-not-directory",
      message: "target path is not a directory: " + candidate,
    });
  }
  if (candidateExists && candidateIsDirectory && !governed) {
    findings.push({
      severity: "review",
      code: "target-not-governed",
      message: "target has no VERSION, .illuci/project.json, or illuci-governance.json marker",
    });
  }

  return {
    schema: TARGET_SCHEMA,
    mode: requested ? "explicit" : "default-current",
    requestedPath: requested,
    cwd,
    candidateRoot,
    repoRoot,
    gitRoot: gitRoot ? safeRealpath(gitRoot) : null,
    exists: candidateExists,
    governed,
    markers,
    findings,
  };
}

export function targetIsBlocked(target) {
  return target.findings.some((finding) => finding.severity === "blocking");
}

export default {
  TARGET_SCHEMA,
  resolveGovernanceTarget,
  targetIsBlocked,
};
