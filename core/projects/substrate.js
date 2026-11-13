import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { underAuthorityGate } from '../governance/grants/authority-gate.js';
import { selectExistingRecordAppend } from './record-file-port.mjs';
import { buildDefaultProjectConfig } from "./manager.js";
import { resolveProjectConfigDir, resolveProjectConfigFile } from "./config-dir.js";
import { bootstrap as bootstrapProject } from "../bootstrap/project-init.js";
import { resolveGovernanceTarget, targetIsBlocked } from "../governance/target.js";
import { inspectSandboxHygiene, pruneSandboxHygiene, SANDBOX_BRANCH_PREFIX, SANDBOX_DIR_NAME } from "../sandbox/hygiene.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ILLUCI_ROOT = resolve(HERE, "..", "..");
const SUBSTRATE_PLAN_SCHEMA = "illuci.project.substrate.plan/1";
const PROJECT_SUBSTRATE_SCHEMA = "illuci.project.substrate/1";
const BRIDGE_SCHEMA = "illuci.project.bridge.local/1";
const DOCTOR_SCHEMA = "illuci.project.substrate.doctor/1";
const DATA_RECORD_SCHEMA = "illuci.project.data.record/1";
const SUBSTRATE_CAPTURE_SCHEMA = "illuci.project.substrate.capture/1";
const JETBRAINS_ACP_SCHEMA = "illuci.ide.jetbrains.acp/1";
const DEFAULT_VERSION = "0.1.0";
export const LOCAL_RUNTIME_ENV = "ILLUCI_PROJECT_SUBSTRATE_LOCAL_RUNTIME";

const LOCAL_EXCLUDES = [
  ".illuci/bridge.local.json",
  ".illuci/ide.local/",
  ".illuci/data/",
  ".illuci/runtime/",
  ".illuci-sandboxes/",
  ".idea/",
];

export const PROJECT_DATA_LANES = [
  "observations",
  "runs",
  "traces",
  "research",
  "decisions",
  "artifacts",
  "telemetry",
  "sessions",
  "memory",
  "governance",
];

const DATA_DIRS = PROJECT_DATA_LANES.map((lane) => `.illuci/data/${lane}`);
const LEGACY_RUNTIME_DIRS = PROJECT_DATA_LANES.map((lane) => `.illuci/runtime/${lane}`);
const RECORDS_FILE = "records.jsonl";

function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return null; }
}

function isFile(filePath) {
  return safeStat(filePath)?.isFile() === true;
}

function isDirectory(filePath) {
  return safeStat(filePath)?.isDirectory() === true;
}

