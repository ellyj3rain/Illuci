/**
 * illuci — Mandate Verification
 *
 * Automatic verification checkpoint for accountability topologies.
 *
 * When a pipeline stage uses a topology with `removalSemantics` (Censorate,
 * Sanhedrin, Colosseum, mob-sit-down, etc.), the stage output may contain
 * mandates — required actions that must be executed before the pipeline
 * advances. This module parses those mandates and verifies them against
 * the working tree.
 *
 * This is infrastructure, not configuration. Every pipeline gets it for free.
 */

import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { createStageArtifact, ArtifactType, PipelineStatus, createPipelineStage } from './pipeline-types.js';
import {
  emitPipelineStageStart,
  emitPipelineStageComplete,
} from '../events/emitter.js';

// ─── MANDATE PARSING PATTERNS ───

const SECTION_HEADERS = /^#{1,4}\s*(mandates?|rulings?|requirements?|orders?|directives?|required\s+changes?|action\s+items?|binding\s+orders?)/im;
const NUMBERED_ITEM = /^\s*(\d+)[.)]\s+(.+)/;
const KEYWORD_LINE = /^\s*(?:MANDATE|REQUIRED|RULING|ORDER|DIRECTIVE|BINDING)\s*[:—–\-]\s*(.+)/i;
const BACKTICK_PATH = /`([a-zA-Z0-9_\-./\\]+\.[a-zA-Z]{1,5})`/g;
const BARE_PATH = /(?:^|\s)((?:[\w-]+\/)+[\w-]+\.[\w]{1,5})(?:\s|$|[,;.])/g;
const BACKTICK_IDENT = /`([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)`/g;
const CODE_IDENT = /\b([A-Z][a-z]+[A-Z][\w]*|[a-z]+[A-Z][\w]*)\b/g;

/**
 * Parse mandates from accountability topology output.
 *
 * Handles multiple formats:
 *   - Mandates sections with numbered items
 *   - Keyword-prefixed lines (MANDATE: ..., REQUIRED: ...)
 *   - Numbered lists within ruling/verdict sections
 *
 * @param {string} stageOutput - Raw text output from the accountability stage
 * @returns {Mandate[]} Parsed mandates with verification hints
 */
export function parseMandates(stageOutput) {
  if (!stageOutput || typeof stageOutput !== 'string') return [];

  const mandates = [];
  const lines = stageOutput.split('\n');
  const seen = new Set();

  let inMandateSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect mandate section headers
    if (SECTION_HEADERS.test(line)) {
      inMandateSection = true;
      continue;
    }

    // Exit section on next unrelated header
    if (inMandateSection && /^#{1,4}\s/.test(line) && !SECTION_HEADERS.test(line)) {
      inMandateSection = false;
      continue;
    }

    // Extract numbered items from mandate sections
    if (inMandateSection) {
      const numbered = line.match(NUMBERED_ITEM);
      if (numbered) {
        let fullText = numbered[2].trim();
        // Collect continuation lines
        let j = i + 1;
        while (
          j < lines.length &&
          lines[j].trim() &&
          !NUMBERED_ITEM.test(lines[j]) &&
          !SECTION_HEADERS.test(lines[j]) &&
          !/^#{1,4}\s/.test(lines[j])
        ) {
          fullText += ' ' + lines[j].trim();
          j++;
        }
        const key = fullText.slice(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          mandates.push(buildMandate(mandates.length + 1, fullText));
        }
        i = j - 1;
      }
    }

    // Keyword-prefixed mandates anywhere in output
    const keyword = line.match(KEYWORD_LINE);
    if (keyword) {
      const text = keyword[1].trim();
      const key = text.slice(0, 80);
      if (!seen.has(key)) {
        seen.add(key);
        mandates.push(buildMandate(mandates.length + 1, text));
      }
    }
  }

  return mandates;
}

/**
 * Build a structured mandate object with verification hints.
 */
