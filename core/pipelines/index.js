/**
 * illuci — Pipeline Module
 *
 * Pipeline execution for multi-topology sequences with artifact tracking
 * and provenance. Composes topologies into higher-order workflows.
 *
 * Entry point for the CLI-to-IDE pipeline implementation.
 */

export {
  // Types and enums
  PipelineType,
  PipelineStatus,
  ArtifactType,
  RelationshipType,
  EdgeSemantics,

  // Factory functions
  createPipelineRun,
  createPipelineStage,
  createStageArtifact,
  createProvenanceLink,

  // Predicates
  isSwarm,
  isCDC,
  isCAC,
  isExplore,
  isBuild,
  isValidate,
  isAccount,
  isTerminal,
  isActive,

  // Presets
  PipelineCompositions,
} from './pipeline-types.js';

export {
  runPipeline,
  resumePipeline,
  getComposition,
  listCompositions,
} from './pipeline-runner.js';

export {
  buildPipelinePlan,
  compilePipelineNode,
  compilePipelineStageNode,
  listPipelineCompositions,
  resolvePipelineComposition,
} from './compositions.js';

// Default export for convenience
export { default } from './pipeline-types.js';
