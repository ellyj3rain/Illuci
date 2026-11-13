/**
 * illuci — VCS Dashboard / Git Ledger Manager
 *
 * Maintains a structured JSON ledger per pipeline that tracks all VCS events
 * across sandboxed git worktrees: branch creation, commits, PR opens, reviews,
 * merges, rejections. Replaces raw stdout piping from concurrent sandboxes
 * with structured Git state tracking.
 *
 * Each AI agent works on its own branch, creates PRs, gets reviewed, and
 * merges through governance. This module is the single source of truth for
 * that lifecycle.
 *
 * Attribution: all foundational concepts operator-originated.
 *
 * @module core/dashboard/git-manager
 */

import { emit } from "../events/emitter.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

/** @type {Map<string, Ledger>} pipelineId → ledger */
const ledgers = new Map();

/**
 * @typedef {Object} LedgerEvent
 * @property {string} type - One of: branch_created, commit, pr_opened, review, merge, rejection
 * @property {string} [agent] - Model/agent identifier
 * @property {string} [seat] - Seat assignment (implementer, reviewer, etc.)
 * @property {string} [branch] - Branch name
 * @property {string} [target] - Merge target branch
 * @property {string} [title] - PR title
 * @property {string} [message] - Commit message
 * @property {string[]} [files] - Affected files
 * @property {string} [hash] - Git commit hash
 * @property {string} [diff_summary] - Diff summary string
 * @property {string} [verdict] - Review verdict (approved, changes_requested, etc.)
 * @property {string[]} [comments] - Review comments
 * @property {string} [merged_by] - Entity that performed the merge
 * @property {string} [pr] - PR branch reference
 * @property {string} [reason] - Rejection reason
 * @property {string} timestamp - ISO timestamp
 */

/**
 * @typedef {Object} Ledger
 * @property {string} pipelineId
 * @property {string} createdAt - ISO timestamp
 * @property {LedgerEvent[]} events
 */

const VALID_EVENT_TYPES = new Set([
  "branch_created",
  "commit",
  "pr_opened",
  "review",
  "merge",
  "rejection",
]);

// ─── Persistence helpers ───

/**
 * Returns the EFS ledger directory if ILLUCI_EFS_MOUNT is configured.
 * @returns {string|null}
 */
function efsLedgerDir() {
  const mount = process.env.ILLUCI_EFS_MOUNT;
  if (!mount) return null;
  const dir = join(mount, "ledgers");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Persist a ledger to EFS if configured.
 * @param {Ledger} ledger
 */
function persistToEfs(ledger) {
  const dir = efsLedgerDir();
  if (!dir) return;
  try {
    writeFileSync(
      join(dir, `${ledger.pipelineId}.json`),
      JSON.stringify(ledger, null, 2),
      "utf-8"
    );
  } catch (err) {
    emit({
      time: Date.now(),
      type: "vcs_ledger_error",
      payload: {
        pipelineId: ledger.pipelineId,
        action: "efs_persist",
        error: err.message,
      },
    });
  }
}

/**
 * Try to load a ledger from EFS (cold restore).
 * @param {string} pipelineId
 * @returns {Ledger|null}
 */
function loadFromEfs(pipelineId) {
  const dir = efsLedgerDir();
  if (!dir) return null;
  const filePath = join(dir, `${pipelineId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// ─── GitHub API helpers ───

const GITHUB_API = "https://api.github.com";

/**
 * Parse "owner/repo" into components.
 * @param {string} remoteRepo
 * @returns {{ owner: string, repo: string }}
 */
function parseRepo(remoteRepo) {
  const parts = remoteRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid remoteRepo format: "${remoteRepo}". Expected "owner/repo".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Make an authenticated GitHub API request.
 * @param {string} method
 * @param {string} path - Relative to GITHUB_API
 * @param {string} token
 * @param {Object} [body]
 * @returns {Promise<Object>}
 */
async function ghFetch(method, path, token, body = null) {
  const opts = {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${GITHUB_API}${path}`, opts);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json.message || resp.statusText;
    throw new Error(`GitHub API ${method} ${path} → ${resp.status}: ${msg}`);
  }
  return json;
}

// ─── Public API ───

/**
 * Initialize a new ledger for a pipeline run.
 * If a ledger already exists in EFS, it is restored from disk.
 *
 * @param {string} pipelineId - Unique pipeline identifier
 * @returns {Ledger} The created (or restored) ledger
 */
export function createLedger(pipelineId) {
  if (!pipelineId) throw new Error("createLedger requires a pipelineId");

  // Check for existing in-memory ledger
  if (ledgers.has(pipelineId)) {
    return ledgers.get(pipelineId);
  }

  // Try cold restore from EFS
  const restored = loadFromEfs(pipelineId);
  if (restored) {
    ledgers.set(pipelineId, restored);
    return restored;
  }

  const ledger = {
    pipelineId,
    createdAt: new Date().toISOString(),
    events: [],
  };

  ledgers.set(pipelineId, ledger);
  persistToEfs(ledger);

  emit({
    time: Date.now(),
    type: "vcs_ledger_created",
    payload: { pipelineId },
  });

  return ledger;
}