function buildMandate(index, text) {
  return {
    id: `mandate-${index}`,
    index,
    text,
    hints: extractVerificationHints(text),
    status: 'pending',
  };
}

/**
 * Extract verifiable targets from mandate text.
 *
 * Finds:
 *   - File paths (backtick-quoted and bare)
 *   - Code identifiers (camelCase, PascalCase, backtick-quoted)
 *   - Function/class names
 *
 * @param {string} text - Mandate text
 * @returns {{ filePaths: string[], identifiers: string[] }}
 */
function extractVerificationHints(text) {
  const hints = { filePaths: [], identifiers: [] };

  // Backtick-quoted file paths
  let match;
  while ((match = BACKTICK_PATH.exec(text)) !== null) {
    if (!hints.filePaths.includes(match[1])) {
      hints.filePaths.push(match[1]);
    }
  }
  BACKTICK_PATH.lastIndex = 0;

  // Bare file paths (word/word/word.ext)
  while ((match = BARE_PATH.exec(text)) !== null) {
    if (!hints.filePaths.includes(match[1])) {
      hints.filePaths.push(match[1]);
    }
  }
  BARE_PATH.lastIndex = 0;

  // Backtick-quoted identifiers (not file paths)
  while ((match = BACKTICK_IDENT.exec(text)) !== null) {
    const ident = match[1];
    if (!ident.includes('/') && !hints.identifiers.includes(ident)) {
      hints.identifiers.push(ident);
    }
  }
  BACKTICK_IDENT.lastIndex = 0;

  // camelCase/PascalCase code identifiers
  while ((match = CODE_IDENT.exec(text)) !== null) {
    const ident = match[1];
    // Filter short identifiers and common English camelCase words
    if (ident.length > 5 && !hints.identifiers.includes(ident)) {
      hints.identifiers.push(ident);
    }
  }
  CODE_IDENT.lastIndex = 0;

  return hints;
}

/**
 * Verify mandates against the working tree.
 *
 * For each mandate:
 *   - Check if referenced files exist and have content
 *   - Check if referenced identifiers appear in the codebase (via git grep)
 *   - Mark as verified, unresolved, or manual (no verifiable hints)
 *
 * @param {Mandate[]} mandates - Parsed mandates
 * @param {string} workingDir - Project root
 * @returns {VerificationReport}
 */
