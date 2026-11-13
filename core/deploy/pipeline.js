/**
 * illuci — Deploy Pipeline
 *
 * Structured build → test → deploy pipeline with gate phases.
 * Each stage must pass before the next runs.
 *
 * Pipeline:
 *   1. Pre-flight checks (git clean, version, dependencies)
 *   2. Build (npm run build / custom build command)
 *   3. Test (npm test / custom test command)
 *   4. Deploy (target-specific: vercel, ssh, local, custom)
 *   5. Post-deploy verification
 *
 * Targets configured in .illuci/project.json → deploy section.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { logDecision } from "../decisions/logger.js";

// ─── PIPELINE STAGES ───

async function preflight(projectDir) {
  const checks = [];

  // Git clean check
  try {
    const status = execSync("git status --porcelain", { cwd: projectDir, encoding: "utf-8", windowsHide: true }).trim();
    if (status) {
      checks.push({ name: "git-clean", pass: false, detail: `${status.split("\n").length} uncommitted changes` });
    } else {
      checks.push({ name: "git-clean", pass: true });
    }
  } catch {
    checks.push({ name: "git-clean", pass: false, detail: "not a git repo" });
  }

  // Version file
  const versionPath = resolve(projectDir, "VERSION");
  if (existsSync(versionPath)) {
    const version = readFileSync(versionPath, "utf-8").trim();
    checks.push({ name: "version", pass: true, detail: version });
  } else {
    checks.push({ name: "version", pass: false, detail: "no VERSION file" });
  }

  // Package.json
  const pkgPath = resolve(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    checks.push({ name: "package.json", pass: true });
  } else {
    checks.push({ name: "package.json", pass: false });
  }

  // Node modules
  const nmPath = resolve(projectDir, "node_modules");
  if (existsSync(nmPath)) {
    checks.push({ name: "node_modules", pass: true });
  } else {
    checks.push({ name: "node_modules", pass: false, detail: "run npm install" });
  }

  return { stage: "preflight", checks, pass: checks.every(c => c.pass) };
}

async function build(projectDir, config = {}) {
  const cmd = config.buildCommand || "npm run build";
  const start = Date.now();

  try {
    const output = execSync(cmd, {
      cwd: projectDir, encoding: "utf-8", timeout: 300000,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    return { stage: "build", pass: true, output: output.substring(0, 2000), latency: Date.now() - start };
  } catch (err) {
    return { stage: "build", pass: false, error: err.stderr?.substring(0, 1000) || err.message, latency: Date.now() - start };
  }
}

async function test(projectDir, config = {}) {
  const cmd = config.testCommand || "npm test";
  const start = Date.now();

  try {
    const output = execSync(cmd, {
      cwd: projectDir, encoding: "utf-8", timeout: 300000,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    return { stage: "test", pass: true, output: output.substring(0, 2000), latency: Date.now() - start };
  } catch (err) {
    return { stage: "test", pass: false, error: err.stderr?.substring(0, 1000) || err.message, latency: Date.now() - start };
  }
}

async function deploy(projectDir, target, config = {}) {
  const start = Date.now();

  switch (target) {
    case "vercel": return await deployVercel(projectDir, config);
    case "ssh": return await deploySSH(projectDir, config);
    case "local": return await deployLocal(projectDir, config);
    case "custom": return await deployCustom(projectDir, config);
    default: return { stage: "deploy", pass: false, error: `Unknown target: ${target}` };
  }
}

async function deployVercel(projectDir, config) {
  try {
    const cmd = config.production ? "npx vercel --prod --yes" : "npx vercel --yes";
    const output = execSync(cmd, {
      cwd: projectDir, encoding: "utf-8", timeout: 300000,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const urlMatch = output.match(/https:\/\/[\w.-]+\.vercel\.app/);
    return { stage: "deploy", target: "vercel", pass: true, url: urlMatch?.[0], output: output.substring(0, 1000), latency: Date.now() };
  } catch (err) {
    return { stage: "deploy", target: "vercel", pass: false, error: err.message.substring(0, 500) };
  }
}

async function deploySSH(projectDir, config) {
  if (!config.host || !config.remotePath) {
    return { stage: "deploy", target: "ssh", pass: false, error: "SSH deploy requires host and remotePath in config" };
  }
  try {
    const cmd = `rsync -avz --delete ${projectDir}/ ${config.user || "deploy"}@${config.host}:${config.remotePath}`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 120000, windowsHide: true });
    return { stage: "deploy", target: "ssh", pass: true, output: output.substring(0, 500) };
  } catch (err) {
    return { stage: "deploy", target: "ssh", pass: false, error: err.message.substring(0, 500) };
  }
}

async function deployLocal(projectDir, config) {
  const dest = config.localPath || resolve(projectDir, "dist");
  return { stage: "deploy", target: "local", pass: true, path: dest, note: "Build artifacts at " + dest };
}

async function deployCustom(projectDir, config) {
  if (!config.deployCommand) {
    return { stage: "deploy", target: "custom", pass: false, error: "Custom deploy requires deployCommand in config" };
  }
  try {
    const output = execSync(config.deployCommand, {
      cwd: projectDir, encoding: "utf-8", timeout: 300000, windowsHide: true,
    });
    return { stage: "deploy", target: "custom", pass: true, output: output.substring(0, 1000) };
  } catch (err) {
    return { stage: "deploy", target: "custom", pass: false, error: err.message.substring(0, 500) };
  }
}

// ─── FULL PIPELINE ───

/**
 * Run the complete deploy pipeline.
 *
 * @param {string} projectDir — project root
 * @param {object} config — deploy configuration from project.json
 * @returns {object} Pipeline result with all stage outcomes
 */
