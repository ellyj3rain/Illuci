/**
 * illuci — Context Manager
 *
 * Builds model-specific views of the project context.
 * Every model has a different context window. The manager knows
 * the limits and constructs the best possible view for each model:
 *
 *   1. Identity — who the model is, what it's good/bad at
 *   2. Project context — relevant artifacts, recent history
 *   3. Task context — the current prompt + any related artifacts
 *
 * Models with large windows get rich history. Models with small
 * windows get compressed snapshots + the most recent messages.
 * Every model gets the same information density, scaled to its capacity.
 *
 * The manager also handles writing back — when a model produces
 * output, it's attributed and stored in the context store.
 */

import * as store from "./store.js";
import { getContextLimit, estimateTokens as tokenEstimate } from "./tokens.js";

/**
 * Get the context window size for a model.
 * Delegates to centralized token service.
 */
export function getContextWindow(modelId) {
  return getContextLimit(modelId);
}

// ─── CONTEXT VIEW BUILDER ───

/**
 * Build a context view for a model within a project.
 * This is what actually gets sent to the bridge as the prompt prefix.
 *
 * @param {string} projectId — the project the model is working in
 * @param {string} modelId — the model receiving the context
 * @param {object} options
 * @param {string} options.task — the current task/prompt
 * @param {string[]} options.relevantArtifacts — artifact names to include
 * @param {number} options.historyDepth — max recent messages to include
 * @param {boolean} options.includeIdentity — include model's self-assessment
 * @param {boolean} options.includePeers — include perception of peers in this run
 * @returns {object} { systemContext, messages, tokenBudgetRemaining }
 */
export function buildView(projectId, modelId, options = {}) {
  // If skipContext is true, return a minimal context
  if (options.skipContext) {
    return {
      systemContext: null,
      artifactContext: null,
      messages: [],
      tokensUsed: 0,
      tokenBudgetRemaining: getContextWindow(modelId), // Assuming full budget is available
      windowSize: getContextWindow(modelId),
    };
  }

  const windowSize = getContextWindow(modelId);
  let tokensUsed = 0;
  const sections = [];

  // ─── 1. IDENTITY (who you are) ───
  if (options.includeIdentity !== false) {
    const self = store.getSelfAssessment(modelId);
    if (self) {
      const identityBlock = formatIdentity(modelId, self);
      const identityTokens = estimateTokens(identityBlock);
      if (tokensUsed + identityTokens < windowSize * 0.1) { // max 10% of window
        sections.push({ type: "identity", content: identityBlock, tokens: identityTokens });
        tokensUsed += identityTokens;
      }
    }
  }

  // ─── 2. PEER AWARENESS (who you're working with) ───
  if (options.includePeers && options.peerIds) {
    const peerBlock = formatPeerAwareness(modelId, options.peerIds);
    if (peerBlock) {
      const peerTokens = estimateTokens(peerBlock);
      if (tokensUsed + peerTokens < windowSize * 0.1) {
        sections.push({ type: "peers", content: peerBlock, tokens: peerTokens });
        tokensUsed += peerTokens;
      }
    }
  }

  // ─── 3. RELEVANT ARTIFACTS (the work product) ───
  if (options.relevantArtifacts?.length > 0) {
    const artifactBudget = windowSize * 0.4; // max 40% for artifacts
    let artifactTokens = 0;

    for (const name of options.relevantArtifacts) {
      const artifact = store.readArtifact(projectId, name);
      if (!artifact) continue;

      const content = artifact.summary || artifact.content;
      const tokens = estimateTokens(content);

      if (artifactTokens + tokens > artifactBudget) {
        // Use summary if available, otherwise truncate
        if (artifact.summary && artifact.summary !== content) {
          const summaryTokens = estimateTokens(artifact.summary);
          if (artifactTokens + summaryTokens <= artifactBudget) {
            sections.push({
              type: "artifact",
              content: `[Artifact: ${artifact.name} v${artifact.version} by ${artifact.author}]\n${artifact.summary}`,
              tokens: summaryTokens,
            });
            artifactTokens += summaryTokens;
          }
        }
        continue;
      }

      sections.push({
        type: "artifact",
        content: `[Artifact: ${artifact.name} v${artifact.version} by ${artifact.author}]\n${content}`,
        tokens,
      });
      artifactTokens += tokens;
    }
    tokensUsed += artifactTokens;
  }

  // ─── 4. MESSAGE HISTORY (what happened recently) ───
  const historyBudget = windowSize - tokensUsed - (options.taskTokens || 2000);
  const historyMessages = [];

  if (historyBudget > 0) {
    // First, check for snapshots
    const snapshots = store.getSnapshots(projectId);
    let snapshotTokens = 0;

    if (snapshots.length > 0 && historyBudget > 2000) {
      // Use the most recent snapshot as compressed history
      const snap = snapshots[0];
      snapshotTokens = snap.token_count;
      if (snapshotTokens < historyBudget * 0.3) {
        sections.push({
          type: "snapshot",
          content: `[Context Summary — covers messages ${snap.covers_from}-${snap.covers_to}]\n${snap.summary}`,
          tokens: snapshotTokens,
        });
        tokensUsed += snapshotTokens;
      }
    }

    // Fill remaining budget with recent messages (chronological)
    const recentBudget = historyBudget - snapshotTokens;
    if (recentBudget > 500) {
      const depth = options.historyDepth || 100;
      const recent = store.getMessages(projectId, { limit: depth, order: "desc" });

      let accumulated = 0;
      for (const msg of recent) {
        if (accumulated + msg.tokenCount > recentBudget) break;
        historyMessages.unshift(msg); // reverse to chronological
        accumulated += msg.tokenCount;
      }
      tokensUsed += accumulated;
    }
  }

  // ─── BUILD FINAL VIEW ───
  const systemContext = sections
    .filter(s => s.type !== "artifact") // artifacts go in the message flow
    .map(s => s.content)
    .join("\n\n---\n\n");

  const artifactContext = sections
    .filter(s => s.type === "artifact")
    .map(s => s.content)
    .join("\n\n");

  return {
    systemContext: systemContext || null,
    artifactContext: artifactContext || null,
    messages: historyMessages,
    tokensUsed,
    tokenBudgetRemaining: windowSize - tokensUsed,
    windowSize,
  };
}

