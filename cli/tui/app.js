/**
 * illuci CLI — Terminal UI (GZDS Substrate)
 *
 * Architecture: Static output (scrolls naturally) + live input area (stays at bottom).
 * Same pattern as Claude Code and Gemini CLI.
 * React-based using Ink, no JSX.
 */

import React from "react";
import { render, Box, Text, Static, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { readFileSync } from "fs";
import { join } from "path";
import { MODEL_DEFAULTS } from "../../core/bridges/index.js";
import { getThrottleStatus } from "../../core/throttle/throttle.js";
import { onEvent } from "../../core/events/emitter.js";
import { listSkills, runSkill } from "../../core/skills/registry.js";
import { listTopologies, TOPOLOGIES } from "../../core/topologies/index.js";
import * as history from "../../cli/repl/history.js";
import { resolveGate } from "../../core/gates/tui-gate.js";
import { TERMINAL_LOGO_LINES, compactPortrait, renderCompactModelCard } from "../terminal/design.js";
import { modelIdentityCardFor } from "../terminal/identity-cards.js";
import { listModelDoctorReports } from "../../core/fleet/model-doctor.js";

const { useState, useEffect, useCallback, useRef, createElement: h } = React;

// ─── THEME ───

const T = {
  brand:  "#00ffcc",
  muted:  "#666666",
  text:   "#cccccc",
  ok:     "#00ff88",
  warn:   "#ffaa00",
  err:    "#ff4444",
  phase:  "#6699ff",
  dim:    "#444444",
};

// ─── SYSTEM FLAGS ───

const SYSTEM_FLAGS = [
  "--baseline", "--full", "--output", "--budget",
  "--model", "--timeout", "--verbose", "--quiet",
  "--reasoning",
];

// Helper to parse flags locally in TUI
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ─── STATIC OUTPUT ITEM ───
// Each item becomes part of the terminal scrollback — never disappears.

function OutputItem({ item }) {
  if (item.type === "banner") {
    return h(Box, { flexDirection: "column", paddingX: 1 },
      h(Text, { bold: true, color: T.brand }, item.title),
      ...item.lines.map((l, i) => h(Text, { key: i, color: T.muted }, `  ${l}`)),
      h(Text, null, ""),
    );
  }

  if (item.type === "phase") {
    return h(Box, { paddingX: 1 },
      h(Text, { color: T.phase, bold: true }, `\u2500\u2500 ${item.text} \u2500\u2500`),
    );
  }

  if (item.type === "model-response") {
    return h(Box, { flexDirection: "column", paddingX: 1 },
      h(Box, null,
        h(Text, { color: item.color || T.ok, bold: true }, item.model),
        h(Text, { color: T.muted }, ` (${item.seat})`),
        item.latency && h(Text, { color: T.dim }, ` ${item.latency}`),
      ),
      ...item.lines.map((l, i) => h(Text, { key: i, wrap: "wrap", color: T.text }, `  ${l}`)),
      h(Text, null, ""),
    );
  }

  if (item.type === "error") {
    return h(Box, { paddingX: 1 },
      h(Text, { color: T.err }, item.text),
    );
  }

  if (item.type === "info") {
    return h(Box, { paddingX: 1 },
      h(Text, { color: item.color || T.muted }, item.text),
    );
  }

  if (item.type === "command") {
    return h(Box, { paddingX: 1 },
      h(Text, { color: T.dim }, "\u276F "),
      h(Text, { color: T.text }, item.text),
    );
  }

  if (item.type === "response") {
    return h(Box, { flexDirection: "column", paddingX: 1 },
      ...item.text.split("\n").map((l, i) => h(Text, { key: i, wrap: "wrap", color: T.text }, l)),
      h(Text, null, ""),
    );
  }

  if (item.type === "gate") {
    return h(Box, { flexDirection: "column", paddingX: 1, borderStyle: "single", borderColor: T.warn },
      h(Text, { bold: true, color: T.warn }, "GATE APPROVAL"),
      h(Text, { color: T.muted }, `${item.model} (${item.seat}) \u2192 ${item.tool}`),
      h(Text, null, item.description),
      h(Text, { color: T.muted }, "y = approve, n = deny"),
    );
  }

  // Fallback
  return h(Box, { paddingX: 1 },
    h(Text, { wrap: "wrap", color: item.color || T.text }, item.text || ""),
  );
}

// ─── HEADER BAR ───

function HeaderBar({ projectName, contextStats, gateStats, councilActive, cols }) {
  const brand = "illuci";
  const projectStr = projectName || "No project";
  const statsStr = contextStats || "";
  const gateStr = gateStats || "";
  const councilStr = councilActive ? " COUNCIL " : "";

  return h(Box, { paddingX: 1, height: 1, width: cols, justifyContent: "space-between" },
    h(Box, null,
      h(Text, { bold: true, color: T.brand }, brand),
      h(Text, { color: T.dim }, "  "),
      h(Text, { color: T.text }, projectStr),
    ),
    h(Box, null,
      councilStr && h(Text, { bold: true, color: T.warn, backgroundColor: "#332200" }, councilStr),
      h(Text, { color: T.dim }, "  "),
      h(Text, { color: T.muted }, statsStr),
      gateStr && h(Text, { color: T.warn }, `  ${gateStr}`),
    ),
  );
}

// ─── FLEET SIDEBAR ───

function FleetSidebar({ models, activePhase, tokens, councilActive, councilLineup }) {
  return h(Box, {
    flexDirection: "column",
    width: 26,
    borderStyle: "single",
    borderColor: T.dim,
    paddingX: 1,
  },
    // Council roster — shown when a council is running
    councilActive && councilLineup && h(Box, { flexDirection: "column", marginBottom: 1 },
      h(Text, { bold: true, color: T.warn }, "Council"),
      activePhase && h(Text, { color: T.phase }, `\u25B6 ${activePhase}`),
      ...Object.entries(councilLineup).map(([seat, assigned]) => {
        const modelIds = Array.isArray(assigned) ? assigned : [assigned];
        return h(Box, { key: seat, flexDirection: "column" },
          h(Text, { color: T.muted, dimColor: true }, ` ${seat}`),
          ...modelIds.map(mid => {
            const m = models.find(x => x.id === mid);
            const dot = m?.active ? "\u25C9" : "\u25CF";
            const dotColor = m?.active ? T.warn : T.ok;
            return h(Box, { key: mid },
              h(Text, { color: dotColor }, `  ${dot} `),
              h(Text, { color: m?.color || T.text }, m?.displayName || mid),
            );
          }),
        );
      }),
      h(Text, { color: T.dim }, "\u2500".repeat(22)),
    ),

    // Fleet panel
    h(Text, { bold: true, color: T.muted }, "Fleet"),
    h(Text, null, ""),
    ...models.map(m => {
      const dot = m.active ? "\u25C9" : m.alive ? "\u25CF" : "\u25CB";
      const dotColor = m.active ? T.warn : m.alive ? T.ok : T.dim;
      const name = (m.displayName || m.id).substring(0, 12).padEnd(12);
      const seatStr = m.seat ? ` ${m.seat}` : "";
      const latStr = m.lastLatency ? ` ${(m.lastLatency / 1000).toFixed(1)}s` : "";
      return h(Box, { key: m.id },
        h(Text, { color: dotColor }, dot),
        h(Text, { color: m.color || T.muted }, ` ${name}`),
        h(Text, { color: T.dim }, `${seatStr}${latStr}`),
      );
    }),
    h(Text, null, ""),
    h(Text, { color: T.dim }, `${tokens.toLocaleString()} tok`),
    !councilActive && activePhase && h(Text, { color: T.phase }, `\u25B6 ${activePhase}`),
  );
}

// ─── FLEET STATUS (compact, one line) — fallback for narrow terminals ───

function FleetLine({ models }) {
  return h(Box, { paddingX: 1, flexWrap: "wrap" },
    ...models.map(m => {
      const dot = m.active ? "\u25C9" : m.alive ? "\u25CF" : "\u25CB";
      const dotColor = m.active ? T.warn : m.alive ? T.ok : T.dim;
      return h(Box, { key: m.id, marginRight: 1 },
        h(Text, { color: dotColor }, dot),
        h(Text, { color: m.color || T.muted }, ` ${m.displayName || m.id}`),
      );
    }),
  );
}

// ─── STATUS BAR ───

function StatusBar({ mode, message, cols }) {
  return h(Box, { paddingX: 1, height: 1, width: cols, justifyContent: "space-between" },
    h(Text, { color: T.muted }, mode || "Normal"),
    h(Text, { color: T.dim }, message || ""),
    h(Text, { color: T.dim }, "F1:Help  Ctrl+K:Skills  Ctrl+C:Exit"),
  );
}

// --- FLEET DISPLAY SEED ---

function getInitialModelsList() {
  return listModelDoctorReports().map((report) => {
    const id = report.canonicalId || report.requestedId;
    const card = modelIdentityCardFor(id);
    return {
      id,
      displayName: card.displayName,
      color: card.portrait.color,
      portraitLines: compactPortrait(card.portrait.ascii, { maxLines: 2, maxWidth: 12 }),
      identityCard: card,
      alive: report.liveness?.staticAvailable === true,
      authStatus: report.liveness?.status || "unknown",
      active: false,
      family: report.family,
      provider: report.providerKey,
      providerLabel: report.providerId || report.providerKey,
      transport: report.transport,
      seat: null,
      lastLatency: 0,
      sessionTokens: 0,
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ─── MAIN APP ───

const STAR_PULSE_SPINNER = {
  frames: ["·", "∙", "•", "⊹", "✦", "★", "✦", "⊹", "•", "∙"],
  interval: 100, // ~100ms each = 1s cycle
};

function IlluciApp({ initialCommand }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;

  // Static output items — each one scrolls naturally once rendered
  const [items, setItems] = useState([]);
  const [executing, setExecuting] = useState(false);
  const [activeModel, setActiveModel] = useState(null);
  const [defaultModel, setDefaultModel] = useState("deepseek");
  const [mode, setMode] = useState("direct");
  const activeModelRef = useRef(null);
  const [tokens, setTokens] = useState(0);
  const [gate, setGate] = useState(null);
  const [models, setModels] = useState([]);
  const [councilActive, setCouncilActive] = useState(false);
  const [councilLineup, setCouncilLineup] = useState(null);
  const [activePhase, setActivePhase] = useState(null);
  const [projectName, setProjectName] = useState(null);
  const [contextStats, setContextStats] = useState("");
  const [gateStats, setGateStats] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [showSkillPalette, setShowSkillPalette] = useState(false);
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyPointer, setHistoryPointer] = useState(0);
  const [currentInput, setCurrentInput] = useState("");
  const nextId = useRef(0);

  const modelsRef = useRef(models);
  const commandHistoryRef = useRef(commandHistory);
  const initialCommandRun = useRef(false);

  useEffect(() => { modelsRef.current = models; }, [models]);
  useEffect(() => { commandHistoryRef.current = commandHistory; }, [commandHistory]);

  const addItem = useCallback((item) => {
    setItems(prev => [...prev, { ...item, id: nextId.current++ }]);
  }, []);

  // ─── STARTUP ───

  useEffect(() => {
    let loadedVersion = "0.9.0";
    try {
      const ROOT = join(new URL(import.meta.url).pathname, "..", "..", "..").replace(/^\/([A-Z]:)/, "$1");
      loadedVersion = readFileSync(join(ROOT, "VERSION"), "utf-8").trim();
    } catch {}

    setModels(getInitialModelsList());

    const loadedHistory = history.load();
    setCommandHistory(loadedHistory);
    setHistoryPointer(loadedHistory.length);

    // Startup banner
    (async () => {
      addItem({ type: "response", text: TERMINAL_LOGO_LINES.join("\n") });

      const bannerLines = [];

      try {
        const store = await import("../../core/context/store.js");
        const stats = store.globalStats();
        bannerLines.push(`${stats.messages} messages, ${stats.artifacts} artifacts, ${stats.totalTokens.toLocaleString()} tokens`);
        store.close();
      } catch {}

      try {
        const { checkAll, PROVIDERS } = await import("../../core/health/monitor.js");
        const { getProviderResource } = await import("../../core/fleet/resource-gateway.js");
        const status = await checkAll();
        const up = PROVIDERS.filter(p => status[p]?.status === "up");
        const labels = up.map(p => status[p]?.label || p);
        bannerLines.push(`${up.length} providers online: ${labels.join(", ")}`);
        // Update model alive status from provider resources.
        setModels(prev => prev.map(m => {
          const providerId = getProviderResource(m.provider)?.id;
          return {
            ...m,
            alive: (providerId && status[providerId]?.status === "up") || m.alive,
          };
        }));
      } catch {}

      try {
        const { listMaturity } = await import("../../core/gates/approval-context.js");
        const mat = listMaturity();
        const all = [...Object.values(mat.modules || {}), ...Object.values(mat.files || {})];
        const l = all.filter(e => e.level === "locked").length;
        const g = all.filter(e => e.level === "gated").length;
        bannerLines.push(`${l} locked, ${g} gated`);
      } catch {}

      bannerLines.push("Type 'help' for commands. Ctrl+K for skills. Ctrl+C to exit.");

      addItem({
        type: "banner",
        title: `illuci v${loadedVersion}`,
        lines: bannerLines,
      });

      // Load active project
      try {
        const { getActiveProject } = await import("../../core/projects/manager.js");
        const proj = getActiveProject();
        if (proj) {
          setProjectName(proj.name);
          addItem({ type: "info", text: `Project: ${proj.name}`, color: T.muted });
        }
      } catch {}

      // Load context stats for header
      try {
        const store2 = await import("../../core/context/store.js");
        const stats2 = store2.globalStats();
        setContextStats(`${stats2.messages}msg ${stats2.artifacts}art ${stats2.totalTokens.toLocaleString()}tok`);
        store2.close();
      } catch {}

      // Load gate stats for header
      try {
        const { listMaturity: lm } = await import("../../core/gates/approval-context.js");
        const mat2 = lm();
        const all2 = [...Object.values(mat2.modules || {}), ...Object.values(mat2.files || {})];
        const locked = all2.filter(e => e.level === "locked").length;
        const gated = all2.filter(e => e.level === "gated").length;
        if (locked > 0 || gated > 0) setGateStats(`${locked}L ${gated}G`);
      } catch {}
    })();

    // Throttle-based model activity polling
    const interval = setInterval(() => {
      const throttleStatus = getThrottleStatus();
      setModels(prev => prev.map(m => ({
        ...m,
        active: throttleStatus[m.provider]?.inflight > 0 || m.active,
      })));
    }, 1000);

    // Event stream — council events render as static items
    const unsubscribe = onEvent((event) => {
      switch (event.type) {
        case "topology_start": {
          const { topologyName, lineup, prompt } = event.payload;
          setCouncilActive(true);
          setCouncilLineup(lineup);
          const lineupStr = Object.entries(lineup)
            .map(([seat, m]) => `${seat}: ${Array.isArray(m) ? m.join(", ") : m}`)
            .join("  ");
          addItem({ type: "phase", text: `Council: ${topologyName}` });
          addItem({ type: "info", text: lineupStr, color: T.muted });
          break;
        }
        case "phase_start": {
          const { phaseId, phaseType } = event.payload;
          setActivePhase(`${phaseId} (${phaseType})`);
          addItem({ type: "phase", text: `${phaseId} (${phaseType})` });
          break;
        }
        case "message": {
          const { agent, content, role, latency, usage } = event.payload;
          if (content && role === "assistant") {
            const [seat, modelId] = (agent || "?:?").split(":");
            const modelInfo = modelsRef.current.find(m => m.id === modelId);
            addItem({
              type: "model-response",
              model: modelId,
              seat,
              color: modelInfo?.color || T.ok,
              latency: latency ? `${(latency / 1000).toFixed(1)}s` : null,
              lines: content.split("\n"),
            });
            if (modelId) {
              setModels(prev => prev.map(m => m.id === modelId ? {
                ...m,
                seat: seat !== "?" ? seat : m.seat,
                lastLatency: latency || m.lastLatency,
                sessionTokens: (m.sessionTokens || 0) + (usage?.total_tokens || 0),
              } : m));
            }
          }
          break;
        }
        case "phase_complete": {
          const { responseCount, totalTokens, latency } = event.payload;
          addItem({
            type: "info",
            text: `${responseCount} responses, ${totalTokens || 0} tok, ${((latency || 0) / 1000).toFixed(1)}s`,
            color: T.dim,
          });
          setModels(prev => prev.map(m => ({ ...m, active: false })));
          break;
        }
        case "topology_complete": {
          const { topologyName, totalLatency } = event.payload;
          setCouncilActive(false);
          setCouncilLineup(null);
          setActivePhase(null);
          addItem({ type: "phase", text: `Complete: ${topologyName} (${(totalLatency / 1000).toFixed(1)}s)` });
          setModels(prev => prev.map(m => ({ ...m, seat: null, active: false })));
          setExecuting(false);
          setActiveModel(null);
          history.save(commandHistoryRef.current);
          break;
        }
        case "permission_requested": {
          const { agent, tool, reason } = event.payload;
          setGate({
            model: agent, tool,
            description: reason || `Approval required for ${tool}`,
            diff: event.payload.diff,
            seat: event.payload.seat || "?",
          });
          break;
        }
      }
    });

    if (initialCommand && !initialCommandRun.current) {
      initialCommandRun.current = true;
      setTimeout(() => handleCommand(initialCommand), 100);
    }

    return () => {
      clearInterval(interval);
      unsubscribe();
      history.save(commandHistoryRef.current);
    };
  }, []);

  // ─── GATE INPUT ───

  useInput((input, key) => {
    if (gate) {
      if (input === "y" || input === "Y") {
        resolveGate({ approved: true });
        addItem({ type: "info", text: "Gate approved.", color: T.ok });
        setGate(null);
      } else if (input === "n" || input === "N") {
        resolveGate({ approved: false, reason: "Operator denied" });
        addItem({ type: "info", text: "Gate denied.", color: T.err });
        setGate(null);
      }
      return;
    }
    if (key.ctrl && input === "k") {
      setShowSkillPalette(true);
    }
  });

  // ─── COMMAND HANDLER ───

  const handleCommand = useCallback(async (input) => {
    addItem({ type: "command", text: input });

    setCommandHistory(prev => {
      const h = [...prev, input];
      setHistoryPointer(h.length);
      return h;
    });

    // Slash commands
    if (input.startsWith("/")) {
      const match = input.match(/^\/([^\s]+)(?:\s+(.*))?$/);
      if (match) {
        setExecuting(true);
        try {
          await runSkill(match[1], (match[2] || "").split(/\s+/).filter(Boolean));
          addItem({ type: "info", text: `/${match[1]} complete.`, color: T.ok });
        } catch (err) {
          addItem({ type: "error", text: err.message });
        }
        setExecuting(false);
        return;
      }
    }

    if (input === "exit" || input === "quit" || input === ".exit") { exit(); return; }
    if (input === "clear" || input === ".clear") { setItems([]); return; }

    if (input === "help" || input === ".help") {
      addItem({ type: "response", text: [
        "Illuci CLI",
        "",
        "  <task>                   Execute via formation engine",
        "  ask <model> <msg>        Query a specific model",
        "  ask all <msg>            Query all models",
        "  use <model>              Switch default model",
        "  council <topo> <msg>     Run a topology",
        "  council list             List topologies",
        "",
        "  status                   Model health",
        "  models                   Fleet overview",
        "  matrix                   Capability matrix",
        "  context                  Context store stats",
        "  gate list                Maturity levels",
        "  decisions [n]            Decision log",
        "",
        "  /<skill> [args]          Run a skill",
        "  Ctrl+K                   Skill palette",
        "  clear                   Clear output",
        "  exit                     Quit",
        "",
        `  Default model: ${defaultModel}`,
      ].join("\n") });
      return;
    }

    if (input === "models") {
      addItem({ type: "response", text: modelsRef.current.map((m) => {
        const isDefault = m.id === defaultModel ? "  < default" : "";
        return renderCompactModelCard(m.identityCard || modelIdentityCardFor(m.id), {
          provider: m.providerLabel,
          transport: m.transport,
          liveness: m.authStatus,
          color: false,
        }) + isDefault;
      }).join("\n\n") });
      return;
    }

    if (input === "status") {
      setExecuting(true);
      try {
        const { checkAll, PROVIDERS } = await import("../../core/health/monitor.js");
        const status = await checkAll();
        for (const p of PROVIDERS) {
          const s = status[p];
          const icon = s.status === "up" ? "UP" : "DOWN";
          const color = s.status === "up" ? T.ok : T.err;
          const detail = s.error ? ` - ${s.error}` : s.detail ? ` - ${s.detail}` : "";
          addItem({ type: "info", text: `${icon} ${s.label || p} [${p}]${detail}`, color });
        }
      } catch (e) { addItem({ type: "error", text: e.message }); }
      setExecuting(false);
      return;
    }

    if (input === "context") {
      try {
        const store = await import("../../core/context/store.js");
        const s = store.globalStats();
        addItem({ type: "info", text: `${s.messages} msgs, ${s.artifacts} arts, ${s.perceptions} perceptions, ${s.totalTokens.toLocaleString()} tok` });
        store.close();
      } catch (e) { addItem({ type: "error", text: e.message }); }
      return;
    }

    if (input === "gate list" || input === "gates") {
      try {
        const { listMaturity } = await import("../../core/gates/approval-context.js");
        const mat = listMaturity();
        for (const [path, entry] of Object.entries({ ...mat.modules, ...mat.files })) {
          const icon = entry.level === "locked" ? "L" : entry.level === "gated" ? "G" : "O";
          addItem({ type: "info", text: `[${icon}] ${path}`, color: entry.level === "locked" ? T.err : entry.level === "gated" ? T.warn : T.ok });
        }
      } catch (e) { addItem({ type: "error", text: e.message }); }
      return;
    }

    // Switch model
    const useMatch = input.match(/^use\s+(\S+)$/);
    if (useMatch) {
      if (MODEL_DEFAULTS[useMatch[1]]) {
        setDefaultModel(useMatch[1]);
        activeModelRef.current = useMatch[1];
        addItem({ type: "info", text: `Default model: ${useMatch[1]}`, color: T.ok });
      } else {
        addItem({ type: "error", text: `Unknown model. Available: ${Object.keys(MODEL_DEFAULTS).join(", ")}` });
      }
      return;
    }

    // Ask command
    if (input.startsWith("ask ")) {
      const parts = input.split(/\s+/);
      const modelId = parts[1];
      const { flags, positional } = parseFlags(parts.slice(2));
      const message = positional.join(" ");
      if (!modelId || !message) {
        addItem({ type: "error", text: "Usage: ask <model> [flags] <message>" });
        return;
      }

      setExecuting(true);
      setActiveModel(modelId);
      try {
        const { queryModel, queryConcurrent } = await import("../../core/dispatch/dispatch.js");
        if (modelId === "all") {
          const ids = Object.keys(MODEL_DEFAULTS);
          const results = await queryConcurrent(ids, message, { projectId: "illuci-tui" });
          for (const r of results) {
            const c = modelsRef.current.find(m => m.id === r.model)?.color || T.text;
            if (r.error) {
              addItem({ type: "error", text: `${r.model}: ${r.error}` });
            } else {
              addItem({ type: "model-response", model: r.model, seat: "ask", color: c, latency: `${(r.latency / 1000).toFixed(1)}s`, lines: (r.response || "").split("\n") });
            }
          }
        } else {
          const result = await queryModel(modelId, message, { 
            projectId: "illuci-tui", 
            seat: "ask",
            reasoning: flags.reasoning || null,
            timeoutMs: flags.timeout ? parseInt(flags.timeout, 10) : null
          });
          if (result.error) {
            addItem({ type: "error", text: result.error });
          } else {
            const c = modelsRef.current.find(m => m.id === result.model)?.color || T.text;
            addItem({ type: "model-response", model: result.model, seat: "ask", color: c, latency: `${(result.latency / 1000).toFixed(1)}s`, lines: (result.response || "").split("\n") });
          }
          setTokens(prev => prev + (result.usage?.total_tokens || 0));
        }
      } catch (err) { addItem({ type: "error", text: err.message }); }
      setExecuting(false);
      setActiveModel(null);
      return;
    }

    // Council command
    if (input.startsWith("council ")) {
      const parts = input.split(/\s+/).slice(1);
      const topologyId = parts[0];
      if (topologyId === "list") {
        const topos = listTopologies();
        for (const id of topos) {
          const t = TOPOLOGIES[id];
          addItem({ type: "info", text: `${id.padEnd(24)} ${t?.description || ""}` });
        }
        return;
      }

      const { flags, positional } = parseFlags(parts.slice(1));
      const message = positional.join(" ");
      if (!message) {
        addItem({ type: "error", text: "Usage: council <topology> [flags] <message>" });
        return;
      }

      setExecuting(true);
      setActiveModel(`council:${topologyId}`);
      try {
        const { runTopology } = await import("../../core/topologies/runner.js");
        const trace = await runTopology(topologyId, {}, message, {
          humanStatus: "operator-initiated",
          context: `TUI council: ${topologyId}`,
          projectId: "illuci-tui",
          reasoning: flags.reasoning || null,
          tokenBudget: flags.budget ? parseFloat(flags.budget) : null,
          minConfidence: flags["min-confidence"] ? parseFloat(flags["min-confidence"]) : null,
        });
        setTokens(prev => prev + (trace.budget?.totalSpent || 0));
      } catch (err) {
        addItem({ type: "error", text: err.message });
      }
      setExecuting(false);
      setActiveModel(null);
      return;
    }

    // Pipeline command
    const pipelineMatch = input.match(/^pipeline\s+(\S+)\s+(.+)$/);
    if (pipelineMatch) {
      const [, composition, message] = pipelineMatch;
      setExecuting(true);
      setActiveModel(`pipeline:${composition}`);
      setCouncilActive(true);
      try {
        const { runPipeline: execPipeline } = await import("../../core/pipelines/index.js");
        const result = await execPipeline({
          type: composition,
          prompt: message,
          sessionId: "illuci-tui",
          options: {
            onStageComplete: (stage) => {
              addItem({ type: "phase", text: `Stage complete: ${stage.label || stage.type}` });
            },
          },
        });
        addItem({ type: "phase", text: `Pipeline complete: ${result.status}` });
      } catch (err) {
        addItem({ type: "error", text: err.message });
      }
      setCouncilActive(false);
      setExecuting(false);
      setActiveModel(null);
      return;
    }

    // Parse flags for direct query
    const { flags, positional } = parseFlags(input.split(/\s+/));
    const cleanInput = positional.join(" ");

    // Default: direct query to default model — with windowed conversation context
    setExecuting(true);
    const targetModel = activeModelRef?.current || defaultModel;
    setActiveModel(targetModel);
    try {
      const { queryModel } = await import("../../core/dispatch/dispatch.js");
      const store = await import("../../core/context/store.js");
      const contextManager = await import("../../core/context/manager.js");

      // Record operator message
      store.appendMessage("illuci-tui", { role: "user", content: cleanInput });

      // Compress if needed (async, won't block if threshold not met)
      contextManager.maybeCompress("illuci-tui").catch(() => {});

      // Build model-specific context view
      const view = contextManager.buildView("illuci-tui", targetModel, {
        task: cleanInput,
        includeIdentity: true,
        includePeers: true,
        peerIds: Object.keys(MODEL_DEFAULTS),
      });

      // Assemble the full message with context
      const parts = [];
      if (view.systemContext) parts.push(view.systemContext);
      if (view.messages.length > 0) {
        const history = view.messages.map(m => {
          const tag = m.modelId || m.role;
          return `[${tag}]: ${m.content}`;
        }).join("\n\n");
        parts.push(`Conversation history:\n${history}`);
      }
      parts.push(`---\n\nOperator: ${cleanInput}`);

      const result = await queryModel(targetModel, parts.join("\n\n"), { 
        projectId: "illuci-tui", 
        seat: "chat",
        reasoning: flags.reasoning || null,
        timeoutMs: flags.timeout ? parseInt(flags.timeout, 10) : null
      });

      if (result.error) {
        addItem({ type: "error", text: result.error });
      } else {
        addItem({ type: "response", text: result.response || "" });
        // Record model response
        contextManager.recordOutput("illuci-tui", targetModel, result.response || "", {});
      }
      addItem({ type: "info", text: `${(result.latency / 1000).toFixed(1)}s  ${view.tokensUsed.toLocaleString()}tok ctx`, color: T.dim });
      setTokens(prev => prev + (result.usage?.total_tokens || 0));
    } catch (err) {
      addItem({ type: "error", text: err.message });
    }
    setExecuting(false);
    setActiveModel(null);
  }, [addItem, exit, defaultModel]);

  // ─── HISTORY NAVIGATION ───

  const handleHistoryNavigate = useCallback((index) => {
    setHistoryPointer(index);
    setCurrentInput(index < commandHistory.length ? commandHistory[index] : "");
  }, [commandHistory]);

  // ─── TAB COMPLETION ───

  const handleTabComplete = useCallback((currentValue, setValue) => {
    const tokens = currentValue.split(/\s+/);
    const last = tokens[tokens.length - 1];

    if (tokens[0] === "council" && tokens.length === 2) {
      const ids = listTopologies().filter(id => id.startsWith(last || ""));
      if (ids.length === 1) setValue(`council ${ids[0]} `);
      else if (ids.length > 1) addItem({ type: "info", text: ids.join("  "), color: T.muted });
      return;
    }

    if (tokens[0] === "ask" && tokens.length === 2) {
      const ids = Object.keys(MODEL_DEFAULTS).filter(id => id.startsWith(last || ""));
      if (ids.length === 1) setValue(`ask ${ids[0]} `);
      else if (ids.length > 1) addItem({ type: "info", text: ids.join("  "), color: T.muted });
      return;
    }

    if (currentValue.startsWith("/") && !currentValue.includes(" ")) {
      const prefix = currentValue.slice(1);
      const names = listSkills().map(s => s.name).filter(n => n.startsWith(prefix));
      if (names.length === 1) setValue(`/${names[0]} `);
      else if (names.length > 1) addItem({ type: "info", text: names.map(n => "/" + n).join("  "), color: T.muted });
      return;
    }
  }, [addItem]);

  // ─── RENDER ───

  const wideEnough = cols >= 80;

  return h(Box, { flexDirection: "column", width: cols },
    // Header bar
    h(HeaderBar, { projectName, contextStats, gateStats, councilActive, cols }),

    // Main area: sidebar (if wide enough) + content
    h(Box, { flexDirection: "row", flexGrow: 1 },

      // Left sidebar — fleet panel (hidden on narrow terminals)
      wideEnough && h(FleetSidebar, { models, activePhase, tokens, councilActive, councilLineup }),

      // Main content column
      h(Box, { flexDirection: "column", flexGrow: 1 },
        // Static output — scrolls naturally in terminal
        h(Static, { items },
          (item) => h(OutputItem, { key: item.id, item }),
        ),

        // Gate approval overlay
        gate && h(Box, { flexDirection: "column", paddingX: 1, borderStyle: "single", borderColor: T.warn },
          h(Text, { bold: true, color: T.warn }, "GATE APPROVAL"),
          h(Text, { color: T.muted }, `${gate.model} (${gate.seat}) \u2192 ${gate.tool}`),
          h(Text, null, gate.description),
          h(Text, { color: T.muted }, "y = approve, n = deny"),
        ),

        // Input prompt
        h(Box, { paddingX: 1, height: 1 },
          executing && h(Spinner, { spinner: STAR_PULSE_SPINNER }),
          executing && h(Text, { color: T.muted }, ` ${activeModel || ""} `),
          !executing && h(Text, { bold: true, color: T.brand }, "\u276F "),
          !executing && h(TextInput, {
            value: currentInput,
            onChange: (v) => {
              setCurrentInput(v);
              if (v === "/" || (v.startsWith("/") && v.length === 1)) setShowSkillPalette(true);
            },
            onSubmit: (v) => {
              if (v.trim()) {
                handleCommand(v.trim());
                setCurrentInput("");
              }
            },
            placeholder: "message or command...",
            isDisabled: showSkillPalette,
          }),
        ),
      ),
    ),

    // Status bar — fallback fleet line on narrow terminals + mode/keybindings
    wideEnough
      ? h(StatusBar, { mode: councilActive ? "Council" : "Normal", message: statusMessage, cols })
      : h(Box, { paddingX: 1, height: 1, justifyContent: "space-between", width: cols },
          h(FleetLine, { models }),
          h(Text, { color: T.dim }, `${tokens.toLocaleString()} tok`),
        ),
  );
}

// ─── ENTRY ───

export async function startTUI(options = {}) {
  if (!process.stdin.isTTY) {
    console.error("\n  Illuci requires an interactive terminal.\n  Use 'illuci --stream' for piped/headless mode.\n");
    process.exit(1);
  }

  const instance = render(h(IlluciApp, { initialCommand: options.command }), {
    exitOnCtrlC: true,
  });

  await instance.waitUntilExit();
}

export default { startTUI };
