/**
 * illuci/core/mcp/runtime-guard.js
 *
 * Long-lived MCP hosts can keep a server process alive after the illuci checkout has
 * changed. Node keeps the old modules in memory, so the process may keep serving
 * stale code into new host sessions. This guard fingerprints the source checkout
 * at boot and fails closed when the backing source changes.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ILLUCI_ROOT = resolve(HERE, "..", "..");
const DEFAULT_PATHS = Object.freeze([
  "core",
  "cli",
  "scripts",
  "package.json",
  "package-lock.json",
  "VERSION",
]);
const EXCLUDED_PREFIXES = Object.freeze([]);
const DEFAULT_CHECK_INTERVAL_MS = 1000;

export class McpRuntimeStaleError extends Error {
  constructor({ boot, current }) {
    super(
      "MCP_RUNTIME_STALE: illuci MCP server source changed after this process booted; " +
      "restart the MCP server before using it again.",
    );
    this.name = "McpRuntimeStaleError";
    this.code = "MCP_RUNTIME_STALE";
    this.jsonRpcCode = -32075;
    this.boot = boot;
    this.current = current;
  }
}

function runGit(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/");
}

function shouldIgnore(relPath) {
  const normalized = normalizePath(relPath);
  return EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function statFingerprint(root, relPath) {
  if (shouldIgnore(relPath)) return null;
  const abs = resolve(root, relPath);
  if (!existsSync(abs)) return `${normalizePath(relPath)}:missing`;
  try {
    const stat = statSync(abs);
    if (stat.isDirectory()) return null;
    return `${normalizePath(relPath)}:${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return `${normalizePath(relPath)}:unreadable`;
  }
}

function trackedRuntimePaths(root, paths = DEFAULT_PATHS) {
  const out = runGit(root, ["ls-files", "-z", "--", ...paths]);
  if (out != null && out !== "") {
    return out
      .split("\0")
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => !shouldIgnore(item))
      .sort();
  }
  return [...paths].filter((item) => existsSync(resolve(root, item))).sort();
}

function hashObject(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildMcpRuntimeStamp({ root = ILLUCI_ROOT, paths = DEFAULT_PATHS } = {}) {
  const tracked = trackedRuntimePaths(root, paths);
  const fileStats = tracked
    .map((relPath) => statFingerprint(root, relPath))
    .filter(Boolean);
  const packageJson = readText(resolve(root, "package.json"));
  let packageVersion = null;
  if (packageJson) {
    try {
      packageVersion = JSON.parse(packageJson).version || null;
    } catch {
      packageVersion = null;
    }
  }
  const stamp = {
    schema: "illuci.mcp.runtime-stamp/1",
    root,
    gitHead: runGit(root, ["rev-parse", "HEAD"]),
    gitBranch: runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    version: readText(resolve(root, "VERSION")),
    packageVersion,
    fileCount: fileStats.length,
    fileStats,
  };
  return {
    ...stamp,
    fingerprint: hashObject(stamp),
  };
}

export function describeRuntimeDelta(boot, current) {
  return {
    boot: {
      gitHead: boot?.gitHead || null,
      gitBranch: boot?.gitBranch || null,
      version: boot?.version || null,
      packageVersion: boot?.packageVersion || null,
      fingerprint: boot?.fingerprint || null,
    },
    current: {
      gitHead: current?.gitHead || null,
      gitBranch: current?.gitBranch || null,
      version: current?.version || null,
      packageVersion: current?.packageVersion || null,
      fingerprint: current?.fingerprint || null,
    },
  };
}

export function createMcpRuntimeGuard({
  enabled = process.env.ILLUCI_MCP_STALE_GUARD !== "0",
  root = ILLUCI_ROOT,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  snapshot = () => buildMcpRuntimeStamp({ root }),
} = {}) {
  const boot = snapshot();
  let lastCheck = 0;
  let staleError = null;

  function assertFresh(now = Date.now()) {
    if (!enabled) return { fresh: true, disabled: true, boot };
    if (staleError) throw staleError;
    if (now - lastCheck < checkIntervalMs) return { fresh: true, boot };
    lastCheck = now;
    const current = snapshot();
    if (current.fingerprint !== boot.fingerprint) {
      staleError = new McpRuntimeStaleError({ boot, current });
      throw staleError;
    }
    return { fresh: true, boot };
  }

  return {
    boot,
    assertFresh,
    isFresh() {
      try {
        assertFresh(0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function isMcpRuntimeStaleError(error) {
  return error?.code === "MCP_RUNTIME_STALE";
}

export default {
  McpRuntimeStaleError,
  buildMcpRuntimeStamp,
  createMcpRuntimeGuard,
  describeRuntimeDelta,
  isMcpRuntimeStaleError,
};
