/**
 * illuci — Diff Generator
 *
 * Generates unified diffs for the write gate's modification proposals.
 * Pure JS implementation — no external dependencies.
 */

/**
 * Generate a unified diff between two strings.
 *
 * @param {string} original - Original file content
 * @param {string} modified - Proposed new content
 * @param {string} filename - File path for the diff header
 * @returns {string} Unified diff format
 */
export function generateDiff(original, modified, filename = "file") {
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");

  // Simple LCS-based diff
  const lcs = computeLCS(oldLines, newLines);
  const hunks = buildHunks(oldLines, newLines, lcs);

  if (hunks.length === 0) return ""; // No changes

  const header = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
  ];

  const diffLines = [];
  for (const hunk of hunks) {
    diffLines.push(hunk.header);
    diffLines.push(...hunk.lines);
  }

  return [...header, ...diffLines].join("\n");
}

/**
 * Compute Longest Common Subsequence table.
 */
function computeLCS(a, b) {
  const m = a.length;
  const n = b.length;

  // For large files, use a simpler approach
  if (m * n > 10000000) {
    return simpleDiff(a, b);
  }

  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the actual LCS
  const result = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift({ oldIdx: i - 1, newIdx: j - 1, line: a[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Fallback for very large files — line-by-line comparison.
 */
function simpleDiff(a, b) {
  const result = [];
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      result.push({ oldIdx: i, newIdx: j, line: a[i] });
      i++; j++;
    } else {
      // Skip ahead in whichever has more remaining
      if (a.length - i > b.length - j) i++;
      else j++;
    }
  }
  return result;
}

/**
 * Build unified diff hunks from LCS result.
 */
function buildHunks(oldLines, newLines, lcs, context = 3) {
  // Build change map
  const changes = [];
  let oldIdx = 0, newIdx = 0, lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx < lcs.length && oldIdx === lcs[lcsIdx].oldIdx && newIdx === lcs[lcsIdx].newIdx) {
      changes.push({ type: " ", oldIdx, newIdx, line: oldLines[oldIdx] });
      oldIdx++; newIdx++; lcsIdx++;
    } else if (lcsIdx < lcs.length && oldIdx < lcs[lcsIdx].oldIdx) {
      changes.push({ type: "-", oldIdx, newIdx: -1, line: oldLines[oldIdx] });
      oldIdx++;
    } else if (lcsIdx < lcs.length && newIdx < lcs[lcsIdx].newIdx) {
      changes.push({ type: "+", oldIdx: -1, newIdx, line: newLines[newIdx] });
      newIdx++;
    } else if (lcsIdx >= lcs.length && oldIdx < oldLines.length) {
      changes.push({ type: "-", oldIdx, newIdx: -1, line: oldLines[oldIdx] });
      oldIdx++;
    } else if (lcsIdx >= lcs.length && newIdx < newLines.length) {
      changes.push({ type: "+", oldIdx: -1, newIdx, line: newLines[newIdx] });
      newIdx++;
    } else {
      break;
    }
  }

  // Group into hunks with context
  const hunks = [];
  let hunkStart = -1;

  for (let i = 0; i < changes.length; i++) {
    if (changes[i].type !== " ") {
      const start = Math.max(0, i - context);
      const end = Math.min(changes.length - 1, i + context);

      if (hunkStart === -1) {
        hunkStart = start;
      }

      // Extend current hunk or start new one
      const hunkEnd = end;

      // Look ahead to see if next change is within context range
      let nextChange = -1;
      for (let j = i + 1; j < changes.length; j++) {
        if (changes[j].type !== " ") { nextChange = j; break; }
      }

      if (nextChange === -1 || nextChange - i > context * 2) {
        // Emit hunk
        const hunkLines = [];
        let oldStart = -1, newStart = -1, oldCount = 0, newCount = 0;

        for (let j = hunkStart; j <= hunkEnd && j < changes.length; j++) {
          const c = changes[j];
          if (oldStart === -1 && c.oldIdx >= 0) oldStart = c.oldIdx;
          if (newStart === -1 && c.newIdx >= 0) newStart = c.newIdx;

          hunkLines.push(`${c.type}${c.line}`);
          if (c.type === " " || c.type === "-") oldCount++;
          if (c.type === " " || c.type === "+") newCount++;
        }

        hunks.push({
          header: `@@ -${(oldStart || 0) + 1},${oldCount} +${(newStart || 0) + 1},${newCount} @@`,
          lines: hunkLines,
        });

        hunkStart = -1;
      }
    }
  }

  return hunks;
}

/**
 * Quick stats for a diff.
 */
export function diffStats(diffText) {
  if (!diffText) return { additions: 0, deletions: 0, changes: 0 };

  const lines = diffText.split("\n");
  let additions = 0, deletions = 0;

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  return { additions, deletions, changes: additions + deletions };
}

export default { generateDiff, diffStats };
