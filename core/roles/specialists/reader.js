/**
 * Specialist role reader.
 *
 * Reads specialist role profiles and their linked knowledge seeds from
 * core/roles/specialists/{profiles,knowledge}. These files are role substrate:
 * they can inform a seat assignment and future knowledge graph links, but they
 * are not agent identity, cast, persona, or anthropology.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__dirname, "profiles");
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

export function parseFrontmatter(raw) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("|") || lines[i].trim() === "")) i++;
  if (lines[i] !== "---") {
    return { frontmatter: {}, body: lines.slice(i).join("\n").trim() };
  }

  const fmStart = i + 1;
  const fmEnd = lines.indexOf("---", fmStart);
  if (fmEnd === -1) {
    return { frontmatter: {}, body: lines.slice(i).join("\n").trim() };
  }

  const fmRaw = lines.slice(fmStart, fmEnd).join("\n");
  const body = lines.slice(fmEnd + 1).join("\n").trim();
  const frontmatter = {};
  const fmLines = fmRaw.split(/\r?\n/);
  let pendingKey = null;
  let pendingList = null;

  for (const line of fmLines) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (pendingKey && listItem) {
      pendingList.push(listItem[1].trim().replace(/^"(.*)"$/, "$1"));
      continue;
    }
    if (pendingKey) {
      frontmatter[pendingKey] = pendingList;
      pendingKey = null;
      pendingList = null;
    }

    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, valueRaw] = m;
    const value = valueRaw.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (value === "") {
      pendingKey = key;
      pendingList = [];
    } else {
      frontmatter[key] = value.replace(/^"(.*)"$/, "$1");
    }
  }

  if (pendingKey) {
    frontmatter[pendingKey] = pendingList.length > 0 ? pendingList : null;
  }

  return { frontmatter, body };
}

function slugFile(dir, slug) {
  if (typeof slug !== "string" || slug.trim() === "") return null;
  const normalized = slug.replace(/\\/g, "/").trim();
  const parts = normalized.split("/");
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith(".") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid specialist slug: ${slug}`);
  }
  return path.join(dir, ...parts) + ".md";
}

async function readEntry(dir, slug) {
  const file = slugFile(dir, slug);
  if (!file) return null;
  try {
    const raw = await fs.readFile(file, "utf8");
    return parseFrontmatter(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function readSpecialistProfile(slug) {
  return readEntry(PROFILES_DIR, slug);
}

export async function resolveSpecialistProfile(slug) {
  return readEntry(PROFILES_DIR, slug);
}

export async function resolveSpecialistKnowledge(slug) {
  return readEntry(KNOWLEDGE_DIR, slug);
}

export default {
  parseFrontmatter,
  readSpecialistProfile,
  resolveSpecialistProfile,
  resolveSpecialistKnowledge,
};