// ─── WRITE BACK ───

/**
 * Record a model's output in the context store.
 * Called by the bridge after every model response.
 */
export function recordOutput(projectId, modelId, output, metadata = {}) {
  // Store the message
  store.appendMessage(projectId, {
    role: "assistant",
    modelId,
    content: output,
    metadata,
  });

  // If the output contains a named artifact, store it
  if (metadata.artifactName) {
    store.writeArtifact(projectId, {
      name: metadata.artifactName,
      type: metadata.artifactType || "output",
      content: output,
      author: modelId,
      metadata,
    });
  }
}

/**
 * Record an operator directive.
 */
export function recordDirective(projectId, content, metadata = {}) {
  store.appendMessage(projectId, {
    role: "operator",
    content,
    metadata,
  });
}

/**
 * Record a tool result.
 */
export function recordToolResult(projectId, modelId, toolName, result, metadata = {}) {
  store.appendMessage(projectId, {
    role: "tool",
    modelId,
    content: `[${toolName}] ${typeof result === "string" ? result : JSON.stringify(result)}`,
    metadata: { ...metadata, tool: toolName },
  });
}

// ─── SNAPSHOT MANAGEMENT ───

/**
 * Check if a project's history needs compression for a given model.
 * Returns true if total message tokens exceed the model's window.
 */
export function needsCompression(projectId, modelId) {
  const totalTokens = store.messageTokens(projectId);
  const window = getContextWindow(modelId);
  return totalTokens > window * 0.7; // compress when history hits 70% of smallest consumer
}

/**
 * Compress old messages into a snapshot.
 * This should be called with a summarizer model — typically the
 * cheapest/fastest model available (Ollama/DeepSeek).
 *
 * @param {string} projectId
 * @param {string} summary — the compressed text (generated externally)
 * @param {number} fromId — first message ID covered
 * @param {number} toId — last message ID covered
 * @param {string} createdBy — model that generated the summary
 */
export function compress(projectId, summary, fromId, toId, createdBy) {
  store.saveSnapshot(projectId, {
    summary,
    coversFrom: fromId,
    coversTo: toId,
    createdBy,
  });
}

