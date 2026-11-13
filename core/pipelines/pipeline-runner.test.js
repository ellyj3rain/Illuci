import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runPipeline } from './pipeline-runner.js';

const runNodeMock = vi.fn();
const runVerificationCheckpointMock = vi.fn();

function makeTrace(topologyId) {
  return {
    phases: {
      final: {
        responses: [
          {
            response: `${topologyId} output`,
            seat: 'seat',
            model: 'model',
            usage: { total_tokens: 10 },
          },
        ],
      },
    },
    totalLatency: 5,
    budget: { spent: 10 },
    halted: false,
  };
}

describe('pipeline runner conditional stages', () => {
  beforeEach(() => {
    runNodeMock.mockReset();
    runVerificationCheckpointMock.mockReset();

    runNodeMock.mockImplementation(async (node) => makeTrace(node.topologyId));
  });

  it('skips remediation and re-accountability when accountability passes', async () => {
    runVerificationCheckpointMock.mockResolvedValueOnce({
      passed: true,
      totalCount: 1,
      resolvedCount: 1,
      unresolvedCount: 0,
      manualCount: 0,
      mandates: [],
    });

    const result = await runPipeline({
      type: 'total-axes',
      prompt: 'Assess posture',
      options: {
        _runNode: runNodeMock,
        _runVerificationCheckpoint: runVerificationCheckpointMock,
      },
    });

    expect(runNodeMock.mock.calls.map(([node]) => node.topologyId)).toEqual([
      'research-swarm',
      'adversarial-debate',
      'mob-sit-down',
    ]);
    expect(result.status).toBe('completed');
    expect(result.metadata.lastAccountMandateReport.passed).toBe(true);
  });

  it('branches into remediation and re-accountability when accountability leaves unresolved mandates', async () => {
    runVerificationCheckpointMock
      .mockResolvedValueOnce({
        passed: false,
        totalCount: 2,
        resolvedCount: 1,
        unresolvedCount: 1,
        manualCount: 0,
        mandates: [],
      })
      .mockResolvedValueOnce({
        passed: true,
        totalCount: 1,
        resolvedCount: 1,
        unresolvedCount: 0,
        manualCount: 0,
        mandates: [],
      });

    const result = await runPipeline({
      type: 'total-axes',
      prompt: 'Assess posture',
      options: {
        _runNode: runNodeMock,
        _runVerificationCheckpoint: runVerificationCheckpointMock,
      },
    });

    expect(runNodeMock.mock.calls.map(([node]) => node.topologyId)).toEqual([
      'research-swarm',
      'adversarial-debate',
      'mob-sit-down',
      'dev-team',
      'mob-sit-down',
    ]);
    expect(result.status).toBe('completed');
    expect(result.metadata.lastAccountMandateReport.passed).toBe(true);
  });
});
