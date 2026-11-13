import { existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_ILLUCI_ROOT_DIR = "Illuci";

function firstExisting(candidates = []) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function extractWindowsDrive(candidate) {
  if (typeof candidate !== "string") return null;
  const match = candidate.match(/^([a-zA-Z]:)/);
  return match?.[1] || null;
}

function isWindowsPathLike(candidate) {
  return typeof candidate === "string" && (/^[a-zA-Z]:(?:[\\/]|$)/.test(candidate) || candidate.startsWith("\\\\"));
}

function joinToolPath(root, ...segments) {
  if (!isWindowsPathLike(root)) return join(root, ...segments);

  const base = String(root).replace(/[\\/]+$/, "");
  const tail = segments
    .filter((segment) => segment !== null && segment !== undefined && String(segment) !== "")
    .map((segment) => String(segment).replace(/^[\\/]+|[\\/]+$/g, "").replace(/[\\/]+/g, "\\"))
    .filter(Boolean)
    .join("\\");
  return tail ? `${base}\\${tail}` : base;
}

function inferDriveScopedIlluciRoot() {
  const explicitDrive = extractWindowsDrive(process.env.ILLUCI_DRIVE)
    || extractWindowsDrive(process.env.SYSTEMDRIVE)
    || extractWindowsDrive(process.env.SystemDrive)
    || extractWindowsDrive(process.env.HOMEDRIVE);

  const drive = explicitDrive
    || (process.platform === "win32"
      ? extractWindowsDrive(process.cwd())
        || extractWindowsDrive(REPO_ROOT)
        || extractWindowsDrive(homedir())
      : null);

  if (!drive) return null;

  const dirName = process.env.ILLUCI_ROOT_DIR_NAME || DEFAULT_ILLUCI_ROOT_DIR;
  return joinToolPath(`${drive}\\`, dirName);
}

export function resolveIlluciHomeRoot() {
  const driveScoped = inferDriveScopedIlluciRoot();
  return process.env.ILLUCI_HOME
    || process.env.ILLUCI_TOOL_HOME
    || firstExisting([driveScoped])
    || driveScoped
    || homedir();
}

export function resolveToolStateHome(toolName, envVar = `${toolName.toUpperCase()}_HOME`) {
  return process.env[envVar] || joinToolPath(resolveIlluciHomeRoot(), `.${toolName}`);
}

function withCmdExtension(commandName) {
  if (process.platform !== "win32") return commandName;
  return commandName.endsWith(".cmd") || commandName.endsWith(".exe")
    ? commandName
    : `${commandName}.cmd`;
}

function canonicalBinCandidates(commandName) {
  const root = resolveIlluciHomeRoot();
  if (process.platform === "win32") {
    return [
      joinToolPath(root, ".bin", `${commandName}.cmd`),
      joinToolPath(root, ".bin", `${commandName}.exe`),
      joinToolPath(root, ".bin", commandName),
      joinToolPath(root, "AppData", "Roaming", "npm", `${commandName}.cmd`),
      joinToolPath(root, "AppData", "Roaming", "npm", commandName),
      joinToolPath(root, ".local", "bin", `${commandName}.exe`),
      joinToolPath(root, ".local", "bin", commandName),
    ];
  }

  return [
    joinToolPath(root, ".bin", commandName),
    joinToolPath(root, ".local", "bin", commandName),
  ];
}

/** The REAL user profile's npm-global shims ([A45]/F-087): npm-installed CLIs
 *  (gemini, …) live under the genuine %APPDATA%\npm, which interactive shells
 *  reach via PATH but detached services do not. canonicalBinCandidates probes the
 *  relocated canonical tool-home; this probes where npm actually installed. */
function userNpmGlobalCandidates(commandName) {
  if (process.platform !== "win32") return [];
  const npmDir = join(homedir(), "AppData", "Roaming", "npm");
  return [join(npmDir, `${commandName}.cmd`), join(npmDir, `${commandName}.exe`), join(npmDir, commandName)];
}

export function resolveCommandPath(commandName, envVar, extraCandidates = []) {
  return process.env[envVar]
    || firstExisting([
      ...extraCandidates,
      ...canonicalBinCandidates(commandName),
      ...userNpmGlobalCandidates(commandName),
    ])
    // [A46]/F-088: the bare fallback must not force ".cmd" onto a name that
    // resolves on PATH as a native .exe (agy, grok) — cmd.exe resolves the bare
    // name via PATHEXT, but "agy.cmd" matches nothing when only agy.exe exists.
    // Names NOT on PATH keep the historical .cmd shim expectation.
    || (resolvesOnPath(commandName) ? commandName : withCmdExtension(commandName));
}

export function buildCanonicalToolEnv(extraEnv = {}, toolName = null) {
  const root = resolveIlluciHomeRoot();
  const env = { ...process.env, ...extraEnv };
  const roaming = joinToolPath(root, "AppData", "Roaming");
  const local = joinToolPath(root, "AppData", "Local");
  const tmp = joinToolPath(local, "Temp");
  const config = joinToolPath(root, ".config");
  const cache = joinToolPath(root, ".cache");
  const state = joinToolPath(root, ".local", "state");

  env.HOME = root;
  env.XDG_CONFIG_HOME = config;
  env.XDG_CACHE_HOME = cache;
  env.XDG_STATE_HOME = state;

  if (process.platform === "win32") {
    const drive = root.slice(0, 2);
    const tail = root.slice(2) || "\\";
    env.USERPROFILE = root;
    env.HOMEDRIVE = drive;
    env.HOMEPATH = tail.startsWith("\\") ? tail : `\\${tail}`;
    env.APPDATA = roaming;
    env.LOCALAPPDATA = local;
    env.TEMP = tmp;
    env.TMP = tmp;
  }

  if (toolName) {
    env[`${toolName.toUpperCase()}_HOME`] = resolveToolStateHome(toolName);
  }

  return env;
}

export function getCodexSourceHome() {
  return process.env.CODEX_SOURCE_HOME
    || process.env.ILLUCI_CODEX_HOME
    || process.env.CODEX_HOME
    || resolveToolStateHome("codex");
}

export function getCodexRuntimeHome() {
  if (process.env.CODEX_RUNTIME_HOME) return process.env.CODEX_RUNTIME_HOME;
  return join(tmpdir(), "illuci-codex-home");
}

/** The Anthropic Claude CLI. Resolution: CLAUDE_PATH → the Anthropic vendor folder
 *  under the configured vendor root (.local\bin\claude.exe) → canonical ILLUCI_HOME bins → bare
 *  fallback. The vendor candidates fix the post-npm layout: the operator's CLIs
 *  live per-vendor (Anthropic\.local\bin\claude.exe), so the old `claude.cmd`
 *  npm-shim fallback spawned a name that no longer exists anywhere. */
export function getClaudeCommand() {
  const pb = findVendorRoot();
  const extra = [];
  if (pb) {
    extra.push(join(pb, "Anthropic", ".local", "bin", "claude.exe"));
    extra.push(join(pb, "Anthropic", ".local", "bin", "claude.cmd"));
    extra.push(join(pb, "Anthropic", ".local", "bin", "claude"));
  }
  return resolveCommandPath("claude", "CLAUDE_PATH", extra);
}

/** The Google Gemini CLI (legacy `gemini`; the agy CLI has its own bridge path).
 *  Same vendor-folder resolution as claude/grok. */
export function getGeminiCommand() {
  const pb = findVendorRoot();
  const extra = [];
  if (pb) {
    extra.push(join(pb, "Google", ".local", "bin", "gemini.exe"));
    extra.push(join(pb, "Google", ".local", "bin", "gemini.cmd"));
    extra.push(join(pb, "Google", ".local", "bin", "gemini"));
  }
  return resolveCommandPath("gemini", "GEMINI_PATH", extra);
}

/** Explicit optional vendor-install root. Command-specific paths and PATH also work. */
export function findVendorRoot({ env = process.env } = {}) {
  return env.ILLUCI_VENDOR_ROOT || null;
}

/** The official xAI "Grok Build" CLI. Resolution: GROK_PATH → the xAI vendor folder under
 *  the configured vendor root (grok\bin\grok.exe) → canonical ILLUCI_HOME bins → bare `grok` on PATH. */
export function getGrokCommand() {
  const pb = findVendorRoot();
  const extra = [];
  if (pb) {
    extra.push(join(pb, "xAI", "grok", "bin", "grok.exe"));
    extra.push(join(pb, "xAI", "grok", "bin", "grok"));
    extra.push(join(pb, "xAI", ".local", "bin", "grok.exe"));
    extra.push(join(pb, "xAI", ".local", "bin", "grok"));
  }
  return resolveCommandPath("grok", "GROK_PATH", extra);
}

/** The Google Antigravity (agy) CLI — the live Gemini channel (AI Ultra OAuth, no
 *  free-tier 429). agy install puts it on PATH; the vendor folder is the fallback.
 *  Presence is a NECESSARY precondition — the full PTY+OAuth pipeline's liveness is
 *  preflight-probe-determined, not asserted here. */
export function getAgyCommand() {
  const pb = findVendorRoot();
  const extra = [];
  if (pb) {
    extra.push(join(pb, "Google", ".local", "bin", "agy.exe"));
    extra.push(join(pb, "Google", ".local", "bin", "agy"));
  }
  return resolveCommandPath("agy", "AGY_PATH", extra);
}

export function getKimiCommand() {
  const root = resolveIlluciHomeRoot();
  const executable = process.platform === "win32" ? "kimi.exe" : "kimi";

  return process.env.KIMI_PATH
    || firstExisting([
      joinToolPath(root, "AppData", "Roaming", "uv", "tools", "kimi-cli", "Scripts", executable),
      joinToolPath(root, ".local", "bin", executable),
      joinToolPath(root, ".bin", executable),
    ])
    || executable;
}

/** Does a bare command name resolve to a real executable on PATH? Cross-platform,
 *  no spawn (honors PATHEXT on Windows so "kimi" matches "kimi.exe"/"kimi.cmd"). */
export function resolvesOnPath(commandName) {
  const pathVar = process.env.PATH || process.env.Path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const base = commandName.replace(/\.(exe|cmd|bat)$/i, "");
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    if (existsSync(join(dir, commandName))) return true;
    for (const ext of exts) {
      if (existsSync(join(dir, base + ext))) return true;
    }
  }
  return false;
}

/** True only when the Kimi (Moonshot) CLI is actually present — a real resolved path
 *  that exists, or a bare name reachable on PATH. getKimiCommand() returns the bare
 *  executable as a last-resort fallback even when nothing is installed, so callers must
 *  not treat a non-null command as "installed"; this is the authoritative check that
 *  availability (capability-matrix, health monitor) and the bridge preflight share. */
export function isKimiInstalled() {
  if (process.env.KIMI_PATH) return existsSync(process.env.KIMI_PATH);
  const cmd = getKimiCommand();
  if (cmd.includes("\\") || cmd.includes("/")) return existsSync(cmd);
  return resolvesOnPath(cmd);
}
