/**
 * illuci/core/mcp/write-tools.js — the skill-framework's first WRITE verb on the MCP boundary.
 *
 * Where the composition tools (composition-tools.js) are read-shaped resolvers, this is a
 * MUTATING tool: role_create_v1 creates a runtime role in the writable role-overlay store
 * (runtime-roles.js). It carries co-located `requiredActions` so the Phase-2 boundary
 * (permission-context.js) gates it — only a seat whose effective permission includes the
 * required action may call it; a read-only/restricted seat is denied CAPABILITY_DENIED
 * before the handler runs.
 *
 * Operator-ratified design (2026-06-21): additive-only (a runtime role is a new id, never
 * shadows the frozen canon — createRuntimeRole refuses a canonical id), subtractive-by-
 * construction (the stored profile can only TIGHTEN the topology ceiling), persisted to a
 * home .illuci leaf. This is Slice 1's first write verb; topology.create / skill.assign /
 * mcp.boundary.set follow the same pattern over the same store.
 *
 * @module core/mcp/write-tools
 */
import { createRuntimeRole, assignSkillBundle, assignSkillFrameworks, setBoundary } from "../roles/runtime-roles.js";
import { TOPOLOGIES } from "../topologies/index.js";
import { createRuntimeTopology } from "../topologies/runtime-topologies.js";
import { validateRuntimeTopology } from "../contracts/runtime-topology-schema.js";

export const WRITE_TOOLS = [
  {
    name: "role_create_v1",
    schema_version: "1.0.0",
    description:
      "Create a runtime role in the writable role-overlay store. Additive over the frozen " +
      "canon (refuses a canonical id) and subtractive-by-construction (a role may only TIGHTEN " +
      "the topology ceiling via tightenActions, never widen it). Persisted to the home .illuci leaf. " +
      "Returns the stored profile, or created:false when the id is invalid or canonical.",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        roleId: { type: "string", description: "The new runtime role id (must not collide with a canonical role)." },
        tightenActions: { type: "array", items: { type: "string" }, description: "Actions this role REMOVES from the topology ceiling (subtractive)." },
        requireGateFor: { type: "array", items: { type: "string" }, description: "Actions this role forces through the gate." },
        skillBundleRoleId: { type: ["string", "null"], description: "Optional bridge to a skill-registry ROLES bundle." },
        skillFrameworkRefs: { type: "array", items: { type: "string" }, description: "Optional graph-native skill-framework refs." },
        permissionBoundaryRefs: { type: "array", items: { type: "string" }, description: "Optional permission-boundary refs carried for audit." },
      },
      required: ["roleId"],
    },
    async handler(args = {}) {
      const { roleId, tightenActions, requireGateFor, skillBundleRoleId, skillFrameworkRefs, permissionBoundaryRefs } = args;
      const profile = createRuntimeRole(roleId, {
        tightenActions,
        requireGateFor,
        skillBundleRoleId,
        skillFrameworkRefs,
        permissionBoundaryRefs,
      });
      if (profile === null) {
        return { roleId, created: false, reason: "invalid, empty, or collides with a canonical role id" };
      }
      return { roleId, created: true, profile };
    },
  },
  {
    name: "skill_assign_v1",
    schema_version: "1.0.0",
    description:
      "Attach skill capability refs to a RUNTIME role: the legacy skillBundleRoleId and/or " +
      "graph-native skillFrameworkRefs. Runtime roles only; the frozen canon is immutable. Gated.",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        roleId: { type: "string", description: "The runtime role to attach the bundle to." },
        skillBundleRoleId: { type: ["string", "null"], description: "The skill-registry ROLES bundle id (or null to clear)." },
        skillFrameworkRefs: { type: "array", items: { type: "string" }, description: "Graph-native skill-framework refs." },
      },
      required: ["roleId"],
    },
    async handler(args = {}) {
      let role = assignSkillBundle(args.roleId, args.skillBundleRoleId);
      if (role !== null && Array.isArray(args.skillFrameworkRefs)) {
        role = assignSkillFrameworks(args.roleId, args.skillFrameworkRefs);
      }
      if (role === null) {
        return { roleId: args.roleId, assigned: false, reason: "not a runtime role (the frozen canon is immutable)" };
      }
      return {
        roleId: args.roleId,
        assigned: true,
        skillBundleRoleId: role.skillBundleRoleId,
        skillFrameworkRefs: role.skillFrameworkRefs || [],
      };
    },
  },
  {
    name: "mcp_boundary_set_v1",
    schema_version: "1.0.0",
    description:
      "Set the dynamic permission boundary on a RUNTIME role: its tightenActions (subtractive — " +
      "only REMOVES from the topology ceiling) and requireGateFor. Runtime roles only; the frozen " +
      "canon is immutable. Gated.",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        roleId: { type: "string", description: "The runtime role whose boundary to set." },
        tightenActions: { type: "array", items: { type: "string" }, description: "Actions REMOVED from the ceiling (subtractive)." },
        requireGateFor: { type: "array", items: { type: "string" }, description: "Actions forced through the gate." },
        permissionBoundaryRefs: { type: "array", items: { type: "string" }, description: "Permission-boundary refs carried for audit." },
      },
      required: ["roleId"],
    },
    async handler(args = {}) {
      const role = setBoundary(args.roleId, {
        tightenActions: args.tightenActions,
        requireGateFor: args.requireGateFor,
        permissionBoundaryRefs: args.permissionBoundaryRefs,
      });
      if (role === null) {
        return { roleId: args.roleId, set: false, reason: "not a runtime role (the frozen canon is immutable)" };
      }
      return {
        roleId: args.roleId,
        set: true,
        tightenActions: role.tightenActions,
        requireGateFor: role.requireGateFor,
        permissionBoundaryRefs: role.permissionBoundaryRefs || [],
      };
    },
  },
  {
    name: "topology_create_v1",
    schema_version: "1.0.0",
    description:
      "Create a runtime topology in illuci's writable topology-overlay store. Additive over the frozen " +
      "topology registry (a runtime id never shadows the canon). Requires at least one seat and one " +
      "phase. Persisted to the home .illuci leaf. Gated.",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The new runtime topology id." },
        name: { type: "string" },
        description: { type: "string" },
        seats: { type: "array", items: { type: "object" }, description: "Seat definitions (id, label, min, max, roleHint, relationships)." },
        phases: { type: "array", items: { type: "object" }, description: "Phase definitions (id, type, seat(s), input, mode)." },
      },
      required: ["id", "seats", "phases"],
    },
    async handler(args = {}) {
      const reservedIds = Object.keys(TOPOLOGIES);
      // Validate at the trust boundary first so the caller gets actionable errors
      // (bad seat weight / relationship / roleHint, malformed phase, reserved-id
      // collision), not just a generic refusal. createRuntimeTopology re-validates.
      const validation = validateRuntimeTopology(
        { id: args.id, name: args.name, description: args.description, seats: args.seats, phases: args.phases },
        { reservedIds },
      );
      if (!validation.ok) {
        return { id: args.id, created: false, reason: "invalid runtime topology", errors: validation.errors };
      }
      const topology = createRuntimeTopology(
        args.id,
        { name: args.name, description: args.description, seats: args.seats, phases: args.phases },
        { reservedIds },
      );
      if (topology === null) {
        return { id: args.id, created: false, reason: "runtime topology create refused (canonical id collision or store write error)" };
      }
      return { id: topology.id, created: true, topology };
    },
  },
];

export default { WRITE_TOOLS };
