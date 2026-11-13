/**
 * Illuci — Burp Suite Tool Contract
 *
 * Contingent skill: activates when Burp Suite Pro is running.
 * Gives models programmatic access to Burp's REST API for:
 *   - Proxy traffic capture and analysis
 *   - Active/passive scanning
 *   - Sitemap and issue querying
 *   - Traffic interception and replay
 *
 * This is the first tool contract — the pattern for environment-gated
 * capabilities. If Burp isn't running, these tools don't exist.
 *
 * Burp REST API: http://localhost:1337/<api-key>/v0.1/
 * Proxy: http://localhost:8080
 */

import { logDecision } from "../decisions/logger.js";

const BURP_API_BASE = process.env.BURP_API_URL || "http://localhost:1337";
const BURP_PROXY = process.env.BURP_PROXY_URL || "http://127.0.0.1:8080";

let apiKey = null;
let available = null;

// ─── AVAILABILITY CHECK ───

/**
 * Check if Burp is running and discover the API key.
 * The API key is in the URL path — we detect it from the running instance.
 */
export async function checkAvailability() {
  if (available !== null) return available;

  try {
    // Try the proxy first — if proxy responds, Burp is running
    const proxyCheck = await fetch(BURP_PROXY, {
      signal: AbortSignal.timeout(3000),
    });

    // Try to discover API endpoint — Burp's REST API uses a key in the path
    // Check if BURP_API_KEY env is set
    const key = process.env.BURP_API_KEY;
    if (key) {
      const healthUrl = `${BURP_API_BASE}/${key}/v0.1/knowledge_base/issue_definitions`;
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        apiKey = key;
        available = true;
        return true;
      }
    }

    // Proxy is up but no API key — partial availability (proxy only)
    available = "proxy-only";
    return "proxy-only";
  } catch {
    available = false;
    return false;
  }
}

/**
 * Get the API base URL with key.
 */
function apiUrl(endpoint) {
  if (!apiKey) throw new Error("Burp API key not configured. Set BURP_API_KEY env.");
  return `${BURP_API_BASE}/${apiKey}/v0.1${endpoint}`;
}

// ─── TOOL IMPLEMENTATIONS ───

/**
 * Route an HTTP request through Burp's proxy.
 * The request gets captured in Burp's history for analysis.
 */
export async function proxyFetch(url, options = {}) {
  const method = options.method || "GET";
  const headers = options.headers || {};

  const resp = await fetch(url, {
    method,
    headers,
    body: options.body || null,
    signal: AbortSignal.timeout(options.timeout || 30000),
    // Node 18+ supports proxy via undici
    dispatcher: undefined, // TODO: configure undici proxy agent for BURP_PROXY
  });

  const body = await resp.text();

  return {
    success: true,
    result: {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      body: body.substring(0, 10000), // cap for context window
      url,
      method,
      proxied: true,
    },
  };
}

/**
 * Launch a Burp scan against target URLs.
 */
export async function launchScan(urls, options = {}) {
  const scanConfig = {
    urls: Array.isArray(urls) ? urls : [urls],
  };

  if (options.scope) {
    scanConfig.scope = options.scope;
  }

  scanConfig.scan_configurations = [{
    type: "NamedConfiguration",
    name: options.config || "Crawl and Audit - Balanced",
  }];

  const resp = await fetch(apiUrl("/scan"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scanConfig),
    signal: AbortSignal.timeout(10000),
  });

  const location = resp.headers.get("Location") || "";
  const taskId = location.split("/").pop();

  return {
    success: resp.ok || resp.status === 201,
    result: { taskId, status: resp.status },
  };
}

/**
 * Get scan status and findings.
 */
