/**
 * illuci - Home-leaf migrator (neocli purge, Stage A1)
 *
 * Migrates the legacy `~/.neocli` home leaf (= homedir()/.neocli, where the live
 * operator data lives: agents, persona memory, session + repl history, plugins,
 * skills) to the forward homedir()/.illuci leaf. Thin wrapper over the shared,
 * verified migrate-leaf core (copy -> size+sha256 verify -> delete-only-on-clean).
 *
 * Bound to homedir(), NOT resolveIlluciHomeRoot()/ILLUCI_HOME: the deleted path is a
 * single stable location, never env-relocatable. (The drive-scoped
 * resolveIlluciHomeRoot()/.neocli audit cache is a SEPARATE concern, purged at
 * Stage D.) The `homeRoot` param exists ONLY for tests; default homedir().
 *
 * Dry-run by default; QUIESCE (no illuci process active) is required for the real
 * apply. See migrate-leaf.js for the full safety contract.
 *
 * "neocli" is the deprecated legacy token; "illuci" is the substrate name.
 */

import { join } from "path";
import { homedir } from "os";
import { migrateLeaf } from "./migrate-leaf.js";

/**
 * Migrate homedir()/.neocli -> homedir()/.illuci. Dry-run by default.
 *
 * @param {{apply?:boolean, homeRoot?:string}} [opts]
 *   apply: false (default) returns a plan and touches nothing; true performs
 *          copy -> verify -> delete. homeRoot: test-only override of homedir().
 * @returns {Object} migrate-leaf status object.
 */
export function migrateHome({ apply = false, homeRoot = homedir() } = {}) {
  return migrateLeaf(join(homeRoot, ".neocli"), join(homeRoot, ".illuci"), { apply });
}

export default { migrateHome };
