/**
 * illuci data path resolver.
 *
 * Runtime data is source material for longitudinal analysis, but it is not the
 * same thing as source code. This module gives runtime observations a governed,
 * typed home under the local illuci data root, while still allowing callers to
 * promote selected artifacts into committed provenance deliberately.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const DEFAULT_RUNTIME_DATA_HOME = join(REPO_ROOT, ".illuci", "data");

export const DATA_KINDS = Object.freeze({
  decisions: "decisions",
  traces: "traces",
  telemetry: "telemetry",
  sessions: "sessions",
  memory: "memory",
  governance: "governance",
  gitops: "gitops",
  infrastructure: "infrastructure",
  connections: "connections",
});

export function runtimeDataHome() {
  return resolve(process.env.ILLUCI_DATA_HOME || DEFAULT_RUNTIME_DATA_HOME);
}

export function runtimeDataPath(kind, name) {
  if (!kind || !DATA_KINDS[kind]) throw new Error(`unknown illuci data kind: ${kind || "(missing)"}`);
  if (!name) throw new Error("runtimeDataPath requires a file name");
  return join(runtimeDataHome(), kind, name);
}

export function ensureRuntimeDataPath(kind, name) {
  const path = runtimeDataPath(kind, name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function committedProvenancePath(...segments) {
  return join(REPO_ROOT, ...segments);
}

export default {
  DATA_KINDS,
  REPO_ROOT,
  DEFAULT_RUNTIME_DATA_HOME,
  runtimeDataHome,
  runtimeDataPath,
  ensureRuntimeDataPath,
  committedProvenancePath,
};
