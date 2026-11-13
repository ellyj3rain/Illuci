/**
 * illuci — Project Manager
 *
 * Lightweight workspace context for model dispatch.
 * A project is a directory with a .illuci/project.json file.
 * Illuci defaults that directory to a root-level product monorepo with
 * governance bootstrap materialized at the repository root.
 *
 * Projects provide:
 *   - Default topology and lineup for council runs
 *   - Model preferences (which models to prefer/exclude)
 *   - Session binding (new sessions auto-bind to active project)
 *   - Workspace-scoped configuration
 *
 * Registry: projects are tracked in data/projects.json (list of paths).
 * Config: each project has .illuci/project.json in its directory.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { bootstrap as bootstrapProject } from "../bootstrap/project-init.js";
import { resolveProjectConfigDir, resolveProjectConfigFile } from "./config-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, "../../data/projects.json");
const CONFIG_FILE = "project.json";
const DEFAULT_WORKSPACE_POSTURE = "root-level-monorepo-product";
const DEFAULT_GOVERNANCE_STANDARD_ID = "gzs-governance-standard";
const DEFAULT_GOVERNANCE_STANDARD_NAME = "Ground Zero Solutions Governance Standard";
const REQUIRED_BOOTSTRAP_PROTOCOLS = ["standards-assessment", "reorganization-protocol"];

// ─── ACTIVE PROJECT ───

let activeProjectPath = null;

// ─── REGISTRY ───

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { projects: [] };
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
}

function saveRegistry(registry) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf-8");
}

// ─── PROJECT CONFIG SCHEMA ───

export function buildDefaultProjectConfig(dirPath) {
  return {
    name: basename(dirPath),
    projectKind: "product",
    workspacePosture: DEFAULT_WORKSPACE_POSTURE,
    workspaceExceptions: [],
    releaseSurface: "ide",
    internalOperatorSurfaces: ["cli", "tui"],
    governanceStandardId: DEFAULT_GOVERNANCE_STANDARD_ID,
    governanceStandardName: DEFAULT_GOVERNANCE_STANDARD_NAME,
    governanceManifest: "illuci-governance.json",
    requiredBootstrapProtocols: REQUIRED_BOOTSTRAP_PROTOCOLS,
    defaultTopology: null,
    defaultLineup: {},
    modelPreferences: {
      preferred: [],
      excluded: [],
    },
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };
}

// ─── PUBLIC API ───

/**
 * Initialize a directory as a illuci project.
 * Creates .illuci/project.json and registers it.
 *
 * @param {string} dirPath - Absolute path to the project directory
 * @param {object} overrides - Optional config overrides
 * @returns {object} The created project config
 */
export function initProject(dirPath, overrides = {}) {
  const absPath = resolve(dirPath);
  const configDir = resolveProjectConfigDir(absPath);
  const configPath = resolve(configDir, CONFIG_FILE);
  const existingPath = resolveProjectConfigFile(absPath, CONFIG_FILE);
  const bootstrapState = bootstrapProject(absPath, overrides.name || basename(absPath));

  if (existsSync(existingPath)) {
    const current = getProjectConfig(absPath);
    const normalized = {
      ...buildDefaultProjectConfig(absPath),
      ...current,
      ...overrides,
      modifiedAt: new Date().toISOString(),
    };
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(normalized, null, 2), "utf-8");
    return { ...normalized, bootstrap: bootstrapState };
  }

  mkdirSync(configDir, { recursive: true });

  const config = {
    ...buildDefaultProjectConfig(absPath),
    ...overrides,
    bootstrap: {
      posture: DEFAULT_WORKSPACE_POSTURE,
      governanceStandardId: DEFAULT_GOVERNANCE_STANDARD_ID,
      governanceStandardName: DEFAULT_GOVERNANCE_STANDARD_NAME,
      manifest: "illuci-governance.json",
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  // Register
  const registry = loadRegistry();
  if (!registry.projects.includes(absPath)) {
    registry.projects.push(absPath);
    saveRegistry(registry);
  }

  return { ...config, bootstrap: bootstrapState };
}

/**
 * Get the config for a project.
 */
export function getProjectConfig(dirPath) {
  const absPath = resolve(dirPath);
  const configPath = resolveProjectConfigFile(absPath, CONFIG_FILE);

  if (!existsSync(configPath)) return null;

  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  config._path = absPath;
  return config;
}

/**
 * Update a project's config.
 */
export function updateProjectConfig(dirPath, updates) {
  const absPath = resolve(dirPath);
  const configPath = resolveProjectConfigFile(absPath, CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new Error(`Not a illuci project: ${absPath}`);
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  Object.assign(config, updates, { modifiedAt: new Date().toISOString() });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

/**
 * List all registered projects.
 */
export function listProjects() {
  const registry = loadRegistry();
  return registry.projects
    .filter(p => existsSync(resolveProjectConfigFile(p, CONFIG_FILE)))
    .map(p => {
      const config = getProjectConfig(p);
      return {
        path: p,
        name: config?.name || basename(p),
        defaultTopology: config?.defaultTopology || null,
        active: p === activeProjectPath,
        modifiedAt: config?.modifiedAt,
      };
    });
}

/**
 * Remove a project from the registry (does not delete .illuci/).
 */
export function unregisterProject(dirPath) {
  const absPath = resolve(dirPath);
  const registry = loadRegistry();
  registry.projects = registry.projects.filter(p => p !== absPath);
  saveRegistry(registry);
  if (activeProjectPath === absPath) activeProjectPath = null;
}

/**
 * Set the active project. New sessions will auto-bind to this path.
 */
export function setActiveProject(dirPath) {
  if (dirPath === null) {
    activeProjectPath = null;
    return null;
  }
  const absPath = resolve(dirPath);
  if (!existsSync(resolveProjectConfigFile(absPath, CONFIG_FILE))) {
    throw new Error(`Not a illuci project: ${absPath}. Run 'illuci project init' first.`);
  }
  activeProjectPath = absPath;
  return getProjectConfig(absPath);
}

/**
 * Get the active project path.
 */
export function getActiveProject() {
  if (!activeProjectPath) return null;
  return getProjectConfig(activeProjectPath);
}

/**
 * Get the active project path string.
 */
export function getActiveProjectPath() {
  return activeProjectPath;
}

/**
 * Resolve dispatch options for the active project.
 * Returns topology and lineup overrides if configured.
 */
export function resolveProjectDefaults() {
  if (!activeProjectPath) return {};
  const config = getProjectConfig(activeProjectPath);
  if (!config) return {};

  const defaults = {};
  if (config.defaultTopology) defaults.topology = config.defaultTopology;
  if (config.defaultLineup && Object.keys(config.defaultLineup).length > 0) {
    defaults.lineup = config.defaultLineup;
  }
  return defaults;
}

export default {
  buildDefaultProjectConfig,
  initProject, getProjectConfig, updateProjectConfig,
  listProjects, unregisterProject, setActiveProject,
  getActiveProject, getActiveProjectPath, resolveProjectDefaults,
};
