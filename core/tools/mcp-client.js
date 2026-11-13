/**
 * illuci/core/tools/mcp-client.js — outbound Model Context Protocol client (stdio)
 *
 * A minimal, dependency-free MCP client: spawns an MCP server as a child process
 * and speaks JSON-RPC 2.0 over its stdin/stdout (newline-delimited, per the MCP
 * stdio transport). It does the initialize handshake, lists the server's tools,
 * and calls them. Hand-rolled to match illuci's no-extra-dependency posture (the
 * `@modelcontextprotocol/sdk` package is deliberately NOT a dependency); the same
 * posture as the bespoke `unreal-mcp.js` TCP client, generalized to real MCP.
 *
 * This is the CLIENT concern (substrate-talks-to-other-MCP-servers), which
 * constitutional/BILL_OF_STANDARDS.md (Standard 16) § "What core/mcp/ does NOT carry" places in
 * core/tools/, sibling-separated from the server boundary at core/mcp/.
 *
 * Scope (first cut): stdio transport only. HTTP/SSE transport is a later add.
 *
 * @typedef {object} McpToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema   — JSON Schema for the tool's arguments
 *
 * @typedef {object} McpClient
 * @property {string} name                                   — the server's label
 * @property {() => Promise<McpToolDef[]>} listTools
 * @property {() => Promise<object[]>} [listResources]
 * @property {(nameOrUri: string, args?: object) => Promise<object>} [readResource]
 * @property {(tool: string, args: object) => Promise<{ ok: boolean, content?: any, error?: string }>} callTool
 * @property {() => Promise<void>} close
 */

import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "illuci", version: "1.0.0" };

/**
 * Connect to an MCP server over stdio: spawn it, complete the initialize
 * handshake, and return a client handle. Rejects if the handshake does not
 * complete within `timeoutMs`.
 *
 * @param {object} spec
 * @param {string} spec.name           — a label for the server (namespacing + logs)
 * @param {string} spec.command        — the executable to spawn
 * @param {string[]} [spec.args]       — its arguments
 * @param {object} [spec.env]          — extra env (merged over process.env)
 * @param {string} [spec.cwd]          — working directory
 * @param {number} [spec.timeoutMs]    — handshake + per-request timeout (default 30000)
 * @returns {Promise<McpClient>}
 */
export async function connectMcpServer(spec) {
  const name = spec.name || spec.command;
  const timeoutMs = spec.timeoutMs || 30000;

  const child = spawn(spec.command, spec.args || [], {
    env: { ...process.env, ...(spec.env || {}) },
    cwd: spec.cwd || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer }
  let closed = false;
  let stderrTail = "";
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
  });

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON line (some servers log to stdout) — skip
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
      // notifications (no id) are ignored in this first cut
    }
  });

  const fail = (err) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  };
  child.on("error", (err) => { closed = true; fail(err); });
  child.on("close", (code) => {
    closed = true;
    fail(new Error(`MCP server "${name}" exited (code ${code})${stderrTail ? `: ${summarizeStderr(stderrTail)}` : ""}`));
  });

  /** Send a JSON-RPC request and await its matched response. */
  function request(method, params) {
    if (closed) return Promise.reject(new Error(`MCP server "${name}" is not connected`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${name})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  function notify(method, params) {
    if (closed) return;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  // ── Handshake ──
  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  notify("notifications/initialized", {});

  return {
    name,
    async listTools() {
      const result = await request("tools/list", {});
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async listResources() {
      const result = await request("resources/list", {});
      return Array.isArray(result?.resources) ? result.resources : [];
    },
    async readResource(nameOrUri, args = {}) {
      const params = String(nameOrUri || "").startsWith("illuci://")
        ? { uri: nameOrUri, arguments: args }
        : { name: nameOrUri, arguments: args };
      return request("resources/read", params);
    },
    async callTool(tool, args) {
      try {
        const result = await request("tools/call", { name: tool, arguments: args || {} });
        // MCP returns { content: [...], isError?: boolean }
        if (result?.isError) {
          return { ok: false, error: contentToText(result.content) || "tool reported an error" };
        }
        return { ok: true, content: result?.content ?? result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try { child.stdin.end(); } catch { /* ignore */ }
      child.kill();
    },
  };
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, done: () => clearTimeout(timer) };
}

/**
 * Connect to a Illuci-compatible MCP server over the runtime HTTP transport.
 * Uses POST /mcp JSON-RPC 2.0; callers do not need a local checkout.
 *
 * @param {object} spec
 * @param {string} spec.url             base runtime service URL, e.g. http://127.0.0.1:7473
 * @param {string} [spec.name]
 * @param {string} [spec.token]         optional bearer token for non-health endpoints
 * @param {number} [spec.timeoutMs]
 * @param {typeof fetch} [spec.fetchImpl]
 * @returns {Promise<McpClient>}
 */
export async function connectMcpHttpServer(spec) {
  const name = spec.name || "illuci-runtime-http";
  const timeoutMs = spec.timeoutMs || 30000;
  const fetchImpl = spec.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("connectMcpHttpServer requires fetch");
  const base = String(spec.url || "").replace(/\/+$/, "");
  if (!base) throw new Error("connectMcpHttpServer: spec.url is required");
  let nextId = 1;

  async function request(method, params) {
    const id = nextId++;
    const { controller, done } = withTimeout(timeoutMs);
    try {
      const res = await fetchImpl(`${base}/mcp`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(spec.token ? { authorization: `Bearer ${spec.token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      const msg = await res.json();
      if (!res.ok) throw new Error(msg?.error?.message || msg?.error || `HTTP ${res.status}`);
      if (msg?.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg?.result;
    } finally {
      done();
    }
  }

  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });

  return {
    name,
    async listTools() {
      const result = await request("tools/list", {});
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async listResources() {
      const result = await request("resources/list", {});
      return Array.isArray(result?.resources) ? result.resources : [];
    },
    async readResource(nameOrUri, args = {}) {
      const params = String(nameOrUri || "").startsWith("illuci://")
        ? { uri: nameOrUri, arguments: args }
        : { name: nameOrUri, arguments: args };
      return request("resources/read", params);
    },
    async callTool(tool, args) {
      try {
        const result = await request("tools/call", { name: tool, arguments: args || {} });
        if (result?.isError) {
          return { ok: false, error: contentToText(result.content) || "tool reported an error" };
        }
        return { ok: true, content: result?.content ?? result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async close() {},
  };
}

/** Flatten MCP content blocks ([{type:"text",text}, ...]) to a string. */
export function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content);
}

function summarizeStderr(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  return (
    lines.find((line) => /\b(?:Error|GroundingError|ILLUCI_[A-Z0-9_]+)\b/.test(line)) ||
    lines[0]
  );
}

export default { connectMcpServer, connectMcpHttpServer, contentToText };
