/**
 * Illuci - agent resolver.
 *
 * Composes the active preamble layers for a seated agent without importing
 * extraction-residue cast or voice surfaces.
 */

import { getAgent } from "../agents/agent-core.js";
import { getSpecialistRolePreamble } from "../roles/specialists/preamble.js";
import { composeBehavioralDisposition } from "./disposition-resolver.js";

export const PREAMBLE_BLOCK_ORDER = Object.freeze([
  "specialistRole",
  "disposition",
  "memory",
  "role",
]);

/**
 * Compose an agent preamble from active role and disposition surfaces.
 *
 * @param {Object} input
 * @param {string} [input.agentId] registered agent-core id
 * @param {string} [input.specialistSlug] specialist role slug
 * @param {string} [input.modelId] model filling the seat
 * @param {string} [input.seatId] topology seat id
 * @param {Object} [input.seatDef] topology seat definition
 * @param {Object} [input.dispatchOpts] run options carrying seatDispositions
 * @param {boolean} [input.includeLegacyProfileBody=false] specialist preamble detail switch
 * @returns {Promise<{preamble: string, layers: Object, dispositionMeta: Object|null, core: Object|null}>}
 */
export async function resolveAgent(input = {}, runtime = {}) {
  void runtime;
  const {
    agentId = null,
    specialistSlug = null,
    modelId = null,
    seatId = null,
    seatDef = {},
    dispatchOpts = {},
    includeLegacyProfileBody = false,
  } = input;

  const core = agentId ? getAgent(agentId) : null;
  const roleSpecialistSlug =
    specialistSlug || (core && core.worldRef && core.worldRef.anchorBioRef) || null;

  const layers = {};

  if (roleSpecialistSlug) {
    const specialist = await getSpecialistRolePreamble(roleSpecialistSlug, {
      includeLegacyProfileBody,
    });
    if (specialist) layers.specialistRole = specialist;
  }

  const disposition = await composeBehavioralDisposition({ modelId, seatId, seatDef, dispatchOpts });
  if (disposition && disposition.block) layers.disposition = disposition.block;

  const parts = [];
  for (const key of PREAMBLE_BLOCK_ORDER) {
    if (layers[key]) parts.push(layers[key]);
  }

  return {
    preamble: parts.join("\n\n"),
    layers,
    dispositionMeta: disposition
      ? { engine: disposition.engine, audit: disposition.audit, meta: disposition.meta }
      : null,
    core,
  };
}

export default { resolveAgent, PREAMBLE_BLOCK_ORDER };
