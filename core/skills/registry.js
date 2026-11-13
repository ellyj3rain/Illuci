/**
 * illuci — Unified Skill Registry
 *
 * Three skill sources, one interface:
 *   1. illuci native — council presets and pipeline tasks
 *   2. Claude Code — slash commands exposed via `claude -p`
 *   3. Codex — exec, review, mcp-server, sandbox
 *
 * Skills are named, autocomplete-able, and executable from the REPL.
 *
 * Usage in REPL:
 *   /cac "review this code"          -> runs adversarial review
 *   /cdc "build feature X"           -> runs the dev-team topology
 *   /claude:commit                   → Claude Code commit skill
 *   /codex:review                    → Codex code review
 *   /deploy --vercel                 → deploy pipeline
 */

import { execSync, spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync, readFileSync, readdirSync } from "fs";
import { resolveIlluciHomeDir } from "../agents/home-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// ─── SKILL DEFINITIONS ───

const SKILLS = {

  // ═══ illuci Native ═══

  cac: {
    source: "illuci",
    name: "cac",
    description: "Run adversarial review (red, blue, arbiter)",
    usage: '/cac "<task>"',
    run: async (args) => runCouncil("adversarial-debate", args),
  },

  cdc: {
    source: "illuci",
    name: "cdc",
    description: "Run the dev-team build topology (architect, implementer, reviewer, QA)",
    usage: '/cdc "<task>"',
    run: async (args) => runCouncil("dev-team", args),
  },

  deploy: {
    source: "illuci",
    name: "deploy",
    description: "Run build -> test -> deploy pipeline",
    usage: "/deploy [--vercel|--ssh|--prod]",
    run: async (args) => {
      const { runPipeline } = await import("../deploy/pipeline.js");
      return runPipeline(process.cwd(), { target: args[0] || "local" });
    },
  },

  review: {
    source: "illuci",
    name: "review",
    description: "Dev-team review of current branch diff",
    usage: "/review",
    run: async () => {
      const { branchDiff, cdcReview } = await import("../deploy/git-workflow.js");
      const diff = branchDiff(process.cwd());
      return cdcReview(process.cwd(), diff);
    },
  },

  status: {
    source: "illuci",
    name: "status",
    description: "Health check all models",
    usage: "/status",
    run: async () => execCLI(["status"]),
  },

  matrix: {
    source: "illuci",
    name: "matrix",
    description: "Display capability matrix",
    usage: "/matrix",
    run: async () => execCLI(["matrix"]),
  },

  // ═══ Claude Code ═══

  "claude:commit": {
    source: "claude",
    name: "claude:commit",
    description: "Create a git commit via Claude Code",
    usage: "/claude:commit",
    run: async () => execExternal("claude", ["-p", "/commit"]),
  },

  "claude:review": {
    source: "claude",
    name: "claude:review",
    description: "Review code via Claude Code",
    usage: '/claude:review "<file or description>"',
    run: async (args) => execExternal("claude", ["-p", `/review ${args.join(" ")}`]),
  },

  "claude:simplify": {
    source: "claude",
    name: "claude:simplify",
    description: "Simplify/refactor code via Claude Code",
    usage: "/claude:simplify",
    run: async () => execExternal("claude", ["-p", "/simplify"]),
  },

  "claude:ask": {
    source: "claude",
    name: "claude:ask",
    description: "Ask Claude Code a question",
    usage: '/claude:ask "<question>"',
    run: async (args) => execExternal("claude", ["-p", args.join(" ")]),
  },

  // ═══ Codex ═══

  "codex:exec": {
    source: "codex",
    name: "codex:exec",
    description: "Run Codex non-interactively on a task",
    usage: '/codex:exec "<task>"',
    run: async (args) => execExternal("npx", ["codex", "exec", args.join(" ")]),
  },

  "codex:review": {
    source: "codex",
    name: "codex:review",
    description: "Run Codex code review",
    usage: "/codex:review",
    run: async () => execExternal("npx", ["codex", "review"]),
  },

  "codex:apply": {
    source: "codex",
    name: "codex:apply",
    description: "Apply the latest Codex diff to working tree",
    usage: "/codex:apply",
    run: async () => execExternal("npx", ["codex", "apply"]),
  },

  "codex:sandbox": {
    source: "codex",
    name: "codex:sandbox",
    description: "Run a command in Codex sandbox",
    usage: '/codex:sandbox "<command>"',
    run: async (args) => execExternal("npx", ["codex", "sandbox", ...args]),
  },

  "codex:resume": {
    source: "codex",
    name: "codex:resume",
    description: "Resume previous Codex session",
    usage: "/codex:resume",
    run: async () => execExternal("npx", ["codex", "resume", "--last"]),
  },
};

// ─── HELPERS ───

async function runCouncil(topology, args) {
  const message = args.join(" ");
  const { runTopology } = await import("../../core/topologies/runner.js");
  return runTopology(topology, {}, message, { // Empty lineup for now, let it autofill
    humanStatus: "operator-initiated",
    context: `Skill council: ${topology}`,
    projectId: "illuci-tui", // Assuming TUI context
  });
}

async function execCLI(args) {
  return new Promise((res) => {
    const proc = spawn("node", [resolve(ROOT, "cli/illuci.mjs"), ...args], {
      cwd: ROOT, stdio: "inherit", windowsHide: true,
    });
    proc.on("close", () => res());
  });
}

async function execExternal(cmd, args) {
  return new Promise((res) => {
    const proc = spawn(cmd, args, {
      cwd: process.cwd(), stdio: "inherit", shell: true, windowsHide: true,
    });
    proc.on("close", () => res());
    proc.on("error", (err) => { console.error(`Error: ${err.message}`); res(); });
  });
}

loadLibrarySkills();

function loadLibrarySkills() {
  try {
    const { installed } = require("./library.js");
    // Can't use require with ESM — use dynamic detection instead
  } catch {}

  // Synchronous fallback: scan the store directory directly
  const storeDir = resolveIlluciHomeDir("skills");
  if (!existsSync(storeDir)) return;

  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(storeDir, entry.name, "skill.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (!manifest.name || SKILLS[manifest.name]) continue;

      SKILLS[manifest.name] = {
        source: "library",
        name: manifest.name,
        description: manifest.description || manifest.name,
        usage: `/${manifest.name}`,
        run: async (args) => {
          const prompt = (manifest.prompt || "{{input}}").replace("{{input}}", args.join(" "));
          if (manifest.entry) {
            const entryPath = resolve(storeDir, entry.name, manifest.entry);
            const mod = await import(pathToFileURL(entryPath).href);
            if (typeof mod.run === "function") return mod.run(args, { prompt, manifest });
          }
          return runCouncil(manifest.topology || "dev-team", [prompt]);
        },
      };
    } catch {}
  }
}

// ─── PUBLIC API ───

export function getSkill(name) {
  return SKILLS[name] || null;
}

export function listSkills(source) {
  const skills = Object.values(SKILLS);
  if (source) return skills.filter(s => s.source === source);
  return skills;
}

export function getSkillNames() {
  return Object.keys(SKILLS);
}

export async function runSkill(name, args = []) {
  const skill = SKILLS[name];
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  return skill.run(args);
}

export default { getSkill, listSkills, getSkillNames, runSkill };
