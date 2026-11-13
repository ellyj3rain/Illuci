/**
 * illuci — Claude Bridge (Subscription CLI)
 *
 * Spawns local Claude Code CLI in print mode with OAuth auth.
 * Strips ANTHROPIC_API_KEY to force subscription routing.
 * System prompts via temp file (Windows command-line length limit).
 *
 * Sub-model selection (core-loop capability spine): the `model` option accepts
 * a illuci sub-model id (claude-fable / claude-opus / claude-sonnet / claude-haiku)
 * or a CLI alias (fable / opus / sonnet / haiku); it resolves to the CLI's
 * --model value. Default is Fable 5.
 *
 * Double-agency containment (core-loop audit): as a DISPATCH model the inner
 * Claude CLI must not be a second autonomous agent operating outside illuci's gate.
 * So by default it is granted NO tools and never runs with
 * --dangerously-skip-permissions — it returns a text response and illuci's loop
 * executes any tools through executeTool (the single gated surface). A caller
 * that genuinely wants the inner CLI to act natively must opt in explicitly via
 * options.nativeAgent, and even then permissions are not blanket-skipped unless
 * options.skipPermissions is also set.
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getClaudeCommand } from "./tool-paths.js";
import { resolveCliLaneWorkspace } from "./cli-sandbox.js";
import { cliReportedError } from "./cli-error.js";
import { getEntry } from "./model-registry.js";

const CMD = getClaudeCommand();
const DEFAULT_MODEL = process.env.CLAUDE_BRIDGE_MODEL || "claude-fable-5";

/** Resolve a illuci sub-model id or CLI alias to the CLI --model value. */
// Resolution rides the model registry (the single source of truth): any known
// spelling (canonical id, legacy alias incl. "fable"/"claude-local", cli
// shortcut, provider model string) lands on one entry. Prefer the CLI shortcut
// where the CLI has one (opus/sonnet/haiku); Fable has none, so the full model
// id dispatches. Unknown strings pass through for forward-compat.
const DEFAULT_ID = process.env.CLAUDE_BRIDGE_MODEL || "claude-fable";

function resolveCliModel(requested) {
  if (!requested) {
    const d = getEntry(DEFAULT_ID);
    return d ? (d.cliAlias || d.model) : DEFAULT_ID;
  }
  const entry = getEntry(requested);
  return entry ? (entry.cliAlias || entry.model) : requested;
}

