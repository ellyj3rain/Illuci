// core/mcp/runtime-resource.js
//
// [A22.4] Runtime-backed MCP resources. These resources expose the canonical
// runtime API shapes through MCP; they do not re-author runtime state.

import { getRuntimeIdentity } from "../runtime/identity.js";
import { getRuntimeCapability } from "../runtime/capability.js";
import { runtimeDoctor } from "../runtime/doctor.js";
import { postureProfileSnapshot } from "../governance/posture-profile.js";

function jsonResource({ name, uri, description, read }) {
  return {
    name,
    schema_version: "1.0.0",
    uri,
    mimeType: "application/json",
    description,
    read(_args = {}, context = {}) {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(read(context), null, 2),
          },
        ],
      };
    },
  };
}

export const RUNTIME_IDENTITY_RESOURCE = jsonResource({
  name: "runtime_identity_v1",
  uri: "illuci://runtime/identity",
  description: "Canonical Illuci runtime identity, mirrored from GET /runtime/identity.",
  read: () => getRuntimeIdentity(),
});

export const RUNTIME_CAPABILITY_RESOURCE = jsonResource({
  name: "runtime_capability_v1",
  uri: "illuci://runtime/capability",
  description: "Canonical Illuci runtime capability map, mirrored from GET /runtime/capability.",
  read: (context = {}) => getRuntimeCapability({ mcpRegistry: context.mcpRegistry ?? null }),
});

export const RUNTIME_DOCTOR_RESOURCE = jsonResource({
  name: "runtime_doctor_v1",
  uri: "illuci://runtime/doctor",
  description: "Canonical Illuci runtime doctor report, mirrored from GET /runtime/doctor.",
  read: (context = {}) => runtimeDoctor({ mcpRegistry: context.mcpRegistry ?? null }),
});

export const POSTURE_PROFILE_RESOURCE = jsonResource({
  name: "posture_profile_v1",
  uri: "illuci://governance/posture-profile",
  description: "Resolved Illuci posture profile: operator/project/agent policy over version-derived maturity evidence.",
  read: () => postureProfileSnapshot(),
});

export const RUNTIME_RESOURCES = [
  RUNTIME_IDENTITY_RESOURCE,
  RUNTIME_CAPABILITY_RESOURCE,
  RUNTIME_DOCTOR_RESOURCE,
  POSTURE_PROFILE_RESOURCE,
];

export default {
  RUNTIME_IDENTITY_RESOURCE,
  RUNTIME_CAPABILITY_RESOURCE,
  RUNTIME_DOCTOR_RESOURCE,
  POSTURE_PROFILE_RESOURCE,
  RUNTIME_RESOURCES,
};
