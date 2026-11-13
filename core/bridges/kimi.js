/**
 * illuci — Kimi K2 Bridge (CLI)
 *
 * Spawns Kimi CLI in print mode.
 * Kimi K2 by Moonshot AI — strong reasoning, multilingual.
 *
 * Prompt written to temp file and piped via stdin to avoid
 * ENAMETOOLONG on large context payloads.
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { buildCanonicalToolEnv, getKimiCommand, isKimiInstalled } from "./tool-paths.js";
import { resolveCliLaneWorkspace } from "./cli-sandbox.js";
import { autoApproveEnabled } from "./write-mode.js";

const CMD = getKimiCommand();

export async function query(userMessage, options = {}) {
  const start = Date.now();

  // Preflight: never hand an unresolved binary to the shell. getKimiCommand() falls back
  // to the bare "kimi.exe" when nothing is installed, and `type … | "kimi.exe"` under
  // shell:true then dies as the opaque `'"kimi.exe"' is not recognized`. Fail legibly and
  // point at the working alternative (capability-matrix already drops kimi-local from
  // auto-fill when this is false; this guards the explicit-seat path).
  if (!isKimiInstalled()) {
    throw new Error(
      "Kimi CLI (Moonshot) is not installed — `kimi-local` is unavailable on this machine. " +
      "Install the Moonshot CLI (or set KIMI_PATH), or use `kimi-cloud` (Ollama-hosted Kimi)."
    );
  }

  // Session contract: prepend prior conversation as context
  if (options.sessionState && Array.isArray(options.sessionState) && options.sessionState.length > 0) {
    const history = options.sessionState.map(m => `[${m.role}]: ${m.content}`).join("\n\n");
    userMessage = `Prior conversation:\n${history}\n\n---\n\nCurrent message:\n${userMessage}`;
  }

  const fullMessage = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${userMessage}`
    : userMessage;

  const tmpDir = mkdtempSync(join(process.env.TEMP || "/tmp", "illuci-kimi-"));
  const promptFile = join(tmpDir, "prompt.txt");
  writeFileSync(promptFile, fullMessage, "utf-8");

  const env = buildCanonicalToolEnv({
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  }, "kimi");

  // DR-204/F-144 — FAIL CLOSED: --yolo (auto-approve every tool) requires the
  // caller's explicit writeMode:true; the default is the gated print mode the
  // respond/read phases have always used.
  const writeFlags = autoApproveEnabled(options) ? "--yolo" : "";
  const pipeCmd = process.platform === "win32"
    ? `type "${promptFile}" | "${CMD}" --print --final-message-only ${writeFlags}`
    : `cat "${promptFile}" | "${CMD}" --print --final-message-only ${writeFlags}`;

  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      const proc = spawn(pipeCmd, [], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 300000,
        shell: true,
        windowsHide: true,
        env,
        // DR-200/F-139 — kimi is a full agentic CLI; ground it in a
        // per-dispatch sandbox unless the operator opts into shared.
        cwd: resolveCliLaneWorkspace(options).cwd,
      });
      const chunks = [];
      let err = "";
      proc.stdout.on("data", (d) => { chunks.push(d); });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => {
        const out = Buffer.concat(chunks).toString("utf-8");
        if (code !== 0 && !out) reject(new Error(`Kimi CLI ${code}: ${err.substring(0, 300)}`));
        else resolve(out);
      });
      proc.on("error", (e) => reject(e));
    });
  } finally {
    try { unlinkSync(promptFile); } catch {}
  }

  const latency = Date.now() - start;
  let response = "", usage = {};

  try {
    const parsed = JSON.parse(stdout);
    response = parsed.result || parsed.content || parsed.text || stdout.trim();
    if (parsed.usage) {
      usage = {
        prompt_tokens: parsed.usage.input_tokens || parsed.usage.prompt_tokens || 0,
        completion_tokens: parsed.usage.output_tokens || parsed.usage.completion_tokens || 0,
        total_tokens: (parsed.usage.input_tokens || parsed.usage.prompt_tokens || 0) +
                      (parsed.usage.output_tokens || parsed.usage.completion_tokens || 0),
      };
    }
  } catch {
    response = stdout.trim();
  }

  const priorMessages = options.sessionState || [];
  const sessionState = [
    ...priorMessages,
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ];

  return { model: "kimi-local", role: options.role || "agent", response, usage, latency, sessionState };
}

export default { query };
