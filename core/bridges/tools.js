/**
 * illuci — Tool Bridge
 *
 * Executes tools on behalf of models with gated write protection.
 * All file system, shell, and git operations flow through here.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, realpathSync, lstatSync } from 'fs';
import { basename, dirname, join, resolve, relative } from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback, execFile as execFileCallback } from 'child_process';
import { requestApproval } from '../gates/gate-controller.js';
import { isGated } from '../gates/gate-registry.js';
import { evaluateSkillGrant } from '../skills/grants.js';
import { evaluateToolCapability } from '../governance/grants/affordances.js';
import { logDecision } from '../decisions/logger.js';
import { isRoleGovernanceEnabled } from '../roles/config.js';
import { buildRoleContext } from '../roles/build-role-context.js';
import { resolveRoleId } from '../roles/role-registry.js';
import { DENIAL_CODES } from '../roles/denial-codes.js';
import { assertWorkPermit, isWorkPermitRequired } from '../governance/work-permit.js';

// ─── ROLE CAPABILITY CHECK (Phase 1, dark behind ILLUCI_ROLE_GOVERNANCE_ENABLED) ──
// Capability is checked HERE, at the stable TOOL boundary (never inside the gate
// classifier's evaluate() — glm's dissent). When armed AND the context carries a
// roleId, we derive the role's effective permission (the topology ceiling minus
// the role's subtractive tighten) and refuse an AUTHORING tool the role's
// effective permission does not include. Floor read tools and non-authoring
// tools are never capability-blocked here. Minimal + extensible: the set of
// capability-governed tools is named explicitly rather than buried in an opaque
// map, and a fuller tool→capability surface can extend CAPABILITY_GOVERNED_TOOLS.
const CAPABILITY_GOVERNED_TOOLS = new Set([
  'file_write', 'file_edit', 'file_delete', 'file_move',
  'git_add', 'git_commit',
]);

/**
 * Phase-1 role capability check at the tool boundary.
 *
 * @param {string} name — tool name
 * @param {object} context — execution context (may carry roleId, topologyId)
 * @returns {{ allow: boolean, reason: string }}
 */
function checkRoleCapability(name, context) {
  // Dark: flag off → never blocks (behavior identical to pre-Phase-1).
  if (!isRoleGovernanceEnabled()) return { allow: true, reason: 'role governance off' };

  // No role on the context → nothing role-scoped to enforce.
  const rawRole = context && context.roleId;
  if (!rawRole) return { allow: true, reason: 'no roleId on context' };

  // Only AUTHORING tools are capability-governed in Phase 1.
  if (!CAPABILITY_GOVERNED_TOOLS.has(name)) {
    return { allow: true, reason: 'tool not capability-governed' };
  }

  const roleId = resolveRoleId(rawRole);
  if (!roleId) {
    // Unknown role + armed governance: fail closed for an authoring tool.
    return { allow: false, reason: `unknown role '${rawRole}' — no capability for '${name}'` };
  }

  const { effectivePermission } = buildRoleContext({ roleId, topology: context.topologyId });
  if (!effectivePermission.includes(name)) {
    return {
      allow: false,
      reason: `role '${roleId}' lacks the capability for '${name}' (not in its effective permission)`,
    };
  }
  return { allow: true, reason: `role '${roleId}' is capable of '${name}'` };
}

export let GLOBAL_HALT_FLAG = false;

export function setGlobalHalt(value) {
  GLOBAL_HALT_FLAG = value;
}

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

// --- HARD INVARIANT DEFINITIONS ---
const HARD_DENY_PATTERNS = [
  // System Destruction - file_delete, file_write on critical directories/files
  {
    tool: ['file_delete', 'file_write', 'file_edit', 'file_move'],
    param: 'path',
    regex: [
      /^\/$/, // Root directory (Linux/macOS)
      /^C:\\?$/, /^C:\\Windows/i, /^C:\\Program Files/i, /^C:\\System32/i, // Critical Windows directories
      /^\/boot/i, /^\/etc\/(passwd|shadow|fstab)/i, // Critical OS files
      /\bMBR\b/i, /\bEFI\b/i, // Boot related terms
    ],
    reason: "Attempted file operation on critical system directory/file."
  },
  // System Destruction - shell_exec with dangerous commands
  {
    tool: ['shell_exec'],
    param: 'command',
    regex: [
      /\brm\s+-rf\s+\//, // rm -rf /
      /\bdel\s+\/s\s+\/q\s+C:\\/, // del /s /q C:\
      /\bformat\b/i, /\bdiskpart\b/i, /\bfdisk\b/i, /\bmkfs\b/i, // Disk destruction
      /\bshutdown\b/i, /\breboot\b/i, // System shutdown/reboot
      /\breg\s+delete\s+HKLM\\SYSTEM/i, // Windows Registry destruction
      /\bpkill\s+1/i, /\bkill\s+-9\s+1/i, // Kill init/systemd (Linux)
    ],
    reason: "Attempted shell execution of a system destructive command."
  },
  // Credential Theft / Exfiltration - file_read on sensitive locations
  {
    tool: ['file_read'],
    param: 'path',
    regex: [
      /(^|\/)\.ssh\//, /(^|\/)\.aws\/(credentials|config)/, // SSH keys, AWS credentials
      /\.env$/i, // .env files
      /\bsecrets\.(json|yaml|yml|txt)/i, // Generic secrets files
      /\bprivate_key/i, /\bid_rsa/i, // Private keys
    ],
    reason: "Attempted file read from a sensitive credential location."
  },
  // Persistence - file_write to startup directories
  {
    tool: ['file_write', 'file_edit'],
    param: 'path',
    regex: [
      /\bStartup/i, /\binit\.d/i, /\bcron\.d/i, /\bLaunchAgents/i, // Startup directories
      /\.bashrc/i, /\.profile/i, /\.zshrc/i, // Shell profile files
    ],
    reason: "Attempted file write to a persistence-related directory/file."
  },
];