export async function verifyMandates(mandates, workingDir) {
  if (!mandates.length) {
    return {
      passed: true,
      totalCount: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      manualCount: 0,
      mandates: [],
    };
  }

  const results = [];

  for (const mandate of mandates) {
    const result = { ...mandate, checks: [] };
    let hasVerifiableHint = false;
    let allChecksPassed = true;

    // Check file paths
    for (const filePath of mandate.hints.filePaths) {
      hasVerifiableHint = true;
      const fullPath = resolve(workingDir, filePath);
      const exists = existsSync(fullPath);
      let isEmpty = false;

      if (exists) {
        try {
          isEmpty = readFileSync(fullPath, 'utf8').trim().length === 0;
        } catch {
          isEmpty = true;
        }
      }

      result.checks.push({
        type: 'file_exists',
        target: filePath,
        passed: exists && !isEmpty,
        detail: exists
          ? (isEmpty ? 'File exists but is empty' : 'File exists with content')
          : 'File not found',
      });

      if (!exists || isEmpty) allChecksPassed = false;
    }

    // Check identifiers via git grep (cross-platform)
    for (const ident of mandate.hints.identifiers) {
      hasVerifiableHint = true;
      let found = false;

      try {
        const output = execSync(
          `git grep -l "${ident}" -- "*.js" "*.ts" "*.tsx" "*.jsx"`,
          { cwd: workingDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        found = output.trim().length > 0;
      } catch {
        // git grep exits non-zero when no matches found
        found = false;
      }

      result.checks.push({
        type: 'identifier_exists',
        target: ident,
        passed: found,
        detail: found ? 'Found in codebase' : 'Not found in codebase',
      });

      if (!found) allChecksPassed = false;
    }

    // Determine mandate status
    if (!hasVerifiableHint) {
      result.status = 'manual';
    } else if (allChecksPassed) {
      result.status = 'verified';
    } else {
      result.status = 'unresolved';
    }

    results.push(result);
  }

  const resolvedCount = results.filter(r => r.status === 'verified').length;
  const unresolvedCount = results.filter(r => r.status === 'unresolved').length;
  const manualCount = results.filter(r => r.status === 'manual').length;

  return {
    passed: unresolvedCount === 0,
    totalCount: mandates.length,
    resolvedCount,
    unresolvedCount,
    manualCount,
    mandates: results,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run the full mandate verification checkpoint for a completed accountability stage.
 *
 * Called by the pipeline runner after any stage whose topology has removalSemantics.
 * Returns null if no mandates found (stage passes through).
 *
 * @param {Object} completedStage - The completed pipeline stage
 * @param {Object} pipeline - The parent pipeline run
 * @param {string} workingDir - Project root
 * @param {string} [sessionId] - Session for event emission
 * @returns {Promise<VerificationReport|null>}
 */
export async function runVerificationCheckpoint(completedStage, pipeline, workingDir, sessionId) {
  const output = completedStage.output?.rawOutput || '';
  const mandates = parseMandates(output);

  if (mandates.length === 0) return null;

  // Create a synthetic verification stage in the pipeline
  const verificationStage = createPipelineStage({
    sequence: pipeline.stages.length,
    topologyId: 'system:mandate-verification',
    label: `Verify mandates from ${completedStage.label || completedStage.topologyId}`,
    lineup: {},
    input: { type: 'previous', previousStageId: completedStage.stageId },
  });

  verificationStage.status = PipelineStatus.RUNNING;
  verificationStage.startedAt = new Date().toISOString();
  pipeline.stages.push(verificationStage);

  emitPipelineStageStart(
    verificationStage.stageId,
    'system:mandate-verification',
    verificationStage.label,
    sessionId,
  );

  // Run verification
  const report = await verifyMandates(mandates, workingDir);

  // Store report as artifact
  const artifact = createStageArtifact({
    pipelineId: pipeline.pipelineId,
    stageId: verificationStage.stageId,
    type: ArtifactType.MANDATE_VERIFICATION,
    content: JSON.stringify(report, null, 2),
    createdBy: 'system:mandate-verification',
    metadata: {
      sourceStageId: completedStage.stageId,
      sourceTopology: completedStage.topologyId,
      totalMandates: report.totalCount,
      resolved: report.resolvedCount,
      unresolved: report.unresolvedCount,
      manual: report.manualCount,
    },
  });

  pipeline.artifacts.push(artifact);
  verificationStage.artifactIds.push(artifact.artifactId);

  // Build readable output
  const lines = ['# Mandate Verification Report', ''];
  for (const m of report.mandates) {
    const icon = m.status === 'verified' ? 'PASS' : m.status === 'unresolved' ? 'FAIL' : 'MANUAL';
    lines.push(`[${icon}] ${m.index}. ${m.text}`);
    for (const check of m.checks) {
      lines.push(`      ${check.passed ? '+' : '-'} ${check.type}: ${check.target} — ${check.detail}`);
    }
    lines.push('');
  }
  lines.push(`Result: ${report.passed ? 'PASSED' : 'BLOCKED'} — ${report.resolvedCount}/${report.totalCount} verified, ${report.unresolvedCount} unresolved, ${report.manualCount} manual`);

  verificationStage.output = {
    rawOutput: lines.join('\n'),
    tokenUsage: 0,
  };

  // Complete the verification stage
  verificationStage.status = report.passed ? PipelineStatus.COMPLETED : PipelineStatus.FAILED;
  verificationStage.completedAt = new Date().toISOString();

  emitPipelineStageComplete(verificationStage.stageId, [artifact], sessionId);

  return report;
}

export default {
  parseMandates,
  verifyMandates,
  runVerificationCheckpoint,
};
