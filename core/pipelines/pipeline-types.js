/**
 * illuci — Pipeline Types
 *
 * Core data structures for pipeline execution, stage artifacts, and provenance tracking.
 * Aligned with design/pipeline-types-2026-04-05.md
 *
 * Pipelines are sequences of topology executions where output flows between them.
 * Topologies are structures. Pipelines are patterns for how structures chain.
 *
 * Pipeline phases:
 *   - Explore:  decompose, investigate, and surface options
 *   - Build:    implement, specify, and integrate
 *   - Validate: challenge, defend, and verify
 */

/**
 * Pipeline phase enumeration.
 *
 * @readonly
 * @enum {string}
 */
export const PipelinePhase = {
  EXPLORE: 'explore',
  BUILD: 'build',
  VALIDATE: 'validate',
  ACCOUNT: 'account',
};

/**
 * Stable wire identifiers retained for existing pipeline traces.
 * @readonly
 * @enum {string}
 */
export const PipelineType = {
  SWARM: 'swarm',
  CDC: 'cdc',
  CAC: 'cac'
};

const PIPELINE_TYPE_DISPLAY = {
  [PipelineType.SWARM]: 'EXPLORE',
  [PipelineType.CDC]: 'BUILD',
  [PipelineType.CAC]: 'VALIDATE',
};

/**
 * Functional seat roles per phase — independent of topology.
 *
 * Each phase has its own vocabulary for what seats DO. The topology
 * defines what seats ARE CALLED. A mapping layer translates between them.
 *
 * "challenger" is what the seat does in the VALIDATE phase.
 * "prosecutor" is what judiciary calls it. "red" is what adversarial-debate calls it.
 * The pipeline doesn't care — it works with functional roles.
 *
 * @readonly
 */
export const PhaseSeatRole = {
  // EXPLORE — breadth-first investigation
  SYNTHESIZER: 'synthesizer',   // integrates findings (integrator, elder, leader)
  INVESTIGATOR: 'investigator', // researches independently (investigator, commune-member, devotee)
  SKEPTIC: 'skeptic',           // challenges groupthink (outsider, dissenter)

  // BUILD — depth-first implementation
  ARCHITECT: 'architect',       // designs approach (architect)
  BUILDER: 'builder',           // implements (implementer, devotee)
  REVIEWER: 'reviewer',         // reviews output (reviewer)
  VALIDATOR: 'validator',       // quality assurance (qa, validator)

  // VALIDATE — adversarial quality challenge
  CHALLENGER: 'challenger',     // attacks the work (prosecutor, red, attacker)
  DEFENDER: 'defender',         // defends the work (defender, blue, subject)
  ARBITER: 'arbiter',           // renders judgment (judge, arbiter, emperor)

  // ACCOUNT — accountability review
  AUTHORITY: 'authority',       // holds authority to mandate (emperor, boss, nasi, kgosi)
  AUDITOR: 'auditor',           // audits compliance (censor, consigliere, judge)
  RECORDER: 'recorder',         // records findings (clerk, censor, witness)
};

/**
 * Mapping: functional seat role → topology-specific seat ID.
 *
 * Keyed by topologyId, then by PhaseSeatRole, yields the actual seat ID
 * in that topology. This is the translation layer that lets the pipeline
 * work with functional vocabulary while topologies keep their own names.
 */
