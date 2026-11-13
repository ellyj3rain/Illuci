/**
 * illuci - Leaf migrator core (neocli purge)
 *
 * The shared, verified copy -> byte-verify (size + sha256) -> delete engine that
 * migrates a legacy `.neocli` leaf to the forward `.illuci` leaf. Used by both the
 * home-leaf migrator (migrate-home.js, bound to homedir()) and the per-project
 * leaf migrator (migrate-project.js, bound to a project dir).
 *
 * SAFETY (each point is a fix from the Stage-A1 adversarial review):
 *  - Dry-run by DEFAULT: writes and deletes nothing.
 *  - The source delete is reachable ONLY after a 100% clean verify (size + sha256
 *    per file); any mismatch ABORTS with the source left fully intact.
 *  - Refuses on a NON-EMPTY destination: never overwrites/clobbers dst data.
 *  - Refuses on non-regular entries (symlinks/special) rather than silently
 *    dropping them before deleting the source (walk uses lstat, never follows).
 *  - Preserves directory structure, including empty directories.
 *  - Empty source -> "empty-source", NO delete.
 *  - QUIESCE is the CALLER's precondition: run the real apply with NO illuci
 *    process active. These files can be actively written by a running harness; a
 *    concurrent write between copy and delete is a TOCTOU hazard the in-process
 *    logic cannot fully prevent. The explicit migrate verb owns that precondition.
 *
 * "neocli" is the deprecated legacy token; "illuci" is the substrate name.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "fs";
import { join, dirname, relative } from "path";
import { createHash } from "crypto";

/**
 * Walk `root` recursively WITHOUT following symlinks.
 * @returns {{files:string[], dirs:string[], nonRegular:(string|null)}}
 *   files/dirs are relative to root; nonRegular is the first symlink/special
 *   entry found (or null).
 */
function walk(root) {
  const files = [];
  const dirs = [];
  let nonRegular = null;
  const rec = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (nonRegular) return;
      const abs = join(dir, e.name);
      let st;
      try {
        st = lstatSync(abs); // lstat: do NOT follow symlinks
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
        nonRegular = relative(root, abs);
        return;
      }
      if (st.isDirectory()) {
        dirs.push(relative(root, abs));
        rec(abs);
      } else if (st.isFile()) {
        files.push(relative(root, abs));
      }
    }
  };
  rec(root);
  return { files, dirs, nonRegular };
}

function sha256OfFile(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * Migrate `src` (a `.neocli` leaf) -> `dst` (the forward `.illuci` leaf).
 * Dry-run by default.
 *
 * @param {string} src absolute path of the legacy leaf
 * @param {string} dst absolute path of the forward leaf
 * @param {{apply?:boolean}} [opts] apply: false (default) returns a plan and
 *   touches nothing; true performs copy -> verify -> delete.
 * @returns {Object} { status, ... }. status is one of:
 *   "nothing-to-migrate" | "empty-source" | "dry-run" | "refused" |
 *   "verify-failed" | "migrated".
 */
export function migrateLeaf(src, dst, { apply = false } = {}) {
  if (!existsSync(src)) return { status: "nothing-to-migrate", src, dst };

  const { files, dirs, nonRegular } = walk(src);
  if (nonRegular) {
    return { status: "refused", reason: "non-regular-entry", entry: nonRegular, src, dst };
  }

  const fileCount = files.length;
  if (fileCount === 0) {
    return {
      status: "empty-source",
      src,
      dst,
      note: "source has no regular files; nothing migrated, source left intact",
    };
  }

  if (!apply) {
    return { status: "dry-run", src, dst, fileCount, dirCount: dirs.length, files: [...files], wouldDelete: true };
  }

  // APPLY. Never overwrite a populated destination.
  if (existsSync(dst)) {
    let dstEntries = [];
    try {
      dstEntries = readdirSync(dst);
    } catch {
      dstEntries = [];
    }
    if (dstEntries.length > 0) {
      return { status: "refused", reason: "destination-not-empty", dst };
    }
  }

  // Recreate directory structure (including empty dirs), then copy files.
  mkdirSync(dst, { recursive: true });
  for (const rel of dirs) mkdirSync(join(dst, rel), { recursive: true });
  for (const rel of files) {
    const dstFile = join(dst, rel);
    mkdirSync(dirname(dstFile), { recursive: true });
    copyFileSync(join(src, rel), dstFile);
  }

  // Verify file-by-file: existence + size + sha256 content hash.
  const mismatches = [];
  for (const rel of files) {
    const s = join(src, rel);
    const d = join(dst, rel);
    if (!existsSync(d)) {
      mismatches.push({ path: rel, reason: "missing" });
      continue;
    }
    let ss, ds;
    try {
      ss = lstatSync(s);
      ds = lstatSync(d);
    } catch {
      mismatches.push({ path: rel, reason: "stat-failed" });
      continue;
    }
    if (ss.size !== ds.size) {
      mismatches.push({ path: rel, reason: "size-mismatch" });
      continue;
    }
    if (sha256OfFile(s) !== sha256OfFile(d)) {
      mismatches.push({ path: rel, reason: "hash-mismatch" });
      continue;
    }
  }

  if (mismatches.length > 0) {
    // Source stays fully intact; do NOT delete.
    return { status: "verify-failed", mismatches, src, dst, note: "source left fully intact" };
  }

  // Clean verify -> delete source. Last statement, reachable only on zero mismatches.
  rmSync(src, { recursive: true, force: true });
  return { status: "migrated", fileCount, dirCount: dirs.length, verified: true, deletedSource: true, dst };
}

export default { migrateLeaf };
