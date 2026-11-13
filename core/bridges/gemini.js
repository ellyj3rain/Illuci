/**
 * illuci — Gemini Bridge (Subscription CLI)
 *
 * Spawns Gemini CLI with OAuth subscription auth.
 * Prompt written to temp file, piped via stdin to avoid shell escaping.
 * Gemini SCANS its cwd on startup — under DR-200 it grounds in a per-dispatch
 * sandbox by default, and under DR-204 it runs GATED (--approval-mode=plan)
 * unless the caller explicitly sets writeMode:true (then yolo).
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { buildCanonicalToolEnv, getGeminiCommand } from "./tool-paths.js";
import { resolveCliLaneWorkspace } from "./cli-sandbox.js";
import { autoApproveEnabled } from "./write-mode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const DEFAULT_MODEL = process.env.GEMINI_BRIDGE_MODEL || "gemini-3.1-pro-preview";
const CMD = getGeminiCommand();

export async function query(userMessage, options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const start = Date.now();

  // Session contract: prepend prior conversation as context
  if (options.sessionState && Array.isArray(options.sessionState) && options.sessionState.length > 0) {
    const history = options.sessionState.map(m => `[${m.role}]: ${m.content}`).join("\n\n");
    userMessage = `Prior conversation:\n${history}\n\n---\n\nCurrent message:\n${userMessage}`;
  }

  const fullMessage = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${userMessage}`
    : userMessage;

  // Write prompt to temp file to avoid shell argument issues
  const tmpDir = mkdtempSync(join(tmpdir(), "illuci-gemini-"));
  const promptFile = join(tmpDir, "prompt.txt");
  writeFileSync(promptFile, fullMessage, "utf-8");

  const env = buildCanonicalToolEnv({}, "gemini");
  // The Gemini CLI finds its login/auth at ~/.gemini via os.homedir()
  // (USERPROFILE on Windows). buildCanonicalToolEnv rewrites HOME/USERPROFILE to
  // the illuci root (e.g. C:\Illuci), which hides the operator's real ~/.gemini login
  // and forces the CLI into GEMINI_API_KEY mode. Restore the real home so the
  // CLI's own OAuth / gateway / subscription auth is found (an explicit API key,
  // set below, still wins because that path is checked first).
  const realHome = process.env.USERPROFILE || process.env.HOME;
  if (realHome) {
    env.USERPROFILE = realHome;
    env.HOME = realHome;
  }
  // Keep API key if present, and copy to GOOGLE_API_KEY to satisfy different CLI versions
  if (process.env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!env.GOOGLE_API_KEY) {
      env.GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
    }
  }
  // Trust the workspace to avoid interactive trust prompts in headless mode
  env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  // DR-200/F-139 — an explicit options.cwd remains the stronger control;
  // otherwise the lane grounds in the per-dispatch sandbox, and the disclosed
  // `shared` opt-out restores the historical project-root grounding.
  const sandbox = resolveCliLaneWorkspace(options);
  const cwd = options.cwd || (sandbox.mode === "shared"
    ? (process.env.ILLUCI_PROJECT_DIR || PROJECT_ROOT)
    : sandbox.cwd);

  let stdout;
  try {
    // Pipe prompt file to gemini via shell — avoids arg escaping on Windows.
    // The piped stdin IS the prompt: the current Gemini CLI reads a non-TTY
    // stdin as the prompt, so we must NOT also pass `-p` (an explicit `-p " "`
    // wins and the model receives an empty prompt — it replies "ready for
    // instructions" and ignores stdin). Use --approval-mode= (not -y/--yolo)
    // to avoid conflict with user config; the = form is unambiguous.
    // --skip-trust: the current CLI refuses (exit 55) in any directory not in
    // its trusted-folders list; council dispatch needs no folder tools, so we
    // skip the trust gate rather than depend on per-folder operator trust.
    // DR-204/F-144 — FAIL CLOSED: yolo (auto-approve every tool) requires the
    // caller's explicit writeMode:true (write/execute/delegate phase seats, MCP
    // bypass posture). Everything else runs `plan`, the CLI's read-only mode —
    // the same gated mode respond/read phases have always used.
    const approvalMode = autoApproveEnabled(options) ? "yolo" : "plan";
    const pipeCmd = process.platform === "win32"
      ? `type "${promptFile}" | "${CMD}" -m ${model} -o json --approval-mode=${approvalMode} --skip-trust`
      : `cat "${promptFile}" | "${CMD}" -m ${model} -o json --approval-mode=${approvalMode} --skip-trust`;

    stdout = await new Promise((resolve, reject) => {
      const proc = spawn(pipeCmd, [], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 300000, env, shell: true, cwd,
      });
      let out = "", err = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => {
        if (code !== 0 && !out) reject(new Error(`Gemini CLI ${code}: ${err.substring(0, 300)}`));
        else resolve(out);
      });
      proc.on("error", (e) => reject(e));
    });
  } finally {
    try { unlinkSync(promptFile); } catch {}
  }

  const latency = Date.now() - start;
  let response = "", usage = {};

  // Gemini JSON may have non-JSON lines before the object (YOLO warnings etc.)
  const jsonStart = stdout.indexOf("{");
  const jsonStr = jsonStart >= 0 ? stdout.substring(jsonStart) : stdout;

  try {
    const parsed = JSON.parse(jsonStr);
    response = parsed.response || parsed.result || parsed.content || jsonStr.trim();
    // Gemini reports tokens under stats.models.<model>.tokens
    const modelTokens = parsed.stats?.models?.[model]?.tokens;
    if (modelTokens) {
      usage = {
        prompt_tokens: modelTokens.input || 0,
        completion_tokens: modelTokens.output || 0,
        total_tokens: (modelTokens.input || 0) + (modelTokens.output || 0),
      };
    }
  } catch { response = stdout.trim(); }

  const priorMessages = options.sessionState || [];
  const sessionState = [
    ...priorMessages,
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ];

  return { model: "gemini-local", role: options.role || "agent", response, usage, latency, sessionState };
}

export default { query };
