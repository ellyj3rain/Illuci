/**
 * Specialist role catalog helpers.
 *
 * A specialist is a role-shaped assignment profile with optional knowledge
 * graph/reference links. It is not an agent identity; identities may inhabit
 * these specialist roles at dispatch.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineResolutionRecord } from "../../composition/resolution-record.js";
import { readSpecialistProfile } from "./reader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__dirname, "profiles");

async function walkSlugs(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(...(await walkSlugs(path.join(dir, entry.name), next)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const base = entry.name.slice(0, -3);
      out.push(prefix ? `${prefix}/${base}` : base);
    }
  }
  return out;
}

export function specialistRoleId(slug) {
  return `specialist/${String(slug).replace(/\\/g, "/")}`;
}

function words(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function titleFromSlug(slug) {
  return String(slug)
    .split("/")
    .map((part) => part.split("-").map((w) => w ? `${w[0].toUpperCase()}${w.slice(1)}` : w).join(" "))
    .join(" / ");
}

function categoryFromSlug(slug) {
  const parts = String(slug).split("/");
  if (parts.length > 1) return parts[0];
  return "general";
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function knowledgeRefsOf(frontmatter) {
  if (Array.isArray(frontmatter["knowledge-refs"])) return frontmatter["knowledge-refs"].filter(Boolean);
  if (typeof frontmatter["knowledge-ref"] === "string" && frontmatter["knowledge-ref"].trim()) {
    return [frontmatter["knowledge-ref"].trim()];
  }
  return [];
}

function tokenScore(token, groups) {
  const ordered = [
    [groups.slug, 1],
    [groups.label, 0.8],
    [groups.core, 0.55],
    [groups.tags, 0.2],
  ];
  for (const [tokens, score] of ordered) {
    if (tokens.includes(token)) return score;
  }
  for (const [tokens, score] of ordered) {
    if (tokens.some((candidate) => candidate.includes(token) || token.includes(candidate))) {
      return score * 0.5;
    }
  }
  return 0;
}

function weightedMatchScore(queryTokens, groups) {
  if (queryTokens.length === 0) return 0;
  const score = queryTokens.reduce((sum, token) => sum + tokenScore(token, groups), 0);
  return Math.min(1, score / queryTokens.length);
}

function matchedSignalsFor(queryTokens, groups) {
  const all = unique([...groups.slug, ...groups.label, ...groups.core, ...groups.tags]);
  return unique(queryTokens.filter((token) =>
    all.some((candidate) => candidate === token || candidate.includes(token) || token.includes(candidate)),
  ));
}

export async function listSpecialistRoleSlugs() {
  return walkSlugs(PROFILES_DIR);
}

export async function deriveSpecialistRole(slug) {
  const profile = await readSpecialistProfile(slug);
  if (!profile) return null;
  const fm = profile.frontmatter;
  const resolvedSlug = fm.slug || slug;
  const knowledgeRefs = knowledgeRefsOf(fm);
  const tags = unique([
    categoryFromSlug(resolvedSlug),
    fm.role,
    ...knowledgeRefs,
  ]);
  return Object.freeze({
    id: specialistRoleId(resolvedSlug),
    slug: resolvedSlug,
    label: titleFromSlug(resolvedSlug),
    source: fm["sourced-from"] || null,
    baseRole: fm.role || null,
    knowledgeRefs,
    knowledgeGraphRefs: arrayValue(fm["knowledge-graph-refs"]),
    skillFrameworkRefs: arrayValue(fm["skill-framework-refs"]),
    category: categoryFromSlug(resolvedSlug),
    tags,
    ui: {
      label: titleFromSlug(resolvedSlug),
      category: categoryFromSlug(resolvedSlug),
      subtitle: fm.role || "specialist role",
      badges: unique([fm.role, ...knowledgeRefs]).slice(0, 4),
    },
    telemetry: {
      rawSlug: slug,
      resolvedSlug,
      hasProfileBody: Boolean(profile.body),
      knowledgeRefCount: knowledgeRefs.length,
      knowledgeGraphRefCount: arrayValue(fm["knowledge-graph-refs"]).length,
      skillFrameworkRefCount: arrayValue(fm["skill-framework-refs"]).length,
    },
    provenance: {
      codedBy: "human-directed-system",
      codedOn: "2026-06-23",
      referenceBasis: `core/roles/specialists/profiles/${slug}.md`,
    },
  });
}

export async function listSpecialistRoles() {
  const slugs = await listSpecialistRoleSlugs();
  const roles = await Promise.all(slugs.map((slug) => deriveSpecialistRole(slug)));
  return roles.filter(Boolean);
}

export async function resolveSpecialistRole(query, opts = {}) {
  const roles = await listSpecialistRoles();
  const rawQuery = String(query || "").trim();
  const normalizedQuery = rawQuery.replace(/^specialist\//, "");
  const qTokens = words(normalizedQuery);
  const candidates = roles.map((role) => {
    const groups = {
      slug: words([role.id, role.slug].join(" ")),
      label: words(role.label),
      core: words([role.baseRole, role.category, ...(role.knowledgeRefs || [])].join(" ")),
      tags: words((role.tags || []).join(" ")),
    };
    const exact =
      normalizedQuery === role.slug ||
      rawQuery === role.id ||
      normalizedQuery.toLowerCase() === role.label.toLowerCase();
    const confidence = exact ? 1 : weightedMatchScore(qTokens, groups);
    const matchedSignals = matchedSignalsFor(qTokens, groups);
    return {
      role,
      confidence,
      matchedSignals: unique(matchedSignals),
      mismatchSignals: qTokens.filter((token) => !matchedSignals.includes(token)),
    };
  })
    .filter((candidate) => candidate.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.role.slug.localeCompare(b.role.slug));

  const limit = Number.isInteger(opts.limit) ? Math.max(1, opts.limit) : 5;
  const limited = candidates.slice(0, limit);
  const best = limited[0] || null;
  const threshold = typeof opts.threshold === "number" ? opts.threshold : 0.5;
  const resolved = best && best.confidence >= threshold ? best.role : null;

  return defineResolutionRecord({
    layer: "role.specialist",
    query: rawQuery,
    resolved,
    confidence: best ? best.confidence : 0,
    candidates: limited,
    resolver: "specialist-role-catalog-v1",
    telemetry: {
      totalRoles: roles.length,
      candidateCount: candidates.length,
    },
    threshold,
    status: resolved ? "resolved-with-candidates" : best ? "candidates-below-threshold" : "unresolved",
    ui: {
      label: resolved ? resolved.ui.label : rawQuery,
      candidates: limited.map((candidate) => ({
        id: candidate.role.id,
        label: candidate.role.ui.label,
        confidence: candidate.confidence,
      })),
    },
    governance: {
      layerBoundary: "seat -> role -> specialist role profile; role may attach skill framework refs and knowledge refs",
    },
    provenance: {
      basis: "core/roles/specialists/profiles",
    },
  });
}

export default {
  specialistRoleId,
  listSpecialistRoleSlugs,
  deriveSpecialistRole,
  listSpecialistRoles,
  resolveSpecialistRole,
};
