/**
 * illuci/core/mcp/surface-resource.js — capability card / surface-context probe as an MCP resource.
 *
 * illuci self-describes to a host agent (Claude/Codex/Grok/Cursor) or human: what it
 * is, how to invoke it over CLI/MCP/API, and what is on/gated/off plus the one-line
 * control to turn each off-capability on. Read-only, disclosure-only snapshot;
 * grounds in the source-owned surface-map + defaults + feature-gate registries and
 * flips nothing. The MCP mirror of `illuci describe`.
 */

import { buildCapabilityCard } from "../surface/capability-card.js";

const URI = "illuci://surface/capability-card";

export const CAPABILITY_CARD_RESOURCE = {
  name: "capability_card_v1",
  schema_version: "1.0.0",
  uri: URI,
  mimeType: "application/json",
  description:
    "illuci's self-description for a host agent or human: identity, how to invoke it (CLI/MCP/API), " +
    "capabilities on/gated/dark, the disclosed run-posture defaults, and the feature gates that are " +
    "off plus the one-line control to turn each on. Read-only disclosure snapshot; flips nothing.",
  read() {
    return {
      contents: [
        {
          uri: URI,
          mimeType: "application/json",
          text: JSON.stringify(buildCapabilityCard(), null, 2),
        },
      ],
    };
  },
};

export default { CAPABILITY_CARD_RESOURCE };
