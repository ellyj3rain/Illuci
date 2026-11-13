/**
 * illuci - SSE Event Server + Static File Server
 *
 * Streams topology execution events to the visualizer via SSE.
 * Also serves the visualizer's static build files.
 *
 * `illuci flow` starts this server and opens the browser.
 * Single port serves both the app and the event stream.
 */

import http from "http";
import { readFile, writeFile, mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import { extname, join, resolve } from "path";
import { onEvent } from "./emitter.js";

const MAX_EVENT_BUFFER = 5000;
const DEFAULT_PORT = 7470;

// ─── ACCESS CONTROL ───
// Two-scope auth: admin (CLI/TUI) and public (IDE visualizer).
// CLI/TUI are strictly internal administrative tools.
// The visual IDE is the sole public gateway.
//
// Admin scope: full access — gate overrides, model management, system config.
// Public scope: workflow execution, canvas interaction, topology viewing.

let _adminToken = null;
let _publicToken = null;

function getAdminToken() {
  if (!_adminToken) _adminToken = randomBytes(32).toString("hex");
  return _adminToken;
}

function getPublicToken() {
  if (!_publicToken) _publicToken = randomBytes(32).toString("hex");
  return _publicToken;
}

/** Legacy alias — returns admin token for backward compat */
function getAuthToken() { return getAdminToken(); }

/**
 * Verify auth and return scope: "admin", "public", or null.
 */
function verifyAuth(req) {
  const header = req.headers.authorization;
  const url = new URL(req.url, "http://localhost");
  const queryToken = url.searchParams.get("token");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  if (!provided) return null;
  if (provided === getAdminToken()) return "admin";
  if (provided === getPublicToken()) return "public";
  return null;
}

/** Check if request meets required scope */
function requireScope(req, scope) {
  const actual = verifyAuth(req);
  if (!actual) return false;
  if (scope === "public") return true; // admin satisfies public
  return actual === "admin";
}

// Admin-only commands: system-level mutations
const ADMIN_ONLY_COMMANDS = new Set([
  "pause_model", "resume_model",
  "create_seat", "remove_seat", "group_seats",
]);

// Public commands: workflow execution, canvas interaction
const PUBLIC_COMMANDS = new Set([
  "reassign_seat", "inject_prompt",
  "create_edge", "remove_edge", "execute",
]);

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".json": "application/json",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json",
};

const clients = new Set();
const eventBuffer = [];
let server = null;

// ACTIVE SESSION STATE
// Mutable state for running sessions. Commands mutate this state and emit events.
// The runner reads this state to apply mid-run changes.

const activeSession = {
  lineup: {},
  paused: new Set(),
  injections: [],
  topologyId: null,
  sessionId: null,
};

// PIPELINE STATE
// When a pipeline is running, track its stages so /api/graph returns
// the pipeline-level graph with stage clusters.

const activePipeline = {
  pipelineId: null,
  stages: [],
  activeStageId: null,
  sessionId: null,
};

/** Set active pipeline (called when pipeline_start event arrives) */
export function setActivePipeline(pipelineId, stages, sessionId) {
  activePipeline.pipelineId = pipelineId;
  activePipeline.stages = stages.map(s => ({ ...s, status: "pending" }));
  activePipeline.activeStageId = null;
  activePipeline.sessionId = sessionId;
}

/** Mark a pipeline stage as active */
export function setPipelineStageActive(stageId) {
  activePipeline.activeStageId = stageId;
  const stage = activePipeline.stages.find(s => s.stageId === stageId);
  if (stage) stage.status = "running";
}

/** Mark a pipeline stage as complete */
export function setPipelineStageComplete(stageId) {
  const stage = activePipeline.stages.find(s => s.stageId === stageId);
  if (stage) stage.status = "completed";
}

/** Clear pipeline state */
export function clearActivePipeline() {
  activePipeline.pipelineId = null;
  activePipeline.stages = [];
  activePipeline.activeStageId = null;
  activePipeline.sessionId = null;
}