export const SeatRoleMapping = {
  // EXPLORE topologies
  'research-swarm': {
    [PhaseSeatRole.SYNTHESIZER]: 'integrator',
    [PhaseSeatRole.INVESTIGATOR]: 'investigator',
    [PhaseSeatRole.SKEPTIC]: 'investigator',
  },
  'commune': {
    [PhaseSeatRole.SYNTHESIZER]: 'elder',
    [PhaseSeatRole.INVESTIGATOR]: 'commune-member',
    [PhaseSeatRole.SKEPTIC]: 'outsider',
  },
  'cult': {
    [PhaseSeatRole.SYNTHESIZER]: 'leader',
    [PhaseSeatRole.INVESTIGATOR]: 'devotee',
    [PhaseSeatRole.SKEPTIC]: 'dissenter',
  },
  'delphi-panel': {
    [PhaseSeatRole.SYNTHESIZER]: 'facilitator',
    [PhaseSeatRole.INVESTIGATOR]: 'panelist',
    [PhaseSeatRole.SKEPTIC]: 'panelist',
  },

  // BUILD topologies
  'dev-team': {
    [PhaseSeatRole.ARCHITECT]: 'architect',
    [PhaseSeatRole.BUILDER]: 'implementer',
    [PhaseSeatRole.REVIEWER]: 'reviewer',
    [PhaseSeatRole.VALIDATOR]: 'qa',
  },
  'apprentice-master': {
    [PhaseSeatRole.ARCHITECT]: 'master',
    [PhaseSeatRole.BUILDER]: 'apprentice',
    [PhaseSeatRole.REVIEWER]: 'master',
    [PhaseSeatRole.VALIDATOR]: 'master',
  },
  'corporate-hierarchy': {
    [PhaseSeatRole.ARCHITECT]: 'executive',
    [PhaseSeatRole.BUILDER]: 'report',
    [PhaseSeatRole.REVIEWER]: 'executive',
    [PhaseSeatRole.VALIDATOR]: 'executive',
  },

  // VALIDATE topologies
  'judiciary': {
    [PhaseSeatRole.CHALLENGER]: 'prosecutor',
    [PhaseSeatRole.DEFENDER]: 'defender',
    [PhaseSeatRole.ARBITER]: 'judge',
    [PhaseSeatRole.RECORDER]: 'witness',
  },
  'adversarial-debate': {
    [PhaseSeatRole.CHALLENGER]: 'red',
    [PhaseSeatRole.DEFENDER]: 'blue',
    [PhaseSeatRole.ARBITER]: 'arbiter',
  },
  'turing-test': {
    [PhaseSeatRole.CHALLENGER]: 'interrogator',
    [PhaseSeatRole.DEFENDER]: 'subject',
    [PhaseSeatRole.ARBITER]: 'controller',
  },
  'colosseum': {
    [PhaseSeatRole.CHALLENGER]: 'gladiator',
    [PhaseSeatRole.DEFENDER]: 'gladiator',
    [PhaseSeatRole.ARBITER]: 'emperor',
  },

  // ACCOUNT topologies
  'censorate': {
    [PhaseSeatRole.AUTHORITY]: 'emperor',
    [PhaseSeatRole.AUDITOR]: 'censor',
    [PhaseSeatRole.RECORDER]: 'censor',
  },
  'mob-sit-down': {
    [PhaseSeatRole.AUTHORITY]: 'boss',
    [PhaseSeatRole.AUDITOR]: 'consigliere',
    [PhaseSeatRole.RECORDER]: 'consigliere',
  },
  'sanhedrin': {
    [PhaseSeatRole.AUTHORITY]: 'nasi',
    [PhaseSeatRole.AUDITOR]: 'judge',
    [PhaseSeatRole.RECORDER]: 'nasi',
  },
  'legislature': {
    [PhaseSeatRole.AUTHORITY]: 'sponsor',
    [PhaseSeatRole.AUDITOR]: 'member',
    [PhaseSeatRole.RECORDER]: 'clerk',
  },
  'kgotla': {
    [PhaseSeatRole.AUTHORITY]: 'kgosi',
    [PhaseSeatRole.AUDITOR]: 'motho',
    [PhaseSeatRole.RECORDER]: 'kgosi',
  },
};

/**
 * Validates that all stages reference a topology with a mapped seat role.
 * @param {Array} stages - Pipeline stages to validate
 */
export function validateSeatMappings(stages) {
  if (!stages || !Array.isArray(stages)) return;
  for (const stage of stages) {
    if (stage.topologyId && !SeatRoleMapping[stage.topologyId]) {
      console.warn(`[pipeline-types] Warning: topologyId '${stage.topologyId}' has no mapping in SeatRoleMapping.`);
    }
  }
}

/**
 * Resolve a functional seat role to a topology-specific seat ID.
 *
 * @param {string} topologyId
 * @param {string} functionalRole - PhaseSeatRole value
 * @returns {string} Topology-specific seat ID, or the functional role as fallback
 */
export function resolveSeatId(topologyId, functionalRole) {
  return SeatRoleMapping[topologyId]?.[functionalRole] ?? functionalRole;
}

/**
 * Pipeline run status enumeration
 * @readonly
 * @enum {string}
 */