function checkHardInvariants(toolName, params) {
  for (const invariant of HARD_DENY_PATTERNS) {
    if (invariant.tool.includes(toolName)) {
      const paramValue = params[invariant.param];
      if (typeof paramValue === 'string') {
        for (const regex of invariant.regex) {
          if (regex.test(paramValue)) {
            return { blocked: true, reason: invariant.reason };
          }
        }
      }
    }
  }

  // ── Pre-gate parameter injection check for git operations ──
  // Metacharacters in git params indicate injection attempts.
  // This runs before gating to prevent hanging on interactive prompts.
  const GIT_PARAM_TOOLS = ['git_log', 'git_diff', 'git_add', 'git_commit', 'git_push'];
  if (GIT_PARAM_TOOLS.includes(toolName)) {
    const paramValues = [];
    if (params.message) paramValues.push(params.message);
    if (params.path) paramValues.push(params.path);
    if (params.limit && typeof params.limit === 'string') paramValues.push(params.limit);
    if (Array.isArray(params.paths)) paramValues.push(...params.paths);

    for (const val of paramValues) {
      if (typeof val === 'string' && SHELL_METACHARACTERS.test(val)) {
        return { blocked: true, reason: `Git parameter contains shell metacharacter in "${val.substring(0, 40)}".` };
      }
    }
  }

  // ── Pre-gate shell_exec validation ──
  // Reject commands that would fail allowlist/denylist BEFORE gating,
  // so invalid commands don't hang on interactive gate prompts.
  if (toolName === 'shell_exec' && params.command) {
    const cmd = params.command;

    // Absolute deny patterns (e.g. chmod, eval, piping to shell)
    for (const pattern of SHELL_EXEC_ABSOLUTE_DENY_PATTERNS) {
      if (pattern.test(cmd)) {
        return { blocked: true, reason: `Shell command blocked by deny list: ${pattern.source}` };
      }
    }

    // Metacharacter check (would fail parseCommandToArgv)
    if (SHELL_METACHARACTERS.test(cmd)) {
      return { blocked: true, reason: `Shell command contains metacharacter.` };
    }

    // Allowlist check against parsed executable
    const executable = cmd.trim().split(/\s+/)[0]?.toLowerCase();
    if (executable && !SHELL_EXEC_ALLOWLIST.includes(executable)) {
      return { blocked: true, reason: `Command "${executable}" not in allowlist.` };
    }
  }

  return { blocked: false };
}
// --- END HARD INVARIANT DEFINITIONS ---

// Duplicate summarizeArgs from gate-controller.js for now.
// TODO: Refactor summarizeArgs into a shared utility.
function summarizeArgs(args) {
  if (!args) return "";
  if (args.path) return args.path;
  if (args.command) return args.command.substring(0, 80);
  return JSON.stringify(args).substring(0, 100);
}

// --- PATH CONTAINMENT DEFINITIONS ---
let PROJECT_ROOT = process.cwd(); // default: the directory illuci was launched from

/**
 * Re-root the secured tool surface. Needed when illuci runs IN-PROCESS inside a
 * host (e.g. OTL importing the Agent SDK), where process.cwd() is the host's
 * directory, not the user's project. The containment logic is unchanged — only
 * the root it contains TO becomes configurable. Defaults back to process.cwd()
 * when called with a falsy value. Process-scoped, matching the one-active-run-
 * per-process posture.
 */
export function setWorkspaceRoot(root) {
  PROJECT_ROOT = root ? resolve(root) : process.cwd();
  return PROJECT_ROOT;
}

/** The current workspace root the tool surface contains file operations to. */
export function getWorkspaceRoot() {
  return PROJECT_ROOT;
}

const SENSITIVE_PROJECT_PATHS = [
  /\.git\/hooks\//i,         // Git hooks for CI pipeline injection
  /\.github\/workflows\//i,  // GitHub Actions workflows for CI pipeline injection
  // Potentially 'package.json' for writes to the 'scripts' field would need specific logic,
  // not just regex on path.
];

/**
 * Check that every component of a resolved path stays within PROJECT_ROOT.
 * Catches symlinks that point outside the project even though the symlink
 * itself lives inside the project tree.
 */
function validatePathComponents(absolutePath, workspaceRoot = PROJECT_ROOT) {
  const parts = relative(workspaceRoot, absolutePath).split(/[\\/]/);
  let current = workspaceRoot;

  for (const part of parts) {
    current = join(current, part);

    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        // Resolve where the symlink points and verify it's in-project
        const target = realpathSync(current);
        const targetRel = relative(workspaceRoot, target);
        if (targetRel.startsWith('..')) {
          throw new Error(
            `Symlink "${current}" points outside workspace root to "${target}". ` +
            `Symlink traversal outside the workspace is not allowed.`
          );
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') break; // path component doesn't exist yet (new file)
      if (err.message.includes('Symlink')) throw err; // re-throw our own error
      // Other stat errors — continue (file may not exist yet for writes)
    }
  }
}

function validateFilePath(filePath, operationType = 'read', workspaceRoot = PROJECT_ROOT) {
  // Resolve relative paths against the configured workspace root (PROJECT_ROOT), NOT
  // process.cwd(). For the CLI these coincide (PROJECT_ROOT defaults to cwd); for an
  // in-process host (OTL importing the SDK + setWorkspaceRoot) cwd is the host's dir, so
  // resolving against cwd sent every relative path outside the workspace and failed.
  // An absolute filePath is unaffected — resolve() ignores the base when given an absolute.
  const absolutePath = resolve(workspaceRoot, filePath);

  // For new files (write/create): resolve against parent directory instead of
  // calling realpathSync on a path that doesn't exist yet.
  // realpathSync throws ENOENT for nonexistent files, blocking file creation.
  let realPath;
  try {
    realPath = realpathSync(absolutePath);
  } catch (err) {
    if (err.code === 'ENOENT' && (operationType === 'write' || operationType === 'create')) {
      // File doesn't exist — validate the parent directory instead
      const parentDir = dirname(absolutePath);
      try {
        const realParent = realpathSync(parentDir);
        const parentRelative = relative(workspaceRoot, realParent);
        if (parentRelative.startsWith('..')) {
          throw new Error(`Path "${filePath}" parent directory is outside the workspace root "${workspaceRoot}".`);
        }
        // Use the resolved parent + the filename for the final path
        realPath = join(realParent, basename(absolutePath));
      } catch (parentErr) {
        if (parentErr.code === 'ENOENT') {
          throw new Error(`Parent directory for "${filePath}" does not exist.`);
        }
        throw parentErr;
      }
    } else {
      throw err;
    }
  }

  const relativePath = relative(workspaceRoot, realPath);

  if (relativePath.startsWith('..')) {
    throw new Error(`Path "${filePath}" (${realPath}) is outside the workspace root "${workspaceRoot}".`);
  }

  // ── SYMLINK TRAVERSAL CHECK ──
  // Verify every path component between workspaceRoot and the target is in-project.
  // Prevents: model creates symlink inside project → symlink points outside → write through it.
  validatePathComponents(absolutePath, workspaceRoot);

  // For existing files, also check if the target itself is a symlink pointing out
  try {
    const stat = lstatSync(realPath);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(realPath);
      const targetRel = relative(PROJECT_ROOT, target);
      if (targetRel.startsWith('..')) {
        throw new Error(`Path "${filePath}" is a symlink pointing outside the project root to "${target}".`);
      }
    }
  } catch (err) {
    if (err.message.includes('symlink') || err.message.includes('Symlink')) throw err;
    // ENOENT is fine — file doesn't exist yet
  }

  // Allow reading the project root itself, but not writing/deleting it
  if (realPath === PROJECT_ROOT && operationType !== 'read') {
     throw new Error(`Direct operation on project root "${PROJECT_ROOT}" is not allowed.`);
  }

  // Check for sensitive paths within the project root
  if (operationType !== 'read') {
    for (const sensitivePattern of SENSITIVE_PROJECT_PATHS) {
      if (sensitivePattern.test(relativePath)) {
        throw new Error(`Path "${filePath}" (${relativePath}) is a sensitive project path and cannot be modified.`);
      }
    }
  }

  return realPath;
}
// --- END PATH CONTAINMENT DEFINITIONS ---

