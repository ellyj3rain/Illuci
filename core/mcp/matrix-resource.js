/**
 * illuci/core/mcp/matrix-resource.js — capability matrix as a Tier-1 MCP resource
 *
 * Per constitutional/BILL_OF_STANDARDS.md (Standard 16) the capability matrix is Tier-1
 * ("Capability matrix lookup; static-data resource") — a RESOURCE, not a tool
 * (it is read-only static data, not a request→response invocation). Exposes a
 * snapshot: for each role, the priority-ordered models that can fill it, plus
 * the model + role rosters. Read-only.
 */

import { getMatrix, MODELS, getRoles } from "../matrix/capability-matrix.js";

const URI = "illuci://matrix/capabilities";

export const CAPABILITY_MATRIX_RESOURCE = {
  name: "capability_matrix_v1",
  schema_version: "1.0.0",
  uri: URI,
  mimeType: "application/json",
  description:
    "The illuci capability matrix: for each role, the priority-ordered models that can fill it, " +
    "plus the model and role rosters. Static-data snapshot; read-only.",
  read() {
    return {
      contents: [
        {
          uri: URI,
          mimeType: "application/json",
          text: JSON.stringify(
            { models: MODELS, roles: getRoles(), matrix: getMatrix() },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export default { CAPABILITY_MATRIX_RESOURCE };
