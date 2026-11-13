/**
 * illuci — Skill Library
 *
 * Open-source skill registry for multi-model AI workflows.
 * Skills are model-agnostic packages that anyone can publish, install, and remix.
 *
 * Architecture:
 *   Registry (remote)  ←→  Library client (this file)  ←→  Local skill store
 *
 * Skill package format:
 *   skill.json — manifest (name, version, description, author, models, topology, prompt)
 *   index.js   — entry module (optional, for programmatic skills)
 *   README.md  — documentation
 *
 * Registry: configurable via ILLUCI_SKILL_REGISTRY env or .illuci/config.json
 * A remote registry is used only when ILLUCI_SKILL_REGISTRY is configured.
 *
 * Local store: resolved via resolveIlluciHomeDir("skills") (~/.illuci/skills/<name>/)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "fs";
import { resolve, join } from "path";
import { logDecision } from "../decisions/logger.js";
import { resolveIlluciHomeDir } from "../agents/home-dir.js";
import { checkCreationDecision } from "../governance/compiler/runtime/dispatch-bridge.js";

const STORE_DIR = resolveIlluciHomeDir("skills");
const REGISTRY_URL = process.env.ILLUCI_SKILL_REGISTRY?.trim() || null;
const INDEX_FILE = resolve(STORE_DIR, "registry-index.json");

// ─── SKILL PACKAGE FORMAT ───

/**
 * Standard skill manifest (skill.json):
 *
 * {
 *   "name": "security-audit",
 *   "version": "1.0.0",
 *   "description": "Full adversarial security audit",
 *   "author": "gzs-inc",
 *   "license": "MIT",
 *   "models": {
 *     "required": [],              // must have at least one of these
 *     "recommended": ["claude-local", "deepseek"],
 *     "compatible": "*"            // "*" = all, or array of model IDs
 *   },
 *   "topology": "adversarial-debate",
 *   "seats": {
 *     "red": { "roleHint": "attacker-whitebox", "description": "Offensive analysis" },
 *     "blue": { "roleHint": "defender", "description": "Defensive review" },
 *     "arbiter": { "roleHint": "arbiter", "description": "Final ruling" }
 *   },
 *   "prompt": "Conduct a full security audit of: {{input}}",
 *   "tags": ["security", "audit", "cac"],
 *   "entry": "index.js"           // optional programmatic entry
 * }
 */

// ─── LOCAL STORE ───

function ensureStore() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

/**
 * List all locally installed skills.
 */
export function installed() {
  ensureStore();
  const skills = [];

  for (const dir of readdirSync(STORE_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifestPath = resolve(STORE_DIR, dir.name, "skill.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      skills.push({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        models: manifest.models,
        topology: manifest.topology,
        tags: manifest.tags || [],
        path: resolve(STORE_DIR, dir.name),
      });
    } catch {}
  }

  return skills;
}

/**
 * Get a locally installed skill by name.
 */
