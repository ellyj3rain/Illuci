/**
 * illuci — Project Bootstrap
 *
 * When a project starts, the first thing that happens is establishing
 * the Ground Zero Solutions governance standard. This is the default user experience —
 * not optional, not afterthought.
 *
 * The bootstrap creates:
 *   1. Root-level product monorepo directory structure
 *   2. Pipeline artifact directory structure
 *   3. Default governance configuration
 *   4. Project manifest with vocabulary definitions
 *   5. Disposition preset availability declaration
 *
 * Agents running in a new project should call bootstrap() as step one.
 *
 * @module core/bootstrap/project-init
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { PipelinePhase, PhaseSeatRole } from '../pipelines/pipeline-types.js';
import { listPresets } from '../agents/disposition-presets.js';
import { listTopologies } from '../topologies/index.js';

// ═════════════════════════════════════════════════════════════════════════════
// DIRECTORY STRUCTURE
// ═════════════════════════════════════════════════════════════════════════════

const MONOREPO_DIRS = [
  'apps',
  'packages',
  'services',
  'infra',
  'tooling',
  'docs',
];

const PIPELINE_DIRS = [
  'pipelines/transcripts',
  'pipelines/decisions',
  'pipelines/research',
  'pipelines/implementations',
  'pipelines/validations',
  'pipelines/accountability',
];

const PROJECT_DIRS = [
  ...MONOREPO_DIRS,
  'decisions',
  'design',
  ...PIPELINE_DIRS,
];

// ═════════════════════════════════════════════════════════════════════════════
// GOVERNANCE MANIFEST
// ═════════════════════════════════════════════════════════════════════════════

function generateManifest(projectName, projectRoot) {
  const topologies = listTopologies();
  const dispositionPresets = listPresets();

  return {
    version: '1.3',
    project: projectName,
    createdAt: new Date().toISOString(),
    createdBy: 'illuci-bootstrap',

    governance: {
      description: 'Ground Zero Solutions governance standard. Established at project creation.',

      standard: {
        id: 'gzs-governance-standard',
        name: 'Ground Zero Solutions Governance Standard',
        owner: 'Ground Zero Solutions, Inc.',
        product: 'Illuci',
        appliesTo: 'Illuci-managed projects inherit the Ground Zero Solutions governance standard unless an explicit exception or alternate governing authority is declared.',
      },

      workspace: {
        description: 'Default project posture for Illuci-managed products governed under the Ground Zero Solutions standard.',
        defaultPosture: 'root-level-monorepo-product',
        productKind: 'product',
        releaseSurface: 'ide',
        internalOperatorSurfaces: ['cli', 'tui'],
        repositoryBoundary: 'The repository root is the product root and orchestration boundary.',
        runtimePolicy: 'Project workspaces assume a drive-root Illuci runtime namespace and a root-level monorepo repository shape.',
        directories: {
          apps: 'Deployable user-facing applications, including the released Illuci IDE and adjacent app surfaces',
          packages: 'Shared packages, SDKs, domain libraries, and reusable modules',
          services: 'Backend services, workers, APIs, and agent backends',
          infra: 'Infrastructure as code, deployment specs, and environment definitions',
          tooling: 'Internal CLI/TUI surfaces plus build, automation, governance, and developer tooling',
          docs: 'Product, architecture, and operating documentation',
          decisions: 'Append-only design decisions and architectural rulings',
          design: 'Design specifications and visual system artifacts',
        },
        exceptions: 'Single-package or leaf-repo layouts are explicit exceptions, not the default assumption.',
      },

      bootstrapProtocols: {
        description: 'Required governance procedures before broad implementation or structural change under the Ground Zero Solutions standard.',
        executionOrder: ['standards-assessment', 'reorganization-protocol'],
        standardsAssessment: {
          standardId: 'gzs-governance-standard',
          standardName: 'Ground Zero Solutions Governance Standard',
          postureOwner: 'illuci',
          postureId: 'root-level-monorepo-product',
          entrypoint: 'illuci project assess',
          status: 'required-before-major-work',
          purpose: 'Assess whether the repository, runtime assumptions, and workspace layout conform to the Ground Zero Solutions governance standard and the active Illuci workspace posture before major implementation begins.',
          requiredOutputs: [
            'workspace-posture verdict',
            'layout conformance report',
            'exceptions list',
            'drift inventory',
            'recommended reorganization scope',
          ],
          checks: [
            'Confirm the Ground Zero Solutions governance standard is the active governing standard',
            'Confirm the repository root is the product and orchestration boundary',
            'Classify released IDE surfaces into apps and internal CLI/TUI surfaces into tooling',
            'Classify current directories into apps/packages/services/infra/tooling/docs/governance lanes',
            'Identify missing required lanes and misplaced artifacts',
            'Record whether the workspace is standard, transitional, or exception-bearing',
            'Decide whether reorganization is mandatory, optional, or blocked',
          ],
        },
        reorganizationProtocol: {
          standardId: 'gzs-governance-standard',
          standardName: 'Ground Zero Solutions Governance Standard',
          entrypoint: 'illuci project plan-reorg',
          executionEntrypoint: 'illuci project execute-reorg',
          status: 'required-before-structural-change',
          purpose: 'Govern how agents and operators restructure a repository after assessment without introducing drift or losing provenance.',
          prerequisites: [
            'Completed standards assessment',
            'Declared target workspace posture',
            'Approved move plan for major structural changes',
          ],
          rules: [
            'Reorganize by root-level product lane first, not by ad hoc convenience',
            'Treat released IDE surfaces as apps and CLI/TUI surfaces as internal tooling unless an exception is declared',
            'Preserve repository history and provenance whenever possible',
            'Move code, config, docs, and governance artifacts together when they are structurally linked',
            'Update references, tooling, and manifests as part of the same reorganization batch',
            'Record intentional exceptions instead of silently tolerating drift',
          ],
          requiredOutputs: [
            'reorganization plan',
            'move map',
            'updated governance manifest',
            'post-reorganization verification summary',
          ],
        },
      },

      pipeline: {
        description: 'Ordered sequence of phases. Each phase has a purpose, a topology (swappable), and seat assignments.',
        phases: {
          [PipelinePhase.EXPLORE]: {
            purpose: 'Breadth-first problem space investigation',
            description: 'Multiple agents explore the problem from different angles. Output is research, options, decompositions.',
            defaultTopology: 'research-swarm',
            alternativeTopologies: ['commune', 'cult', 'delphi-panel'],
            seatRoles: [PhaseSeatRole.SYNTHESIZER, PhaseSeatRole.INVESTIGATOR, PhaseSeatRole.SKEPTIC],
          },
          [PipelinePhase.BUILD]: {
            purpose: 'Depth-first implementation',
            description: 'Agents implement the solution. Architect designs, builders implement, reviewers check, validators verify.',
            defaultTopology: 'dev-team',
            alternativeTopologies: ['apprentice-master', 'corporate-hierarchy'],
            seatRoles: [PhaseSeatRole.ARCHITECT, PhaseSeatRole.BUILDER, PhaseSeatRole.REVIEWER, PhaseSeatRole.VALIDATOR],
          },
          [PipelinePhase.VALIDATE]: {
            purpose: 'Adversarial quality challenge',
            description: 'Agents attack and defend the work. Challenger finds flaws, defender justifies, arbiter rules.',
            defaultTopology: 'judiciary',
            alternativeTopologies: ['adversarial-debate', 'colosseum', 'turing-test'],
            seatRoles: [PhaseSeatRole.CHALLENGER, PhaseSeatRole.DEFENDER, PhaseSeatRole.ARBITER],
          },
          [PipelinePhase.ACCOUNT]: {
            purpose: 'Accountability review and mandate enforcement',
            description: 'Authority reviews outcomes, auditors verify compliance, mandates are issued. Unresolved mandates block the pipeline.',
            defaultTopology: 'censorate',
            alternativeTopologies: ['mob-sit-down', 'sanhedrin', 'legislature', 'kgotla'],
            seatRoles: [PhaseSeatRole.AUTHORITY, PhaseSeatRole.AUDITOR, PhaseSeatRole.RECORDER],
          },
        },
      },

      artifacts: {
        description: 'Pipeline outputs organized by phase function.',
        directories: {
          'pipelines/transcripts': 'Raw execution transcripts, full session records',
          'pipelines/decisions': 'Design decisions, rulings, council outputs',
          'pipelines/research': 'EXPLORE phase output — swarm findings, research, options',
          'pipelines/implementations': 'BUILD phase output — code specs, architecture, implementation records',
          'pipelines/validations': 'VALIDATE phase output — adversarial findings, quality assessments',
          'pipelines/accountability': 'ACCOUNT phase output — mandates, verification reports, compliance records',
        },
      },

      disposition: {
        description: 'Active seat disposition presets available to Illuci-managed topology and pipeline runs.',
        inputShape: {
          presetId: 'Named preset from the active disposition preset library',
          profile: 'Inline dimensional profile',
          role: 'Optional matrix or skill-bundle role intent',
          skills: 'Optional skill ids that influence role composition',
        },
        availablePresets: dispositionPresets,
      },

      topologies: {
        description: 'Structural patterns that define how agents interact. The topology says WHO TALKS TO WHOM. The phase says WHY.',
        available: topologies,
        count: topologies.length,
      },

      roleProvenance: {
        description: 'Every role assignment is tracked by origin.',
        types: {
          topological: 'Role comes from the topology seat definition — the structure chose it',
          agent: 'Role resolved by the capability matrix — the system chose it',
          human: 'Role explicitly assigned by the operator — you chose it',
        },
      },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Bootstrap a new project with the Ground Zero Solutions governance standard.
 *
 * Creates root-level monorepo directories, governance manifest, and initial configuration.
 * Idempotent - safe to call on an existing project (won't overwrite).
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {string} [projectName] - Human-readable project name
 * @returns {{ created: string[], skipped: string[], manifest: Object }}
 */