/**
 * Return the full ledger for a pipeline.
 * Falls back to EFS if not in memory.
 *
 * @param {string} pipelineId
 * @returns {Ledger|null} The ledger, or null if not found
 */
export function getLedger(pipelineId) {
  if (ledgers.has(pipelineId)) {
    return ledgers.get(pipelineId);
  }

  // Try EFS fallback
  const restored = loadFromEfs(pipelineId);
  if (restored) {
    ledgers.set(pipelineId, restored);
    return restored;
  }

  return null;
}

/**
 * Append a VCS event to the ledger.
 * Validates event type before appending. Persists to EFS if configured.
 *
 * @param {string} pipelineId
 * @param {Partial<LedgerEvent>} event - Must include at least `type`
 * @returns {LedgerEvent} The stamped event that was appended
 */
export function appendEvent(pipelineId, event) {
  if (!pipelineId) throw new Error("appendEvent requires a pipelineId");
  if (!event || !event.type) throw new Error("appendEvent requires an event with a type");
  if (!VALID_EVENT_TYPES.has(event.type)) {
    throw new Error(`Unknown VCS event type: "${event.type}". Valid: ${[...VALID_EVENT_TYPES].join(", ")}`);
  }

  const ledger = getLedger(pipelineId);
  if (!ledger) {
    throw new Error(`No ledger found for pipeline "${pipelineId}". Call createLedger first.`);
  }

  const stamped = {
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  };

  ledger.events.push(stamped);
  persistToEfs(ledger);

  emit({
    time: Date.now(),
    type: "vcs_event",
    payload: { pipelineId, event: stamped },
  });

  return stamped;
}

/**
 * Push internal sandbox state to a real GitHub repo via the GitHub REST API.
 * Replays ledger events as real GitHub operations: branch creation, file commits,
 * PR creation, reviews, and merges.
 *
 * @param {Ledger} ledger - The ledger to sync
 * @param {string} remoteRepo - "owner/repo" format
 * @param {string} token - GitHub personal access token or fine-grained token
 * @returns {Promise<Object>} Summary of sync operations performed
 */
export async function syncToGitHub(ledger, remoteRepo, token) {
  if (!ledger) throw new Error("syncToGitHub requires a ledger");
  if (!remoteRepo) throw new Error("syncToGitHub requires a remoteRepo (owner/repo)");
  if (!token) throw new Error("syncToGitHub requires a GitHub token");

  const { owner, repo } = parseRepo(remoteRepo);
  const results = {
    branches: [],
    commits: [],
    prs: [],
    reviews: [],
    merges: [],
    errors: [],
  };

  // Track PR numbers we create so reviews/merges can reference them
  const branchToPr = new Map();

  for (const event of ledger.events) {
    try {
      switch (event.type) {
        case "branch_created": {
          // Get the default branch SHA to branch from
          const ref = await ghFetch("GET", `/repos/${owner}/${repo}/git/ref/heads/main`, token);
          const sha = ref.object.sha;

          await ghFetch("POST", `/repos/${owner}/${repo}/git/refs`, token, {
            ref: `refs/heads/${event.branch}`,
            sha,
          });
          results.branches.push(event.branch);
          break;
        }

        case "commit": {
          // Push files via the contents API (single-file commits)
          for (const filePath of (event.files || [])) {
            // Check if file exists to get its SHA for updates
            let existingSha = null;
            try {
              const existing = await ghFetch(
                "GET",
                `/repos/${owner}/${repo}/contents/${filePath}?ref=${event.branch}`,
                token
              );
              existingSha = existing.sha;
            } catch {
              // File doesn't exist yet — that's fine
            }

            const body = {
              message: event.message || "Commit from Illuci pipeline",
              branch: event.branch,
              // Content must be base64-encoded; we send a placeholder since
              // actual file content lives in the sandbox, not the ledger.
              content: Buffer.from(
                `// Synced from Illuci pipeline\n// Agent: ${event.agent || "unknown"}\n// Original hash: ${event.hash || "n/a"}\n`
              ).toString("base64"),
            };
            if (existingSha) body.sha = existingSha;

            await ghFetch("PUT", `/repos/${owner}/${repo}/contents/${filePath}`, token, body);
          }
          results.commits.push({ branch: event.branch, hash: event.hash });
          break;
        }

        case "pr_opened": {
          const pr = await ghFetch("POST", `/repos/${owner}/${repo}/pulls`, token, {
            title: event.title || `Illuci PR: ${event.branch}`,
            head: event.branch,
            base: event.target || "main",
            body: [
              `**Agent:** ${event.agent || "unknown"}`,
              `**Diff:** ${event.diff_summary || "n/a"}`,
              `**Pipeline:** ${ledger.pipelineId}`,
              "",
              "_Created by Illuci VCS Dashboard_",
            ].join("\n"),
          });
          branchToPr.set(event.branch, pr.number);
          results.prs.push({ branch: event.branch, number: pr.number });
          break;
        }

        case "review": {
          const prNumber = branchToPr.get(event.pr);
          if (!prNumber) {
            results.errors.push({
              event: event.type,
              message: `No PR number found for branch "${event.pr}". PR must be opened first.`,
            });
            break;
          }

          const ghEvent = event.verdict === "approved" ? "APPROVE"
            : event.verdict === "changes_requested" ? "REQUEST_CHANGES"
            : "COMMENT";

          await ghFetch("POST", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, token, {
            event: ghEvent,
            body: Array.isArray(event.comments)
              ? event.comments.join("\n\n")
              : `Review by ${event.agent || "unknown"} (${event.seat || "reviewer"}): ${event.verdict}`,
          });
          results.reviews.push({ pr: event.pr, verdict: event.verdict });
          break;
        }

        case "merge": {
          const prNum = branchToPr.get(event.pr);
          if (!prNum) {
            results.errors.push({
              event: event.type,
              message: `No PR number found for branch "${event.pr}". PR must be opened first.`,
            });
            break;
          }

          await ghFetch("PUT", `/repos/${owner}/${repo}/pulls/${prNum}/merge`, token, {
            merge_method: "squash",
            commit_message: `Merged by ${event.merged_by || "governance-gate"} — Illuci pipeline ${ledger.pipelineId}`,
          });
          results.merges.push({ pr: event.pr, number: prNum });
          break;
        }

        case "rejection": {
          // Rejections are recorded as review comments — no merge
          const rejPr = branchToPr.get(event.pr);
          if (rejPr) {
            await ghFetch("POST", `/repos/${owner}/${repo}/pulls/${rejPr}/reviews`, token, {
              event: "REQUEST_CHANGES",
              body: `**Rejected** by ${event.agent || "unknown"} (${event.seat || "reviewer"})\n\n${event.reason || "No reason provided"}`,
            });
            results.reviews.push({ pr: event.pr, verdict: "rejected" });
          }
          break;
        }
      }
    } catch (err) {
      results.errors.push({
        event: event.type,
        branch: event.branch || event.pr,
        message: err.message,
      });
    }
  }

  emit({
    time: Date.now(),
    type: "vcs_sync_complete",
    payload: {
      pipelineId: ledger.pipelineId,
      remoteRepo,
      branches: results.branches.length,
      commits: results.commits.length,
      prs: results.prs.length,
      reviews: results.reviews.length,
      merges: results.merges.length,
      errors: results.errors.length,
    },
  });

  return results;
}