// --- SHELL_EXEC ALLOWLIST & DENY DEFINITIONS ---
const SHELL_EXEC_ALLOWLIST = [
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find',
  'node', 'npm', 'npx', 'python', 'pip', 'cargo', 'go', 'make',
  'tsc', 'eslint', 'jest', 'vitest', 'pwd', 'which', 'echo', 'wc', 'sort', 'uniq', 'diff', 'jq',
  'git', // This needs careful handling to ensure only read ops are allowed
  'curl' // Needs to be restricted to GET only in http_fetch, not here for shell_exec.
];

const SHELL_EXEC_ABSOLUTE_DENY_PATTERNS = [
  /\bbase64\b/i,           // Encoding for obfuscation/exfil
  /\beval\b/,              // Arbitrary code execution
  /\bexec\b/,              // Arbitrary code execution
  /\|(\s*)sh\b/, /\|(\s*)bash\b/, /\|(\s*)powershell\b/i, /\|(\s*)cmd\b/i, // Piping to shells
  /^-(\w|\s)*enc/,         // Common encoding flags (e.g., powershell -enc)
  /\b(wget|curl)\b.*\b(post|put|delete)\b/i, // curl/wget attempting non-GET
  /\bchown\b/, /\bchmod\b/, /\bchgrp\b/, // Permission changes
  // Interpreters invoked with an inline-eval flag turn an allowlisted runtime into an
  // arbitrary-code shell, escaping the allowlist's intent (the allowlist says "only node",
  // but `node -e <anything>` is anything). Module/file execution stays allowed (`-m`,
  // `node script.js`); that path is the operator-gated shell_exec. Isolating model-authored
  // *files* needs a real process sandbox — tracked as a finding, not closed here.
  /^\s*(node|deno|bun)\b.*\s(-e|-p|--eval|--print)\b/i,
  /^\s*(python3?|py)\b.*\s-c\b/i,
  /^\s*(ruby|perl)\b.*\s-e\b/i,
  /^\s*php\b.*\s-r\b/i,
];

