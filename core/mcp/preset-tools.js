/**
 * illuci/core/mcp/preset-tools.js - graph preset authoring, resolution, and execution tools.
 *
 * A4.4 keeps graph preset execution inside the existing preset MCP family. Plan
 * tools are pure/auditable; run tools require file_write and the explicit
 * ILLUCI_PRESET_RUN_ENABLED gate before dispatch.
 */
import {
  createRuntimeGraphPreset,
  listGraphPresets,
  resolveGraphPresetById,
  validateGraphPresetById,
} from "../composition/graph-preset-store.js";
import { validateGraphPreset } from "../composition/graph-preset.js";
import { materializeTopologyFromGraphPreset } from "../composition/graph-preset-topology.js";
import { scaffoldRuntimeGraphPreset } from "../composition/graph-preset-scaffold.js";
import { planGraphPreset, runGraphPreset } from "../composition/graph-preset-runner.js";

function graphPresetFromCreateArgs(args = {}) {
  if (args.kind) return scaffoldRuntimeGraphPreset(args.id, args.kind, args.spec || {});
  return args.preset || {};
}

export const PRESET_TOOLS = [
  {
    name: "preset_list_v1",
    schema_version: "1.0.0",
    description: "List graph-spine presets from canon plus the additive runtime overlay.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", description: "Include hidden presentation records." },
      },
    },
    async handler(args = {}) {
      const presets = listGraphPresets({ includeHidden: Boolean(args.includeHidden) });
      return { count: presets.length, presets };
    },
  },
  {
    name: "preset_validate_v1",
    schema_version: "1.0.0",
    description: "Validate a graph-spine preset by id, or validate an inline preset object without writing it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing graph preset id to validate." },
        preset: { type: "object", description: "Inline graph preset object to validate without storing." },
      },
    },
    async handler(args = {}) {
      if (args.preset && typeof args.preset === "object") return validateGraphPreset(args.preset);
      return validateGraphPresetById(args.id);
    },
  },
  {
    name: "preset_resolve_v1",
    schema_version: "1.0.0",
    description: "Resolve a graph-spine preset into an auditable resolution record.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing graph preset id to resolve." },
      },
      required: ["id"],
    },
    async handler(args = {}) {
      return resolveGraphPresetById(args.id);
    },
  },
  {
    name: "preset_create_v1",
    schema_version: "1.0.0",
    description: "Create a runtime graph-spine preset in the additive .illuci overlay. Canonical ids cannot be shadowed.",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Runtime preset id when using kind/spec scaffold creation." },
        kind: { type: "string", enum: ["pipeline", "company"], description: "Optional compact scaffold kind." },
        spec: { type: "object", description: "Compact pipeline/company spec used with kind." },
        preset: { type: "object", description: "Raw graph preset object to store in the runtime overlay." },
      },
    },
    async handler(args = {}) {
      return createRuntimeGraphPreset(graphPresetFromCreateArgs(args));
    },
  },
  {
    name: "preset_plan_v1",
    schema_version: "1.0.0",
    description: "Compile a graph preset into an auditable runNode plan without dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing graph preset id to plan." },
        prompt: { type: "string", description: "Operator prompt to bind to the root node." },
        lineup: { type: "object", description: "Invocation-time model lineup overrides." },
        rootNodeId: { type: "string", description: "Optional executable root node id." },
        record: { type: "boolean", description: "Append a local .illuci plan record; defaults true." },
      },
      required: ["id"],
    },
    async handler(args = {}) {
      return planGraphPreset(args.id, {
        prompt: args.prompt || "",
        lineup: args.lineup || {},
        rootNodeId: args.rootNodeId || null,
        record: args.record !== false,
      });
    },
  },
  {
    name: "preset_run_v1",
    schema_version: "1.0.0",
    description: "Run a graph preset through runNode. Requires file_write permission and ILLUCI_PRESET_RUN_ENABLED=1.",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing graph preset id to run." },
        prompt: { type: "string", description: "Operator prompt to bind to the root node." },
        lineup: { type: "object", description: "Invocation-time model lineup overrides." },
        rootNodeId: { type: "string", description: "Optional executable root node id." },
        record: { type: "boolean", description: "Append a local .illuci run record; defaults true." },
      },
      required: ["id"],
    },
    async handler(args = {}) {
      return runGraphPreset(args.id, {
        prompt: args.prompt || "",
        lineup: args.lineup || {},
        rootNodeId: args.rootNodeId || null,
        record: args.record !== false,
      });
    },
  },
  {
    name: "preset_materialize_topology_v1",
    schema_version: "1.0.0",
    description: "Materialize a graph topology node into the existing runtime topology overlay store.",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        presetId: { type: "string", description: "Graph preset id containing a materializable topology node." },
        nodeId: { type: ["string", "null"], description: "Optional topology node id; defaults to the first materializable topology node." },
      },
      required: ["presetId"],
    },
    async handler(args = {}) {
      return materializeTopologyFromGraphPreset(args.presetId, args.nodeId || null);
    },
  },
];

export default { PRESET_TOOLS };
