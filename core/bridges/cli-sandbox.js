// CLI-agent lane sandbox (DR-200; F-139) — operator-ratified 2026-07-11.
//
// The CLI-backed model lanes (claude, grok-cli, gemini, kimi, agy) are not
// text endpoints: each spawns a FULL AGENTIC HOST with its own shell and file
// tools, and those tools ground wherever the child process's cwd points. Left
// to inherit the engine's cwd, a dispatched seat can read the engine checkout
// for context and write scratch files into it — entirely outside illuci's
// governed tool surface, which never observes a byte of it (F-139: a grok-cli
// seat did exactly this during the first Foundry studio series, while illuci's
// own tool gate was correctly denying file_write to its governed seats).
//
// The ratified posture: every CLI-lane process grounds in a PER-DISPATCH
// scratch directory by default. The operator opt-out is explicit and
// disclosed (`ILLUCI_CLI_LANE_WORKSPACE=shared`, or dispatch option
// `cliWorkspace: "shared"`), per the explicit-controls law (DR-129/DR-130).
//
// Boundary, stated honestly: this is a GROUNDING boundary, not a jail. It
// re-roots the agent's default/relative file behavior and its context
// discovery; a sufficiently motivated agent can still write absolute paths.
// A hard OS-level jail is a different mechanism, out of scope here and named
// as such in DR-200.
//
// Lifecycle (WO-S10 / DR-200 residual): resolveCliLaneWorkspace creates
// scratch dirs and leaves them for post-run inspection. sweepCliLaneSandboxes
// prunes aged direct children of the sandbox root only — never outside it.

import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export const CLI_SANDBOX_SCHEMA = "illuci.bridges.cli-sandbox/1";
export const CLI_LANE_WORKSPACE_MODES = Object.freeze(["sandbox", "shared"]);

/** Default sandbox root under the OS temp directory (DR-200 grounding). */
export const CLI_SANDBOX_ROOT_NAME = "illuci-cli-lane-sandbox";

/** Default age before a sandbox entry is eligible for sweep (24h). */
export const CLI_SANDBOX_SWEEP_DEFAULT_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

let warnedUnknownMode = false;
let dispatchSeq = 0;

/**
 * Canonical production sandbox root: tmpdir()/illuci-cli-lane-sandbox.
 * @returns {string}
 */
export function defaultCliSandboxRoot() {
  return join(tmpdir(), CLI_SANDBOX_ROOT_NAME);
}

/**
 * Resolve the working directory a CLI-lane child process grounds in.
 *
 * Default `sandbox`: a fresh per-dispatch scratch directory under the OS
 * temp root (created here, left for post-run inspection; the OS owns temp
 * cleanup). Explicit `shared`: the engine's own cwd, exactly the pre-DR-200
 * behavior. An UNKNOWN requested mode degrades to `sandbox` with one loud
 * warning — for a safety boundary the safe side of a typo is isolation,
 * never silent sharing.
 *
 * @param {object} [options] — dispatch options (reads `cliWorkspace`, and
 *   `runId`/`sessionId` for a legible sandbox dir name)
 * @param {object} [env]     — environment (reads ILLUCI_CLI_LANE_WORKSPACE)
 * @returns {{ mode: "sandbox"|"shared", cwd: string }}
 */
export function resolveCliLaneWorkspace(options = {}, env = process.env) {
  const requested = options.cliWorkspace ?? env.ILLUCI_CLI_LANE_WORKSPACE ?? "sandbox";
  let mode = requested;
  if (!CLI_LANE_WORKSPACE_MODES.includes(mode)) {
    if (!warnedUnknownMode) {
      warnedUnknownMode = true;
      console.warn(`[cli-sandbox] unknown workspace mode "${requested}" — grounding in sandbox (the safe side; valid: ${CLI_LANE_WORKSPACE_MODES.join("|")})`);
    }
    mode = "sandbox";
  }
  if (mode === "shared") {
    return { mode, cwd: process.cwd() };
  }
  const tag = String(options.runId || options.sessionId || "dispatch").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  dispatchSeq += 1;
  const cwd = join(tmpdir(), "illuci-cli-lane-sandbox", `${tag}-${process.pid}-${dispatchSeq}`);
  mkdirSync(cwd, { recursive: true });
  return { mode, cwd };
}

/**
 * True iff `name` is a single path segment safe to join under the sandbox root.
 * Rejects empty, `.`, `..`, separators, NUL, and absolute paths.
 * @param {string} name
 * @returns {boolean}
 */
function isSafeDirectChildName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("\0")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (isAbsolute(name)) return false;
  // basename mismatch catches residual traversal / drive-relative forms
  if (basename(name) !== name) return false;
  return true;
}

/**
 * Resolve the directory the sweep is allowed to operate on.
 *
 * Production: always tmpdir()/illuci-cli-lane-sandbox (created if missing).
 * Test override: BOTH `root` (absolute path under OS temp) AND
 * `allowTestRoot: true` are required. Relative roots, roots outside tmpdir,
 * and `root` without the explicit test flag are rejected as programmer error
 * before any deletion runs.
 *
 * @param {object} [options]
 * @returns {string}
 */
