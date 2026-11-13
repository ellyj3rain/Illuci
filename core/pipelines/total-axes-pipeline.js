import { PipelinePhase, PipelineType } from './pipeline-types.js';

export const TOTAL_AXES_RUN_WHEN = {
  MANDATES_UNRESOLVED: 'mandates-unresolved',
  MANDATES_RESOLVED: 'mandates-resolved',
};

export const TOTAL_AXES_COMPOSITION = {
  id: 'total-axes',
  name: 'Total Axes',
  description: 'Research -> Adversarial -> Mob Accountability, with remediation and re-accountability only when accountability leaves unresolved mandates.',
  stages: [
    {
      phase: PipelinePhase.EXPLORE,
      type: PipelineType.SWARM,
      topologyId: 'research-swarm',
      label: 'Research Swarm',
    },
    {
      phase: PipelinePhase.VALIDATE,
      type: PipelineType.CAC,
      topologyId: 'adversarial-debate',
      label: 'Adversarial Swarm',
    },
    {
      phase: PipelinePhase.ACCOUNT,
      topologyId: 'mob-sit-down',
      label: 'Mob Accountability',
    },
    {
      phase: PipelinePhase.BUILD,
      type: PipelineType.CDC,
      topologyId: 'dev-team',
      label: 'Remediation',
      runWhen: TOTAL_AXES_RUN_WHEN.MANDATES_UNRESOLVED,
    },
    {
      phase: PipelinePhase.ACCOUNT,
      topologyId: 'mob-sit-down',
      label: 'Re-Accountability',
      runWhen: TOTAL_AXES_RUN_WHEN.MANDATES_UNRESOLVED,
    },
  ],
};

export default TOTAL_AXES_COMPOSITION;