export const PipelineStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Artifact type enumeration
 * @readonly
 * @enum {string}
 */
export const ArtifactType = {
  // Swarm outputs
  RESEARCH_FINDINGS: 'research_findings',
  OPTIONS_LIST: 'options_list',
  SUB_PROBLEM_DECOMPOSITION: 'sub_problem_decomposition',
  SYNTHESIZED_RESEARCH: 'synthesized_research',

  // Build outputs
  CODE_IMPLEMENTATION: 'code_implementation',
  SPECIFICATION: 'specification',
  INFRASTRUCTURE_CONFIG: 'infrastructure_config',
  DESIGN_DECISION: 'design_decision',

  // Validate outputs
  VULNERABILITY_REPORT: 'vulnerability_report',
  QUALITY_ASSESSMENT: 'quality_assessment',
  RULING: 'ruling',
  SECURITY_FINDINGS: 'security_findings',

  // Verification
  MANDATE_VERIFICATION: 'mandate_verification',

  // Generic
  RAW_OUTPUT: 'raw_output',
  CONTEXT_SNAPSHOT: 'context_snapshot',
  GATE_DECISION: 'gate_decision',
};

/**
 * Relationship type for topology seat relationships
 * @readonly
 * @enum {string}
 */
export const RelationshipType = {
  PARENT_OF: 'parent-of',
  ADVERSARIAL_TO: 'adversarial-to',
  PRECEDES: 'precedes',
  INTEGRATES_FROM: 'integrates-from',
  REPORTS_TO: 'reports-to',
  PEER_OF: 'peer-of',
};

/**
 * Edge semantics for relationship behavior
 * @readonly
 * @enum {string}
 */
export const EdgeSemantics = {
  DIRECTS: 'directs',
  RED_TEAMS: 'red-teams',
  PIPELINE_FLOW: 'pipeline-flow',
  DEBATE_PAIR: 'debate-pair',
  HIERARCHY: 'hierarchy',
  ADVERSARIAL: 'adversarial',
};

/**
 * @typedef {Object} PipelineRun
 * @property {string} pipelineId - Unique pipeline identifier
 * @property {string} sessionId - Parent session identifier
 * @property {string} name - Human-readable pipeline name
 * @property {PipelineType} type - Stable pipeline wire identifier
 * @property {PipelineStatus} status - Current execution status
 * @property {string} prompt - Original task/prompt
 * @property {PipelineStage[]} stages - Ordered pipeline stages
 * @property {StageArtifact[]} artifacts - All artifacts produced
 * @property {ProvenanceChain} provenance - Execution provenance chain
 * @property {string} startedAt - ISO timestamp
 * @property {string} [completedAt] - ISO timestamp when completed
 * @property {PipelineError} [error] - Error details if failed
 * @property {Object} metadata - Additional pipeline metadata
 */

/**
 * @typedef {Object} PipelineStage
 * @property {string} stageId - Unique stage identifier within pipeline
 * @property {number} sequence - Execution order (0-indexed)
 * @property {string} topologyId - Topology to execute
 * @property {string} [label] - Human-readable stage label
 * @property {Object} lineup - Seat to model mapping
 * @property {StageInput} input - Input specification
 * @property {StageOutput} output - Output captured from execution
 * @property {PipelineStatus} status - Stage execution status
 * @property {string} startedAt - ISO timestamp
 * @property {string} [completedAt] - ISO timestamp when completed
 * @property {string[]} artifactIds - References to produced artifacts
 * @property {number} [latencyMs] - Execution latency in milliseconds
 * @property {number} [tokenUsage] - Tokens consumed in this stage
 * @property {CalibrationResult} [calibration] - Confidence metrics
 */

/**
 * @typedef {Object} StageInput
 * @property {string} type - Input type: 'prompt' | 'previous' | 'artifact' | 'composite'
 * @property {string[]} [artifactIds] - Artifact IDs to include
 * @property {string} [previousStageId] - Reference to previous stage output
 * @property {string} [transform] - Optional transform applied to input
 */

/**
 * @typedef {Object} StageOutput
 * @property {string} rawOutput - Raw text output from topology
 * @property {string[]} [artifactIds] - Extracted artifact references
 * @property {Object} [trace] - Full topology execution trace
 * @property {number} tokenUsage - Total tokens consumed
 */

