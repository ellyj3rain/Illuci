/**
 * Illuci - pipeline composition registry and node compiler.
 *
 * Pipeline is a process shape: an ordered stage sequence that composes topology
 * leaves and, where needed, composite company/pipeline nodes. This module is the
 * source of truth for resolving named pipeline presets and compiling stages into
 * the unified runNode ontology. Instrumentation layers may add artifacts,
 * provenance, or verification policy, but they should not invent their own
 * pipeline composition semantics.
 */

import { PipelinePhase, PipelineCompositions } from "./pipeline-types.js";
import { TOTAL_AXES_COMPOSITION } from "./total-axes-pipeline.js";

export function resolvePipelineComposition(compositionId) {
  if (!compositionId) return null;

  const normalizedId = String(compositionId).toLowerCase();
  const upperId = String(compositionId).toUpperCase().replace(/-/g, "_");

  if (PipelineCompositions[upperId]) {
    return PipelineCompositions[upperId];
  }

  if (TOTAL_AXES_COMPOSITION.id === normalizedId) {
    return TOTAL_AXES_COMPOSITION;
  }

  return null;
}

export function listPipelineCompositions() {
  return [
    ...Object.values(PipelineCompositions),
    TOTAL_AXES_COMPOSITION,
  ];
}

export function buildPipelinePlan({ type, lineup = {}, options = {} } = {}) {
  const composition = typeof type === "string" ? resolvePipelineComposition(type) : null;
  const pipelineType = composition
    ? null
    : Object.values(PipelinePhase).includes(type)
      ? type
      : PipelinePhase.BUILD;

  const stages = composition
    ? composition.stages.map((stage, index) => ({ ...stage, sequence: index }))
    : [{
        phase: pipelineType,
        topologyId: options.topologyId || "dev-team",
        sequence: 0,
        label: "Execute",
        lineup,
      }];

  return {
    composition,
    pipelineType,
    stages,
  };
}

export function compilePipelineStageNode(stageDef, { lineup = {}, prompt = "", options = {} } = {}) {
  if (stageDef?.kind === "company" || stageDef?.kind === "pipeline") {
    return {
      ...stageDef,
      id: stageDef.id || stageDef.label || stageDef.kind,
      prompt,
      lineup: stageDef.lineup || lineup,
      options: { ...(stageDef.options || {}), ...options },
    };
  }

  if (stageDef?.kind === "topology") {
    return {
      ...stageDef,
      id: stageDef.id || stageDef.label || stageDef.topologyId,
      prompt,
      lineup: stageDef.lineup || lineup,
      options: { ...(stageDef.options || {}), ...options },
    };
  }

  return {
    kind: "topology",
    id: stageDef?.id || stageDef?.label || stageDef?.topologyId,
    topologyId: stageDef?.topologyId,
    prompt,
    lineup: stageDef?.lineup || lineup,
    options: { ...(stageDef?.options || {}), ...options },
    phase: stageDef?.phase || null,
    label: stageDef?.label || null,
    runWhen: stageDef?.runWhen || null,
  };
}

export function compilePipelineNode({ type, prompt = "", lineup = {}, options = {} } = {}) {
  const plan = buildPipelinePlan({ type, lineup, options });
  return {
    kind: "pipeline",
    id: plan.composition?.id || plan.pipelineType || "build",
    prompt,
    stages: plan.stages.map((stage) => compilePipelineStageNode(stage, {
      lineup: stage.lineup || lineup,
      options: { ...options, ...(stage.options || {}) },
    })),
    meta: {
      compositionId: plan.composition?.id || null,
      pipelineType: plan.pipelineType,
    },
  };
}
