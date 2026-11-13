/**
 * Shipped graph preset seeds.
 *
 * These are source-owned examples and bootstrap presets for the graph spine.
 * User-authored presets live in the runtime overlay and may not shadow these IDs.
 */

import { FOUNDRY_GRAPH_PRESET } from "./company-presets/foundry.js";

export const CANONICAL_GRAPH_PRESETS = Object.freeze({
  // [A106] the operator's first company preset, ratified for promotion —
  // authored in core/composition/company-presets/foundry.js.
  foundry: FOUNDRY_GRAPH_PRESET,
  "direct-harness": Object.freeze({
    id: "direct-harness",
    version: 1,
    status: "draft",
    presentation: {
      label: "Direct Harness",
      publicLabel: "Direct Harness",
      visibility: "default",
      status: "active",
    },
    nodes: [
      {
        id: "orchestrator",
        type: "orchestrator",
        label: "Meta Orchestrator",
        customization: {
          instructionRefs: [],
          roleRefs: [],
          dispositionRefs: [],
          skillFrameworkRefs: [],
          permissionBoundaryRefs: [],
        },
      },
      { id: "topology.direct", type: "topology", ref: "direct", label: "Direct Topology" },
    ],
    edges: [
      { from: "orchestrator", to: "topology.direct", type: "delegates-to" },
    ],
    provenance: {
      source: "canon",
      createdBy: "illuci",
      referenceBasis: "A4.3 bootstrap graph preset for first-class single-model harness use.",
    },
    governance: {
      auditable: true,
      dynamic: true,
      stability: "draft",
    },
  }),
  "topology-authoring": Object.freeze({
    id: "topology-authoring",
    version: 1,
    status: "draft",
    presentation: {
      label: "Topology Authoring",
      publicLabel: "Topology Authoring",
      visibility: "advanced",
      status: "active",
    },
    nodes: [
      {
        id: "orchestrator",
        type: "orchestrator",
        label: "Topology Composer",
        customization: {
          roleRefs: ["architect"],
          skillFrameworkRefs: ["system-design"],
          permissionBoundaryRefs: ["topology-authoring"],
        },
      },
      {
        id: "boundary.topology-authoring",
        type: "permission-boundary",
        ref: "topology-authoring",
        label: "Topology Authoring Boundary",
      },
    ],
    edges: [
      { from: "orchestrator", to: "boundary.topology-authoring", type: "constrains" },
    ],
    provenance: {
      source: "canon",
      createdBy: "illuci",
      referenceBasis: "A4.3 graph-spine topology creation and curation plan.",
    },
    governance: {
      auditable: true,
      dynamic: true,
      stability: "draft",
    },
  }),
});

export default { CANONICAL_GRAPH_PRESETS };