export function getInstalled(name) {
  const manifestPath = resolve(STORE_DIR, name, "skill.json");
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

// ─── REGISTRY CLIENT ───

/**
 * Search the remote registry for skills.
 */
export async function search(query, tags = []) {
  if (!REGISTRY_URL) return { error: "Configure ILLUCI_SKILL_REGISTRY to search a remote library", results: [] };
  try {
    const indexUrl = `${REGISTRY_URL}/index.json`;
    const resp = await fetch(indexUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { error: `Registry returned ${resp.status}`, results: [] };

    const index = await resp.json();
    let results = index.skills || [];

    // Filter by query
    if (query) {
      const q = query.toLowerCase();
      results = results.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        (s.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }

    // Filter by tags
    if (tags.length > 0) {
      results = results.filter(s =>
        tags.every(tag => (s.tags || []).includes(tag))
      );
    }

    return { results };
  } catch (err) {
    return { error: err.message, results: [] };
  }
}

/**
 * Install a skill from the registry.
 */
export async function install(name) {
  if (!REGISTRY_URL) return { success: false, error: "Configure ILLUCI_SKILL_REGISTRY before remote installation" };
  ensureStore();

  // Check if already installed
  if (getInstalled(name)) {
    return { success: false, error: `Skill '${name}' already installed. Use 'update' to upgrade.` };
  }

  try {
    // Fetch manifest
    const manifestUrl = `${REGISTRY_URL}/skills/${name}/skill.json`;
    const manifestResp = await fetch(manifestUrl, { signal: AbortSignal.timeout(10000) });
    if (!manifestResp.ok) return { success: false, error: `Skill '${name}' not found in registry (${manifestResp.status})` };

    const manifest = await manifestResp.json();

    // Create local directory
    const skillDir = resolve(STORE_DIR, name);
    mkdirSync(skillDir, { recursive: true });

    // Save manifest
    writeFileSync(resolve(skillDir, "skill.json"), JSON.stringify(manifest, null, 2));

    // Fetch entry module if specified
    if (manifest.entry) {
      try {
        const entryUrl = `${REGISTRY_URL}/skills/${name}/${manifest.entry}`;
        const entryResp = await fetch(entryUrl, { signal: AbortSignal.timeout(10000) });
        if (entryResp.ok) {
          writeFileSync(resolve(skillDir, manifest.entry), await entryResp.text());
        }
      } catch {}
    }

    // Fetch README if available
    try {
      const readmeUrl = `${REGISTRY_URL}/skills/${name}/README.md`;
      const readmeResp = await fetch(readmeUrl, { signal: AbortSignal.timeout(5000) });
      if (readmeResp.ok) {
        writeFileSync(resolve(skillDir, "README.md"), await readmeResp.text());
      }
    } catch {}

    logDecision({
      humanStatus: "operator-initiated",
      modelStatus: [{ model: "system", seat: "library" }],
      context: `Installed skill: ${name} v${manifest.version}`,
      type: "skill-install",
      decision: `Installed ${name} v${manifest.version} from ${REGISTRY_URL}`,
      inputs: { name, version: manifest.version },
      metadata: { author: manifest.author, topology: manifest.topology },
    });

    return { success: true, name, version: manifest.version, path: skillDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Uninstall a locally installed skill.
 */
export function uninstall(name) {
  const skillDir = resolve(STORE_DIR, name);
  if (!existsSync(skillDir)) return { success: false, error: `Skill '${name}' not installed` };

  rmSync(skillDir, { recursive: true, force: true });

  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: [{ model: "system", seat: "library" }],
    context: `Uninstalled skill: ${name}`,
    type: "skill-uninstall",
    decision: `Removed ${name} from local store`,
    inputs: { name },
    metadata: {},
  });

  return { success: true, name };
}

/**
 * Publish a skill to the registry.
 * Generates a package for explicit upload to the configured registry.
 */
export function pack(skillDir) {
  const manifestPath = resolve(skillDir, "skill.json");
  if (!existsSync(manifestPath)) {
    return { success: false, error: "No skill.json found in " + skillDir };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  // Validate manifest
  const required = ["name", "version", "description", "topology", "prompt"];
  const missing = required.filter(f => !manifest[f]);
  if (missing.length > 0) {
    return { success: false, error: `Manifest missing: ${missing.join(", ")}` };
  }

  // Validate models compatibility
  if (!manifest.models) {
    manifest.models = { compatible: "*" };
  }

  return {
    success: true,
    name: manifest.name,
    version: manifest.version,
    manifest,
    note: `Ready to publish. Upload the ${skillDir} directory to the registry.`,
  };
}

/**
 * Create a new skill scaffold.
 */
export function scaffold(name, dir, options = {}) {
  const verdict = checkCreationDecision(options.creationDecision, options);
  if (!verdict.ok) {
    return { success: false, blocked: true, error: verdict.reason };
  }
  const skillDir = resolve(dir || ".", name);
  mkdirSync(skillDir, { recursive: true });

  const manifest = {
    name,
    version: "0.1.0",
    description: `${name} — a illuci skill`,
    author: "",
    license: "MIT",
    models: {
      required: [],
      recommended: [],
      compatible: "*",
    },
    topology: "dev-team",
    seats: {},
    prompt: "{{input}}",
    tags: [],
  };

  writeFileSync(resolve(skillDir, "skill.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(skillDir, "README.md"), `# ${name}\n\nA illuci skill.\n\n## Usage\n\n\`/skill ${name}\`\n`);

  return { path: skillDir, manifest };
}

export default { installed, getInstalled, search, install, uninstall, pack, scaffold };
