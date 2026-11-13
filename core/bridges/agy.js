/**
 * illuci — Antigravity (agy) Bridge: subscription multi-model gateway, headless.
 *
 * Routes through a separately installed and authenticated Google Antigravity
 * `agy` CLI. Account eligibility, available models and service limits belong to
 * that installation and service.
 *
 * agy's `--print` mode emits nothing to a non-TTY stdout (upstream antigravity-cli
 * bug #76), so we drive it through a Windows pseudo-console: the `agy_pty.py` helper
 * hands agy a ConPTY (via pywinpty), captures the render, de-ANSIs it, and writes the
 * response to a UTF-8 file this bridge reads. Sibling to grok-cli.js (the xAI
 * subscription-CLI bridge); same query/return contract.
 *
 * Model is the agy display name (e.g. "Gemini 3.1 Pro (High)"), resolved from
 * options.agyModel / options.model / AGY_BRIDGE_MODEL. The (Low|Medium|High) suffix
 * is agy's per-model reasoning tier.
 *
 * Containment (DR-205/[A118], the DR-202 residual's agy slice): agy is a full
 * agentic host with terminal + file tools. It ships its OWN sandbox subsystem
 * (`--sandbox`: terminal restrictions + a network sandboxproxy with a CEL policy
 * enforcer — in-process Go, so unlike grok's kernel-primitive jail it is not a
 * win32 no-op) and its own approval modes (`--mode plan|accept-edits`). This
 * bridge engages `--sandbox` by default and fails the mode CLOSED to `plan`,
 * opting into `accept-edits` only on explicit writeMode; it NEVER emits agy's
 * `--dangerously-skip-permissions`. See buildAgyArgs.
 */

import { spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { resolveCliLaneWorkspace } from "./cli-sandbox.js";
import { autoApproveEnabled } from "./write-mode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "agy_pty.py");
const PYTHON = process.env.ILLUCI_PYTHON || "py";
const DEFAULT_MODEL = process.env.AGY_BRIDGE_MODEL || "Gemini 3.5 Flash (Medium)";
const DEFAULT_PROMPT_ARG_LIMIT = 24000;

// agy's own execution-mode enum (`agy --help`: --mode accept-edits|plan). `plan` is
// read-only (no edits, gated); `accept-edits` auto-approves edits. There is no
// per-tool-prompt value that survives a non-TTY --print run, so the fail-closed
// default is `plan` and the writeMode opt-in is `accept-edits`. `--dangerously-skip-
// permissions` (agy's --yolo equivalent) is DELIBERATELY never emitted here.
const AGY_MODES = Object.freeze(["plan", "accept-edits"]);

/**
 * Build the argv for the ConPTY helper with the [A118]/DR-205 containment flags
 * engaged: agy's OWN `--sandbox` (terminal restrictions + the sandboxproxy CEL
 * enforcer — a real in-process subsystem, not a kernel-primitive jail, so unlike
 * grok it is not a win32 no-op) is default-ON, and `--mode` fails closed to `plan`
 * unless the caller explicitly opted into writes.
 *
 * Precedence (explicit-controls law, DR-129/130):
 *   sandbox — options.agySandbox > env ILLUCI_AGY_SANDBOX > default on; `off`/false opts out.
 *   mode    — options.agyMode > env ILLUCI_AGY_MODE > (writeMode ? accept-edits : plan).
 * An unknown mode value degrades LOUDLY to `plan` (the safe side).
 *
 * @returns {string[]} args AFTER the helper's [outFile] positional (helper + outFile
 *   are prepended by the caller); pure + injectable env for tests.
 */
export function buildAgyArgs(outFile, prompt, model, timeout, options = {}, env = process.env) {
  // OS-jail: default ON. Disclosed opt-out (a determined seat with a real reason).
  const sandboxOff =
    options.agySandbox === false ||
    options.agySandbox === "off" ||
    (options.agySandbox == null && String(env.ILLUCI_AGY_SANDBOX || "").trim().toLowerCase() === "off");

  // Approval posture: fail closed to plan; accept-edits only on explicit writeMode.
  let mode = null;
  if (typeof options.agyMode === "string" && options.agyMode.length > 0) mode = options.agyMode;
  else if (typeof env.ILLUCI_AGY_MODE === "string" && env.ILLUCI_AGY_MODE.length > 0) mode = env.ILLUCI_AGY_MODE;
  else mode = autoApproveEnabled(options) ? "accept-edits" : "plan";
  mode = String(mode).trim().toLowerCase();
  if (!AGY_MODES.includes(mode)) mode = "plan";

  const args = [HELPER, outFile];
  if (!sandboxOff) args.push("--sandbox");
  args.push("--mode", mode);
  args.push("--print", prompt, "--model", model, "--print-timeout", timeout);
  return args;
}

export function buildAgyPrompt(userMessage, options = {}) {
  let prompt = userMessage;
  if (Array.isArray(options.sessionState) && options.sessionState.length > 0) {
    const history = options.sessionState.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    prompt = `Prior conversation:\n${history}\n\n---\n\nCurrent message:\n${prompt}`;
  }
  if (options.systemPrompt) {
    prompt = `${options.systemPrompt}\n\n---\n\n${prompt}`;
  }
  return prompt;
}

export function classifyAgyPromptArg(prompt, options = {}) {
  const envLimit = Number.parseInt(process.env.ILLUCI_AGY_PROMPT_ARG_LIMIT || "", 10);
  const optionLimit = Number.isFinite(options.promptArgLimit) ? Number(options.promptArgLimit) : null;
  const limit = optionLimit || (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_PROMPT_ARG_LIMIT);
  const length = String(prompt || "").length;

  return {
    ok: length <= limit,
    length,
    limit,
    reason: length <= limit ? null : "command-line-limit",
  };
}

export async function query(userMessage, options = {}) {
  const start = Date.now();

  // System prompt + prior session fold into the single-turn prompt (mirrors the
  // grok/claude subscription bridges).
  const prompt = buildAgyPrompt(userMessage, options);
  const promptPosture = classifyAgyPromptArg(prompt, options);
  if (!promptPosture.ok) {
    const err = new Error(
      `agy bridge prompt exceeds command-line safe limit ` +
      `(${promptPosture.length} > ${promptPosture.limit}); ` +
      `route through a shorter handoff`
    );
    err.code = "AGY_PROMPT_TOO_LONG";
    err.details = promptPosture;
    throw err;
  }

  const model = options.agyModel || options.model || DEFAULT_MODEL;
  const timeout = options.timeoutMs ? `${Math.ceil(options.timeoutMs / 1000)}s` : "120s";

  const dir = mkdtempSync(join(tmpdir(), "illuci-agy-"));
  const outFile = join(dir, "response.txt");

  let response = "";
  try {
    await new Promise((resolve, reject) => {
      // DR-205/[A118] — engage agy's own containment: --sandbox (terminal
      // restrictions + sandboxproxy) default-on, --mode fail-closed to plan.
      const args = buildAgyArgs(outFile, prompt, model, timeout, options);
      const proc = spawn(PYTHON, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // Real environment: agy stores its OAuth login under the user profile, so do
        // NOT relocate HOME/APPDATA (that strands it waiting for an auth it can't find).
        env: process.env,
        shell: false,
        timeout: 300000,
        // DR-200/F-139 — agy drives an agentic host through a pty; ground it in
        // a per-dispatch sandbox unless the operator opts into shared.
        cwd: resolveCliLaneWorkspace(options).cwd,
      });
      let err = "";
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(`agy pty helper exit ${code}: ${err.substring(0, 300)}`));
        else resolve();
      });
      proc.on("error", reject);
    });
    response = readFileSync(outFile, "utf-8").trim();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  // Honor illuci's never-silently-succeed invariant: an empty capture is a failure
  // (agy not signed in, or the pty render produced nothing) — never a blank success.
  if (!response) {
    throw new Error("agy bridge returned empty (agy not signed in, or pty capture failed)");
  }

  const latency = Date.now() - start;
  const sessionState = [
    ...(options.sessionState || []),
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ];

  return { model: "agy", role: options.role || "agent", response, usage: {}, latency, sessionState };
}

export default { query };
