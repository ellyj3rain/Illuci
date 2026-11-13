import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { resolve } from "path";
import { resolveIlluciHomeDir } from "../../core/agents/home-dir.js";

const HISTORY_DIR = resolveIlluciHomeDir();
const HISTORY_FILE = resolve(HISTORY_DIR, "repl_history");
const MAX_ENTRIES = 1000;

export function load() {
  if (!existsSync(HISTORY_FILE)) return [];
  const content = readFileSync(HISTORY_FILE, "utf-8");
  return content.split(/\r?\n/).filter((line) => line.length > 0);
}

export function save(lines) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const trimmed = lines.slice(-MAX_ENTRIES);
  writeFileSync(HISTORY_FILE, trimmed.join("\n") + (trimmed.length > 0 ? "\n" : ""), "utf-8");
  try {
    chmodSync(HISTORY_FILE, 0o600);
  } catch {}
}