/**
 * Compress context if message count exceeds threshold.
 * Uses a raw bridge call (bypasses queryModel) to prevent recursion.
 *
 * Guards:
 *   1. Re-entrancy — one compression per project at a time
 *   2. Skip flag — options.skipCompression disables
 *   3. Truncation — never prune below MIN_RETAIN messages
 *   4. Raw bridge — direct bridge.query(), no governance/dispatch loop
 *
 * @param {string} projectId
 * @param {object} options
 * @param {boolean} options.skipCompression — disable compression
 * @returns {Promise<boolean>} true if compression occurred
 */
const COMPRESSING = new Set();
const COMPRESSION_THRESHOLD = 50; // messages
const MIN_RETAIN_MESSAGES = 5;
const SUMMARIZER_MODEL_ID = "deepseek"; // cheap, fast

export async function maybeCompress(projectId, options = {}) {
  if (options.skipCompression) return false;
  if (COMPRESSING.has(projectId)) return false;

  const count = store.getMessageCount(projectId);
  if (count < COMPRESSION_THRESHOLD) return false;

  COMPRESSING.add(projectId);
  try {
    const compressCount = Math.min(
      Math.floor(count * 0.8),
      count - MIN_RETAIN_MESSAGES
    );
    if (compressCount <= 0) return false;

    const oldMessages = store.getMessages(projectId, {
      limit: compressCount,
      order: "asc",
    });

    if (oldMessages.length === 0) return false;

    // Raw bridge call — bypasses dispatch/governance to prevent recursion
    const { getBridge } = await import("../bridges/index.js");
    const bridge = await getBridge(SUMMARIZER_MODEL_ID);

    const messageText = oldMessages.map(m => {
      const tag = m.modelId ? `${m.role}:${m.modelId}` : m.role;
      return `[${tag}] ${m.content}`;
    }).join("\n\n");

    const result = await bridge.query(
      `Summarize these messages into key decisions, context, and outcomes. Be concise.\n\n${messageText}`,
      { raw: true, maxTokens: 2000 }
    );

    if (!result?.response) return false;

    // Save snapshot before pruning
    store.saveSnapshot(projectId, {
      summary: result.response,
      coversFrom: oldMessages[0].id,
      coversTo: oldMessages[oldMessages.length - 1].id,
      createdBy: SUMMARIZER_MODEL_ID,
    });

    // Prune compressed messages
    store.pruneMessages(
      projectId,
      oldMessages.map(m => m.id)
    );

    return true;
  } catch {
    return false;
  } finally {
    COMPRESSING.delete(projectId);
  }
}

// ─── FORMATTERS ───

function formatIdentity(modelId, selfAssessment) {
  const content = selfAssessment.content;
  const lines = [`[Identity: ${modelId}]`];

  if (content.strengths) {
    lines.push("Strengths: " + (Array.isArray(content.strengths) ? content.strengths.join(", ") : content.strengths));
  }
  if (content.weaknesses) {
    lines.push("Weaknesses: " + (Array.isArray(content.weaknesses) ? content.weaknesses.join(", ") : content.weaknesses));
  }
  if (content.avoidTasks) {
    lines.push("Avoid: " + (Array.isArray(content.avoidTasks) ? content.avoidTasks.join(", ") : content.avoidTasks));
  }

  return lines.join("\n");
}

function formatPeerAwareness(modelId, peerIds) {
  const lines = ["[Peer Awareness]"];
  let hasPeers = false;

  for (const peerId of peerIds) {
    if (peerId === modelId) continue;
    const perception = store.getPerception(modelId, peerId, "peer");
    if (!perception) continue;
    hasPeers = true;

    const content = perception.content;
    const strengths = content.strengths ? (Array.isArray(content.strengths) ? content.strengths.join(", ") : content.strengths) : "unknown";
    const weaknesses = content.weaknesses ? (Array.isArray(content.weaknesses) ? content.weaknesses.join(", ") : content.weaknesses) : "unknown";
    lines.push(`${peerId}: strengths=[${strengths}] weaknesses=[${weaknesses}]`);
  }

  return hasPeers ? lines.join("\n") : null;
}

function estimateTokens(text = "") {
  return tokenEstimate(text);
}

export default {
  getContextWindow, buildView,
  recordOutput, recordDirective, recordToolResult,
  needsCompression, compress, maybeCompress,
};