// Shell metacharacters that indicate command chaining/injection
const SHELL_METACHARACTERS = /[;|&`$><(){}!\n]/;

// Helper to extract the main command/executable
function getShellCommandExecutable(command) {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return '';
  return parts[0].toLowerCase();
}

/**
 * Parse a command string into [executable, ...args] for shell-free spawn.
 * Handles simple quoting (single and double quotes).
 * Rejects commands containing shell metacharacters.
 */
function parseCommandToArgv(command) {
  const trimmed = command.trim();

  // Reject any shell metacharacters in the raw command
  if (SHELL_METACHARACTERS.test(trimmed)) {
    const match = trimmed.match(SHELL_METACHARACTERS);
    throw new Error(
      `Command contains shell metacharacter "${match[0]}" which is not allowed. ` +
      `Commands must be simple executable + arguments, no chaining or redirection.`
    );
  }

  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);

  if (inSingle || inDouble) {
    throw new Error('Unterminated quote in command string');
  }

  if (args.length === 0) {
    throw new Error('Empty command');
  }

  return args;
}

// Function to validate working directory
function validateShellWorkingDirectory(workingDirectory, workspaceRoot = PROJECT_ROOT) {
  if (!workingDirectory) {
    return workspaceRoot; // Default to workspace root
  }
  // Relative working dirs resolve under the workspace root, not the host's process.cwd().
  const absolutePath = resolve(workspaceRoot, workingDirectory);
  const realPath = realpathSync(absolutePath);
  const relativePath = relative(workspaceRoot, realPath);

  if (relativePath.startsWith('..')) {
    throw new Error(`Working directory "${workingDirectory}" (${realPath}) is outside the workspace root "${workspaceRoot}".`);
  }
  return realPath;
}
// --- END SHELL_EXEC ALLOWLIST & DENY DEFINITIONS ---

// --- HTTP_FETCH ALLOWLIST & DENY DEFINITIONS ---
const HTTP_FETCH_ALLOWLIST_DOMAINS = [
  'api.github.com',
  'registry.npmjs.org',
  'pypi.org',
  // Add known model API endpoints here if applicable
  // e.g., 'generativelanguage.googleapis.com',
];

const HTTP_FETCH_BLOCKED_IP_RANGES = [
  /^localhost$/,
  /^127\.0\.0\.1$/,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
];

const HTTP_FETCH_BLOCKED_CLOUD_METADATA = [
  /^169\.254\.169\.254$/,
  /^metadata\.google\.internal$/,
  /^169\.254\.170\.2$/, // Azure IMDS
];

function getHostnameFromUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.toLowerCase();
  } catch (e) {
    return null;
  }
}

function checkHttpFetchUrl(url, method) {
  const hostname = getHostnameFromUrl(url);

  if (!hostname) {
    throw new Error(`Invalid URL: ${url}`);
  }

  // 1. Block internal networks and cloud metadata
  for (const pattern of [...HTTP_FETCH_BLOCKED_IP_RANGES, ...HTTP_FETCH_BLOCKED_CLOUD_METADATA]) {
    if (pattern.test(hostname)) {
      throw new Error(`Access to internal network or cloud metadata URL "${url}" is blocked.`);
    }
  }

  // 2. URL allowlist mode
  const isAllowedDomain = HTTP_FETCH_ALLOWLIST_DOMAINS.some(allowed => hostname.endsWith(allowed));
  if (!isAllowedDomain) {
    throw new Error(`Access to URL "${url}" is not allowed. Domain "${hostname}" is not in the allowlist.`);
  }

  // 3. POST/PUT/DELETE gating (this part is more complex, as it relies on the gating system)
  // For now, if it's not a GET request, and we haven't explicitly set up ESCALATED gating
  // for http_fetch with non-GET methods, we will block it.
  // In future, gate-registry should classify http_fetch based on method.
  // For now, if it's not a GET, it needs to be explicitly approved by an ESCALATED gate.
  // Since we are non-interactive and ESCALATED gates are denied, this effectively blocks.
  if (method.toUpperCase() !== 'GET') {
    throw new Error(`HTTP method "${method}" for URL "${url}" is not allowed. Only GET requests are permitted by default.`);
  }
}
// --- END HTTP_FETCH ALLOWLIST & DENY DEFINITIONS ---

// --- RATE LIMITER DEFINITIONS ---
class RateLimiter {
  constructor(rate, burst) {
    this.rate = rate; // actions per second
    this.burst = burst; // max actions in a burst
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  consume(amount = 1) {
    this.refill();
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }
}

// Global rate limiter for OS control actions: 10 actions per 5 seconds (2 actions/sec), burst of 10
const osControlRateLimiter = new RateLimiter(2, 10); // 2 actions per second, max 10 burst

// --- END RATE LIMITER DEFINITIONS ---

/**
 * Available tools registry
 */
const TOOLS = {
  // File operations
  file_read: toolFileRead,
  file_write: toolFileWrite,
  file_edit: toolFileEdit,
  file_delete: toolFileDelete,
  file_move: toolFileMove,

  // Search operations
  search: toolSearch,
  glob: toolGlob,

  // Shell operations
  shell_exec: toolShellExec,

  // Git operations
  git_status: toolGitStatus,
  git_log: toolGitLog,
  git_diff: toolGitDiff,
  git_add: toolGitAdd,
  git_commit: toolGitCommit,
  git_push: toolGitPush,

  // Web/HTTP operations
  http_fetch: toolHttpFetch,
  browse_page: toolBrowsePage,

  // OS control — spatial, hardware, system
  ...(process.env.ILLUCI_ENABLE_OS_CONTROL === 'true' ? {
    mouse_move: toolMouseMove,
    mouse_click: toolMouseClick,
    mouse_position: toolMousePosition,
    key_type: toolKeyType,
    key_press: toolKeyPress,
    key_combo: toolKeyCombo,
    screenshot: toolScreenshot,
    screen_info: toolScreenInfo,
    volume_set: toolVolumeSet,
    volume_get: toolVolumeGet,
    volume_mute: toolVolumeMute,
    window_list: toolWindowList,
    window_focus: toolWindowFocus,
    process_launch: toolProcessLaunch,
    process_kill: toolProcessKill,
    process_list: toolProcessList,
    system_info: toolSystemInfo,
    clipboard_get: toolClipboardGet,
    clipboard_set: toolClipboardSet,
  } : {}),
};

// ─── TOOL CONTRACT: BURP SUITE ───
// Contingent tools — only registered if Burp is running.
// This is the pattern for all environment-gated capabilities.
let burpToolsLoaded = false;
async function loadBurpTools() {
  if (burpToolsLoaded) return;
  try {
    const burp = await import("../tools/burp.js");
    const burpTools = await burp.getTools();
    for (const [name, tool] of Object.entries(burpTools)) {
      TOOLS[name] = tool.handler;
    }
    if (Object.keys(burpTools).length > 0) {
      console.error(`[tools] Burp Suite detected — ${Object.keys(burpTools).length} security tools registered`);
    }
  } catch {}
  burpToolsLoaded = true;
}
// Auto-detect on first import
loadBurpTools();

// ─── TOOL CONTRACT: UE5 MCP ───
// Contingent tools — only registered if UE5 editor is running.
// Replaces the dead Ludus AI cloud bridge. Any seated model gets UE5 tools.
let ue5ToolsLoaded = false;
async function loadUe5Tools() {
  if (ue5ToolsLoaded) return;
  try {
    const ue5 = await import("../tools/unreal-mcp.js");
    const ue5Tools = await ue5.getTools();
    for (const [name, tool] of Object.entries(ue5Tools)) {
      TOOLS[name] = tool.handler;
    }
    if (Object.keys(ue5Tools).length > 0) {
      console.error(`[tools] UE5 MCP detected — ${Object.keys(ue5Tools).length} editor tools registered`);
    }
  } catch {}
  ue5ToolsLoaded = true;
}
loadUe5Tools();

export const TOOL_NAMES = Object.keys(TOOLS);

export async function getToolNames() { return [...TOOL_NAMES]; }

/**
 * List all available tools
 * @returns {Object}
 */
export function listTools() {
  return Object.keys(TOOLS).reduce((acc, name) => {
    acc[name] = { name, gated: isGated(name) };
    return acc;
  }, {});
}

/**
 * Execute a tool with gating
 *
 * @param {string} name - Tool name
 * @param {Object} params - Tool parameters
 * @param {Object} context - Execution context (sessionId, phaseId, agentId, etc.)
 * @returns {Promise<any>}
 */
export async function executeTool(name, params = {}, context = {}) {
  // --- CANCELLATION CHECK ---
  // context.signal is the run's AbortSignal (threaded run() → loop → here).
  // An aborted run must not start new tool work; the same context (including
  // the signal) reaches the handler so in-flight tools can interrupt themselves.
  if (context.signal && context.signal.aborted) {
    return { success: false, blocked: true, reason: "aborted" };
  }
  // --- END CANCELLATION CHECK ---

  console.log("executeTool: ", { name, shouldGate: isGated(name, params), invariantBlocked: checkHardInvariants(name, params).blocked });
  // --- KILL SWITCH CHECK ---
  if (GLOBAL_HALT_FLAG) {
    // Log the halt if it's not already logged by the invariant check
    if (context.source && context.source.model) { // Ensure context is available
      logDecision({
        humanStatus: "operator-overridden",
        modelStatus: [context.source],
        context: `Tool ${name} blocked due to operator halt.`,
        type: "system-halted",
        decision: `Denied ${name}(${summarizeArgs(params)}) due to system halt.`,
        inputs: { tool: name, args: params },
        metadata: { tool: name, params: params },
      });
    }
    return { success: false, blocked: true, reason: "operator-halt" };
  }
  // --- END KILL SWITCH CHECK ---

  // --- WORK PERMIT CHECK (A8) ---
  // A permit, when supplied or required by runtime policy, binds this exact
  // agent/action/channel/capability/target/risk before role grants, skill grants,
  // gates, or handlers can execute.
  if (context.workPermit || context.permit || isWorkPermitRequired(context)) {
    try {
      assertWorkPermit(name, params, context);
    } catch (err) {
      logDecision({
        humanStatus: "operator-overridden",
        modelStatus: [context.source || { model: context.agentId || "unknown", seat: context.agentName || "unknown" }],
        context: `Work permit denied: ${name} - ${err.reason || err.message}`,
        type: "work-permit",
        decision: `Denied ${name}(${summarizeArgs(params)}) - work permit scope mismatch`,
        inputs: { tool: name, args: params },
        metadata: { reason: err.reason || err.message, tool: name, agentId: context.agentId || null, code: DENIAL_CODES.WORK_PERMIT_DENIED },
      });
      return { success: false, blocked: true, reason: err.reason || err.message, code: DENIAL_CODES.WORK_PERMIT_DENIED };
    }
  }
  // --- END WORK PERMIT CHECK ---

  // --- ROLE CAPABILITY CHECK (Phase 1 / ILLUCI_ROLE_GOVERNANCE_ENABLED) ---
  // Capability is checked HERE, at the stable tool boundary, BEFORE the license
  // check — NEVER inside the gate classifier's evaluate(). Dark by default: with
  // the flag off (or no roleId on the context) checkRoleCapability allows
  // everything, so this is behavior-identical to pre-Phase-1. When armed and a
  // role lacks capability for an authoring tool, the standard failure shape is
  // tagged DENIAL_CODES.CAPABILITY_DENIED so the three denials are distinct.
  const capability = checkRoleCapability(name, context);
  if (!capability.allow) {
    logDecision({
      humanStatus: "operator-overridden",
      modelStatus: [context.source || { model: context.agentId || "unknown", seat: context.agentName || "unknown" }],
      context: `Role capability denied: ${name} — ${capability.reason}`,
      type: "role-capability",
      decision: `Denied ${name}(${summarizeArgs(params)}) — role lacks capability`,
      inputs: { tool: name, args: params },
      metadata: { reason: capability.reason, tool: name, roleId: context.roleId || null, code: DENIAL_CODES.CAPABILITY_DENIED },
    });
    return { success: false, blocked: true, reason: capability.reason, code: DENIAL_CODES.CAPABILITY_DENIED };
  }
  // --- END ROLE CAPABILITY CHECK ---

  // --- SKILL-GRANT LICENSE CHECK (M6 / DR-112) ---
  // When the seat carries a skill layer (context.skillGrants), off-floor MCP
  // access is opt-in: a bridge the seat's skills do not grant is DENIED here,
  // BEFORE the mode gate (and before the tool-existence check, so an unlicensed
  // MCP name is refused regardless of dynamic registration). A grant never
  // approves a gated tool or lowers its level — it only licenses the seat to
  // then face the gate. Absent grants, this is a no-op (floor governs).
  if (context.skillGrants) {
    const license = evaluateSkillGrant(name, context.skillGrants);
    if (!license.allow) {
      logDecision({
        humanStatus: "operator-overridden",
        modelStatus: [context.source || { model: context.agentId || "unknown", seat: context.agentName || "unknown" }],
        context: `Skill license denied: ${name} — ${license.reason}`,
        type: "skill-grant",
        decision: `Denied ${name}(${summarizeArgs(params)}) — not licensed by any bound skill`,
        inputs: { tool: name, args: params },
        metadata: { reason: license.reason, tool: name, skillIds: context.skillGrants.skillIds || [], code: DENIAL_CODES.SKILL_LICENSE_DENIED },
      });
      return { success: false, blocked: true, reason: license.reason, code: DENIAL_CODES.SKILL_LICENSE_DENIED };
    }
  }
  // --- END SKILL-GRANT LICENSE CHECK ---

  // --- [A39]/CAP-3 CAPABILITY-AFFORDANCE SEAM (warn-first until the CAP-4 floor flip) ---
  // A tool labeled to a licensed affordance (computer-use, browser-frontend,
  // desktop-gui, sandbox-exec, vision) additionally requires the seat's
  // capability resolution (record-backed, R4) to license it. Deny-only: a
  // grant never approves a gated tool. Under the ratified warn-first
  // transition an unlicensed labeled call PROCEEDS with a coded, recorded
  // warning; unlabeled off-floor tools gate at the flip (R5 deny-default).
  if (context.capabilityResolution !== undefined) {
    const capVerdict = evaluateToolCapability(name, context.capabilityResolution);
    if (capVerdict.gated && !capVerdict.allow) {
      // [A40]/CAP-4: the floor is FLIPPED — an unlicensed labeled affordance
      // DENIES with the same blocked shape as the skill gate. Deny-only: a
      // grant still never approves a gated tool.
      logDecision({
        humanStatus: "operator-overridden",
        modelStatus: [context.source || { model: context.agentId || "unknown", seat: context.agentName || "unknown" }],
        context: `Capability license denied: ${name} exercises "${capVerdict.affordance.capability}" — ${capVerdict.reason}`,
        type: "capability-license",
        decision: `Denied ${name}(${summarizeArgs(params)}) — no capability grant (deny-by-default floor)`,
        inputs: { tool: name, args: params },
        metadata: { reason: capVerdict.reason, tool: name, capability: capVerdict.affordance.capability, code: capVerdict.code },
      });
      return { success: false, blocked: true, reason: capVerdict.reason, code: capVerdict.code };
    }
    if (capVerdict.gated && capVerdict.warned) {
      logDecision({
        humanStatus: "operator-overridden",
        modelStatus: [context.source || { model: context.agentId || "unknown", seat: context.agentName || "unknown" }],
        context: `Capability warn: ${name} exercises "${capVerdict.affordance.capability}" without a grant — ${capVerdict.reason}`,
        type: "capability-license",
        decision: `WARNED ${name}(${summarizeArgs(params)}) — proceeds under the ratified warn-first transition`,
        inputs: { tool: name, args: params },
        metadata: { reason: capVerdict.reason, tool: name, capability: capVerdict.affordance.capability, code: capVerdict.code },
      });
    }
  }
  // --- END CAPABILITY-AFFORDANCE SEAM ---

  const tool = TOOLS[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // --- HARD INVARIANT CHECK ---
  const invariantCheck = checkHardInvariants(name, params);
  if (invariantCheck.blocked) {
    // Set global halt flag
    setGlobalHalt(true);

    // Log the hard invariant violation
    logDecision({
      humanStatus: "operator-overridden",
      modelStatus: [context.source || { model: "unknown", seat: "unknown" }],
      context: `HARD DENY: Tool ${name} blocked due to invariant violation: ${invariantCheck.reason}. System Halted.`,
      type: "hard-invariant-violation",
      decision: `Denied ${name}(${summarizeArgs(params)}). System Halted.`,
      inputs: { tool: name, args: params },
      metadata: { reason: invariantCheck.reason, tool: name, params: params },
    });
    return {
      success: false,
      blocked: true,
      reason: `Hard invariant violation: ${invariantCheck.reason}. System Halted.`,
    };
  }
  // --- END HARD INVARIANT CHECK ---

  // Check if this action requires gating
  const shouldGate = isGated(name, params);

  if (shouldGate) {
    const gateParams = {
      tool: name,
      args: params,
      source: {
        model: context.agentId,
        seat: context.agentName,
        topology: context.topologyId,
        phase: context.phaseId,
      },
      level: context.gateLevel || undefined,
      sessionId: context.sessionId,
      phaseId: context.phaseId,
      agentId: context.agentId,
      agentName: context.agentName,
      topologyId: context.topologyId,
      // Carry the tool-call id to the approval transport so an in-process consumer can
      // correlate the operator's decision to the exact call (see loop.js toolCtx.toolCallId).
      toolCallId: context.toolCallId,
    };

    // Compute diff for file edits
    if (name === 'file_edit' && params.path && params.content) {
      try {
        if (existsSync(params.path)) {
          const before = readFileSync(params.path, 'utf-8');
          gateParams.contentBefore = before;
          gateParams.diff = computeDiff(before, params.content, params.path);
        } else {
          gateParams.contentBefore = null;
          gateParams.diff = computeDiff('', params.content, params.path);
        }
        gateParams.contentAfter = params.content;
      } catch {
        // If we can't read the file, still allow the gate to proceed
      }
    }

    // For file writes, show the content
    if (name === 'file_write' && params.content) {
      gateParams.contentAfter = params.content;
      gateParams.diff = computeDiff('', params.content, params.path);
    }

    // Request operator approval
    const decision = await requestApproval(gateParams);
    console.log("requestApproval decision: ", decision.approved, decision.reason);

    if (!decision.approved) {
      return {
        success: false,
        blocked: true,
        reason: decision.reason || 'operator-rejected',
      };
    }

    // Apply operator modifications if any
    if (decision.modifiedContent && (name === 'file_write' || name === 'file_edit')) {
      params = { ...params, content: decision.modifiedContent };
    }

    // The gate can wait on a human decision; re-check cancellation so an
    // approval that lands after the run was aborted cannot resurrect the call.
    if (context.signal && context.signal.aborted) {
      return { success: false, blocked: true, reason: "aborted" };
    }
  }

  // Execute the tool
  try {
    const result = await tool(params, context);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ─── FILE OPERATIONS ───

async function toolFileRead({ path, offset, limit }, context = {}) {
  const validatedPath = validateFilePath(path, 'read', context.workspaceRoot);

  if (!existsSync(validatedPath)) {
    throw new Error(`File not found: ${path}`);
  }

  let content = readFileSync(validatedPath, 'utf-8');

  if (offset !== undefined || limit !== undefined) {
    const lines = content.split('\n');
    const start = offset || 0;
    const end = limit ? start + limit : lines.length;
    content = lines.slice(start, end).join('\n');
  }

  return { content, path: validatedPath };
}

async function toolFileWrite({ path, content }, context = {}) {
  const validatedPath = validateFilePath(path, 'write', context.workspaceRoot);
  const dir = dirname(validatedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Verify the created directory chain didn't escape via symlink
    validatePathComponents(dir, context.workspaceRoot);
  }

  writeFileSync(validatedPath, content, 'utf-8');

  // Post-write symlink guard: verify the written file is not a symlink.
  // writeFileSync itself creates regular files, but a race condition or
  // TOCTOU attack could replace the path between validation and write.
  try {
    const stat = lstatSync(validatedPath);
    if (stat.isSymbolicLink()) {
      // Undo the write — remove the symlink
      unlinkSync(validatedPath);
      throw new Error(`Post-write check failed: "${path}" became a symlink. Write reverted.`);
    }
  } catch (err) {
    if (err.message.includes('symlink') || err.message.includes('Symlink')) throw err;
  }

  return { path: validatedPath, written: content.length };
}

async function toolFileEdit({ path, oldString, newString, content: fullContent }) {
  const validatedPath = validateFilePath(path, 'write');

  if (!existsSync(validatedPath)) {
    throw new Error(`File not found: ${path}`);
  }

  const current = readFileSync(validatedPath, 'utf-8');

  // Support both full content replacement and targeted edit
  let newContent;
  if (fullContent !== undefined) {
    newContent = fullContent;
  } else if (oldString !== undefined) {
    if (!current.includes(oldString)) {
      throw new Error(`String to replace not found in file: ${oldString.substring(0, 50)}...`);
    }
    newContent = current.replace(oldString, newString);
  } else {
    throw new Error('Either content or oldString/newString must be provided');
  }

  writeFileSync(validatedPath, newContent, 'utf-8');

  // Post-write symlink guard (mirrors file_write): detect TOCTOU replacement
  try {
    const stat = lstatSync(validatedPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(validatedPath);
      throw new Error(`Post-write check failed: "${path}" became a symlink. Edit reverted.`);
    }
  } catch (err) {
    if (err.message.includes('symlink') || err.message.includes('Symlink')) throw err;
  }

  return { path: validatedPath, edited: true };
}

async function toolFileDelete({ path }) {
  const validatedPath = validateFilePath(path, 'delete');

  if (!existsSync(validatedPath)) {
    throw new Error(`File not found: ${path}`);
  }

  unlinkSync(validatedPath);
  return { path: validatedPath, deleted: true };
}

async function toolFileMove({ source, destination }, context = {}) {
  const validatedSource = validateFilePath(source, 'read', context.workspaceRoot); // Source needs to be readable
  const validatedDestination = validateFilePath(destination, 'write', context.workspaceRoot); // Destination needs to be writable

  if (!existsSync(validatedSource)) {
    throw new Error(`Source not found: ${source}`);
  }

  const dir = dirname(validatedDestination);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  renameSync(validatedSource, validatedDestination);
  return { source: validatedSource, destination: validatedDestination };
}

// ─── SEARCH OPERATIONS ───

async function toolSearch({ pattern, path, type = 'content' }, context = {}) {
  const workspaceRoot = context.workspaceRoot || PROJECT_ROOT;
  const args = ['-n', pattern, path || '.'];
  const rgType = type === 'content' ? 'js' : '*';
  if (rgType !== '*') args.push('--type', rgType);
  let stdout = '';
  try {
    // Run inside the workspace root so a relative `path` (and the '.' default) resolves
    // there, not in the host's process.cwd() (the in-process re-rooting fix).
    ({ stdout } = await execFile('rg', args, { cwd: workspaceRoot }));
  } catch (err) {
    // rg exits 1 on no matches — not an error
    if (err.code === 1) stdout = err.stdout || '';
    else throw err;
  }
  const matches = stdout.trim().split('\n').filter(Boolean).map(line => {
    const [file, lineNum, ...rest] = line.split(':');
    return { file, line: parseInt(lineNum), content: rest.join(':') };
  });
  return { pattern, matches: matches.slice(0, 100) };
}

async function toolGlob({ pattern, path }, context = {}) {
  const workspaceRoot = context.workspaceRoot || PROJECT_ROOT;
  const args = [path || '.', '-type', 'f', '-name', pattern, '-maxdepth', '10'];
  let stdout = '';
  try {
    ({ stdout } = await execFile('find', args, { cwd: workspaceRoot }));
  } catch (err) {
    stdout = err.stdout || '';
  }
  const files = stdout.trim().split('\n').filter(Boolean).slice(0, 100);
  return { pattern, files };
}

// ─── SHELL OPERATIONS ───

async function toolShellExec({ command, workingDirectory, timeout = 60000 }, context = {}) {
  // 1. Validate working directory
  let cwd;
  try {
    cwd = validateShellWorkingDirectory(workingDirectory, context.workspaceRoot);
  } catch (error) {
    throw new Error(`Invalid working directory: ${error.message}`);
  }

  // 2. Absolute deny patterns (checked against raw command string)
  for (const pattern of SHELL_EXEC_ABSOLUTE_DENY_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Command "${command}" blocked by absolute deny list due to pattern: ${pattern.source}`);
    }
  }

  // 3. Parse command into argv — rejects shell metacharacters (;|&`$><)
  let argv;
  try {
    argv = parseCommandToArgv(command);
  } catch (parseErr) {
    throw new Error(`Shell command rejected: ${parseErr.message}`);
  }

  const executable = argv[0].toLowerCase();

  if (process.platform === 'win32') {
    const internalWindowsCommands = ['echo', 'dir', 'type']; // Common internal commands
    if (internalWindowsCommands.includes(executable)) {
      argv.unshift('/c');
      argv.unshift('cmd.exe');
    }
  }

  // 4. Allowlist check against the parsed executable (not raw string first-word)
  let commandToCheck = executable;
  if (process.platform === 'win32' && executable === 'cmd.exe' && argv[1] === '/c') {
    commandToCheck = argv[2]?.toLowerCase(); // Check the actual command, not cmd.exe
  }

  if (!SHELL_EXEC_ALLOWLIST.includes(commandToCheck)) {
    throw new Error(`Command "${commandToCheck}" not in allowlist. Only explicitly allowlisted commands are permitted.`);
  }

  // 5. Spawn WITHOUT shell — no metacharacter interpretation possible
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(argv[0], argv.slice(1), {
      shell: false,
      cwd,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      resolvePromise({
        command,
        exitCode: code,
        stdout: stdout.substring(0, 10000),
        stderr: stderr.substring(0, 10000),
      });
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// ─── GIT OPERATIONS ───
// All git tools use spawn(shell:false) to prevent injection via model-controlled params.
// Parameters are validated and passed as argv elements — never interpolated into shell strings.

/** Reject strings containing shell metacharacters (reuse from shell_exec hardening). */
function sanitizeGitParam(value, paramName) {
  if (typeof value !== 'string') return String(value);
  if (SHELL_METACHARACTERS.test(value)) {
    throw new Error(`Git parameter "${paramName}" contains shell metacharacter — rejected.`);
  }
  return value;
}

/** Run a git command with shell:false. Returns { stdout, stderr, exitCode }. */
export function spawnGit(args, options = {}) {
  const workspaceRoot = options.workspaceRoot || PROJECT_ROOT;
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('git', args, {
      shell: false,
      cwd: workspaceRoot,
      timeout: options.timeout || 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      // Honesty invariant (F-079-class #67): a non-zero git exit is a FAILURE, not a
      // silent success. This previously resolved regardless of `code`, so a failed
      // commit/push still returned { committed:true }/{ pushed:true } — a false
      // "committed/pushed" signal the agent would then act on. Now a non-zero exit
      // rejects with the git stderr, and the executeTool boundary surfaces it as a
      // failed tool result. A caller that legitimately reads an exit code (e.g.
      // `git diff --exit-code`) opts out with allowNonZeroExit.
      if (code !== 0 && options.allowNonZeroExit !== true) {
        const detail = stderr.trim() || stdout.trim();
        const err = new Error(`git ${args[0] || ''} failed (exit ${code})${detail ? `: ${detail}` : ''}`.trim());
        err.exitCode = code;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: code });
    });
    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function toolGitStatus(params = {}, context = {}) {
  const { stdout } = await spawnGit(['status', '--porcelain'], { workspaceRoot: context.workspaceRoot });
  const files = stdout.trim().split('\n').filter(Boolean).map(line => ({
    status: line.substring(0, 2).trim(),
    path: line.substring(3),
  }));
  return { files };
}

async function toolGitLog({ limit = 10, format = 'oneline' }, context = {}) {
  // Validate limit is a safe integer — reject strings that aren't purely numeric
  if (typeof limit === 'string' && !/^\d+$/.test(limit.trim())) {
    throw new Error(`Invalid git log limit: "${limit}". Must be a positive integer.`);
  }
  const safeLimit = parseInt(limit, 10);
  if (isNaN(safeLimit) || safeLimit < 1 || safeLimit > 1000) {
    throw new Error(`Invalid git log limit: ${limit}. Must be an integer 1-1000.`);
  }

  const fmt = format === 'oneline' ? '%h %s' : '%H|%an|%ae|%ad|%s';
  const { stdout } = await spawnGit(['log', `-n`, String(safeLimit), `--pretty=format:${fmt}`], { workspaceRoot: context.workspaceRoot });
  const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
    if (format === 'oneline') {
      const [hash, ...msg] = line.split(' ');
      return { hash, message: msg.join(' ') };
    }
    const [hash, author, email, date, ...msg] = line.split('|');
    return { hash, author, email, date, message: msg.join('|') };
  });
  return { commits };
}

