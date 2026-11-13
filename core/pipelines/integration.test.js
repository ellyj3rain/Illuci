/**
 * illuci — Pipeline Integration Verification
 *
 * Validates pipeline integration with session store and event system.
 * This is a smoke test to ensure the pipeline module loads and integrates
 * correctly with the broader illuci system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { rmSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, '../../data/test-sessions.db');

// Set test database before importing modules
process.env.ILLUCI_SESSION_DB = TEST_DB_PATH;

// Import after setting env
import * as pipelineModule from './index.js';
import * as sessionStore from '../sessions/store.js';

describe('Pipeline Integration', () => {
  beforeEach(() => {
    // Clean up test database
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH);
    }
  });

  afterEach(() => {
    sessionStore.close();
    // Clean up
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH);
    }
  });

  describe('Module exports', () => {
    it('should export all pipeline types', () => {
      expect(pipelineModule.PipelineType).toBeDefined();
      expect(pipelineModule.PipelineType.SWARM).toBe('swarm');
      expect(pipelineModule.PipelineType.CDC).toBe('cdc');
      expect(pipelineModule.PipelineType.CAC).toBe('cac');
    });

    it('should export all pipeline statuses', () => {
      expect(pipelineModule.PipelineStatus).toBeDefined();
      expect(pipelineModule.PipelineStatus.PENDING).toBe('pending');
      expect(pipelineModule.PipelineStatus.RUNNING).toBe('running');
    });

    it('should export factory functions', () => {
      expect(pipelineModule.createPipelineRun).toBeInstanceOf(Function);
      expect(pipelineModule.createPipelineStage).toBeInstanceOf(Function);
      expect(pipelineModule.createStageArtifact).toBeInstanceOf(Function);
      expect(pipelineModule.createProvenanceLink).toBeInstanceOf(Function);
    });

    it('should export predicate functions', () => {
      expect(pipelineModule.isSwarm).toBeInstanceOf(Function);
      expect(pipelineModule.isCDC).toBeInstanceOf(Function);
      expect(pipelineModule.isCAC).toBeInstanceOf(Function);
      expect(pipelineModule.isTerminal).toBeInstanceOf(Function);
      expect(pipelineModule.isActive).toBeInstanceOf(Function);
    });

    it('should export pipeline compositions', () => {
      expect(pipelineModule.PipelineCompositions).toBeDefined();
      expect(pipelineModule.PipelineCompositions.STANDARD).toBeDefined();
      expect(pipelineModule.PipelineCompositions.GOVERNED_DEV).toBeDefined();
    });
  });

  describe('Pipeline creation with session', () => {
    it('should create a pipeline and persist to session', () => {
      // Create a session
      const session = sessionStore.createSession({
        name: 'Test Pipeline Session',
        topologyId: 'dev-team',
      });

      expect(session.id).toBeDefined();

      // Create a pipeline linked to session
      const pipeline = pipelineModule.createPipelineRun({
        type: pipelineModule.PipelineType.CDC,
        prompt: 'Build a feature',
        sessionId: session.id,
      });

      expect(pipeline.sessionId).toBe(session.id);

      // Add an event to the session
      sessionStore.addEvent(session.id, 'pipeline_created', {
        pipelineId: pipeline.pipelineId,
        type: pipeline.type,
      });

      // Verify event was stored
      const events = sessionStore.getEvents(session.id);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('pipeline_created');
      expect(events[0].payload.pipelineId).toBe(pipeline.pipelineId);
    });

    it('should track pipeline stages as session events', () => {
      const session = sessionStore.createSession({
        name: 'Multi-stage Pipeline',
      });

      // Create pipeline with stages
      const pipeline = pipelineModule.createPipelineRun({
        type: pipelineModule.PipelineType.CDC,
        prompt: 'Implement feature',
        sessionId: session.id,
      });

      const stage1 = pipelineModule.createPipelineStage({
        sequence: 0,
        topologyId: 'research-swarm',
        label: 'Research',
      });

      const stage2 = pipelineModule.createPipelineStage({
        sequence: 1,
        topologyId: 'dev-team',
        label: 'Build',
      });

      pipeline.stages.push(stage1, stage2);

      // Store stage transitions as events
      sessionStore.addEvent(session.id, 'pipeline_stage_start', {
        pipelineId: pipeline.pipelineId,
        stageId: stage1.stageId,
        sequence: 0,
      });

      sessionStore.addEvent(session.id, 'pipeline_stage_complete', {
        pipelineId: pipeline.pipelineId,
        stageId: stage1.stageId,
      });

      sessionStore.addEvent(session.id, 'pipeline_stage_start', {
        pipelineId: pipeline.pipelineId,
        stageId: stage2.stageId,
        sequence: 1,
      });

      // Verify all events stored
      const events = sessionStore.getEvents(session.id);
      const stageEvents = events.filter(e => e.type.startsWith('pipeline_stage'));
      expect(stageEvents.length).toBe(3);
    });
  });

  describe('Provenance tracking', () => {
    it('should build complete provenance chain', () => {
      const pipeline = pipelineModule.createPipelineRun({
        type: pipelineModule.PipelineType.CDC,
        prompt: 'Build authentication system',
      });

      // Simulate a 3-stage pipeline
      const stages = [
        pipelineModule.createPipelineStage({
          sequence: 0,
          topologyId: 'architect',
          label: 'Design',
        }),
        pipelineModule.createPipelineStage({
          sequence: 1,
          topologyId: 'dev-team',
          label: 'Implement',
        }),
        pipelineModule.createPipelineStage({
          sequence: 2,
          topologyId: 'adversarial-debate',
          label: 'Validate',
        }),
      ];

      pipeline.stages.push(...stages);

      // Create provenance links
      const link1 = pipelineModule.createProvenanceLink({
        sequence: 0,
        fromStageId: null, // Root
        toStageId: stages[0].stageId,
        artifactIds: [],
        transformType: 'initial-input',
      });

      const link2 = pipelineModule.createProvenanceLink({
        sequence: 1,
        fromStageId: stages[0].stageId,
        toStageId: stages[1].stageId,
        artifactIds: ['design-doc-1'],
        transformType: 'design-to-code',
      });

      const link3 = pipelineModule.createProvenanceLink({
        sequence: 2,
        fromStageId: stages[1].stageId,
        toStageId: stages[2].stageId,
        artifactIds: ['code-impl-1', 'test-suite-1'],
        transformType: 'code-to-review',
      });

      pipeline.provenance.links.push(link1, link2, link3);

      // Validate provenance chain
      expect(pipeline.provenance.links).toHaveLength(3);
      expect(pipeline.provenance.links[0].fromStageId).toBeNull();
      expect(pipeline.provenance.links[1].fromStageId).toBe(stages[0].stageId);
      expect(pipeline.provenance.links[2].artifactIds).toHaveLength(2);
    });
  });

  describe('Artifact extraction and storage', () => {
    it('should create artifacts with correct metadata', () => {
      const pipeline = pipelineModule.createPipelineRun({
        type: pipelineModule.PipelineType.CDC,
        prompt: 'Implement feature',
      });

      const artifact = pipelineModule.createStageArtifact({
        pipelineId: pipeline.pipelineId,
        stageId: 'stage-0-dev-team',
        type: pipelineModule.ArtifactType.CODE_IMPLEMENTATION,
        content: 'export const handler = () => { /* ... */ };',
        createdBy: 'implementer:codex-local',
        metadata: {
          language: 'javascript',
          lines: 42,
          tokens: 850,
        },
      });

      expect(artifact.artifactId).toBeDefined();
      expect(artifact.type).toBe(pipelineModule.ArtifactType.CODE_IMPLEMENTATION);
      expect(artifact.metadata.language).toBe('javascript');
      expect(artifact.metadata.lines).toBe(42);
    });

    it('should support all artifact types defined in spec', () => {
      const artifactTypes = [
        pipelineModule.ArtifactType.RESEARCH_FINDINGS,
        pipelineModule.ArtifactType.OPTIONS_LIST,
        pipelineModule.ArtifactType.SUB_PROBLEM_DECOMPOSITION,
        pipelineModule.ArtifactType.SYNTHESIZED_RESEARCH,
        pipelineModule.ArtifactType.CODE_IMPLEMENTATION,
        pipelineModule.ArtifactType.SPECIFICATION,
        pipelineModule.ArtifactType.INFRASTRUCTURE_CONFIG,
        pipelineModule.ArtifactType.DESIGN_DECISION,
        pipelineModule.ArtifactType.VULNERABILITY_REPORT,
        pipelineModule.ArtifactType.QUALITY_ASSESSMENT,
        pipelineModule.ArtifactType.RULING,
        pipelineModule.ArtifactType.SECURITY_FINDINGS,
      ];

      for (const type of artifactTypes) {
        expect(type).toBeDefined();
        expect(typeof type).toBe('string');
      }
    });
  });

  describe('Pipeline compositions', () => {
    it('should define standard composition matching design spec', () => {
      const standard = pipelineModule.PipelineCompositions.STANDARD;

      // Line 38 of pipeline-types-2026-04-05.md: Explore -> Build -> Validate
      expect(standard.stages[0].type).toBe(pipelineModule.PipelineType.SWARM);
      expect(standard.stages[1].type).toBe(pipelineModule.PipelineType.CDC);
      expect(standard.stages[2].type).toBe(pipelineModule.PipelineType.CAC);
    });

    it('should define governed dev with mob sit-down', () => {
      const governed = pipelineModule.PipelineCompositions.GOVERNED_DEV;

      // Build -> Validate -> accountability
      expect(governed.stages[0].type).toBe(pipelineModule.PipelineType.CDC);
      expect(governed.stages[1].type).toBe(pipelineModule.PipelineType.CAC);
      expect(governed.stages[2].topologyId).toBe('mob-sit-down');
    });

    it('should provide runnable compositions', () => {
      const compositions = [
        pipelineModule.PipelineCompositions.STANDARD,
        pipelineModule.PipelineCompositions.SECURITY_RESEARCH,
        pipelineModule.PipelineCompositions.GOVERNED_DEV,
        pipelineModule.PipelineCompositions.FULL_CYCLE,
      ];

      for (const comp of compositions) {
        expect(comp.id).toBeDefined();
        expect(comp.name).toBeDefined();
        expect(comp.description).toBeDefined();
        expect(comp.stages.length).toBeGreaterThan(0);

        for (const stage of comp.stages) {
          expect(stage.topologyId).toBeDefined();
          expect(stage.label).toBeDefined();
        }
      }
    });

    it('should resolve total-axes through the runner composition registry', () => {
      const totalAxes = pipelineModule.getComposition('total-axes');

      expect(totalAxes).toBeDefined();
      expect(totalAxes.id).toBe('total-axes');
      expect(totalAxes.stages[0].topologyId).toBe('research-swarm');
      expect(totalAxes.stages[1].topologyId).toBe('adversarial-debate');
      expect(totalAxes.stages[2].topologyId).toBe('mob-sit-down');
      expect(totalAxes.stages[3].runWhen).toBe('mandates-unresolved');
      expect(totalAxes.stages[4].runWhen).toBe('mandates-unresolved');
    });
  });
});