function ensureArray(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(ensureArray);
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeLane(lane) {
  const normalized = String(lane || "").trim().toLowerCase();
  if (!PROJECT_DATA_LANES.includes(normalized)) {
    throw new Error(`unknown project data lane: ${lane || "(missing)"}`);
  }
  return normalized;
}

function gitRootFor(targetPath) {
  try {
    return execFileSync("git", ["-C", targetPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function gitPathFor(targetPath, gitPath) {
  try {
    const resolvedPath = execFileSync("git", ["-C", targetPath, "rev-parse", "--git-path", gitPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return resolvedPath ? resolve(targetPath, resolvedPath) : null;
  } catch {
    return null;
  }
}

function gitInfoExcludePathFor(target) {
  if (!target.gitRoot) return join(target.repoRoot, ".git", "info", "exclude");
  return gitPathFor(target.repoRoot, "info/exclude") || join(target.gitRoot, ".git", "info", "exclude");
}

function action(kind, path, operation, extra = {}) {
  return { kind, path, operation, ...extra };
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const utc = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  const pacificParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const byType = Object.fromEntries(pacificParts.map((part) => [part.type, part.value]));
  const pacific = `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute} ${byType.timeZoneName || "PT"}`;
  return `${utc} / ${pacific}`;
}

function docHeader({ title, version = DEFAULT_VERSION, status = "ACTIVE", timestamp }) {
  return `| Document | ${title} |\n|---|---|\n| Version | ${version} |\n| Timestamp | ${timestamp} |\n| Author | illuci project substrate |\n| Status | ${status} |\n\n`;
}

function buildDocPack(projectName, options = {}) {
  const timestamp = options.timestamp || formatTimestamp();
  const version = options.version || DEFAULT_VERSION;
  const name = projectName || "illuci-governed project";
  return {
    "CORE.md": `${docHeader({ title: `${name} Core`, version, timestamp })}# ${name}\n\nThis repository is a illuci-governed project. It carries a local governance substrate, project configuration, runtime data spine, and bridge metadata so illuci can assist, observe, organize, and audit work without making the engine repository the project root.\n`,
    "CONTEXT.md": `${docHeader({ title: `${name} Context`, version, timestamp })}# Context\n\nUse \`illuci project assess --target . --json\` to inspect this checkout. Use \`illuci project substrate doctor --target . --json\` to inspect the local bridge. Use \`illuci project substrate refresh --target . --apply\` to refresh the local bridge substrate after moving the project or illuci runtime. Runtime observations, runs, traces, research notes, and local IDE bridge files live under \`.illuci/\` and are excluded from source unless explicitly promoted.\n`,
    "ARCHITECTURE.md": `${docHeader({ title: `${name} Architecture`, version, timestamp })}# Architecture\n\nThe repository root is the project boundary. The committed project configuration lives at \`.illuci/project.json\`. The local-only bridge manifest lives at \`.illuci/bridge.local.json\`. Runtime data accumulates under \`.illuci/data/\` and can later be promoted into governed artifacts when it becomes durable project knowledge.\n`,
    "GOVERNANCE.md": `${docHeader({ title: `${name} Governance`, version, timestamp })}# Governance\n\nThis project inherits the Ground Zero Solutions governance standard through illuci. Work proceeds through batch-prefixed changes, append-only ledgers, explicit version movement, verification before merge, and local source hygiene. The illuci substrate provides hooks, bridge metadata, runtime data directories, and assessment commands to keep this discipline available from IDEs and terminals.\n`,
    "ROADMAP.md": `${docHeader({ title: `${name} Roadmap`, version, timestamp })}# Roadmap\n\n## Current Milestone\n\n\`[A1]\` initializes the governed project substrate and makes the repository ready for illuci-assisted work.\n\n## Forward Work\n\n| Lane | Purpose | Status |\n|---|---|---|\n| Governance substrate | Keep local hooks, bridge metadata, and project assessment available. | Active |\n| Runtime data spine | Collect observations, runs, traces, research, decisions, telemetry, sessions, memory, governance, and artifacts under \`.illuci/data/\`. | Active |\n| Product work | Define project-specific implementation milestones. | Pending |\n`,
    "BATCH_LOG.md": `${docHeader({ title: `${name} Batch Log`, version, timestamp })}# Batch Log\n\n## [A1] | ${timestamp} | Governed project substrate initialized\n\n*Scope:* Create the initial illuci-governed project substrate.\n\n*Changes:*\n\n- Added committed governance and project context artifacts.\n- Added \`.illuci/project.json\` as the project-local illuci configuration.\n- Added local-only bridge and runtime data surfaces under \`.illuci/\`.\n\n*Version:* \`${version}\`\n`,
    "DECISION_REGISTRY.md": `${docHeader({ title: `${name} Decision Registry`, version, timestamp })}# Decision Registry\n\n## DR-001 | ${timestamp} | illuci governs this project substrate\n\n*Decision:* This repository carries a illuci project substrate for governance, bridge configuration, local runtime data, and IDE-assisted work.\n\n*Rationale:* Project work should be available to illuci across terminals and IDEs without conflating the project repository with the illuci engine repository.\n\n*Consequences:* Local runtime data remains under \`.illuci/data/\` unless promoted into committed artifacts. Older \`.illuci/runtime/\` records are readable legacy data, not the canonical write target.\n`,
    "FINDINGS.md": `${docHeader({ title: `${name} Findings`, version, timestamp })}# Findings\n\nNo findings recorded at substrate creation.\n`,
    "AGENTS.md": `${docHeader({ title: `${name} Agent Instructions`, version, timestamp })}# Agent Instructions\n\nThis repository is illuci-governed. Inspect \`.illuci/project.json\`, run \`illuci project assess --target . --json\`, preserve append-only ledgers, and keep local runtime data under \`.illuci/data/\` unless the operator promotes it into source.\n`,
  };
}

function buildTarget(projectRoot, options = {}) {
  const profile = options.profile || "attach";
  if (profile !== "create") return resolveGovernanceTarget(projectRoot, { cwd: options.cwd });

  const cwd = resolve(options.cwd || process.cwd());
  const requested = projectRoot == null || projectRoot === "" ? null : String(projectRoot);
  const repoRoot = resolve(cwd, requested || options.name || "illuci-project");
  const exists = existsSync(repoRoot);
  const stat = safeStat(repoRoot);
  const findings = [];

  if (exists && !stat?.isDirectory()) {
    findings.push({ severity: "blocking", code: "target-not-directory", message: "target path is not a directory: " + repoRoot });
  }

  const gitRoot = exists && stat?.isDirectory() ? gitRootFor(repoRoot) : null;
  return {
    schema: "illuci.governance.target/1",
    mode: requested ? "explicit" : "default-current",
    requestedPath: requested,
    cwd,
    candidateRoot: repoRoot,
    repoRoot,
    gitRoot: gitRoot ? resolve(gitRoot) : null,
    exists,
    governed: existsSync(join(repoRoot, "VERSION")) || existsSync(join(repoRoot, ".illuci", "project.json")) || existsSync(join(repoRoot, "illuci-governance.json")),
    markers: {
      versionFile: existsSync(join(repoRoot, "VERSION")),
      packageJson: existsSync(join(repoRoot, "package.json")),
      illuciProjectConfig: existsSync(join(repoRoot, ".illuci", "project.json")),
      governanceManifest: existsSync(join(repoRoot, "illuci-governance.json")),
      gitWorktree: Boolean(gitRoot),
    },
    findings,
  };
}

function buildEntrypoints(repoRoot, options = {}) {
  const illuciRoot = resolve(options.illuciRoot || ILLUCI_ROOT);
  const node = options.nodePath || process.execPath;
  return {
    illuciRoot,
    node,
    cli: join(illuciRoot, "cli", "illuci.mjs"),
    mcp: join(illuciRoot, "core", "mcp", "server.js"),
    acp: join(illuciRoot, "core", "acp", "server.js"),
    hooksDir: join(illuciRoot, "core", "governance", "authortime", "hooks"),
    projectRoot: repoRoot,
  };
}

/**
 * Resolve the deployed Illuci Runtime a project consumes. Project substrate emissions
 * are remote-first: unset runtime URL is a missing deployment target, not permission
 * to silently launch a local stdio process. The token is carried only as an env-var
 * name (default ILLUCI_RUNTIME_TOKEN); no secret value is ever written into emitted files.
 */
export function resolveRemoteRuntime(options = {}) {
  const raw = options.runtimeUrl != null && options.runtimeUrl !== true ? String(options.runtimeUrl) : process.env.ILLUCI_RUNTIME_URL;
  if (!raw || typeof raw !== "string" || raw.trim() === "") return null;
  const base = raw.trim().replace(/\/+$/, "").replace(/\/mcp$/, "");
  const tokenEnv = options.runtimeTokenEnv && options.runtimeTokenEnv !== true ? String(options.runtimeTokenEnv) : "ILLUCI_RUNTIME_TOKEN";
  return { url: base, mcpUrl: `${base}/mcp`, tokenEnv };
}

function truthyFlag(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function localRuntimeRequested(options = {}) {
  const mode = options.runtimeMode && options.runtimeMode !== true ? String(options.runtimeMode).trim().toLowerCase() : "";
  return (
    truthyFlag(options.localRuntime) ||
    ["local", "local-stdio", "local-stdio-dev", "dev-stdio"].includes(mode) ||
    truthyFlag(process.env[LOCAL_RUNTIME_ENV])
  );
}

export function resolveRuntimeConsumption(options = {}) {
  const remote = resolveRemoteRuntime(options);
  if (remote) return { mode: "remote", remote, blocked: false, findings: [] };
  if (localRuntimeRequested(options)) return { mode: "local-stdio-dev", remote: null, blocked: false, findings: [] };
  return {
    mode: "remote-required",
    remote: null,
    blocked: true,
    findings: [
      finding(
        "blocking",
        "remote-runtime-required",
        `project substrate requires --runtime-url or ILLUCI_RUNTIME_URL; use --local-runtime or ${LOCAL_RUNTIME_ENV}=1 only for deliberate single-machine development stdio`,
      ),
    ],
  };
}

/** The remote MCP server entry an IDE/host consumes: URL + bearer env-ref, no local launch. */
function remoteMcpServerEntry(remote) {
  return {
    type: "http",
    url: remote.mcpUrl,
    headers: { Authorization: `Bearer \${${remote.tokenEnv}}` },
  };
}

function buildBridgeManifest(repoRoot, entrypoints, options = {}) {
  const bridgePath = join(repoRoot, ".illuci", "bridge.local.json");
  const remote = options.remote || null;
  const runtimeMode = options.runtimeMode || (remote ? "remote" : "local-stdio-dev");
  return {
    schema: BRIDGE_SCHEMA,
    projectRoot: repoRoot,
    illuciRoot: entrypoints.illuciRoot,
    generatedBy: "illuci project substrate",
    profile: options.profile || "attach",
    runtime: remote
      ? { mode: "remote", url: remote.url, mcp: remote.mcpUrl, authorization: { scheme: "bearer", tokenEnv: remote.tokenEnv } }
      : { mode: runtimeMode, developmentOnly: true },
    ...(remote
      ? { remoteRuntime: { url: remote.url, mcp: remote.mcpUrl, authorization: { scheme: "bearer", tokenEnv: remote.tokenEnv } } }
      : {}),
    surfaces: {
      cli: { command: entrypoints.node, args: [entrypoints.cli], cwd: repoRoot },
      mcp: remote
        ? {
            transport: "http",
            url: remote.mcpUrl,
            authorization: { scheme: "bearer", tokenEnv: remote.tokenEnv },
          }
        : {
            transport: "stdio",
            command: entrypoints.node,
            args: [entrypoints.mcp],
            env: { ILLUCI_PROJECT_ROOT: repoRoot, ILLUCI_IDE_BRIDGE: bridgePath },
          },
      acp: {
        transport: "stdio",
        command: entrypoints.node,
        args: [entrypoints.acp],
        env: { ILLUCI_PROJECT_ROOT: repoRoot, ILLUCI_IDE_BRIDGE: bridgePath },
      },
      governance: {
        assess: { command: entrypoints.node, args: [entrypoints.cli, "project", "assess", repoRoot, "--json"] },
        floor: { command: entrypoints.node, args: [join(entrypoints.illuciRoot, "core", "governance", "authortime", "floor-check-cli.mjs"), repoRoot, "--working"] },
        ceiling: { command: entrypoints.node, args: [join(entrypoints.illuciRoot, "core", "governance", "authortime", "ceiling-check-cli.mjs"), repoRoot, "--working"] },
      },
    },
    dataSpine: Object.fromEntries(DATA_DIRS.map((dir) => [dir.split("/").pop(), join(repoRoot, dir)])),
    legacyDataSpine: Object.fromEntries(LEGACY_RUNTIME_DIRS.map((dir) => [dir.split("/").pop(), join(repoRoot, dir)])),
    sandboxRuntime: {
      root: join(repoRoot, SANDBOX_DIR_NAME),
      branchPrefix: SANDBOX_BRANCH_PREFIX,
    },
    researchRuntime: {
      nodeCore: "orchestration-governance-cli-ide-bridges",
      pythonBoundary: "planned-service-or-worker-boundary",
      integrationPatterns: ["http-service", "ndjson-subprocess", "queue-worker", "shared-storage"],
    },
    hooks: { coreHooksPath: entrypoints.hooksDir, armCommand: ["git", "-C", repoRoot, "config", "core.hooksPath", entrypoints.hooksDir] },
  };
}

function buildIdeMcpSnippet(repoRoot, entrypoints, remote = null) {
  return {
    mcpServers: {
      illuci: remote
        ? remoteMcpServerEntry(remote)
        : {
            command: entrypoints.node,
            args: [entrypoints.mcp],
            env: { ILLUCI_PROJECT_ROOT: repoRoot, ILLUCI_IDE_BRIDGE: join(repoRoot, ".illuci", "bridge.local.json") },
          },
    },
  };
}

function buildJetBrainsAcpSnippet(repoRoot, entrypoints) {
  const bridgePath = join(repoRoot, ".illuci", "bridge.local.json");
  return {
    schema: JETBRAINS_ACP_SCHEMA,
    profile: "jetbrains",
    name: "illuci",
    displayName: "illuci ACP",
    purpose: "Register the illuci ACP server for JetBrains-compatible agent-client surfaces.",
    schemaAuthority: "illuci-owned",
    protocol: "acp",
    transport: "stdio",
    command: entrypoints.node,
    args: [entrypoints.acp],
    cwd: repoRoot,
    env: {
      ILLUCI_PROJECT_ROOT: repoRoot,
      ILLUCI_IDE_BRIDGE: bridgePath,
    },
    related: {
      bridgeManifest: bridgePath,
      localProfile: join(repoRoot, ".illuci", "ide.local", "jetbrains", "bridge.json"),
      mcpSnippet: join(repoRoot, ".illuci", "ide.local", "mcp.json"),
    },
  };
}

function buildIdeProfileSnippet(profile, repoRoot, entrypoints, remote = null) {
  const base = {
    schema: `illuci.ide.${profile}/1`,
    profile,
    projectRoot: repoRoot,
    generatedBy: "illuci project substrate",
  };
  const illuciCommand = {
    command: entrypoints.node,
    args: [entrypoints.cli],
    cwd: repoRoot,
  };
  const mcpServer = remote
    ? remoteMcpServerEntry(remote)
    : {
        command: entrypoints.node,
        args: [entrypoints.mcp],
        env: { ILLUCI_PROJECT_ROOT: repoRoot, ILLUCI_IDE_BRIDGE: join(repoRoot, ".illuci", "bridge.local.json") },
      };
  if (profile === "jetbrains") {
    return {
      ...base,
      externalTools: [
        { name: "illuci project assess", ...illuciCommand, args: [...illuciCommand.args, "project", "assess", repoRoot, "--json"] },
        { name: "illuci project substrate doctor", ...illuciCommand, args: [...illuciCommand.args, "project", "substrate", "doctor", "--target", repoRoot, "--json"] },
        { name: "illuci project substrate refresh", ...illuciCommand, args: [...illuciCommand.args, "project", "substrate", "refresh", "--target", repoRoot, "--apply", "--ide", "jetbrains"] },
      ],
      mcpServer,
      acpRegistration: buildJetBrainsAcpSnippet(repoRoot, entrypoints),
      ideaHostFiles: {
        enabledBy: "illuci project substrate emit-ide --profile jetbrains --host-files --apply",
        directory: ".idea/runConfigurations/",
      },
    };
  }
  return {
    ...base,
    mcpServers: { illuci: mcpServer },
    commands: {
      assess: { ...illuciCommand, args: [...illuciCommand.args, "project", "assess", repoRoot, "--json"] },
      doctor: { ...illuciCommand, args: [...illuciCommand.args, "project", "substrate", "doctor", "--target", repoRoot, "--json"] },
    },
  };
}

function xmlAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildJetBrainsRunConfiguration(repoRoot, entrypoints) {
  const cli = xmlAttribute(entrypoints.cli);
  const node = xmlAttribute(entrypoints.node);
  const workDir = xmlAttribute(repoRoot);
  return `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="illuci project doctor" type="NodeJSConfigurationType" path-to-node="${node}" working-dir="${workDir}" application-parameters="&quot;${cli}&quot; project substrate doctor --target &quot;${workDir}&quot; --json">
    <method v="2" />
  </configuration>
</component>
`;
}

function buildJetBrainsAcpRunConfiguration(repoRoot, entrypoints) {
  const acp = xmlAttribute(entrypoints.acp);
  const node = xmlAttribute(entrypoints.node);
  const workDir = xmlAttribute(repoRoot);
  const bridge = xmlAttribute(join(repoRoot, ".illuci", "bridge.local.json"));
  return `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="illuci ACP server" type="NodeJSConfigurationType" path-to-node="${node}" working-dir="${workDir}" application-parameters="&quot;${acp}&quot;">
    <envs>
      <env name="ILLUCI_PROJECT_ROOT" value="${workDir}" />
      <env name="ILLUCI_IDE_BRIDGE" value="${bridge}" />
    </envs>
    <method v="2" />
  </configuration>
</component>
`;
}

function buildProjectConfig(repoRoot, options = {}) {
  const existing = readJson(resolveProjectConfigFile(repoRoot, "project.json")) || {};
  const base = buildDefaultProjectConfig(repoRoot);
  const profile = options.profile || "attach";
  return {
    ...base,
    ...existing,
    name: options.name || existing.name || base.name,
    substrate: {
      ...(existing.substrate || {}),
      schema: PROJECT_SUBSTRATE_SCHEMA,
      installedBy: "illuci project substrate",
      profile,
      governancePack: options.governancePack === true,
      bridgeManifest: ".illuci/bridge.local.json",
      ideSnippets: ".illuci/ide.local/",
      dataRoot: ".illuci/data/",
      runtimeData: ".illuci/data/",
      legacyRuntimeData: ".illuci/runtime/",
      sandboxRuntime: {
        root: `${SANDBOX_DIR_NAME}/`,
        branchPrefix: SANDBOX_BRANCH_PREFIX,
      },
      dataStreams: Object.fromEntries(PROJECT_DATA_LANES.map((lane) => [lane, `.illuci/data/${lane}`])),
      hooks: { optional: true, mode: "local-git-config" },
      researchRuntime: {
        nodeCore: "orchestration-governance-cli-ide-bridges",
        pythonBoundary: "planned-service-or-worker-boundary",
      },
    },
  };
}

function ensureLocalExcludeText(existing) {
  const lines = existing.split(/\r?\n/);
  let changed = false;
  for (const item of LOCAL_EXCLUDES) {
    if (!lines.includes(item)) {
      lines.push(item);
      changed = true;
    }
  }
  return changed ? lines.filter((line, index) => index < lines.length - 1 || line !== "").join("\n") + "\n" : existing;
}

function addDocPackActions(actions, repoRoot, projectName, options = {}) {
  const docs = buildDocPack(projectName, options);
  for (const [file, content] of Object.entries(docs)) {
    actions.push(action("text-if-missing", join(repoRoot, file), isFile(join(repoRoot, file)) ? "exists" : "create", { content }));
  }
}

function addIdeActions(actions, repoRoot, configDir, entrypoints, options = {}) {
  if (options.ide === false) return;
  const ideDir = join(configDir, "ide.local");
  const profiles = ensureArray(options.ideProfiles || options.ideProfile || options.profileName);
  const hostFiles = options.ideHostFiles === true || options.hostFiles === true;
  const remote = options.remote || null;
  actions.push(action("directory", ideDir, existsSync(ideDir) ? "exists" : "create", { local: true }));
  actions.push(action("json", join(ideDir, "mcp.json"), isFile(join(ideDir, "mcp.json")) ? "replace-local" : "create-local", { data: buildIdeMcpSnippet(repoRoot, entrypoints, remote), local: true }));
  for (const profile of profiles) {
    if (!["codex", "vscode", "cursor", "windsurf", "jetbrains"].includes(profile)) continue;
    const profileDir = join(ideDir, profile);
    actions.push(action("directory", profileDir, existsSync(profileDir) ? "exists" : "create", { local: true, profile }));
    actions.push(action("json", join(profileDir, "bridge.json"), isFile(join(profileDir, "bridge.json")) ? "replace-local" : "create-local", {
      data: buildIdeProfileSnippet(profile, repoRoot, entrypoints, remote),
      local: true,
      profile,
    }));
    if (profile === "jetbrains") {
      actions.push(action("json", join(profileDir, "acp.json"), isFile(join(profileDir, "acp.json")) ? "replace-local" : "create-local", {
        data: buildJetBrainsAcpSnippet(repoRoot, entrypoints),
        local: true,
        profile,
      }));
      actions.push(action("text", join(profileDir, "README.md"), "replace-local", {
        content: "# JetBrains illuci bridge\n\nUse `bridge.json` for External Tools-style commands and `acp.json` for the illuci ACP server registration metadata. Host `.idea/` files are only emitted with `--host-files`.\n",
        local: true,
        profile,
      }));
      if (hostFiles) {
        const doctorConfigPath = join(repoRoot, ".idea", "runConfigurations", "Illuci_Project_Doctor.xml");
        const acpConfigPath = join(repoRoot, ".idea", "runConfigurations", "Illuci_ACP_Server.xml");
        actions.push(action("text-if-missing", doctorConfigPath, isFile(doctorConfigPath) ? "exists-local" : "create-local", {
          content: buildJetBrainsRunConfiguration(repoRoot, entrypoints),
          local: true,
          profile,
          hostFile: true,
          hostFileRole: "doctor",
        }));
        actions.push(action("text-if-missing", acpConfigPath, isFile(acpConfigPath) ? "exists-local" : "create-local", {
          content: buildJetBrainsAcpRunConfiguration(repoRoot, entrypoints),
          local: true,
          profile,
          hostFile: true,
          hostFileRole: "acp",
        }));
      }
    }
  }
}

export function buildProjectSubstratePlan(projectRoot = null, options = {}) {
  const profile = options.profile || "attach";
  const target = buildTarget(projectRoot, { ...options, profile });
  const repoRoot = target.repoRoot;
  const projectName = options.name || basename(repoRoot);
  const includeHooks = options.hooks === true;
  const includeGovernancePack = options.governancePack ?? profile === "create";
  const includeGit = options.git !== false;
  const scope = options.scope || "full";
  const entrypoints = buildEntrypoints(repoRoot, options);
  const emitsBridge = scope === "full" || (scope === "ide" && options.ide !== false);
  const runtime = emitsBridge
    ? resolveRuntimeConsumption(options)
    : { mode: "not-required", remote: resolveRemoteRuntime(options), blocked: false, findings: [] };
  const remote = runtime.remote;
  const targetWithFindings = runtime.findings?.length
    ? { ...target, findings: [...target.findings, ...runtime.findings] }
    : target;
  const blocked = targetIsBlocked(targetWithFindings) || runtime.blocked === true;
  const bridge = emitsBridge ? buildBridgeManifest(repoRoot, entrypoints, { profile, remote, runtimeMode: runtime.mode }) : null;
  const projectConfig = buildProjectConfig(repoRoot, { profile, name: projectName, governancePack: includeGovernancePack });
  const configDir = resolveProjectConfigDir(repoRoot);
  const dataDirs = DATA_DIRS.map((dir) => join(repoRoot, dir));
  const gitInfoExcludePath = gitInfoExcludePathFor(target);
  const actions = [];

  if (!blocked) {
    if (scope === "full") {
      if (profile === "create" && !target.exists) actions.push(action("root-directory", repoRoot, "create"));
      if (profile === "create" && includeGit && !target.gitRoot) actions.push(action("git-init", repoRoot, "ensure"));
      if (profile === "create" && !isFile(join(repoRoot, "VERSION"))) actions.push(action("text-if-missing", join(repoRoot, "VERSION"), "create", { content: DEFAULT_VERSION + "\n" }));
      if (profile === "create") actions.push(action("bootstrap", repoRoot, "ensure"));
      if (includeGovernancePack) addDocPackActions(actions, repoRoot, projectName, { version: DEFAULT_VERSION });
      actions.push(action("directory", configDir, existsSync(configDir) ? "exists" : "create"));
      for (const dir of dataDirs) actions.push(action("directory", dir, existsSync(dir) ? "exists" : "create", { local: true }));
      actions.push(action("json", resolveProjectConfigFile(repoRoot, "project.json"), isFile(resolveProjectConfigFile(repoRoot, "project.json")) ? "merge" : "create", { data: projectConfig }));
      actions.push(action("json", join(configDir, "bridge.local.json"), isFile(join(configDir, "bridge.local.json")) ? "replace-local" : "create-local", { data: bridge, local: true }));
    }
    if (scope === "full" || scope === "ide") addIdeActions(actions, repoRoot, configDir, entrypoints, { ...options, remote });
    if (includeGit) actions.push(action("git-info-exclude", gitInfoExcludePath, "ensure-local-excludes", { entries: LOCAL_EXCLUDES }));
    if (includeHooks) actions.push(action("git-config", repoRoot, "set-core-hooks-path", { key: "core.hooksPath", value: entrypoints.hooksDir }));
    if (options.sandboxPrune === true) {
      actions.push(action("sandbox-prune", repoRoot, "prune-sandbox-runtime", {
        local: true,
        removeStaleDirectories: true,
        deleteMergedBranches: options.sandboxPruneMergedBranches === true,
      }));
    }
  }

  return { schema: SUBSTRATE_PLAN_SCHEMA, profile, scope, apply: options.apply === true, blocked, target: targetWithFindings, runtime, bridge, actions };
}
export function applyProjectSubstratePlan(plan) {
  if (plan.blocked) return { ok: false, applied: [], skipped: [], findings: plan.target.findings };
  const applied = [];
  const skipped = [];
  for (const step of plan.actions) {
    if (step.kind === "root-directory" || step.kind === "directory") {
      if (existsSync(step.path)) skipped.push(step);
      else { mkdirSync(step.path, { recursive: true }); applied.push(step); }
    } else if (step.kind === "git-init") {
      if (!existsSync(step.path)) mkdirSync(step.path, { recursive: true });
      if (gitRootFor(step.path)) skipped.push(step);
      else { execFileSync("git", ["-C", step.path, "init"], { encoding: "utf8" }); applied.push(step); }
    } else if (step.kind === "bootstrap") {
      const result = bootstrapProject(step.path);
      applied.push({ ...step, result });
    } else if (step.kind === "text-if-missing") {
      if (existsSync(step.path)) skipped.push(step);
      else { mkdirSync(dirname(step.path), { recursive: true }); writeFileSync(step.path, step.content, "utf8"); applied.push(step); }
    } else if (step.kind === "text") {
      mkdirSync(dirname(step.path), { recursive: true });
      writeFileSync(step.path, step.content, "utf8");
      applied.push(step);
    } else if (step.kind === "json") {
      mkdirSync(dirname(step.path), { recursive: true });
      writeFileSync(step.path, JSON.stringify(step.data, null, 2) + "\n", "utf8");
      applied.push(step);
    } else if (step.kind === "git-info-exclude") {
      const current = existsSync(step.path) ? readFileSync(step.path, "utf8") : "";
      const next = ensureLocalExcludeText(current);
      if (next === current) skipped.push(step);
      else { mkdirSync(dirname(step.path), { recursive: true }); writeFileSync(step.path, next, "utf8"); applied.push(step); }
    } else if (step.kind === "git-config") {
      execFileSync("git", ["-C", step.path, "config", step.key, step.value], { encoding: "utf8" });
      applied.push(step);
    } else if (step.kind === "sandbox-prune") {
      const result = pruneSandboxHygiene(step.path, {
        removeStaleDirectories: step.removeStaleDirectories === true,
        deleteMergedBranches: step.deleteMergedBranches === true,
      });
      applied.push({ ...step, result });
    } else {
      skipped.push({ ...step, reason: "unknown-action" });
    }
  }
  return { ok: true, applied, skipped, findings: [] };
}

function readGitInfoExclude(target) {
  const path = gitInfoExcludePathFor(target);
  return { path, text: existsSync(path) ? readFileSync(path, "utf8") : "" };
}

function finding(severity, code, message, path = null, extra = {}) {
  return { severity, code, message, path, ...extra };
}

function textFileContains(filePath, needles) {
  if (!isFile(filePath)) return false;
  const text = readFileSync(filePath, "utf8");
  return needles.every((needle) => text.includes(needle));
}

function addJetBrainsDoctorFindings(findings, repoRoot, options = {}) {
  const profileDir = join(repoRoot, ".illuci", "ide.local", "jetbrains");
  const bridgePath = join(profileDir, "bridge.json");
  const acpPath = join(profileDir, "acp.json");
  const bridge = readJson(bridgePath);
  const acp = readJson(acpPath);
  if (!bridge) findings.push(finding("warning", "jetbrains-bridge-snippet-missing-or-invalid", "missing or invalid JetBrains bridge snippet", bridgePath));
  if (!acp || acp.schema !== JETBRAINS_ACP_SCHEMA) {
    findings.push(finding("warning", "jetbrains-acp-snippet-missing-or-invalid", "missing or invalid JetBrains ACP registration snippet", acpPath));
  }

  const doctorConfigPath = join(repoRoot, ".idea", "runConfigurations", "Illuci_Project_Doctor.xml");
  const acpConfigPath = join(repoRoot, ".idea", "runConfigurations", "Illuci_ACP_Server.xml");
  const wantHostFiles = options.ideHostFiles === true || options.hostFiles === true;
  const hostFiles = [
    { path: doctorConfigPath, code: "jetbrains-doctor-host-file", needles: ["illuci project doctor", "project substrate doctor"] },
    { path: acpConfigPath, code: "jetbrains-acp-host-file", needles: ["illuci ACP server", "ILLUCI_PROJECT_ROOT", "ILLUCI_IDE_BRIDGE"] },
  ];
  for (const host of hostFiles) {
    if (!isFile(host.path)) {
      if (wantHostFiles) findings.push(finding("warning", `${host.code}-missing`, `missing JetBrains host file: ${host.path}`, host.path, { hostFile: true }));
      continue;
    }
    if (!textFileContains(host.path, host.needles)) {
      findings.push(finding("warning", `${host.code}-invalid`, `JetBrains host file is present but does not match the illuci probe contract: ${host.path}`, host.path, { hostFile: true }));
    } else {
      findings.push(finding("info", `${host.code}-present`, `JetBrains host file is present and matches the illuci probe contract: ${host.path}`, host.path, { hostFile: true }));
    }
  }
}

export function doctorProjectSubstrate(projectRoot = null, options = {}) {
  const target = buildTarget(projectRoot, { ...options, profile: "attach" });
  const findings = [...target.findings];
  if (targetIsBlocked(target)) {
    return { schema: DOCTOR_SCHEMA, target, status: "fail", findings };
  }
  const repoRoot = target.repoRoot;
  const projectConfigPath = resolveProjectConfigFile(repoRoot, "project.json");
  const bridgePath = join(repoRoot, ".illuci", "bridge.local.json");
  const projectConfig = readJson(projectConfigPath);
  const bridge = readJson(bridgePath);
  if (!projectConfig) findings.push(finding("blocking", "project-config-missing-or-invalid", "missing or invalid .illuci/project.json", projectConfigPath));
  if (!bridge) findings.push(finding("blocking", "bridge-manifest-missing-or-invalid", "missing or invalid .illuci/bridge.local.json", bridgePath));
  const remote = resolveRemoteRuntime(options);
  const localRuntime = localRuntimeRequested(options);
  const mcpSurface = bridge?.surfaces?.mcp;
  if (mcpSurface?.transport === "stdio" && !localRuntime) {
    findings.push(finding(
      "blocking",
      "remote-runtime-required",
      "bridge MCP surface launches local stdio; refresh with --runtime-url or set ILLUCI_RUNTIME_URL, or run doctor with --local-runtime for deliberate dev-only stdio",
      bridgePath,
    ));
  }
  if (remote && mcpSurface?.transport !== "http") {
    findings.push(finding("blocking", "bridge-runtime-not-remote", `bridge MCP surface is not pointed at ${remote.mcpUrl}`, bridgePath));
  }
  if (projectConfig?.substrate?.dataRoot !== ".illuci/data/" && projectConfig?.substrate?.runtimeData !== ".illuci/data/") {
    findings.push(finding("warning", "project-data-root-not-canonical", "project substrate data root is not canonical .illuci/data/", projectConfigPath));
  }
  for (const lane of PROJECT_DATA_LANES) {
    const path = join(repoRoot, ".illuci", "data", lane);
    if (!isDirectory(path)) findings.push(finding("blocking", "data-lane-missing", `missing canonical data lane: ${lane}`, path));
  }
  const legacyRuntime = join(repoRoot, ".illuci", "runtime");
  if (isDirectory(legacyRuntime)) {
    findings.push(finding("info", "legacy-runtime-readable", "legacy .illuci/runtime data is readable but not canonical", legacyRuntime));
  }
  const ideMcp = join(repoRoot, ".illuci", "ide.local", "mcp.json");
  if (!readJson(ideMcp)) findings.push(finding("warning", "ide-mcp-snippet-missing-or-invalid", "missing or invalid local IDE MCP snippet", ideMcp));
  for (const profile of ensureArray(options.ideProfiles || options.ideProfile)) {
    const path = join(repoRoot, ".illuci", "ide.local", profile, "bridge.json");
    if (!readJson(path)) findings.push(finding("warning", "ide-profile-snippet-missing-or-invalid", `missing or invalid ${profile} IDE snippet`, path));
    if (profile === "jetbrains") addJetBrainsDoctorFindings(findings, repoRoot, options);
  }
  const exclude = readGitInfoExclude(target);
  for (const entry of LOCAL_EXCLUDES) {
    if (!exclude.text.split(/\r?\n/).includes(entry)) {
      findings.push(finding("warning", "local-exclude-missing", `missing local exclude entry: ${entry}`, exclude.path));
    }
  }
  const sandbox = inspectSandboxHygiene(repoRoot);
  findings.push(...sandbox.findings);
  const hasBlocking = findings.some((item) => item.severity === "blocking");
  const hasWarning = findings.some((item) => item.severity === "warning");
  return { schema: DOCTOR_SCHEMA, target, status: hasBlocking ? "fail" : hasWarning ? "warn" : "pass", findings, sandbox };
}

function readJsonlRecords(path, source) {
  if (!existsSync(path)) return { records: [], errors: [] };
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return { records: [], errors: [] };
  const records = [];
  const errors = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push({ ...JSON.parse(line), _source: source });
    } catch (err) {
      errors.push({ path, line: index + 1, message: err.message });
    }
  });
  return { records, errors };
}

function projectDataPaths(repoRoot, lane) {
  return {
    canonical: join(repoRoot, ".illuci", "data", lane, RECORDS_FILE),
    legacy: join(repoRoot, ".illuci", "runtime", lane, RECORDS_FILE),
  };
}

function appendProjectDataRecord(repoRoot, lane, record) {
  const paths = projectDataPaths(repoRoot, lane);
  mkdirSync(dirname(paths.canonical), { recursive: true });
  appendFileSync(paths.canonical, JSON.stringify(record) + "\n", "utf8");
  return paths.canonical;
}

function isAttachedSubstrateRoot(repoRoot) {
  return isFile(resolveProjectConfigFile(repoRoot, "project.json"));
}

function captureRootForTarget(target, options = {}) {
  if (!targetIsBlocked(target) && isAttachedSubstrateRoot(target.repoRoot)) {
    return { root: target.repoRoot, landingZone: "target", attached: true };
  }
  return { root: resolve(options.controlRoot || options.illuciRoot || ILLUCI_ROOT), landingZone: "control-plane", attached: false };
}

export function captureProjectSubstrateObservation(projectRoot = null, operation = "unknown", payload = {}, options = {}) {
  if (options.capture === false) return { ok: false, skipped: true, reason: "capture-disabled" };
  const target = buildTarget(projectRoot, { ...options, profile: "attach" });
  const landing = captureRootForTarget(target, options);
  const timestamp = new Date().toISOString();
  const record = {
    schema: DATA_RECORD_SCHEMA,
    id: `pdr-${Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp,
    lane: "observations",
    type: `substrate.${operation}`,
    source: "illuci.project.substrate.capture",
    projectRoot: target.repoRoot,
    payload: {
      schema: SUBSTRATE_CAPTURE_SCHEMA,
      operation,
      landingZone: landing.landingZone,
      target: {
        mode: target.mode,
        requestedPath: target.requestedPath || null,
        repoRoot: target.repoRoot,
        governed: target.governed,
        blocked: targetIsBlocked(target),
      },
      observation: payload,
    },
    metadata: {
      captureRoot: landing.root,
      attachedTarget: landing.attached,
    },
  };
  try {
    const path = appendProjectDataRecord(landing.root, "observations", record);
    return {
      ok: true,
      schema: SUBSTRATE_CAPTURE_SCHEMA,
      operation,
      landingZone: landing.landingZone,
      path,
      recordId: record.id,
      captureRoot: landing.root,
      targetRoot: target.repoRoot,
    };
  } catch (err) {
    return {
      ok: false,
      schema: SUBSTRATE_CAPTURE_SCHEMA,
      operation,
      landingZone: landing.landingZone,
      reason: "capture-write-failed",
      message: err.message,
      captureRoot: landing.root,
      targetRoot: target.repoRoot,
    };
  }
}

export function recordProjectData(projectRoot = null, lane, payload = {}, options = {}) {
  const target = buildTarget(projectRoot, { ...options, profile: 'attach' });
  if (targetIsBlocked(target)) return { ok: false, target, findings: target.findings };
  if (normalizeLane(lane) !== 'artifacts') return appendProjectDataUnlocked(projectRoot, lane, payload, options);
  const directory = join(target.repoRoot, '.illuci', 'data', normalizeLane(lane));
  mkdirSync(directory, { recursive: true });
  return underAuthorityGate(directory, () => appendProjectDataUnlocked(projectRoot, lane, payload, options));
}

/** Internal synchronous transaction: all ordinary writers use this same lane gate. */
export function transactProjectData(projectRoot, lane, action) {
  if (lane !== 'artifacts' || typeof action !== 'function') throw TypeError('Synchronous artifacts transaction required');
  const target = buildTarget(projectRoot, { profile: 'attach' });
  if (targetIsBlocked(target)) throw Error('Project target unavailable');
  const directory = join(target.repoRoot, '.illuci', 'data', normalizeLane(lane));
  mkdirSync(directory, { recursive: true });
  return underAuthorityGate(directory, gate => {
    let active = true;
    const check = () => { if (!active) throw Error('Project transaction has ended'); gate.assertCurrent(); };
    try { return action(Object.freeze({
      read: () => { check(); return listProjectData(target.repoRoot, { lane }); },
      append: input => { check(); return appendProjectDataUnlocked(target.repoRoot, lane, input); },
      appendObserved: input => { check(); return appendObservedProjectDataUnlocked(target.repoRoot, lane, input, check); },
    })); } finally { active = false; }
  });
}

function prepareProjectDataAppend(projectRoot = null, lane, payload = {}, options = {}) {
  const target = buildTarget(projectRoot, { ...options, profile: "attach" });
  if (targetIsBlocked(target)) return { ok: false, target, findings: target.findings };
  const normalizedLane = normalizeLane(lane);
  const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { payload };
  const timestamp = input.timestamp || new Date().toISOString();
  const record = {
    schema: DATA_RECORD_SCHEMA,
    id: input.id || `pdr-${Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp,
    lane: normalizedLane,
    type: input.type || options.type || "record",
    source: input.source || options.source || "illuci.project.substrate",
    projectRoot: target.repoRoot,
    payload: input.payload === undefined ? input : input.payload,
    metadata: input.metadata || null,
  };
  return { ok: true, target, normalizedLane, record };
}

function appendProjectDataUnlocked(projectRoot = null, lane, payload = {}, options = {}) {
  const prepared = prepareProjectDataAppend(projectRoot, lane, payload, options);
  if (!prepared.ok) return prepared;
  const { target, normalizedLane, record } = prepared;
  const path = appendProjectDataRecord(target.repoRoot, normalizedLane, record);
  return { ok: true, target, lane: normalizedLane, path, record };
}

/** Internal existing-file observation; caller retains the existing synchronous
 * artifacts gate. Native policy supplies the original selected operation in
 * metadata; this reference is not an append permission or authentication.
 */
function appendObservedProjectDataUnlocked(projectRoot, lane, input, check) {
  const prepared = prepareProjectDataAppend(projectRoot, lane, input);
  if (!prepared.ok) throw Error('Selected project record target unavailable');
  const { target, normalizedLane, record } = prepared;
  const operationRef = record.metadata?.goalFeedbackOperationRef;
  if (normalizedLane !== 'artifacts' || typeof operationRef !== 'string' || !operationRef) {
    throw TypeError('Original native-selected artifacts operation reference required');
  }
  const path = projectDataPaths(target.repoRoot, normalizedLane).canonical;
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16777216n) {
    throw Error('Selected existing record file is unavailable or outside profile');
  }
  const observed = selectExistingRecordAppend({ path,
    fileIdentity: { dev: before.dev.toString(), ino: before.ino.toString() },
    expectedPrefixSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    expectedSize: Number(before.size), operationRef,
    bytes: Buffer.from(JSON.stringify(record) + '\n', 'utf8'),
    assertWriterCurrent: () => { check(); return true; },
  }).appendOnce();
  // Parse the bytes actually read from the retained handle, not the original
  // input object. Any unconfirmed error escapes and keeps the original gate.
  const readbackRecord = JSON.parse(observed.readbackBytes.toString('utf8'));
  return { ok: true, target, lane: normalizedLane, path, record: readbackRecord,
    io: observed.io, authorityGranted: false, custodyAuthenticated: false,
    directorySync: observed.directorySync, hardwareDurability: observed.hardwareDurability };
}

export function listProjectData(projectRoot = null, options = {}) {
  const target = buildTarget(projectRoot, { ...options, profile: "attach" });
  if (targetIsBlocked(target)) return { ok: false, target, findings: target.findings, records: [], errors: [] };
  const lanes = options.lane ? [normalizeLane(options.lane)] : PROJECT_DATA_LANES;
  const records = [];
  const errors = [];
  for (const lane of lanes) {
    const paths = projectDataPaths(target.repoRoot, lane);
    for (const [kind, path] of Object.entries(paths)) {
      const read = readJsonlRecords(path, { kind, path });
      records.push(...read.records);
      errors.push(...read.errors);
    }
  }
  let filtered = records;
  if (options.type) filtered = filtered.filter((record) => record.type === options.type);
  if (options.id) filtered = filtered.filter((record) => record.id === options.id);
  if (options.limit) filtered = filtered.slice(-Number(options.limit));
  return { ok: errors.length === 0, target, lanes, records: filtered, errors };
}

export function readProjectData(projectRoot = null, id, options = {}) {
  const listed = listProjectData(projectRoot, { ...options, id });
  return { ...listed, record: listed.records[0] || null };
}

export function materializeProjectSubstrate(projectRoot = null, options = {}) {
  const plan = buildProjectSubstratePlan(projectRoot, options);
  if (!options.apply) return { planned: true, plan };
  return { planned: true, plan, result: applyProjectSubstratePlan(plan) };
}

export default {
  buildProjectSubstratePlan,
  applyProjectSubstratePlan,
  captureProjectSubstrateObservation,
  doctorProjectSubstrate,
  listProjectData,
  materializeProjectSubstrate,
  readProjectData,
  recordProjectData,
};