/**
 * @typedef {Object} StageArtifact
 * @property {string} artifactId - Unique artifact identifier
 * @property {string} pipelineId - Parent pipeline reference
 * @property {string} stageId - Originating stage reference
 * @property {ArtifactType} type - Artifact classification
 * @property {string} content - Artifact content (text or JSON stringified)
 * @property {Object} [metadata] - Artifact-specific metadata
 * @property {string} createdAt - ISO timestamp
 * @property {string} createdBy - Model/seat that created it
 * @property {string} [checksum] - Content integrity hash
 */

/**
 * @typedef {Object} ProvenanceChain
 * @property {string} rootPrompt - Original task that initiated the pipeline
 * @property {string} initiator - Human or model that started the pipeline
 * @property {ProvenanceLink[]} links - Ordered chain of execution steps
 * @property {Object} contextSnapshots - Key context states at decision points
 * @property {string} pipelineType - Type of pipeline executed
 */

/**
 * @typedef {Object} ProvenanceLink
 * @property {number} sequence - Order in chain
 * @property {string} fromStageId - Source stage (null for root)
 * @property {string} toStageId - Destination stage
 * @property {string[]} artifactIds - Artifacts passed between stages
 * @property {string} timestamp - ISO timestamp
 * @property {string} transformType - How input was transformed
 */

/**
 * @typedef {Object} CalibrationResult
 * @property {number|null} systemConfidence - Aggregated confidence (0-1)
 * @property {number|null} agreementRatio - Response agreement (0-1)
 * @property {string[]} [flags] - Warning flags
 */

/**
 * @typedef {Object} PipelineError
 * @property {string} message - Error description
 * @property {string} [stageId] - Stage where error occurred
 * @property {string} [code] - Error classification code
 * @property {Object} [context] - Additional error context
 */

/**
 * @typedef {Object} PipelineComposition
 * @property {string} compositionId - Unique composition identifier
 * @property {string} name - Human-readable name
 * @property {PipelineStageTemplate[]} stages - Stage templates
 * @property {string[]} [tags] - Classification tags
 * @property {Object} [metadata] - Composition metadata
 */

/**
 * @typedef {Object} PipelineStageTemplate
 * @property {string} topologyId - Topology to use
 * @property {string} [label] - Stage label
 * @property {string} inputSpec - Input specification pattern
 * @property {Object} [defaultLineup] - Default seat assignments
 * @property {boolean} [gate] - Whether this stage has a gate
 */

/**
 * @typedef {Object} SeatRelationship
 * @property {RelationshipType} type - Relationship classification
 * @property {string} target - Target seat ID
 * @property {EdgeSemantics} semantics - Behavioral semantics
 * @property {number} [weight] - Relationship strength (0-1)
 * @property {Object} [metadata] - Additional relationship data
 */

/**
 * @typedef {Object} TopologySeatWithRelations
 * @property {string} id - Seat identifier
 * @property {string} label - Human-readable label
 * @property {number} min - Minimum occupants
 * @property {number} max - Maximum occupants
 * @property {string} [roleHint] - Auto-fill role hint
 * @property {SeatRelationship[]} [relationships] - Seat relationships
 * @property {number} [weight] - Seat priority weight (0-1)
 * @property {Object} [dispositionBlend] - Weighted disposition vector
 */

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new pipeline run
 * @param {Object} params
 * @param {PipelineType} params.type - Pipeline type
 * @param {string} params.prompt - Original prompt
 * @param {string} [params.name] - Pipeline name
 * @param {string} [params.sessionId] - Parent session
 * @returns {PipelineRun}
 */
export function createPipelineRun({ type, prompt, name, sessionId }) {
  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  return {
    pipelineId,
    sessionId: sessionId || null,
    name: name || `${PIPELINE_TYPE_DISPLAY[type] || type.toUpperCase()}-${pipelineId.slice(-6)}`,
    type,
    status: PipelineStatus.PENDING,
    prompt,
    stages: [],
    artifacts: [],
    provenance: {
      rootPrompt: prompt,
      initiator: 'operator', // Default, can be updated
      links: [],
      contextSnapshots: {},
      pipelineType: type,
    },
    startedAt: now,
    metadata: {
      version: '1.0',
      createdWith: 'illuci-pipeline-engine',
    },
  };
}