async function toolGitDiff({ path, staged = false }, context = {}) {
  const args = ['diff'];
  if (staged) args.push('--staged');
  if (path) {
    const safePath = sanitizeGitParam(path, 'path');
    validateFilePath(safePath, 'read', context.workspaceRoot);
    args.push('--', safePath);
  }
  const { stdout } = await spawnGit(args, { workspaceRoot: context.workspaceRoot });
  return { diff: stdout };
}

async function toolGitAdd({ paths }, context = {}) {
  const pathList = Array.isArray(paths) ? paths : [paths];
  const safePaths = pathList.map(p => {
    const safe = sanitizeGitParam(p, 'path');
    validateFilePath(safe, 'write', context.workspaceRoot);
    return safe;
  });
  await spawnGit(['add', ...safePaths], { workspaceRoot: context.workspaceRoot });
  return { added: safePaths.join(', ') };
}

async function toolGitCommit({ message }, context = {}) {
  const safeMessage = sanitizeGitParam(message, 'message');
  const { stdout } = await spawnGit(['commit', '-m', safeMessage], { workspaceRoot: context.workspaceRoot });
  return { committed: true, output: stdout };
}

async function toolGitPush({ force = false }, context = {}) {
  const args = ['push'];
  if (force) args.push('--force');
  const { stdout, stderr } = await spawnGit(args, { workspaceRoot: context.workspaceRoot });
  return { pushed: true, output: stdout || stderr };
}

