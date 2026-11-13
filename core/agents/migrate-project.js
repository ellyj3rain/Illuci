/**
 * illuci - Per-project leaf migrator (neocli purge, Stage C)
 *
 * Migrates a single project's legacy `<projectDir>/.neocli` leaf (per-project
 * project.json, sessions, persona/project memory, project-local plugins) to the
 * forward `<projectDir>/.illuci` leaf. Thin wrapper over the shared, verified
 * migrate-leaf core (copy -> size+sha256 verify -> delete-only-on-clean).
 *
 * This is the per-project analog of the home-leaf migrator. The project config
 * code (config-dir.js, sessions/record.js, plugins/loader.js, standards/reorg)
 * is now `.illuci`-only; this migrator carries existing project data forward so it
 * is not orphaned. Operator-ratified (per-project migrate+remove, 2026-06-19).
 *
 * Dry-run by default; QUIESCE (no illuci process touching this project) is required
 * for the real apply. See migrate-leaf.js for the full safety contract.
 *
 * "neocli" is the deprecated legacy token; "illuci" is the substrate name.
 */

import { join } from "path";
import { migrateLeaf } from "./migrate-leaf.js";

/**
 * Migrate <projectDir>/.neocli -> <projectDir>/.illuci. Dry-run by default.
 *
 * @param {string} projectDir absolute project root
 * @param {{apply?:boolean}} [opts] apply: false (default) plans only; true
 *   performs copy -> verify -> delete.
 * @returns {Object} migrate-leaf status object.
 */
export function migrateProject(projectDir, { apply = false } = {}) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("migrateProject: projectDir (absolute path string) is required");
  }
  return migrateLeaf(join(projectDir, ".neocli"), join(projectDir, ".illuci"), { apply });
}

export default { migrateProject };