/** Get pipeline state for /api/graph */
export function getActivePipeline() {
  return { ...activePipeline, stages: [...activePipeline.stages] };
}

/** Set the active session (called by the runner at topology start) */
export function setActiveSession(topologyId, lineup, sessionId) {
  activeSession.topologyId = topologyId;
  activeSession.lineup = { ...lineup };
  activeSession.sessionId = sessionId;
  activeSession.paused.clear();
  activeSession.injections = [];
}

/** Get active session state (called by the runner to check for mid-run mutations) */
export function getActiveSession() {
  return { ...activeSession, paused: new Set(activeSession.paused) };
}

/** Check if a model is paused */
export function isModelPaused(modelId) {
  return activeSession.paused.has(modelId);
}

/** Drain pending prompt injections for a model */
export function drainInjections(modelId) {
  const pending = activeSession.injections.filter(i => i.modelId === modelId);
  activeSession.injections = activeSession.injections.filter(i => i.modelId !== modelId);
  return pending;
}

// Command handlers
// Bidirectional commands from the visualizer canvas.
// Commands now mutate active session state and emit events.

async function handleCommand(cmd) {
  switch (cmd.type) {
    case "reassign_seat": {
      const payload = cmd.payload || cmd;
      const seatId = payload.seatId || cmd.seatId;
      const modelId = payload.modelId || cmd.modelId;
      if (!seatId || !modelId) throw new Error("reassign_seat requires seatId and modelId");

      const current = activeSession.lineup[seatId];
      if (Array.isArray(current)) {
        if (current.length > 0) current[0] = modelId;
        else current.push(modelId);
      } else {
        activeSession.lineup[seatId] = [modelId];
      }

      broadcast({ type: "agent-event", event: {
        time: Date.now(),
        type: "seat_assigned",
        payload: { seatId: seatId, modelId: modelId, sessionId: activeSession.sessionId },
      }});
      return { applied: true, seat: seatId, model: modelId, lineup: activeSession.lineup };
    }

    case "inject_prompt": {
      if (!cmd.modelId || !cmd.content) throw new Error("inject_prompt requires modelId and content");
      activeSession.injections.push({
        modelId: cmd.modelId,
        content: cmd.content,
        timestamp: new Date().toISOString(),
      });
      return {
        queued: true,
        model: cmd.modelId,
        length: cmd.content.length,
        queueDepth: activeSession.injections.filter(i => i.modelId === cmd.modelId).length,
      };
    }

    case "pause_model": {
      if (!cmd.modelId) throw new Error("pause_model requires modelId");
      activeSession.paused.add(cmd.modelId);
      broadcast({ type: "agent-event", event: {
        time: Date.now(),
        type: "agent_idle",
        payload: { agentId: cmd.modelId, reason: "paused" },
      }});
      return { paused: true, model: cmd.modelId };
    }

    case "resume_model": {
      if (!cmd.modelId) throw new Error("resume_model requires modelId");
      activeSession.paused.delete(cmd.modelId);
      return { resumed: true, model: cmd.modelId };
    }

    // Canvas Edit Mode Commands (Phase 4)

    case "create_seat": {
      const payload = cmd.payload || cmd;
      const label = payload.label || cmd.label;
      const roleHint = payload.roleHint || cmd.roleHint || null;
      const authorityWeight = payload.authorityWeight ?? cmd.authorityWeight ?? null;
      const displayColor = payload.displayColor || cmd.displayColor || null;
      if (!label) throw new Error("create_seat requires label");
      const seatId = label;

      activeSession.lineup[seatId] = [];

      try {
        const { mutateLiveTopology } = await import("../topologies/index.js");
        const topologyId = activeSession.topologyId || "freeform";
        const result = mutateLiveTopology(topologyId, {
          type: "add_seat",
          payload: {
            id: seatId,
            label: seatId,
            min: 1,
            max: 1,
            roleHint,
            weight: authorityWeight,
          }
        });
        if (!result.applied) {
          console.warn("[sse-server] create_seat mutation failed:", result.error);
        }
      } catch (err) {
        console.warn("[sse-server] Failed to mutate topology for create_seat:", err.message);
      }

      broadcast({ type: "agent-event", event: {
        time: Date.now(),
        type: "agent_spawn",
        payload: {
          name: seatId,
          parent: activeSession.topologyId || "freeform",
          task: "new seat",
          isSubagent: true,
          x: payload.x || cmd.x || 0,
          y: payload.y || cmd.y || 0,
          roleHint,
          authorityWeight,
          displayColor,
        },
        sessionId: activeSession.sessionId,
      }});
      return { created: true, seatId };
    }

    case "create_edge": {
      const payload = cmd.payload || cmd;
      const from = payload.from || cmd.from;
      const to = payload.to || cmd.to;
      if (!from || !to) throw new Error("create_edge requires from and to");

      try {
        const { mutateLiveTopology } = await import("../topologies/index.js");
        const topologyId = activeSession.topologyId || "freeform";
        const result = mutateLiveTopology(topologyId, {
          type: "add_edge",
          payload: {
            from,
            to,
            edgeType: payload.edgeType || cmd.edgeType || "peer-of",
            semantics: payload.semantics || cmd.semantics || "connected",
          }
        });
        if (!result.applied) {
          console.warn("[sse-server] create_edge mutation failed:", result.error);
        }
      } catch (err) {
        console.warn("[sse-server] Failed to mutate topology for create_edge:", err.message);
      }

      broadcast({ type: "agent-event", event: {
        time: Date.now(),
        type: "edge_created",
        payload: {
          from: from,
          to: to,
          edgeType: payload.edgeType || cmd.edgeType || "peer-of",
          semantics: payload.semantics || cmd.semantics || "connected",
          topologyId: activeSession.topologyId || "freeform",
        },
        sessionId: activeSession.sessionId,
      }});
      return { created: true, from: from, to: to };
    }

    case "remove_seat": {
      const payload = cmd.payload || cmd;
      const seatId = payload.seatId || cmd.seatId;
      if (!seatId) throw new Error("remove_seat requires seatId");

      delete activeSession.lineup[seatId];

      try {
        const { mutateLiveTopology } = await import("../topologies/index.js");
        const topologyId = activeSession.topologyId || "freeform";
        const result = mutateLiveTopology(topologyId, {
          type: "remove_seat",
          payload: { id: seatId }
        });
        if (!result.applied) {
          console.warn("[sse-server] remove_seat mutation failed:", result.error);
        }
      } catch (err) {
        console.warn("[sse-server] Failed to mutate topology for remove_seat:", err.message);
      }

      broadcast({ type: "agent-event", event: {
        time: Date.now(),
        type: "agent_complete",
        payload: { name: seatId },
        sessionId: activeSession.sessionId,
      }});
      return { removed: true, seatId: seatId };
    }

    case "remove_edge": {
      const payload = cmd.payload || cmd;
      const edgeId = payload.edgeId || cmd.edgeId;
      const from = payload.from || cmd.from;
      const to = payload.to || cmd.to;
      if (!edgeId && !from) throw new Error("remove_edge requires edgeId or from+to");

      if (from && to) {
        try {
          const { mutateLiveTopology } = await import("../topologies/index.js");
          const topologyId = activeSession.topologyId || "freeform";
          const result = mutateLiveTopology(topologyId, {
            type: "remove_edge",
            payload: {
              from: from,
              to: to,
              edgeType: payload.edgeType || cmd.edgeType || undefined,
            }
          });
          if (!result.applied) {
            console.warn("[sse-server] remove_edge mutation failed:", result.error);
          }
        } catch (err) {
          console.warn("[sse-server] Failed to mutate topology for remove_edge:", err.message);
        }
      }

      broadcast({ type: "agent-event", event: {
        time: Date.now(),
        type: "edge_removed",
        payload: {
          edgeId: edgeId,
          from: from,
          to: to,
          topologyId: activeSession.topologyId || "freeform",
        },
        sessionId: activeSession.sessionId,
      }});
      return { removed: true, edgeId: edgeId };
    }

    case "group_seats": {
      const payload = cmd.payload || cmd;
      const seatIds = payload.seatIds || cmd.seatIds;
      const label = payload.label || cmd.label;
      if (!seatIds || !Array.isArray(seatIds) || seatIds.length < 2) {
        throw new Error("group_seats requires seatIds array with at least 2 entries");
      }
      try {
        const { registerFreeformTopology } = await import("../topologies/index.js");
        const seats = seatIds.map(id => ({
          id,
          label: id,
          min: 1,
          max: 1,
          roleHint: null,
          weight: 1.0,
          relationships: [],
        }));
        registerFreeformTopology({
          id: label || `freeform-${Date.now()}`,
          seats,
          edges: [],
        });
      } catch {}
      return { grouped: true, seatIds: seatIds, label: label };
    }

    // Execute Command (Phase 6)

    case "execute": {
      const payload = cmd.payload || cmd;
      const topologyId = payload.topologyId || cmd.topologyId;
      if (!topologyId) throw new Error("execute requires topologyId");

      // Register the topology — prefer the full graph from the canvas if provided,
      // fall back to reconstructing from activeSession for backwards compat.
      try {
        const { registerFreeformTopology, getTopology, compileGraph } = await import("../topologies/index.js");

        if (payload.graph && payload.graph.seats) {
          // Canvas sent the full blueprint graph — use it directly
          registerFreeformTopology(payload.graph);
        } else {
          // No graph from canvas — reconstruct from active session
          const existing = (() => { try { return getTopology(topologyId); } catch { return null; } })();
          if (existing) {
            const compiled = compileGraph(topologyId, activeSession.lineup || {});
            registerFreeformTopology({
              id: topologyId,
              seats: compiled.nodes.map(n => ({
                id: n.id, label: n.label, min: n.min ?? 1, max: n.max ?? 1,
                roleHint: n.roleHint || null, weight: n.weight ?? 1.0, relationships: [],
              })),
              edges: compiled.edges.map(e => ({
                source: e.source, target: e.target, type: e.type, semantics: e.semantics,
              })),
            });
          } else {
            registerFreeformTopology({
              id: topologyId,
              seats: Object.entries(activeSession.lineup || {}).map(([id]) => ({
                id, label: id, min: 1, max: 1, roleHint: null, weight: 1.0, relationships: [],
              })),
              edges: [],
            });
          }
        }
      } catch (err) {
        console.warn("[sse-server] Failed to register topology for execute:", err.message);
      }

      // Run the topology — prefer lineup from canvas if provided
      try {
        const { runTopology } = await import("../topologies/runner.js");
        const lineup = payload.lineup || activeSession.lineup || {};
        const prompt = payload.prompt || cmd.prompt || "Execute freeform topology";

        // Update active session lineup to match what's being executed
        if (payload.lineup) {
          activeSession.lineup = { ...activeSession.lineup, ...payload.lineup };
        }

        runTopology(topologyId, lineup, prompt, {}, activeSession.sessionId).catch((err) => {
          console.warn("[sse-server] Topology execution failed:", err.message);
        });
      } catch (err) {
        console.warn("[sse-server] Failed to start topology execution:", err.message);
      }
      return { executing: true, topologyId };
    }

    default:
      throw new Error(`Unknown command type: ${cmd.type}`);
  }
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

/**
 * Start the SSE + static file server.
 *
 * @param {object} options
 * @param {number} options.port - default 7470
 * @param {string} options.staticDir - path to visualizer/out/ (optional)
 * @returns {Promise<{ port: number, stop: () => void }>}
 */
export async function startSSEServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const staticDir = options.staticDir ? resolve(options.staticDir) : null;

  const unsubscribe = onEvent((event) => {
    eventBuffer.push(event);
    if (eventBuffer.length > MAX_EVENT_BUFFER) {
      eventBuffer.splice(0, eventBuffer.length - MAX_EVENT_BUFFER);
    }

    if (event.type === "pipeline_start" && event.payload) {
      setActivePipeline(event.payload.pipelineId, event.payload.stages || [], event.sessionId);
    } else if (event.type === "pipeline_stage_start" && event.payload) {
      setPipelineStageActive(event.payload.stageId);
    } else if (event.type === "pipeline_stage_complete" && event.payload) {
      setPipelineStageComplete(event.payload.stageId);
    } else if (event.type === "pipeline_complete") {
      clearActivePipeline();
    }

    broadcast({ type: "agent-event", event });
  });

  server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      clients.add(res);

      res.write(`data: ${JSON.stringify({
        type: "session-list",
        sessions: [{
          id: "illuci",
          label: "illuci Topology Engine",
          status: "active",
          startTime: Date.now(),
          lastActivityTime: Date.now(),
        }],
      })}\n\n`);

      if (eventBuffer.length > 0) {
        res.write(`data: ${JSON.stringify({
          type: "agent-event-batch",
          events: eventBuffer,
        })}\n\n`);
      }

      req.on("close", () => {
        clients.delete(res);
      });

      return;
    }

    // REST endpoint for Unreal bridge — returns event buffer as one-shot JSON
    if (req.url === "/api/events" || req.url?.startsWith("/api/events?")) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const newEvents = eventBuffer.slice(since);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        events: newEvents,
        total: eventBuffer.length,
      }));
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        clients: clients.size,
        bufferedEvents: eventBuffer.length,
      }));
      return;
    }

    if (req.url === "/api/graph") {
      res.writeHead(200, { "Content-Type": "application/json" });

      if (activePipeline.pipelineId) {
        try {
          const { compileGraph } = await import("../topologies/index.js");
          const subGraphs = [];
          const allNodes = [];
          const allEdges = [];

          for (const stage of activePipeline.stages) {
            const stageGraph = compileGraph(stage.topologyId, stage.lineup || {});

            const prefix = `pipeline/${stage.stageId}`;
            const stageNodeIds = [];

            for (const node of stageGraph.nodes) {
              const namespacedId = `${prefix}/${node.id}`;
              stageNodeIds.push(namespacedId);
              allNodes.push({ ...node, id: namespacedId, stageId: stage.stageId });
            }

            for (const edge of stageGraph.edges) {
              allEdges.push({
                ...edge,
                source: `${prefix}/${edge.source}`,
                target: `${prefix}/${edge.target}`,
              });
            }

            subGraphs.push({
              id: stage.stageId,
              label: stage.label,
              topologyId: stage.topologyId,
              layout: stageGraph.layout,
              nodeIds: stageNodeIds,
              sequence: stage.sequence,
            });
          }

          for (let i = 0; i < subGraphs.length - 1; i++) {
            const fromNodes = subGraphs[i].nodeIds;
            const toNodes = subGraphs[i + 1].nodeIds;
            if (fromNodes.length > 0 && toNodes.length > 0) {
              allEdges.push({
                source: fromNodes[fromNodes.length - 1],
                target: toNodes[0],
                type: "pipeline-flow",
                semantics: "stage-handoff",
              });
            }
          }

          res.end(JSON.stringify({
            pipelineId: activePipeline.pipelineId,
            isPipeline: true,
            nodes: allNodes,
            edges: allEdges,
            subGraphs,
            layout: "pipeline",
            sessionId: activePipeline.sessionId,
            activeStageId: activePipeline.activeStageId,
          }));
        } catch (err) {
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (activeSession.topologyId) {
        try {
          const { compileGraph } = await import("../topologies/index.js");
          const graph = compileGraph(activeSession.topologyId, activeSession.lineup);
          graph.sessionId = activeSession.sessionId;
          graph.paused = [...activeSession.paused];
          res.end(JSON.stringify(graph));
        } catch (err) {
          res.end(JSON.stringify({ error: err.message }));
        }
      } else {
        res.end(JSON.stringify({ error: "No active session", nodes: [], edges: [] }));
      }
      return;
    }

    // Ingest: admin-only (internal cross-process event delivery)
    if (req.url?.startsWith("/ingest") && req.method === "POST") {
      if (!requireScope(req, "admin")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized — admin scope required for /ingest"}');
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const event = JSON.parse(body);
          eventBuffer.push(event);
          if (eventBuffer.length > MAX_EVENT_BUFFER) {
            eventBuffer.splice(0, eventBuffer.length - MAX_EVENT_BUFFER);
          }
          broadcast({ type: "agent-event", event });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400);
          res.end('{"error":"invalid json"}');
        }
      });
      return;
    }

    // Commands: scope-checked per command type
    if (req.url?.startsWith("/api/command") && req.method === "POST") {
      const scope = verifyAuth(req);
      if (!scope) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const cmd = JSON.parse(body);

          // Check command scope
          if (ADMIN_ONLY_COMMANDS.has(cmd.type) && scope !== "admin") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Command "${cmd.type}" requires admin scope` }));
            return;
          }
          if (!ADMIN_ONLY_COMMANDS.has(cmd.type) && !PUBLIC_COMMANDS.has(cmd.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown command type: ${cmd.type}` }));
            return;
          }

          const result = await handleCommand(cmd);
          broadcast({ type: "command", command: cmd, result });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, command: cmd.type, result }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sseClients: clients.size,
        bufferedEvents: eventBuffer.length,
        lastEvent: eventBuffer[eventBuffer.length - 1] || null,
      }));
      return;
    }

    if (staticDir) {
      const parsed = new URL(req.url, "http://localhost");
      let filePath = join(staticDir, decodeURIComponent(parsed.pathname));

      if (!filePath.startsWith(staticDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      if (filePath.endsWith("/") || filePath.endsWith("\\")) {
        filePath = join(filePath, "index.html");
      }

      try {
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      } catch {
        try {
          const index = await readFile(join(staticDir, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(index);
        } catch {
          res.writeHead(404);
          res.end("Not found - run 'npm run build' in visualizer/ first");
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((res) => {
    server.listen(port, "127.0.0.1", async () => {
      const adminToken = getAdminToken();
      const publicToken = getPublicToken();
      console.log(`Illuci event server: http://127.0.0.1:${port}`);
      console.log(`SSE endpoint: http://127.0.0.1:${port}/events`);
      console.log(`Admin auth: Bearer ${adminToken.substring(0, 8)}... (CLI/TUI)`);
      console.log(`Public auth: Bearer ${publicToken.substring(0, 8)}... (IDE)`);
      if (staticDir) console.log(`Static files: ${staticDir}`);
      console.log(`Clients: ${clients.size}`);

      // Write runtime file with both tokens for cross-process discovery
      try {
        const runtimeDir = join(process.cwd(), ".illuci");
        await mkdir(runtimeDir, { recursive: true });
        await writeFile(join(runtimeDir, "flow-runtime.json"), JSON.stringify({
          url: `http://127.0.0.1:${port}`,
          token: adminToken,
          publicToken,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }, null, 2));
      } catch {}

      res({
        port,
        token: adminToken,
        publicToken,
        stop() {
          unsubscribe();
          server.close();
          for (const c of clients) {
            try { c.end(); } catch {}
          }
          clients.clear();
        },
      });
    });
  });
}

export default { startSSEServer };
