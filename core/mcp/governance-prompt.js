/**
 * illuci/core/mcp/governance-prompt.js — governance preamble as an MCP prompt
 *
 * Ratified at [A63] / DR-073 per the pilot sequencing in
 * `constitutional/BILL_OF_STANDARDS.md (Standard 16)`. Tier-1 prompt surface of the
 * MCP-boundary discipline. Sourced from `illuci/core/governance/injector.js` - the canonical in-process governance-preamble composer.
 *
 * WHAT THIS EXPOSES: the substrate's governance preamble — the standing
 * context every model dispatched through illuci receives (it is operating
 * within the substrate, it has a structural role, its model identity, its
 * peers, the behavioral rules). In-process callers get this via
 * `injectGovernance()`; this surface exposes the SAME preamble to MCP
 * consuming hosts so a host composing its own model queries can prepend the
 * substrate-canonical governance context rather than re-inventing it.
 *
 * REUSE-NOT-REIMPLEMENT: the render path delegates to `injectGovernance()`
 * so the MCP-exposed preamble can never drift from the in-process one. This honors the
 * dual-layer-rendering pattern (same invariant, two surfaces).
 *
 * Schema name follows the `<surface>_v<N>` convention per constitutional/10
 * § "Schema-versioning discipline".
 */

import { injectGovernance } from '../governance/injector.js';
import { scrub } from '../identity/surface.js';


// ─────────────────────────────────────────────────────────────────────────
// GOVERNANCE PREAMBLE PROMPT
// ─────────────────────────────────────────────────────────────────────────

export const GOVERNANCE_PREAMBLE_PROMPT = {
  name: 'governance_preamble_v1',
  schema_version: '1.0.0',
  description: scrub(
    "The substrate's governance preamble — the standing context every model " +
    'dispatched through illuci receives (operating within the substrate; a structural ' +
    'role to execute; model identity; peers in the lineup; behavioral rules). ' +
    'Compose this ahead of a model query to ground a host-side dispatch in the ' +
    'same governance context illuci applies in-process via injectGovernance().',
  ),
  arguments: [
    {
      name: 'message',
      description: 'Optional: the user/phase message to wrap. If omitted, the prompt renders the preamble + context block alone for the host to compose against.',
      required: false,
    },
    {
      name: 'seat',
      description: 'Optional: the seat this model occupies in the topology.',
      required: false,
    },
    {
      name: 'topology',
      description: 'Optional: the topology name (e.g., council, judiciary, dev-team).',
      required: false,
    },
    {
      name: 'modelId',
      description: 'Optional: the model being queried (used to attach an identity summary).',
      required: false,
    },
    {
      name: 'peerIds',
      description: 'Optional: array of other models in the current lineup.',
      required: false,
    },
    {
      name: 'projectId',
      description: 'Optional: the active project context.',
      required: false,
    },
  ],
  render({ message = '', seat, topology, modelId, peerIds, projectId } = {}) {
    // Delegate to the canonical in-process injector so the MCP-exposed
    // preamble cannot drift from the in-process one. With an empty message
    // the result is the preamble + context block + the `---` separator,
    // which the host composes its own user turn against.
    const governed = injectGovernance(message, {
      seat,
      topology,
      modelId,
      peerIds,
      projectId,
    });
    return {
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: scrub(governed),
          },
        },
      ],
    };
  },
};

export default { GOVERNANCE_PREAMBLE_PROMPT };