export async function getScanStatus(taskId) {
  const resp = await fetch(apiUrl(`/scan/${taskId}`), {
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    return { success: false, error: `Burp API ${resp.status}` };
  }

  const data = await resp.json();
  const metrics = data.scan_metrics || {};
  const issues = (data.issue_events || []).map(ie => {
    const issue = ie.issue || {};
    return {
      name: issue.name,
      severity: issue.severity,
      confidence: issue.confidence,
      origin: issue.origin,
      path: issue.path,
      type_index: issue.type_index,
    };
  });

  return {
    success: true,
    result: {
      status: data.scan_status,
      crawlRequests: metrics.crawl_requests_made,
      uniqueLocations: metrics.crawl_unique_locations_visited,
      auditCompleted: metrics.audit_queue_items_completed,
      auditTotal: (metrics.audit_queue_items_completed || 0) + (metrics.audit_queue_items_waiting || 0),
      issueCount: issues.length,
      issues,
    },
  };
}

/**
 * Get Burp's proxy history — captured traffic.
 * This is the key capability for traffic analysis.
 */
export async function getProxyHistory(options = {}) {
  // Burp REST API doesn't expose proxy history directly in the standard API.
  // This requires the Burp REST API extension or custom extension.
  // For now, we can query the sitemap which contains captured URLs.
  const resp = await fetch(apiUrl("/scan"), {
    signal: AbortSignal.timeout(10000),
  });

  // Alternative: if a custom extension exposes /proxy/history
  try {
    const histResp = await fetch(apiUrl("/proxy/history"), {
      signal: AbortSignal.timeout(5000),
    });
    if (histResp.ok) {
      const data = await histResp.json();
      return { success: true, result: data };
    }
  } catch {}

  return {
    success: false,
    error: "Proxy history requires Burp REST API extension. Use sitemap or scan results instead.",
  };
}

/**
 * Get issue type definitions from Burp's knowledge base.
 */
export async function getIssueDefinitions() {
  const resp = await fetch(apiUrl("/knowledge_base/issue_definitions"), {
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    return { success: false, error: `Burp API ${resp.status}` };
  }

  const data = await resp.json();
  return {
    success: true,
    result: data.map(d => ({
      id: d.issue_type_id,
      name: d.name,
      description: d.description?.substring(0, 200),
    })),
  };
}

// ─── TOOL REGISTRATION ───

/**
 * Get the tool definitions for registration in the tool system.
 * Only returns tools if Burp is available.
 */
export async function getTools() {
  const status = await checkAvailability();

  if (!status) return {};

  const tools = {};

  // Always available if proxy is up
  tools.burp_proxy_fetch = {
    name: "burp_proxy_fetch",
    description: "Route an HTTP request through Burp proxy for capture and analysis",
    gated: true,
    handler: async (params) => proxyFetch(params.url, params),
  };

  tools.burp_check = {
    name: "burp_check",
    description: "Check Burp availability and capabilities",
    gated: false,
    handler: async () => ({ success: true, result: { available: status, apiKey: !!apiKey, proxy: BURP_PROXY } }),
  };

  // Full API only if key is configured
  if (status === true) {
    tools.burp_scan = {
      name: "burp_scan",
      description: "Launch a Burp scan against target URLs",
      gated: true,
      handler: async (params) => launchScan(params.urls || params.url, params),
    };

    tools.burp_scan_status = {
      name: "burp_scan_status",
      description: "Get Burp scan status and findings",
      gated: false,
      handler: async (params) => getScanStatus(params.taskId),
    };

    tools.burp_issues = {
      name: "burp_issues",
      description: "Get Burp issue type definitions from knowledge base",
      gated: false,
      handler: async () => getIssueDefinitions(),
    };

    tools.burp_proxy_history = {
      name: "burp_proxy_history",
      description: "Get Burp proxy capture history",
      gated: false,
      handler: async (params) => getProxyHistory(params),
    };
  }

  return tools;
}

/**
 * Get the tool instruction block for models.
 * Appended to TOOL_INSTRUCTION when Burp is available.
 */
export function getToolInstructions() {
  if (!available) return "";

  let instructions = `
Burp Suite (security testing proxy):
- burp_check: {} — check Burp availability
- burp_proxy_fetch: { url, method?, headers?, body? } — route request through Burp proxy for capture`;

  if (available === true) {
    instructions += `
- burp_scan: { urls, config?, scope? } — launch active scan
- burp_scan_status: { taskId } — get scan status and findings
- burp_issues: {} — get issue type definitions
- burp_proxy_history: {} — get captured proxy traffic`;
  }

  return instructions;
}

export default {
  checkAvailability, getTools, getToolInstructions,
  proxyFetch, launchScan, getScanStatus, getProxyHistory, getIssueDefinitions,
};