function resolveSweepRoot(options = {}) {
  if (options.root == null || options.root === undefined) {
    const root = defaultCliSandboxRoot();
    mkdirSync(root, { recursive: true });
    return root;
  }

  if (options.allowTestRoot !== true) {
    throw new TypeError(
      "[cli-sandbox] options.root is hermetic-test-only; pass allowTestRoot: true together with an absolute path under the OS temp directory"
    );
  }

  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("[cli-sandbox] options.root must be a non-empty string");
  }

  if (!isAbsolute(options.root)) {
    throw new TypeError("[cli-sandbox] options.root must be absolute (refuse relative override)");
  }

  // Resolve . / .. segments; do not follow symlinks for the root itself —
  // the override path must literally live under the OS temp root after resolve.
  const resolved = resolve(options.root);
  const tmpRoot = resolve(tmpdir());
  const underTmp =
    resolved === tmpRoot ||
    resolved.startsWith(tmpRoot.endsWith(sep) ? tmpRoot : tmpRoot + sep);

  if (!underTmp) {
    throw new TypeError(
      `[cli-sandbox] options.root must resolve under OS temp (${tmpRoot}); refused: ${resolved}`
    );
  }

  mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Join root + entry name and prove the result is still a direct child of root.
 * Defense in depth against any future change that might reintroduce separators.
 * @param {string} root
 * @param {string} name
 * @returns {string|null} absolute child path, or null if unsafe
 */
function safeChildPath(root, name) {
  if (!isSafeDirectChildName(name)) return null;
  const child = join(root, name);
  const resolvedChild = resolve(child);
  const resolvedRoot = resolve(root);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedChild !== resolvedRoot && !resolvedChild.startsWith(prefix)) {
    return null;
  }
  // Must remain a single segment under root (not root itself, not nested escape)
  if (basename(resolvedChild) !== name) return null;
  if (resolve(resolvedRoot, name) !== resolvedChild) return null;
  return child;
}

/**
 * Sweep aged direct children of the CLI-lane sandbox root.
 *
 * SAFETY (absolute): only entries whose names are safe single segments under
 * the sandbox root are considered. Symlinked entries are never recursed into
 * — they are skipped (kept). Recursive delete runs only on real directories
 * confirmed via lstat. Nothing outside the resolved root can be deleted.
 *
 * @param {object} [options]
 * @param {number} [options.olderThanMs=86400000] — min age (mtime) to sweep
 * @param {boolean} [options.dryRun=false] — list candidates; delete nothing
 * @param {string} [options.root] — HERMETIC TESTS ONLY; requires allowTestRoot
 * @param {true} [options.allowTestRoot] — second gate for options.root
 * @returns {{ swept: string[], kept: string[], errors: { name: string, message: string }[] }}
 */
export function sweepCliLaneSandboxes(options = {}) {
  const olderThanMs =
    typeof options.olderThanMs === "number" && Number.isFinite(options.olderThanMs) && options.olderThanMs >= 0
      ? options.olderThanMs
      : CLI_SANDBOX_SWEEP_DEFAULT_OLDER_THAN_MS;
  const dryRun = options.dryRun === true;
  const now = Date.now();

  const swept = [];
  const kept = [];
  const errors = [];

  let root;
  try {
    root = resolveSweepRoot(options);
  } catch (err) {
    // Invalid root config is a call-site error: surface once, delete nothing.
    errors.push({ name: "(root)", message: err instanceof Error ? err.message : String(err) });
    return { swept, kept, errors };
  }

  let names;
  try {
    names = readdirSync(root);
  } catch (err) {
    errors.push({ name: "(root)", message: err instanceof Error ? err.message : String(err) });
    return { swept, kept, errors };
  }

  for (const name of names) {
    const child = safeChildPath(root, name);
    if (child == null) {
      // Refuse traversal / injection names without touching the filesystem.
      kept.push(name);
      continue;
    }

    let st;
    try {
      st = lstatSync(child);
    } catch (err) {
      errors.push({ name, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    // Symlink: never follow, never recursive-delete through it. Skip (kept).
    if (st.isSymbolicLink()) {
      kept.push(name);
      continue;
    }

    // Rosa's WO-S10R ruling: the sweep owns per-dispatch DIRECTORIES only. A
    // non-directory entry under the root is anomalous — keep it, never unlink
    // what the sweep did not create.
    if (!st.isDirectory()) {
      kept.push(name);
      continue;
    }

    const ageMs = now - st.mtimeMs;
    if (ageMs < olderThanMs) {
      kept.push(name);
      continue;
    }

    if (dryRun) {
      swept.push(name);
      continue;
    }

    try {
      // Real directory only (symlink + non-dir branches already returned).
      // recursive+force removes the tree under this child; child path is
      // proven under root.
      rmSync(child, { recursive: true, force: true });
      swept.push(name);
    } catch (err) {
      // Locked / in-use / EPERM / EBUSY → errors, never throw the sweep.
      errors.push({ name, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { swept, kept, errors };
}

export default {
  CLI_SANDBOX_SCHEMA,
  CLI_LANE_WORKSPACE_MODES,
  CLI_SANDBOX_ROOT_NAME,
  CLI_SANDBOX_SWEEP_DEFAULT_OLDER_THAN_MS,
  defaultCliSandboxRoot,
  resolveCliLaneWorkspace,
  sweepCliLaneSandboxes,
};
