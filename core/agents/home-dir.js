/** Runtime configuration and agent-data directory. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ILLUCI_HOME_LEAF = ".illuci";

/** An explicit deployment root keeps tests and installations independent. */
export function resolveIlluciHomeDir(...subpath) {
  const root = process.env.ILLUCI_CONFIG_HOME
    ? resolve(process.env.ILLUCI_CONFIG_HOME) : join(homedir(), ILLUCI_HOME_LEAF);
  return join(root, ...subpath);
}

export default { ILLUCI_HOME_LEAF, resolveIlluciHomeDir };