export async function query(userMessage, options = {}) {
  const model = resolveCliModel(options.model);
  const start = Date.now();

  const args = ["-p", "--output-format", "json", "--model", model];

  // Containment: native-agent mode is opt-in. Default dispatch = pure model.
  const nativeAgent = options.nativeAgent === true;
  if (nativeAgent) {
    const allowed = options.allowedTools || "Read,Glob,Grep"; // read-only unless caller widens
    args.push("--allowedTools", allowed);
    // Only blanket-skip permissions when explicitly demanded; otherwise the CLI
    // runs under its own gate and illuci's gate still fronts the loop's tools.
    if (options.skipPermissions === true) args.push("--dangerously-skip-permissions");
  }

  // Session contract: prepend prior conversation as context
  if (options.sessionState && Array.isArray(options.sessionState) && options.sessionState.length > 0) {
    const history = options.sessionState.map(m => `[${m.role}]: ${m.content}`).join("\n\n");
    userMessage = `Prior conversation:\n${history}\n\n---\n\nCurrent message:\n${userMessage}`;
  }

  let sysFile = null;
  if (options.systemPrompt) {
    try {
      const dir = mkdtempSync(join(tmpdir(), "illuci-claude-"));
      sysFile = join(dir, "sys.txt");
      writeFileSync(sysFile, options.systemPrompt, "utf-8");
      args.push("--system-prompt-file", sysFile);
    } catch {
      userMessage = options.systemPrompt + "\n\n---\n\n" + userMessage;
    }
  }

  // Use the REAL environment: the Claude CLI stores its login under the user
  // profile (~/.claude/.credentials.json). Relocating HOME/APPDATA to the
  // canonical tool-home points it at an empty profile and the CLI reports
  // "Not logged in". Same lesson grok-cli.js carries. ANTHROPIC_API_KEY is
  // still dropped so dispatch rides the CLI login, never API billing.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  // The DISPATCH layer owns timeout policy: it races bridge.query() against the
  // caller/adaptive timeout (dispatch.js) and is the single authority on when a
  // slow dispatch is abandoned. The spawn `timeout` here is only a last-resort
  // backstop against a truly wedged child — it must NEVER undercut or collide
  // with the dispatch race, or its blind SIGTERM kills the child mid-generation
  // and surfaces as `Claude CLI null:` / `Claude CLI 143:` (143 = 128+15 =
  // SIGTERM), which the resilience layer can't classify and retries as
  // "transient unknown", stalling a council. The previous flat 300000 exactly
  // equaled the highest adaptive tier (xhigh) and the operator's common
  // `--timeout 300000`, so the two fired at the same instant and the spawn kill
  // routinely won. Sit the backstop above any dispatch-managed ceiling: caller
  // timeout (when threaded) plus generous headroom, else a high floor. A cold
  // Opus model-load / long deep-reasoning generation now runs to the dispatch
  // race's verdict instead of being killed by the bridge's own clock.
  const callerTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 0;
  const spawnTimeoutMs = Math.max(600000, callerTimeoutMs + 120000);

  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      const proc = spawn(CMD, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: spawnTimeoutMs, env,
        // DR-200/F-139 — the claude CLI is an agentic host with native file and
        // shell tools; it grounds in a per-dispatch sandbox unless the operator
        // explicitly opts into the shared workspace.
        cwd: resolveCliLaneWorkspace(options).cwd,
        // shell:false when CMD resolved to a real executable path - spawn runs it
        // directly and spaces in the path survive. Under shell:true cmd.exe splits
        // the spaced vendor path ('C:/Users/example-user/Example Project' is not recognized).
        // The bare/.cmd npm-shim fallback still needs the shell to resolve.
        // Same lesson grok-cli.js carries.
        shell: !CMD.endsWith(".exe"),
      });
      let out = "", err = "";
      let settled = false;
      const resolveOnce = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const rejectOnce = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => {
        if (code !== 0 && !out) rejectOnce(new Error(`Claude CLI ${code}: ${err.substring(0, 300)}`));
        else resolveOnce(out);
      });
      proc.on("error", (e) => rejectOnce(e));
      proc.stdin.on("error", (e) => rejectOnce(e));
      try {
        proc.stdin.end(userMessage);
      } catch (err) {
        rejectOnce(err);
      }
    });
  } finally {
    if (sysFile) try { unlinkSync(sysFile); } catch {}
  }

  const latency = Date.now() - start;
  let response = "", usage = {};
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* non-JSON: raw text response below */ }
  if (parsed) {
    // [A46]/F-088: the CLI can exit 0 while reporting failure in-band
    // ({ is_error: true, result: "Not logged in · …" }); the check sits OUTSIDE
    // the parse-catch so the throw is not swallowed into the raw-text fallback.
    const cliErr = cliReportedError(parsed);
    if (cliErr) throw new Error(`Claude CLI reported an error: ${cliErr}`);
    response = parsed.result || parsed.content || parsed.text || stdout.trim();
    if (parsed.usage) {
      usage = {
        prompt_tokens: parsed.usage.input_tokens || 0,
        completion_tokens: parsed.usage.output_tokens || 0,
        total_tokens: (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0),
      };
    }
  } else {
    response = stdout.trim();
  }

  // Build updated session state
  const priorMessages = options.sessionState || [];
  const sessionState = [
    ...priorMessages,
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ];

  return { model: "claude-local", role: options.role || "agent", response, usage, latency, sessionState };
}

export default { query };
