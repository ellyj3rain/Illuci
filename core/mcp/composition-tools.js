/**
 * illuci/core/mcp/composition-tools.js — Tier-1 composition resolvers as MCP tools
 *
 * The first executable surface on the illuci MCP boundary (prior tiers exposed only
 * prompts + resources). Per constitutional/BILL_OF_STANDARDS.md (Standard 16) the composition
 * resolvers are Tier-1 ("Pure resolvers, request → response shape"); this exposes
 * the two single-input ones — role and skill resolution — as MCP tools. The
 * richer-input resolvers (disposition) + matrix + formation Phase A + analysis are
 * the same pattern and follow as their own granular steps in the pilot sequence.
 *
 * Each tool carries an explicit `schema_version` per the schema-versioning
 * discipline, and a versioned name (`compose_role_v1`) so evolution is
 * deprecate-and-add, never destructive.
 *
 * These resolvers are read-shaped (query the substrate's composition decisions
 * without invoking dispatch), so they raise no gate or side-effect concern at the
 * boundary — the property that qualifies them for Tier-1.
 */

import { resolveRole } from "../composition/role-resolver.js";
import { loadSkill } from "../composition/skill-resolver.js";
import { composeBehavioralDisposition } from "../composition/disposition-resolver.js";
import { resolveSkillFramework, resolveSkillFrameworkUse } from "../roles/skill-frameworks/catalog.js";

export const COMPOSITION_TOOLS = [
  {
    name: "compose_role_v1",
    schema_version: "1.0.0",
    description:
      "Resolve a role id to the available models that can fill it (priority-ordered), " +
      "with the resolved role's prompt and candidate set. Read-only; queries the capability matrix.",
    inputSchema: {
      type: "object",
      properties: {
        roleId: { type: "string", description: "The role to resolve (e.g. 'analysis', 'auditor')." },
      },
      required: ["roleId"],
    },
    async handler(args = {}) {
      const roleId = args.roleId;
      if (!roleId || typeof roleId !== "string") {
        throw new Error("compose_role_v1: roleId (string) is required");
      }
      const role = await resolveRole(roleId);
      return role === null ? { roleId, resolved: false } : role;
    },
  },
  {
    name: "compose_skill_v1",
    schema_version: "1.0.0",
    description:
      "Load a skill definition by id (instructions, tools, traits) from the source/runtime registry. " +
      "Read-only; returns an empty definition if not found.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill to load (e.g. 'token-economics')." },
      },
      required: ["skillId"],
    },
    async handler(args = {}) {
      const skillId = args.skillId;
      if (!skillId || typeof skillId !== "string") {
        throw new Error("compose_skill_v1: skillId (string) is required");
      }
      return await loadSkill(skillId);
    },
  },
  {
    name: "compose_skill_framework_v1",
    schema_version: "1.0.0",
    description:
      "Resolve a graph-native skill framework by id. Read-only; returns a resolution record " +
      "with framework graph, capability skill ids, and permission-boundary refs.",
    inputSchema: {
      type: "object",
      properties: {
        frameworkId: { type: "string", description: "The skill framework id to resolve (e.g. 'gitops-review')." },
      },
      required: ["frameworkId"],
    },
    async handler(args = {}) {
      const frameworkId = args.frameworkId;
      if (!frameworkId || typeof frameworkId !== "string") {
        throw new Error("compose_skill_framework_v1: frameworkId (string) is required");
      }
      return resolveSkillFramework(frameworkId);
    },
  },

  {
    name: "compose_skill_framework_use_v1",
    schema_version: "1.0.0",
    description:
      "Resolve a skill framework as a reusable atomic skill-control bundle. Read-only; " +
      "works without a role or topology and applies action/tool-channel toggles as data.",
    inputSchema: {
      type: "object",
      properties: {
        frameworkId: { type: "string", description: "The skill framework id to resolve (e.g. 'gitops-review')." },
        skillRefs: { type: "array", items: { type: "string" }, description: "Optional atomic skill refs or node ids to select." },
        actionToggles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actionRef: { type: "string" },
              enabled: { type: "boolean" },
            },
          },
          description: "Per-action enable/disable controls.",
        },
        toolChannelToggles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              toolChannel: { type: "string" },
              enabled: { type: "boolean" },
            },
          },
          description: "Per-tool-channel enable/disable controls, such as github or mcp.",
        },
        roleId: { type: "string", description: "Optional role context for audit only; not required." },
        topology: { type: "string", description: "Optional topology context for audit only; not required." },
      },
      required: ["frameworkId"],
    },
    async handler(args = {}) {
      const frameworkId = args.frameworkId;
      if (!frameworkId || typeof frameworkId !== "string") {
        throw new Error("compose_skill_framework_use_v1: frameworkId (string) is required");
      }
      return resolveSkillFrameworkUse(args);
    },
  },

  {
    name: "compose_disposition_v1",
    schema_version: "1.0.0",
    description:
      "Compose a [Behavioral Disposition] block from a character preset id (the dimensional engine). " +
      "Returns the block, the directive→source audit trail, and an activation summary. Read-only, pure. " +
      "An unknown preset id returns an error listing the available presets.",
    inputSchema: {
      type: "object",
      properties: {
        presetId: { type: "string", description: "A character preset id from the preset catalog." },
      },
      required: ["presetId"],
    },
    async handler(args = {}) {
      const presetId = args.presetId;
      if (!presetId || typeof presetId !== "string") {
        throw new Error("compose_disposition_v1: presetId (string) is required");
      }
      return await composeBehavioralDisposition({
        modelId: "mcp-tool",
        seatId: "mcp-tool",
        seatDef: {},
        dispatchOpts: { seatDispositions: { "mcp-tool": { presetId } } },
      });
    },
  },
];

export default { COMPOSITION_TOOLS };
