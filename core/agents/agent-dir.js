import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveIlluciHomeDir } from "./home-dir.js";

const BASE_AGENT_DIR = resolveIlluciHomeDir("agents");

/**
 * Ensures the existence of the base agent directory and a specific model's directory within it.
 * @param {string} modelId The ID of the model (e.g., "claude-local").
 * @returns {string} The path to the model's agent directory.
 */
export function ensureAgentDir(modelId) {
  if (!existsSync(BASE_AGENT_DIR)) {
    mkdirSync(BASE_AGENT_DIR, { recursive: true });
  }
  const modelAgentDir = join(BASE_AGENT_DIR, modelId);
  if (!existsSync(modelAgentDir)) {
    mkdirSync(modelAgentDir, { recursive: true });
  }
  return modelAgentDir;
}

/**
 * Get the path to a specific model's agent directory without ensuring its existence.
 * @param {string} modelId The ID of the model (e.g., "claude-local").
 * @returns {string} The path to the model's agent directory.
 */
export function getAgentDir(modelId) {
  return join(BASE_AGENT_DIR, modelId);
}
