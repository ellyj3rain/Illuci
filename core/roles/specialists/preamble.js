/**
 * Specialist role preamble composer.
 *
 * Specialist role profiles are assignable role substrate. Dispatch receives
 * concise role metadata plus knowledge/reference links when present.
 */

import { readSpecialistProfile } from "./reader.js";

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function profileLines(slug, frontmatter) {
  const lines = [`slug: ${frontmatter.slug || slug}`];
  if (present(frontmatter.role)) lines.push(`role: ${frontmatter.role}`);
  if (present(frontmatter["sourced-from"])) lines.push(`source: ${frontmatter["sourced-from"]}`);
  if (present(frontmatter["voice-posture"])) lines.push(`posture: ${frontmatter["voice-posture"]}`);
  if (present(frontmatter["voice-cadence"])) lines.push(`cadence: ${frontmatter["voice-cadence"]}`);
  if (present(frontmatter["voice-refuses"])) lines.push(`refuses: ${frontmatter["voice-refuses"]}`);
  const knowledgeRefs = arrayValue(frontmatter["knowledge-refs"]);
  if (knowledgeRefs.length > 0) {
    lines.push(`knowledgeRefs: ${knowledgeRefs.join(", ")}`);
  }
  const knowledgeGraphRefs = arrayValue(frontmatter["knowledge-graph-refs"]);
  if (knowledgeGraphRefs.length > 0) {
    lines.push(`knowledgeGraphRefs: ${knowledgeGraphRefs.join(", ")}`);
  }
  const skillFrameworkRefs = arrayValue(frontmatter["skill-framework-refs"]);
  if (skillFrameworkRefs.length > 0) {
    lines.push(`skillFrameworkRefs: ${skillFrameworkRefs.join(", ")}`);
  }
  const patterns = list(frontmatter["named-patterns"]);
  if (patterns) lines.push(`patterns: ${patterns}`);
  return lines;
}

export async function getSpecialistRolePreamble(specialistSlug, opts = {}) {
  const profile = await readSpecialistProfile(specialistSlug);
  if (!profile) return null;

  const includeLegacyProfileBody = opts.includeLegacyProfileBody === true;
  const sections = [];

  sections.push(`[Specialist Role]\n${profileLines(specialistSlug, profile.frontmatter).join("\n")}`);

  if (includeLegacyProfileBody && profile.body) {
    sections.push(`[Legacy Profile Notes]\n${profile.body}`);
  }

  return sections.join("\n\n");
}

export default { getSpecialistRolePreamble };
