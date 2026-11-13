import * as telemetryStore from './store.js';

// Cache for aggregated results to avoid re-computing on rapid calls
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getCachedResult(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.value;
  }
  return null;
}

function setCacheResult(key, value) {
  cache.set(key, { value, timestamp: Date.now() });
}

/**
 * Helper to calculate percentiles from an array of numbers.
 * @param {number[]} data - Array of numbers.
 * @param {number[]} percentiles - Array of percentiles to calculate (e.g., [50, 95, 99]).
 * @returns {object} An object with percentile values.
 */
function calculatePercentiles(data, percentiles) {
  if (data.length === 0) {
    return percentiles.reduce((acc, p) => ({ ...acc, [`p${p}`]: null }), {});
  }
  data.sort((a, b) => a - b);
  const result = {};
  for (const p of percentiles) {
    const index = Math.ceil(data.length * p / 100) - 1;
    result[`p${p}`] = data[Math.max(0, index)];
  }
  return result;
}

/**
 * Aggregates run success/failure rates.
 * @param {object} filters - Filters to apply (e.g., project_id, since).
 * @param {number} [days=7] - Number of days to aggregate data for.
 * @returns {object} Success/failure counts and rates.
 */
export function getRunStatusMetrics(filters = {}, days = 7) {
  const cacheKey = `runStatus-${JSON.stringify(filters)}-${days}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const runEvents = telemetryStore.getEvents({
    ...filters,
    event_type: "topology_complete",
    since,
  });

  const runStatus = {
    totalRuns: runEvents.length,
    successfulRuns: 0,
    failedRuns: 0,
    haltedRuns: 0,
    successRate: 0,
    failureRate: 0,
    haltRate: 0,
  };

  for (const event of runEvents) {
    if (event.payload.halted) {
      runStatus.haltedRuns++;
    } else if (event.payload.totalLatency > 0) { // Assuming successful if not halted and has latency
      runStatus.successfulRuns++;
    } else {
      runStatus.failedRuns++; // Should capture errors in topology_complete payload for more precision
    }
  }

  if (runStatus.totalRuns > 0) {
    runStatus.successRate = (runStatus.successfulRuns / runStatus.totalRuns) * 100;
    runStatus.failureRate = (runStatus.failedRuns / runStatus.totalRuns) * 100;
    runStatus.haltRate = (runStatus.haltedRuns / runStatus.totalRuns) * 100;
  }

  setCacheResult(cacheKey, runStatus);
  return runStatus;
}

/**
 * Aggregates model response latencies.
 * @param {object} filters - Filters to apply (e.g., project_id, since).
 * @returns {object} Per-model p50/p95/p99 latencies.
 */
export function getModelLatencyMetrics(filters = {}) {
  const cacheKey = `modelLatency-${JSON.stringify(filters)}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const responseEvents = telemetryStore.getEvents({
    ...filters,
    event_type: "model_response",
  });

  const modelLatencies = {}; // { model_id: [latency1, latency2, ...]}

  for (const event of responseEvents) {
    const modelId = event.model_id;
    const latency = event.payload.latency;
    if (modelId && typeof latency === 'number') {
      if (!modelLatencies[modelId]) {
        modelLatencies[modelId] = [];
      }
      modelLatencies[modelId].push(latency);
    }
  }

  const result = {};
  for (const modelId in modelLatencies) {
    result[modelId] = calculatePercentiles(modelLatencies[modelId], [50, 95, 99]);
  }

  setCacheResult(cacheKey, result);
  return result;
}

/**
 * Aggregates model error rates.
 * @param {object} filters - Filters to apply (e.g., project_id, since).
 * @returns {object} Per-model error counts and rates.
 */