export function bootstrap(projectRoot, projectName) {
  const name = projectName || projectRoot.split(/[/\\]/).pop() || 'illuci-project';
  const created = [];
  const skipped = [];

  // Create directory structure
  for (const dir of PROJECT_DIRS) {
    const fullPath = resolve(projectRoot, dir);
    if (existsSync(fullPath)) {
      skipped.push(dir);
    } else {
      mkdirSync(fullPath, { recursive: true });
      created.push(dir);
    }
  }

  // Write governance manifest
  const manifestPath = resolve(projectRoot, 'illuci-governance.json');
  const manifest = generateManifest(name, projectRoot);

  if (existsSync(manifestPath)) {
    skipped.push('illuci-governance.json');
  } else {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    created.push('illuci-governance.json');
  }

  return { created, skipped, manifest };
}

/**
 * Check if a project has been bootstrapped.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function isBootstrapped(projectRoot) {
  return existsSync(resolve(projectRoot, 'illuci-governance.json'));
}

/**
 * Get the governance manifest for a bootstrapped project.
 *
 * @param {string} projectRoot
 * @returns {Object|null}
 */
export function getManifest(projectRoot) {
  const manifestPath = resolve(projectRoot, 'illuci-governance.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const { readFileSync } = require('fs');
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

export default {
  bootstrap,
  isBootstrapped,
  getManifest,
  PROJECT_DIRS,
  MONOREPO_DIRS,
  PIPELINE_DIRS,
};
