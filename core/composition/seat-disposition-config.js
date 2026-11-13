/**
 * Illuci - seat disposition config.
 *
 * Per-seat disposition config: preset/profile plus role intent and skill hints.
 */

import { isValidProfile } from "../agents/disposition-dimensions.js";
import { listPresets } from "../agents/disposition-presets.js";
import { listSkills, listRoles as listSkillBundleRoles } from "../agents/skill-registry.js";
import { listRoleIds } from "../roles/role-registry.js";
import { resolveCompositionRole } from "./role-composition.js";

const RETIRED_DISPOSITION_KEYS = Object.freeze([
  "personalityTypeId",
  "pathologicalProfiles",
  "qualitativeTraits",
  "roleBias",
  "operatorSet",
  "bigFive",
  "darkTriad",
  "enneagram",
]);

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function normalizeSkillList(value) {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map(cleanString).filter(Boolean);
  }
  return [];
}

export function normalizeDispositionConfig(config = {}) {
  if (!config || typeof config !== "object") return null;

  const out = {};
  const presetId = cleanString(config.presetId);
  const role = cleanString(config.role);
  const skills = normalizeSkillList(config.skills);

  if (presetId) out.presetId = presetId;
  if (config.profile && typeof config.profile === "object") out.profile = config.profile;
  if (role) out.role = role;
  if (skills.length) out.skills = skills;

  return Object.keys(out).length ? out : null;
}

export function buildSeatDispositions({ seatIds = [], globalConfig = {}, perSeatConfig = {} } = {}) {
  const ids = [...new Set((seatIds || []).map(cleanString).filter(Boolean))];
  const global = normalizeDispositionConfig(globalConfig) || {};
  const out = {};

  for (const seatId of ids) {
    const local = normalizeDispositionConfig(perSeatConfig[seatId]) || {};
    const config = normalizeDispositionConfig({ ...global, ...local });
    if (config) out[seatId] = config;
  }

  return out;
}

export function collectTopologySeatIds(topology) {
  return [...new Set((topology?.seats || []).map((seat) => cleanString(seat?.id)).filter(Boolean))];
}

export function collectTopologySeatIdsByIds(topologies, topologyIds = []) {
  const ids = [];
  for (const topologyId of topologyIds) {
    ids.push(...collectTopologySeatIds(topologies?.[topologyId]));
  }
  return [...new Set(ids)];
}

export function validateSeatDispositions(seatDispositions) {
  const errors = [];
  if (!seatDispositions || typeof seatDispositions !== "object") return errors;

  const validPresets = listPresets();
  const validSkills = listSkills();
  const validMatrixRoles = listRoleIds();
  const validSkillBundleRoles = listSkillBundleRoles();

  for (const [seat, rawConfig] of Object.entries(seatDispositions)) {
    const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    const retiredKeys = RETIRED_DISPOSITION_KEYS.filter((key) => config[key] !== undefined);
    if (retiredKeys.length) {
      errors.push({
        kind: "ontology",
        seat,
        keys: retiredKeys,
        detail: "Retired disposition key(s): " + retiredKeys.join(", "),
        remedy: "use presetId/profile with role and skills",
      });
    }

    if (config.presetId && !validPresets.includes(String(config.presetId))) {
      errors.push({
        kind: "preset",
        seat,
        presetId: String(config.presetId),
        available: validPresets,
        detail: "Unknown preset: " + config.presetId,
        remedy: "pick a valid presetId",
      });
    }

    if (config.profile !== undefined && (!config.profile || typeof config.profile !== "object" || !isValidProfile(config.profile))) {
      errors.push({
        kind: "profile",
        seat,
        detail: "Invalid inline dimensional profile",
        remedy: "pass a DimensionalProfile object with valid 0..1 facet values",
      });
    }

    if (config.role) {
      const role = resolveCompositionRole(String(config.role));
      if (role.source === "unresolved") {
        errors.push({
          kind: "role",
          seat,
          role: String(config.role),
          available: { matrixRoles: validMatrixRoles, skillBundleRoles: validSkillBundleRoles },
          detail: "Unknown role: " + config.role,
          remedy: "pick a matrix role or skill-bundle role",
        });
      }
    }

    const unknownSkills = normalizeSkillList(config.skills).filter((skillId) => !validSkills.includes(skillId));
    if (unknownSkills.length) {
      errors.push({
        kind: "skills",
        seat,
        skills: unknownSkills,
        available: validSkills,
        detail: "Unknown skill(s): " + unknownSkills.join(", "),
        remedy: "pick valid skill ids",
      });
    }
  }

  return errors;
}
