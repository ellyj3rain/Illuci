/**
 * Node Spawning & State Visualization Tests
 *
 * Validates the full chain:
 *   topology runner → emitter → SSE server state → visualizer event shape
 *
 * Coverage:
 *   1. agent_spawn events emitted correctly (main + seat agents)
 *   2. SSE server pipeline state tracking (setActivePipeline, stage lifecycle)
 *   3. Event broadcast shape matches visualizer expectations
 *   4. Pipeline → SSE state synchronization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock telemetry before importing emitter ───
vi.mock('../telemetry/store.js', () => ({
  recordEvent: vi.fn(),
}));

import {
  emit,
  onEvent,
  clearListeners,
  emitTopologyStart,
  emitTopologyComplete,
  emitPipelineStart,
  emitPipelineStageStart,
  emitPipelineStageComplete,
  emitPipelineComplete,
} from './emitter.js';

import {
  setActivePipeline,
  setPipelineStageActive,
  setPipelineStageComplete,
  clearActivePipeline,
  getActivePipeline,
  setActiveSession,
  getActiveSession,
  isModelPaused,
  drainInjections,
} from './sse-server.js';


// ─── 1. Agent Spawn Emission ───

describe('agent_spawn emission', () => {
  let captured;
  let unsub;

  beforeEach(() => {
    captured = [];
    unsub = onEvent((event) => captured.push(event));
  });

  afterEach(() => {
    unsub();
    clearListeners();
  });

  it('emits main topology agent_spawn with isMain=true', async () => {
    await emitTopologyStart(
      'dev-team',
      'Development Team',
      { architect: ['claude-local'], coder: ['codex-local'] },
      'Build a feature',
      'session-1',
      null,
      null,
    );

    const spawns = captured.filter(e => e.type === 'agent_spawn');

    // First spawn is the main topology
    const main = spawns[0];
    expect(main.payload.isMain).toBe(true);
    expect(main.payload.name).toBe('Development Team');
    expect(main.payload.roleHint).toBe('orchestrator');
    expect(main.payload.authorityWeight).toBe(1.0);
    expect(main.payload.displayColor).toBe('#66ccff');
    expect(main.payload.task).toBe('Build a feature');
    expect(main.sessionId).toBe('session-1');
    expect(main.time).toBe(0);
  });

  it('emits seat agent_spawn for each model in lineup', async () => {
    await emitTopologyStart(
      'dev-team',
      'Development Team',
      { architect: ['claude-local'], coder: ['codex-local'], reviewer: ['gemini-local'] },
      'Build a feature',
      'session-2',
      null,
      null,
    );

    const spawns = captured.filter(e => e.type === 'agent_spawn');

    // 1 main + 3 seat agents
    expect(spawns.length).toBe(4);

    const seatSpawns = spawns.slice(1);
    expect(seatSpawns[0].payload.name).toBe('architect:claude-local');
    expect(seatSpawns[0].payload.parent).toBe('Development Team');
    expect(seatSpawns[0].payload.task).toBe('architect');
    expect(seatSpawns[0].payload.model).toBe('claude-local');
    expect(seatSpawns[0].sessionId).toBe('session-2');

    expect(seatSpawns[1].payload.name).toBe('coder:codex-local');
    expect(seatSpawns[1].payload.model).toBe('codex-local');

    expect(seatSpawns[2].payload.name).toBe('reviewer:gemini-local');
    expect(seatSpawns[2].payload.model).toBe('gemini-local');
  });

  it('emits model_detected for each seat agent', async () => {
    await emitTopologyStart(
      'dev-team',
      'Development Team',
      { lead: ['claude-local'] },
      'Task',
      'session-3',
      null,
      null,
    );

    const detected = captured.filter(e => e.type === 'model_detected');
    expect(detected.length).toBe(1);
    expect(detected[0].payload.agent).toBe('lead:claude-local');
    expect(detected[0].payload.model).toBe('claude-local');
  });

  it('emits topology_start with graph payload after spawns', async () => {
    const graph = {
      nodes: [
        { id: 'architect', label: 'Architect', roleHint: 'design', weight: 1.5 },
        { id: 'coder', label: 'Coder', roleHint: 'implement', weight: 1.0 },
      ],
      edges: [{ source: 'architect', target: 'coder', type: 'supervises' }],
    };

    await emitTopologyStart(
      'dev-team',
      'Development Team',
      { architect: ['claude-local'], coder: ['codex-local'] },
      'Build a feature',
      'session-4',
      null,
      graph,
    );

    const topStart = captured.find(e => e.type === 'topology_start');
    expect(topStart).toBeDefined();
    expect(topStart.payload.topologyId).toBe('dev-team');
    expect(topStart.payload.graph).toEqual(graph);
    expect(topStart.payload.lineup).toEqual({ architect: ['claude-local'], coder: ['codex-local'] });
  });

  it('enriches seat spawns with graph metadata (roleHint, weight)', async () => {
    const graph = {
      nodes: [
        { id: 'architect', label: 'Lead Architect', roleHint: 'structural-design', weight: 2.0 },
      ],
      edges: [],
    };

    await emitTopologyStart(
      'dev-team',
      'Development Team',
      { architect: ['claude-local'] },
      'Design something',
      'session-5',
      null,
      graph,
    );

    const seatSpawn = captured.filter(e => e.type === 'agent_spawn')[1]; // skip main
    expect(seatSpawn.payload.roleHint).toBe('structural-design');
    expect(seatSpawn.payload.authorityWeight).toBe(2.0);
  });

  it('handles multi-model seats (multiple models per seat)', async () => {
    await emitTopologyStart(
      'adversarial-debate',
      'Adversarial Debate',
      { debater: ['claude-local', 'deepseek', 'gemini-local'] },
      'Debate topic',
      'session-6',
      null,
      null,
    );

    const spawns = captured.filter(e => e.type === 'agent_spawn');
    // 1 main + 3 seat agents
    expect(spawns.length).toBe(4);

    const seatNames = spawns.slice(1).map(s => s.payload.name);
    expect(seatNames).toEqual([
      'debater:claude-local',
      'debater:deepseek',
      'debater:gemini-local',
    ]);
  });
});


// ─── 2. SSE Server Pipeline State ───

describe('SSE server pipeline state tracking', () => {
  afterEach(() => {
    clearActivePipeline();
  });

  it('setActivePipeline initializes stages with pending status', () => {
    const stages = [
      { stageId: 'stage-1', topologyId: 'research-swarm', label: 'Research' },
      { stageId: 'stage-2', topologyId: 'dev-team', label: 'Build' },
    ];

    setActivePipeline('pipe-1', stages, 'session-10');

    const state = getActivePipeline();
    expect(state.pipelineId).toBe('pipe-1');
    expect(state.sessionId).toBe('session-10');
    expect(state.stages.length).toBe(2);
    expect(state.stages[0].status).toBe('pending');
    expect(state.stages[1].status).toBe('pending');
    expect(state.activeStageId).toBeNull();
  });

  it('setPipelineStageActive marks correct stage running', () => {
    setActivePipeline('pipe-2', [
      { stageId: 's1', topologyId: 'a', label: 'A' },
      { stageId: 's2', topologyId: 'b', label: 'B' },
    ], 'session-11');

    setPipelineStageActive('s1');

    const state = getActivePipeline();
    expect(state.activeStageId).toBe('s1');
    expect(state.stages[0].status).toBe('running');
    expect(state.stages[1].status).toBe('pending');
  });

  it('setPipelineStageComplete marks stage completed', () => {
    setActivePipeline('pipe-3', [
      { stageId: 's1', topologyId: 'a', label: 'A' },
    ], 'session-12');

    setPipelineStageActive('s1');
    setPipelineStageComplete('s1');

    const state = getActivePipeline();
    expect(state.stages[0].status).toBe('completed');
  });

  it('full pipeline lifecycle: pending → running → completed → cleared', () => {
    setActivePipeline('pipe-4', [
      { stageId: 's1', topologyId: 'research-swarm', label: 'Research' },
      { stageId: 's2', topologyId: 'dev-team', label: 'Build' },
    ], 'session-13');

    // Stage 1 lifecycle
    setPipelineStageActive('s1');
    expect(getActivePipeline().activeStageId).toBe('s1');

    setPipelineStageComplete('s1');
    expect(getActivePipeline().stages[0].status).toBe('completed');

    // Stage 2 lifecycle
    setPipelineStageActive('s2');
    expect(getActivePipeline().activeStageId).toBe('s2');
    expect(getActivePipeline().stages[1].status).toBe('running');

    setPipelineStageComplete('s2');
    expect(getActivePipeline().stages[1].status).toBe('completed');

    // Clear
    clearActivePipeline();
    const cleared = getActivePipeline();
    expect(cleared.pipelineId).toBeNull();
    expect(cleared.stages.length).toBe(0);
    expect(cleared.activeStageId).toBeNull();
  });

  it('getActivePipeline returns a copy (no external mutation)', () => {
    setActivePipeline('pipe-5', [
      { stageId: 's1', topologyId: 'a', label: 'A' },
    ], 'session-14');

    const state1 = getActivePipeline();
    state1.stages.push({ stageId: 'injected', status: 'hacked' });

    const state2 = getActivePipeline();
    expect(state2.stages.length).toBe(1); // Not mutated
  });
});


// ─── 3. SSE Server Active Session State ───

describe('SSE server active session state', () => {
  it('setActiveSession initializes topology session', () => {
    setActiveSession('dev-team', { architect: ['claude-local'] }, 'session-20');

    const state = getActiveSession();
    expect(state.topologyId).toBe('dev-team');
    expect(state.lineup).toEqual({ architect: ['claude-local'] });
    expect(state.sessionId).toBe('session-20');
    expect(state.paused.size).toBe(0);
  });

  it('isModelPaused returns false by default', () => {
    setActiveSession('dev-team', {}, 'session-21');
    expect(isModelPaused('claude-local')).toBe(false);
  });

  it('drainInjections returns empty array when none queued', () => {
    setActiveSession('dev-team', {}, 'session-22');
    const drained = drainInjections('claude-local');
    expect(drained).toEqual([]);
  });
});


// ─── 4. Pipeline Event → SSE State Sync ───

describe('pipeline events drive SSE state', () => {
  let captured;
  let unsub;

  beforeEach(() => {
    captured = [];
    unsub = onEvent((event) => {
      captured.push(event);

      // Simulate SSE server event listener (mirrors sse-server.js line 570-578)
      if (event.type === 'pipeline_start' && event.payload) {
        setActivePipeline(event.payload.pipelineId, event.payload.stages || [], event.sessionId);
      } else if (event.type === 'pipeline_stage_start' && event.payload) {
        setPipelineStageActive(event.payload.stageId);
      } else if (event.type === 'pipeline_stage_complete' && event.payload) {
        setPipelineStageComplete(event.payload.stageId);
      } else if (event.type === 'pipeline_complete') {
        clearActivePipeline();
      }
    });
  });

  afterEach(() => {
    unsub();
    clearListeners();
    clearActivePipeline();
  });

  it('emitPipelineStart sets active pipeline via event', async () => {
    const stages = [
      { stageId: 'stg-1', topologyId: 'research-swarm', label: 'Research', sequence: 0, lineup: {} },
      { stageId: 'stg-2', topologyId: 'dev-team', label: 'Build', sequence: 1, lineup: {} },
    ];

    await emitPipelineStart('pipe-100', stages, 'Build something', 'session-30');

    const state = getActivePipeline();
    expect(state.pipelineId).toBe('pipe-100');
    expect(state.stages.length).toBe(2);
    expect(state.stages[0].stageId).toBe('stg-1');
    expect(state.stages[1].stageId).toBe('stg-2');
  });

  it('emitPipelineStageStart activates stage via event', () => {
    setActivePipeline('pipe-101', [
      { stageId: 'stg-a', topologyId: 'a', label: 'A' },
    ], 'session-31');

    emitPipelineStageStart('stg-a', 'a', 'Stage A', 'session-31');

    const state = getActivePipeline();
    expect(state.activeStageId).toBe('stg-a');
    expect(state.stages[0].status).toBe('running');
  });

  it('emitPipelineStageComplete completes stage via event', () => {
    setActivePipeline('pipe-102', [
      { stageId: 'stg-b', topologyId: 'b', label: 'B' },
    ], 'session-32');
    setPipelineStageActive('stg-b');

    emitPipelineStageComplete('stg-b', [], 'session-32');

    const state = getActivePipeline();
    expect(state.stages[0].status).toBe('completed');
  });

  it('emitPipelineComplete clears pipeline state via event', () => {
    setActivePipeline('pipe-103', [
      { stageId: 'stg-c', topologyId: 'c', label: 'C' },
    ], 'session-33');

    emitPipelineComplete('pipe-103', 'completed', 'session-33');

    const state = getActivePipeline();
    expect(state.pipelineId).toBeNull();
  });
});


// ─── 5. Event Shape Validation (Visualizer Contract) ───

describe('event shape matches visualizer expectations', () => {
  let captured;
  let unsub;

  beforeEach(() => {
    captured = [];
    unsub = onEvent((event) => captured.push(event));
  });

  afterEach(() => {
    unsub();
    clearListeners();
  });

  it('agent_spawn events have required fields for SimulationEvent', async () => {
    await emitTopologyStart(
      'dev-team',
      'Dev Team',
      { lead: ['claude-local'] },
      'Test task',
      'session-40',
      null,
      null,
    );

    const spawns = captured.filter(e => e.type === 'agent_spawn');
    for (const spawn of spawns) {
      // SimulationEvent contract: time, type, payload, sessionId
      expect(spawn).toHaveProperty('time');
      expect(typeof spawn.time).toBe('number');
      expect(spawn).toHaveProperty('type', 'agent_spawn');
      expect(spawn).toHaveProperty('payload');
      expect(spawn).toHaveProperty('sessionId', 'session-40');

      // Payload must have name
      expect(spawn.payload).toHaveProperty('name');
      expect(typeof spawn.payload.name).toBe('string');
      expect(spawn.payload.name.length).toBeGreaterThan(0);
    }
  });

  it('seat spawn payload has parent, task, model, roleHint, authorityWeight', async () => {
    await emitTopologyStart(
      'dev-team',
      'Dev Team',
      { coder: ['codex-local'] },
      'Code it',
      'session-41',
      null,
      null,
    );

    const seatSpawn = captured.filter(e => e.type === 'agent_spawn')[1];

    expect(seatSpawn.payload).toHaveProperty('parent', 'Dev Team');
    expect(seatSpawn.payload).toHaveProperty('task', 'coder');
    expect(seatSpawn.payload).toHaveProperty('model', 'codex-local');
    expect(seatSpawn.payload).toHaveProperty('roleHint');
    expect(seatSpawn.payload).toHaveProperty('authorityWeight');
    expect(seatSpawn.payload).toHaveProperty('displayColor');
  });

  it('topology_start event carries compiled graph for layout', async () => {
    const graph = {
      nodes: [{ id: 'a', label: 'A' }],
      edges: [{ source: 'a', target: 'b', type: 'peer-of' }],
      layout: 'force',
    };

    await emitTopologyStart(
      'custom',
      'Custom Topology',
      { a: ['model-a'] },
      'Run it',
      'session-42',
      null,
      graph,
    );

    const topStart = captured.find(e => e.type === 'topology_start');
    expect(topStart.payload.graph).toBeDefined();
    expect(topStart.payload.graph.nodes.length).toBe(1);
    expect(topStart.payload.graph.edges.length).toBe(1);
  });
});