/**
 * Returns events structured for CLI/frontend display of the MAW lifecycle.
 * Groups events by branch/PR and annotates with status indicators.
 *
 * @param {string} pipelineId
 * @returns {Object} Structured audit trail
 */
export function getAuditTrail(pipelineId) {
  const ledger = getLedger(pipelineId);
  if (!ledger) {
    throw new Error(`No ledger found for pipeline "${pipelineId}".`);
  }

  // Group events by branch
  const branches = new Map();

  for (const event of ledger.events) {
    const key = event.branch || event.pr || "_pipeline";
    if (!branches.has(key)) {
      branches.set(key, {
        branch: key,
        agent: null,
        seat: null,
        status: "active",
        events: [],
      });
    }
    const group = branches.get(key);
    group.events.push(event);

    if (event.agent && !group.agent) group.agent = event.agent;
    if (event.seat && !group.seat) group.seat = event.seat;

    // Derive status from terminal events
    if (event.type === "merge") group.status = "merged";
    if (event.type === "rejection") group.status = "rejected";
  }

  // Build timeline (flat, chronological)
  const timeline = ledger.events.map((event) => {
    const labels = {
      branch_created: `Branch created: ${event.branch} by ${event.agent} (${event.seat})`,
      commit: `Commit ${event.hash || "?"}: ${event.message || "no message"} on ${event.branch}`,
      pr_opened: `PR opened: ${event.title || event.branch} → ${event.target || "main"}`,
      review: `Review by ${event.agent} (${event.seat}): ${event.verdict}`,
      merge: `Merged: ${event.pr} by ${event.merged_by}`,
      rejection: `Rejected: ${event.pr} — ${event.reason || "no reason"}`,
    };
    return {
      timestamp: event.timestamp,
      type: event.type,
      label: labels[event.type] || `${event.type}: ${JSON.stringify(event)}`,
      raw: event,
    };
  });

  return {
    pipelineId: ledger.pipelineId,
    createdAt: ledger.createdAt,
    totalEvents: ledger.events.length,
    branches: Object.fromEntries(branches),
    timeline,
    summary: {
      branchCount: [...branches.values()].filter((b) => b.branch !== "_pipeline").length,
      commitCount: ledger.events.filter((e) => e.type === "commit").length,
      prCount: ledger.events.filter((e) => e.type === "pr_opened").length,
      mergeCount: ledger.events.filter((e) => e.type === "merge").length,
      rejectionCount: ledger.events.filter((e) => e.type === "rejection").length,
    },
  };
}

export default {
  createLedger,
  getLedger,
  appendEvent,
  syncToGitHub,
  getAuditTrail,
};