export function getModelErrorMetrics(filters = {}) {
  const cacheKey = `modelError-${JSON.stringify(filters)}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const responseEvents = telemetryStore.getEvents({
    ...filters,
    event_type: "model_response",
  });

  const modelErrors = {}; // { model_id: { total: 0, errors: 0, errorTypes: { type: count }}}

  for (const event of responseEvents) {
    const modelId = event.model_id;
    if (modelId) {
      if (!modelErrors[modelId]) {
        modelErrors[modelId] = { total: 0, errors: 0, errorTypes: {} };
      }
      modelErrors[modelId].total++;
      if (event.payload.error) {
        modelErrors[modelId].errors++;
        const errorType = event.payload.error.substring(0, 50); // Truncate error messages for type
        if (!modelErrors[modelId].errorTypes[errorType]) {
          modelErrors[modelId].errorTypes[errorType] = 0;
        }
        modelErrors[modelId].errorTypes[errorType]++;
      }
    }
  }

  const result = {};
  for (const modelId in modelErrors) {
    const data = modelErrors[modelId];
    result[modelId] = {
      totalResponses: data.total,
      errorCount: data.errors,
      errorRate: data.total > 0 ? (data.errors / data.total) * 100 : 0,
      errorTypes: data.errorTypes,
    };
  }

  setCacheResult(cacheKey, result);
  return result;
}

/**
 * Aggregates token usage and estimated cost.
 * @param {object} filters - Filters to apply (e.g., project_id, since).
 * @returns {object} Total tokens and estimated cost.
 */
export function getTokenCostMetrics(filters = {}) {
  const cacheKey = `tokenCost-${JSON.stringify(filters)}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const tokenEvents = telemetryStore.getEvents({
    ...filters,
    event_type: "model_response",
  });

  const modelPricing = {
    // Placeholder pricing per 1k tokens. This would ideally come from a config.
    "default": { input: 0.001, output: 0.002 },
    "deepseek": { input: 0.0001, output: 0.0002 },
    "claude-local": { input: 0.0005, output: 0.0015 },
    "codex-local": { input: 0.002, output: 0.003 },
    "gemini-local": { input: 0.0008, output: 0.0016 },
    "grok": { input: 0.0003, output: 0.0006 },
    "kimi-local": { input: 0.0002, output: 0.0004 },
    "ollama": { input: 0.0, output: 0.0 }, // Local models can be free
  };

  let totalTokens = 0;
  let estimatedCost = 0;
  const tokensByModel = {}; // { model_id: { input: 0, output: 0, total: 0, cost: 0 }}

  for (const event of tokenEvents) {
    const modelId = event.model_id || "default";
    const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    const promptTokens = payload.prompt_tokens || 0;
    const completionTokens = payload.completion_tokens || 0;
    const currentTotalTokens = payload.total_tokens || (promptTokens + completionTokens);

    totalTokens += currentTotalTokens;

    if (!tokensByModel[modelId]) {
      tokensByModel[modelId] = { input: 0, output: 0, total: 0, cost: 0 };
    }
    tokensByModel[modelId].input += promptTokens;
    tokensByModel[modelId].output += completionTokens;
    tokensByModel[modelId].total += currentTotalTokens;

    const pricing = modelPricing[modelId] || modelPricing["default"];
    const modelCost = (promptTokens / 1000 * pricing.input) + (completionTokens / 1000 * pricing.output);
    tokensByModel[modelId].cost += modelCost;
    estimatedCost += modelCost;
  }

  const result = {
    totalTokens,
    estimatedCost,
    tokensByModel,
  };

  setCacheResult(cacheKey, result);
  return result;
}

/**
 * Aggregates gate halt rates and reasons.
 * @param {object} filters - Filters to apply (e.g., project_id, since).
 * @returns {object} Gate halt counts, rates, and reasons.
 */
export function getGateMetrics(filters = {}) {
  const cacheKey = `gateMetrics-${JSON.stringify(filters)}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const gateEvents = telemetryStore.getEvents({
    ...filters,
    event_type: "gate_halt",
  });

  const gateHalts = {
    totalHalts: gateEvents.length,
    reasons: {}, // { reason: count }
  };

  for (const event of gateEvents) {
    const reason = event.payload.reason || "unknown";
    if (!gateHalts.reasons[reason]) {
      gateHalts.reasons[reason] = 0;
    }
    gateHalts.reasons[reason]++;
  }

  setCacheResult(cacheKey, gateHalts);
  return gateHalts;
}

/**
 * Retrieves tool execution events for audit.
 * @param {object} filters - Filters to apply (e.g., run_id, tool_name).
 * @returns {Array<object>} List of tool execution events.
 */
export function getToolExecutionAudit(filters = {}) {
  const cacheKey = `toolAudit-${JSON.stringify(filters)}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const toolEvents = telemetryStore.getEvents({
    ...filters,
    event_type: "tool_execution",
  });

  setCacheResult(cacheKey, toolEvents);
  return toolEvents;
}

/**
 * Retrieves PR creation events for audit.
 * @param {object} filters - Filters to apply (e.g., run_id).
 * @returns {Array<object>} List of PR creation events.
 */
export function getPRCreationAudit(filters = {}) {
  const cacheKey = `prAudit-${JSON.stringify(filters)}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const prEvents = telemetryStore.getEvents({
    ...filters,
    event_type: "pr_created",
  });

  setCacheResult(cacheKey, prEvents);
  return prEvents;
}

export default {
  getRunStatusMetrics,
  getModelLatencyMetrics,
  getModelErrorMetrics,
  getTokenCostMetrics,
  getGateMetrics,
  getToolExecutionAudit,
  getPRCreationAudit,
  // Add more aggregation functions as needed for other metrics
};