// ─── UTILITY ───

/**
 * Compute a unified diff between two strings
 * Simple implementation - production would use a proper diff library
 */
function computeDiff(before, after, filename = 'file') {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Simple line-by-line diff
  let diff = `--- ${filename}\n+++ ${filename}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;

  // Mark removed lines
  for (const line of beforeLines) {
    if (!afterLines.includes(line)) {
      diff += `-${line}\n`;
    }
  }

  // Mark added lines
  for (const line of afterLines) {
    if (!beforeLines.includes(line)) {
      diff += `+${line}\n`;
    }
  }

  return diff;
}

// ─── WEB/HTTP OPERATIONS ───

async function toolHttpFetch({ url, method = "GET", headers = {}, body, timeout = 30000 }) {
  if (!url) throw new Error("url required");

  // --- HTTP_FETCH URL VALIDATION ---
  checkHttpFetchUrl(url, method);
  // --- END HTTP_FETCH URL VALIDATION ---

  const opts = {
    method: method.toUpperCase(),
    headers: { "User-Agent": "illuci/0.4.0", ...headers },
    signal: AbortSignal.timeout(timeout),
  };

  if (body && method !== "GET") {
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(url, opts);
  const contentType = resp.headers.get("content-type") || "";
  let responseBody;

  if (contentType.includes("json")) {
    responseBody = await resp.json();
  } else {
    responseBody = await resp.text();
    if (responseBody.length > 10000) responseBody = responseBody.substring(0, 10000) + "\n...[truncated]";
  }

  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: Object.fromEntries(resp.headers.entries()),
    body: responseBody,
  };
}

async function toolBrowsePage({ url, instructions, timeout = 30000 }) {
  if (!url) throw new Error("url required");

  let browser;
  try {
    const pw = await import("../tools/browser.js");
    browser = await pw.launchClean({ headless: true });

    await browser.page.goto(url, { waitUntil: "networkidle", timeout });

    // Extract page content
    const content = await browser.page.evaluate((instr) => {
      // If instructions given, try to follow them
      const title = document.title;
      const text = document.body?.innerText?.substring(0, 15000) || "";
      const meta = {
        title,
        url: location.href,
        description: document.querySelector('meta[name="description"]')?.content || "",
      };

      // Extract links
      const links = [...document.querySelectorAll("a[href]")]
        .slice(0, 50)
        .map(a => ({ text: a.textContent?.trim().substring(0, 80), href: a.href }));

      return { meta, text, links, instruction: instr || null };
    }, instructions);

    return content;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── OS CONTROL OPERATIONS ───

let _osControl = null;
async function getOsControl() {
  if (!_osControl) _osControl = await import("../tools/os-control.js");
  return _osControl;
}

async function toolMouseMove({ x, y }) { return (await getOsControl()).mouseMove(x, y); }
async function toolMouseClick({ x, y, button }) { return (await getOsControl()).mouseClick(x, y, button); }
async function toolMousePosition() { return (await getOsControl()).mousePosition(); }
async function toolKeyType({ text }) { return (await getOsControl()).keyType(text); }
async function toolKeyPress({ key }) { return (await getOsControl()).keyPress(key); }
async function toolKeyCombo({ modifiers, key }) { return (await getOsControl()).keyCombo(modifiers, key); }
async function toolScreenshot({ region }) { return (await getOsControl()).screenshot(region); }
async function toolScreenInfo() { return (await getOsControl()).screenInfo(); }
async function toolVolumeSet({ level }) { return (await getOsControl()).volumeSet(level); }
async function toolVolumeGet() { return (await getOsControl()).volumeGet(); }
async function toolVolumeMute({ mute }) { return (await getOsControl()).volumeMute(mute); }
async function toolWindowList() { return (await getOsControl()).windowList(); }
async function toolWindowFocus({ target }) { return (await getOsControl()).windowFocus(target); }
async function toolProcessLaunch({ command }) { return (await getOsControl()).processLaunch(command); }
async function toolProcessKill({ pid }) { return (await getOsControl()).processKill(pid); }
async function toolProcessList({ filter }) { return (await getOsControl()).processList(filter); }
async function toolSystemInfo() { return (await getOsControl()).systemInfo(); }
async function toolClipboardGet() { return (await getOsControl()).clipboardGet(); }
async function toolClipboardSet({ text }) { return (await getOsControl()).clipboardSet(text); }

export default {
  listTools,
  executeTool,
  TOOL_NAMES,
};