export async function runPipeline(projectDir, config = {}) {
  const target = config.target || "local";
  const results = { stages: [], pass: true, target };

  console.log(`\nneo — Deploy Pipeline (${target})\n`);

  // 1. Preflight
  console.log("  [1/4] Preflight checks...");
  const pf = await preflight(projectDir);
  results.stages.push(pf);
  for (const c of pf.checks) {
    const icon = c.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`    ${icon} ${c.name}${c.detail ? ": " + c.detail : ""}`);
  }
  if (!pf.pass && !config.force) {
    console.log("  \x1b[31mPreflight failed. Use --force to skip.\x1b[0m");
    results.pass = false;
    return results;
  }

  // 2. Build (skip if no build command configured)
  if (config.buildCommand !== false) {
    console.log("  [2/4] Building...");
    const b = await build(projectDir, config);
    results.stages.push(b);
    console.log(`    ${b.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} Build ${b.pass ? "succeeded" : "failed"} (${((b.latency || 0) / 1000).toFixed(1)}s)`);
    if (!b.pass) { results.pass = false; return results; }
  }

  // 3. Test (skip if no test command configured)
  if (config.testCommand !== false) {
    console.log("  [3/4] Testing...");
    const t = await test(projectDir, config);
    results.stages.push(t);
    console.log(`    ${t.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} Tests ${t.pass ? "passed" : "failed"} (${((t.latency || 0) / 1000).toFixed(1)}s)`);
    if (!t.pass) { results.pass = false; return results; }
  }

  // 4. Deploy
  console.log(`  [4/4] Deploying to ${target}...`);
  const d = await deploy(projectDir, target, config);
  results.stages.push(d);
  console.log(`    ${d.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} Deploy ${d.pass ? "succeeded" : "failed"}`);
  if (d.url) console.log(`    URL: ${d.url}`);
  if (!d.pass) results.pass = false;

  // Log decision
  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: [{ model: "system", seat: "deploy-pipeline" }],
    context: `Deploy pipeline: ${target} — ${results.pass ? "SUCCESS" : "FAILED"}`,
    type: "deploy",
    decision: `Pipeline ${results.pass ? "succeeded" : "failed"} (${results.stages.length} stages)`,
    inputs: { target, projectDir },
    metadata: { stages: results.stages.map(s => ({ stage: s.stage, pass: s.pass })) },
  });

  console.log(`\n  ${results.pass ? "\x1b[32mPipeline complete.\x1b[0m" : "\x1b[31mPipeline failed.\x1b[0m"}\n`);
  return results;
}

export default { runPipeline };
