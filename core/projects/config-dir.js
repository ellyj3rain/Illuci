/**
 * illuci — Project config-dir resolver
 *
 * The project-local convention dir is `.illuci/` (the model-agnostic illuci
 * convention; the `.claude/` analog) for both reads and writes. "illuci" is the
 * substrate name.
 */

import { join } from "path";

export const PROJECT_CONFIG_DIR = ".illuci";

/**
 * Resolve the project-local config dir for a project root.
 *
 * Always `.illuci/` for both reads and writes.
 *
 * @param {string} projectDir absolute project root
 * @returns {string} the resolved config dir path
 */
export function resolveProjectConfigDir(projectDir) {
  return join(projectDir, PROJECT_CONFIG_DIR);
}

/**
 * Resolve a project-local config FILE path.
 * @param {string} projectDir absolute project root
 * @param {string} filename
 * @returns {string}
 */
export function resolveProjectConfigFile(projectDir, filename) {
  return join(resolveProjectConfigDir(projectDir), filename);
}

export default {
  PROJECT_CONFIG_DIR,
  resolveProjectConfigDir,
  resolveProjectConfigFile,
};
