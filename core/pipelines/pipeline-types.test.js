/**
 * illuci — Pipeline Types Verification Tests
 *
 * Validates the core pipeline data structures and factory functions.
 * Run with: npm test -- core/pipelines/pipeline-types.test.js
 */

import { describe, it, expect } from 'vitest';
import {
  PipelineType,
  PipelineStatus,
  ArtifactType,
  RelationshipType,
  EdgeSemantics,
  createPipelineRun,
  createPipelineStage,
  createStageArtifact,
  createProvenanceLink,
  isSwarm,
  isCDC,
  isCAC,
  isTerminal,
  isActive,
  PipelineCompositions,
} from './pipeline-types.js';

describe('Pipeline Types', () => {
  describe('Enums', () => {
    it('should have correct pipeline types', () => {
      expect(PipelineType.SWARM).toBe('swarm');
      expect(PipelineType.CDC).toBe('cdc');
      expect(PipelineType.CAC).toBe('cac');
    });

    it('should have correct pipeline statuses', () => {
      expect(PipelineStatus.PENDING).toBe('pending');
      expect(PipelineStatus.RUNNING).toBe('running');
      expect(PipelineStatus.COMPLETED).toBe('completed');
      expect(PipelineStatus.FAILED).toBe('failed');
    });

    it('should have correct artifact types', () => {
      expect(ArtifactType.CODE_IMPLEMENTATION).toBe('code_implementation');
      expect(ArtifactType.RESEARCH_FINDINGS).toBe('research_findings');
      expect(ArtifactType.VULNERABILITY_REPORT).toBe('vulnerability_report');
    });
  });

  describe('createPipelineRun', () => {
    it('should create a valid build pipeline', () => {
      const pipeline = createPipelineRun({
        type: PipelineType.CDC,
        prompt: 'Implement a user authentication system',
      });

      expect(pipeline.pipelineId).toMatch(/^pipe-\d+-[a-z0-9]+$/);
      expect(pipeline.type).toBe(PipelineType.CDC);
      expect(pipeline.status).toBe(PipelineStatus.PENDING);
      expect(pipeline.prompt).toBe('Implement a user authentication system');
      expect(pipeline.stages).toEqual([]);
      expect(pipeline.artifacts).toEqual([]);
      expect(pipeline.provenance.rootPrompt).toBe(pipeline.prompt);
      expect(pipeline.startedAt).toBeDefined();
      expect(pipeline.name).toContain('BUILD');
    });

    it('should create a valid Swarm pipeline with custom name', () => {
      const pipeline = createPipelineRun({
        type: PipelineType.SWARM,
        prompt: 'Research optimal database schemas',
        name: 'My Research Pipeline',
        sessionId: 'sess-123',
      });

      expect(pipeline.name).toBe('My Research Pipeline');
      expect(pipeline.sessionId).toBe('sess-123');
    });

    it('should include required metadata', () => {
      const pipeline = createPipelineRun({
        type: PipelineType.CAC,
        prompt: 'Security audit',
      });

      expect(pipeline.metadata.version).toBe('1.0');
      expect(pipeline.metadata.createdWith).toBe('illuci-pipeline-engine');
    });
  });

  describe('createPipelineStage', () => {
    it('should create a valid stage', () => {
      const stage = createPipelineStage({
        sequence: 0,
        topologyId: 'dev-team',
        label: 'Build Phase',
      });

      expect(stage.stageId).toBe('stage-0-dev-team');
      expect(stage.sequence).toBe(0);
      expect(stage.topologyId).toBe('dev-team');
      expect(stage.label).toBe('Build Phase');
      expect(stage.status).toBe(PipelineStatus.PENDING);
      expect(stage.artifactIds).toEqual([]);
    });

    it('should accept lineup and input', () => {
      const lineup = { architect: 'claude-local', implementer: 'codex-local' };
      const input = { type: 'prompt' };

      const stage = createPipelineStage({
        sequence: 1,
        topologyId: 'adversarial-debate',
        lineup,
        input,
      });

      expect(stage.lineup).toEqual(lineup);
      expect(stage.input).toEqual(input);
    });
  });

  describe('createStageArtifact', () => {
    it('should create a valid artifact', () => {
      const artifact = createStageArtifact({
        pipelineId: 'pipe-123',
        stageId: 'stage-0-dev-team',
        type: ArtifactType.CODE_IMPLEMENTATION,
        content: 'function auth() { return true; }',
        createdBy: 'implementer:codex-local',
      });

      expect(artifact.artifactId).toMatch(/^art-\d+-[a-z0-9]+$/);
      expect(artifact.pipelineId).toBe('pipe-123');
      expect(artifact.stageId).toBe('stage-0-dev-team');
      expect(artifact.type).toBe(ArtifactType.CODE_IMPLEMENTATION);
      expect(artifact.content).toBe('function auth() { return true; }');
      expect(artifact.createdBy).toBe('implementer:codex-local');
      expect(artifact.createdAt).toBeDefined();
    });

    it('should include optional metadata', () => {
      const artifact = createStageArtifact({
        pipelineId: 'pipe-123',
        stageId: 'stage-1',
        type: ArtifactType.RESEARCH_FINDINGS,
        content: 'Research results',
        createdBy: 'investigator:claude-local',
        metadata: { tokens: 1500, sources: 3 },
      });

      expect(artifact.metadata.tokens).toBe(1500);
      expect(artifact.metadata.sources).toBe(3);
    });
  });

  describe('createProvenanceLink', () => {
    it('should create a valid provenance link', () => {
      const link = createProvenanceLink({
        sequence: 0,
        fromStageId: 'stage-0',
        toStageId: 'stage-1',
        artifactIds: ['art-1', 'art-2'],
        transformType: 'synthesize',
      });

      expect(link.sequence).toBe(0);
      expect(link.fromStageId).toBe('stage-0');
      expect(link.toStageId).toBe('stage-1');
      expect(link.artifactIds).toEqual(['art-1', 'art-2']);
      expect(link.transformType).toBe('synthesize');
      expect(link.timestamp).toBeDefined();
    });

    it('should allow null fromStageId for root links', () => {
      const link = createProvenanceLink({
        sequence: 0,
        toStageId: 'stage-0',
      });

      expect(link.fromStageId).toBeNull();
      expect(link.transformType).toBe('direct-handoff');
    });
  });

  describe('Predicate functions', () => {
    it('should correctly identify pipeline types', () => {
      expect(isSwarm(PipelineType.SWARM)).toBe(true);
      expect(isSwarm(PipelineType.CDC)).toBe(false);

      expect(isCDC(PipelineType.CDC)).toBe(true);
      expect(isCDC(PipelineType.CAC)).toBe(false);

      expect(isCAC(PipelineType.CAC)).toBe(true);
      expect(isCAC(PipelineType.SWARM)).toBe(false);
    });

    it('should correctly identify terminal states', () => {
      expect(isTerminal(PipelineStatus.COMPLETED)).toBe(true);
      expect(isTerminal(PipelineStatus.FAILED)).toBe(true);
      expect(isTerminal(PipelineStatus.CANCELLED)).toBe(true);

      expect(isTerminal(PipelineStatus.RUNNING)).toBe(false);
      expect(isTerminal(PipelineStatus.PENDING)).toBe(false);
      expect(isTerminal(PipelineStatus.PAUSED)).toBe(false);
    });

    it('should correctly identify active states', () => {
      expect(isActive(PipelineStatus.RUNNING)).toBe(true);
      expect(isActive(PipelineStatus.PAUSED)).toBe(true);

      expect(isActive(PipelineStatus.PENDING)).toBe(false);
      expect(isActive(PipelineStatus.COMPLETED)).toBe(false);
      expect(isActive(PipelineStatus.FAILED)).toBe(false);
    });
  });

  describe('PipelineCompositions', () => {
    it('should have standard composition with correct stages', () => {
      const standard = PipelineCompositions.STANDARD;

      expect(standard.id).toBe('standard');
      expect(standard.stages).toHaveLength(3);
      expect(standard.stages[0].type).toBe(PipelineType.SWARM);
      expect(standard.stages[1].type).toBe(PipelineType.CDC);
      expect(standard.stages[2].type).toBe(PipelineType.CAC);
    });

    it('should have governed dev composition with mob sit-down', () => {
      const governed = PipelineCompositions.GOVERNED_DEV;

      expect(governed.stages).toHaveLength(3);
      expect(governed.stages[2].topologyId).toBe('mob-sit-down');
    });

    it('should have all required compositions', () => {
      expect(PipelineCompositions.STANDARD).toBeDefined();
      expect(PipelineCompositions.SECURITY_RESEARCH).toBeDefined();
      expect(PipelineCompositions.GOVERNED_DEV).toBeDefined();
      expect(PipelineCompositions.FULL_CYCLE).toBeDefined();
    });
  });

  describe('End-to-end pipeline construction', () => {
    it('should construct a complete build pipeline with stages and artifacts', () => {
      // Create pipeline
      const pipeline = createPipelineRun({
        type: PipelineType.CDC,
        prompt: 'Build an API endpoint',
        sessionId: 'sess-test-123',
      });

      // Add stages
      const designStage = createPipelineStage({
        sequence: 0,
        topologyId: 'dev-team',
        label: 'Design',
        lineup: { architect: 'claude-local' },
      });

      const buildStage = createPipelineStage({
        sequence: 1,
        topologyId: 'dev-team',
        label: 'Build',
        lineup: { implementer: 'codex-local' },
        input: { type: 'previous', previousStageId: designStage.stageId },
      });

      pipeline.stages.push(designStage, buildStage);

      // Add provenance link
      const link = createProvenanceLink({
        sequence: 0,
        fromStageId: designStage.stageId,
        toStageId: buildStage.stageId,
        transformType: 'design-to-code',
      });
      pipeline.provenance.links.push(link);

      // Add artifact
      const artifact = createStageArtifact({
        pipelineId: pipeline.pipelineId,
        stageId: buildStage.stageId,
        type: ArtifactType.CODE_IMPLEMENTATION,
        content: 'export function handler() {}',
        createdBy: 'implementer:codex-local',
      });
      pipeline.artifacts.push(artifact);
      buildStage.artifactIds.push(artifact.artifactId);

      // Validate structure
      expect(pipeline.stages).toHaveLength(2);
      expect(pipeline.provenance.links).toHaveLength(1);
      expect(pipeline.artifacts).toHaveLength(1);
      expect(buildStage.artifactIds).toContain(artifact.artifactId);
    });
  });
});