/**
 * Create a pipeline stage
 * @param {Object} params
 * @param {number} params.sequence - Stage order
 * @param {string} params.topologyId - Topology to execute
 * @param {string} [params.label] - Stage label
 * @param {Object} [params.lineup] - Seat assignments
 * @param {StageInput} [params.input] - Input specification
 * @returns {PipelineStage}
 */
export function createPipelineStage({ sequence, topologyId, label, lineup, input }) {
  const stageId = `stage-${sequence}-${topologyId}`;

  return {
    stageId,
    sequence,
    topologyId,
    label: label || `${topologyId}-${sequence}`,
    lineup: lineup || {},
    input: input || { type: 'prompt' },
    output: null,
    status: PipelineStatus.PENDING,
    startedAt: null,
    completedAt: null,
    artifactIds: [],
  };
}

/**
 * Create a stage artifact
 * @param {Object} params
 * @param {string} params.pipelineId - Parent pipeline
 * @param {string} params.stageId - Originating stage
 * @param {ArtifactType} params.type - Artifact type
 * @param {string} params.content - Artifact content
 * @param {string} params.createdBy - Creator identifier
 * @param {Object} [params.metadata] - Additional metadata
 * @returns {StageArtifact}
 */
export function createStageArtifact({ pipelineId, stageId, type, content, createdBy, metadata }) {
  const artifactId = `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    artifactId,
    pipelineId,
    stageId,
    type,
    content,
    metadata: metadata || {},
    createdAt: new Date().toISOString(),
    createdBy,
    checksum: null, // Computed by store
  };
}

/**
 * Create a provenance link between stages
 * @param {Object} params
 * @param {number} params.sequence - Link order
 * @param {string} [params.fromStageId] - Source stage
 * @param {string} params.toStageId - Destination stage
 * @param {string[]} [params.artifactIds] - Passed artifacts
 * @param {string} [params.transformType] - Transformation type
 * @returns {ProvenanceLink}
 */
export function createProvenanceLink({ sequence, fromStageId, toStageId, artifactIds, transformType }) {
  return {
    sequence,
    fromStageId: fromStageId || null,
    toStageId,
    artifactIds: artifactIds || [],
    timestamp: new Date().toISOString(),
    transformType: transformType || 'direct-handoff',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PREDICATE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Phase predicates
 */
export function isSwarm(type) { return type === PipelineType.SWARM; }
export function isCDC(type) { return type === PipelineType.CDC; }
export function isCAC(type) { return type === PipelineType.CAC; }

export function isExplore(phase) { return phase === PipelinePhase.EXPLORE; }
export function isBuild(phase) { return phase === PipelinePhase.BUILD; }
export function isValidate(phase) { return phase === PipelinePhase.VALIDATE; }
export function isAccount(phase) { return phase === PipelinePhase.ACCOUNT; }

/**
 * Check if pipeline is in terminal state
 * @param {PipelineStatus} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return status === PipelineStatus.COMPLETED
    || status === PipelineStatus.FAILED
    || status === PipelineStatus.CANCELLED;
}

/**
 * Check if pipeline is active
 * @param {PipelineStatus} status
 * @returns {boolean}
 */
export function isActive(status) {
  return status === PipelineStatus.RUNNING || status === PipelineStatus.PAUSED;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSITION PRESETS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Standard pipeline compositions as defined in design spec.
 * Line 38: Explore -> Build -> Validate -> repeat.
 */
export const PipelineCompositions = {
  /** Standard development cycle: research → build → validate */
  STANDARD: {
    id: 'standard',
    name: 'Standard Development Cycle',
    description: 'Explore -> Build -> Validate: research, build, then validate',
    stages: [
      { type: PipelineType.SWARM, phase: PipelinePhase.EXPLORE, topologyId: 'research-swarm', label: 'Research' },
      { type: PipelineType.CDC, phase: PipelinePhase.BUILD, topologyId: 'dev-team', label: 'Build' },
      { type: PipelineType.CAC, phase: PipelinePhase.VALIDATE, topologyId: 'adversarial-debate', label: 'Validate' },
    ],
  },

  /** Security-focused: research with validation */
  SECURITY_RESEARCH: {
    id: 'security-research',
    name: 'Security Research',
    description: 'Explore -> Validate: research with adversarial validation',
    stages: [
      { type: PipelineType.SWARM, phase: PipelinePhase.EXPLORE, topologyId: 'research-swarm', label: 'Research' },
      { type: PipelineType.CAC, phase: PipelinePhase.VALIDATE, topologyId: 'adversarial-debate', label: 'Security Review' },
    ],
  },

  /** Governed development: build → validate → accountability */
  GOVERNED_DEV: {
    id: 'governed-dev',
    name: 'Governed Development',
    description: 'Build → Validate → Account: Build with validation and accountability',
    stages: [
      { type: PipelineType.CDC, phase: PipelinePhase.BUILD, topologyId: 'dev-team', label: 'Build' },
      { type: PipelineType.CAC, phase: PipelinePhase.VALIDATE, topologyId: 'judiciary', label: 'Quality Gate' },
      { type: PipelineType.CAC, phase: PipelinePhase.ACCOUNT, topologyId: 'mob-sit-down', label: 'Accountability' },
    ],
  },

  /** Full cycle with organizational reshaping */
  FULL_CYCLE: {
    id: 'full-cycle',
    name: 'Full Cycle',
    description: 'Complete cycle with org reshaping',
    stages: [
      { type: PipelineType.SWARM, phase: PipelinePhase.EXPLORE, topologyId: 'research-swarm', label: 'Research' },
      { type: PipelineType.CDC, phase: PipelinePhase.BUILD, topologyId: 'dev-team', label: 'Build' },
      { type: PipelineType.CAC, phase: PipelinePhase.VALIDATE, topologyId: 'judiciary', label: 'Validate' },
      { type: PipelineType.CAC, phase: PipelinePhase.ACCOUNT, topologyId: 'mob-sit-down', label: 'Accountability' },
      { type: PipelineType.CDC, phase: PipelinePhase.BUILD, topologyId: 'dev-team', label: 'Refine' },
    ],
  },

  /** Governed full cycle: Explore -> Build -> Validate -> Account with disposition, role provenance, and subagent protocols */
  GOVERNED_FULL_CYCLE: {
    id: 'governed-full-cycle',
    name: 'Governed Full Cycle',
    description: 'Explore -> Build -> Validate -> Account: disposition assignment, role provenance, and subagent protocols. Topologies are defaults, swappable per-phase.',
    stages: [
      { type: PipelineType.SWARM, phase: PipelinePhase.EXPLORE, topologyId: 'research-swarm', label: 'Explore — Problem Space Investigation' },
      { type: PipelineType.CDC, phase: PipelinePhase.BUILD, topologyId: 'dev-team', label: 'Build — Depth-First Implementation' },
      { type: PipelineType.CAC, phase: PipelinePhase.VALIDATE, topologyId: 'judiciary', label: 'Validate — Adversarial Quality Challenge' },
      { type: PipelineType.CAC, phase: PipelinePhase.ACCOUNT, topologyId: 'censorate', label: 'Account — Accountability Review' },
    ],
  },

  /** Product brainstorm + dev planning: commune ideation → delphi convergence → dev-team planning → legislature ratification */
  BRAINSTORM_PLAN: {
    id: 'brainstorm-plan',
    name: 'Brainstorm & Development Planning',
    description: 'Commune → Delphi → Dev-Team → Legislature: Open ideation, expert convergence, structured dev planning, ratified roadmap.',
    stages: [
      { type: PipelineType.SWARM, phase: PipelinePhase.EXPLORE, topologyId: 'commune', label: 'Brainstorm — Open Ideation Commune' },
      { type: PipelineType.SWARM, phase: PipelinePhase.EXPLORE, topologyId: 'delphi-panel', label: 'Converge — Expert Panel Distillation' },
      { type: PipelineType.CDC, phase: PipelinePhase.BUILD, topologyId: 'dev-team', label: 'Plan — Architecture & Roadmap' },
      { type: PipelineType.CAC, phase: PipelinePhase.ACCOUNT, topologyId: 'legislature', label: 'Ratify — Roadmap Approval & Mandate' },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  // Enums
  PipelinePhase,
  PipelineStatus,
  ArtifactType,
  RelationshipType,
  EdgeSemantics,
  PhaseSeatRole,

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
  resolveSeatId,

  // Presets
  PipelineCompositions,
};
