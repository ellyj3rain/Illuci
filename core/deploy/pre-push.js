/**
 * illuci — Pre-Push Security & Quality Gate
 *
 * Runs automatically before every git push. Blocks push if critical
 * issues found. Scans:
 *   1. Static analysis (ESLint if available, syntax check always)
 *   2. Security scan (hard invariant check on changed files)
 *   3. CQL — Code Quality via model review (fast, single-model)
 *   4. Credential leak detection (.env, keys, tokens in diff)
 *   5. Test suite (if configured)
 *
 * Install as git hook:
 *   illuci deploy hook install
 *
 * Run manually:
 *   illuci scan [--full]
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { logDecision } from "../decisions/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// ─── CREDENTIAL PATTERNS ───

const CREDENTIAL_PATTERNS = [
  { name: "AWS Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "Private Key", pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: "API Key (generic)", pattern: /['"](sk|pk|api[_-]?key)['"]\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/ },
  { name: "JWT Token", pattern: /eyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}/ },
  { name: "GitHub Token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: "Slack Token", pattern: /xox[baprs]-[0-9]{10,}/ },
  { name: ".env value", pattern: /^\+[A-Z_]+=.{8,}/ },
  { name: "Password in code", pattern: /password\s*[:=]\s*['"][^'"]{6,}['"]/ },
  { name: "Connection string", pattern: /mongodb(\+srv)?:\/\/[^'"\s]+/ },
];

// ─── SCAN FUNCTIONS ───

function getDiff(cwd) {
  try {
    // Diff between current HEAD and the remote tracking branch
    const remote = execSync("git rev-parse --abbrev-ref @{upstream}", {
      cwd, encoding: "utf-8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return execSync(`git diff ${remote}...HEAD`, { cwd, encoding: "utf-8", windowsHide: true });
  } catch {
    // Fallback: diff of last commit
    return execSync("git diff HEAD~1", { cwd, encoding: "utf-8", windowsHide: true });
  }
}

function getChangedFiles(cwd) {
  try {
    const remote = execSync("git rev-parse --abbrev-ref @{upstream}", {
      cwd, encoding: "utf-8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return execSync(`git diff --name-only ${remote}...HEAD`, {
      cwd, encoding: "utf-8", windowsHide: true,
    }).trim().split("\n").filter(Boolean);
  } catch {
    return execSync("git diff --name-only HEAD~1", {
      cwd, encoding: "utf-8", windowsHide: true,
    }).trim().split("\n").filter(Boolean);
  }
}

/**
 * 1. Syntax check — verify all changed JS files parse
 */
function scanSyntax(cwd, files) {
  const jsFiles = files.filter(f => f.endsWith(".js") || f.endsWith(".mjs"));
  const errors = [];

  for (const file of jsFiles) {
    const fullPath = resolve(cwd, file);
    if (!existsSync(fullPath)) continue;

    try {
      execSync(`node --check "${fullPath}"`, {
        cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      errors.push({ file, error: err.stderr?.toString().substring(0, 200) || "syntax error" });
    }
  }

  return { name: "syntax", pass: errors.length === 0, errors };
}

/**
 * 2. Security scan — check for dangerous patterns in the diff
 */
function scanSecurity(diff) {
  const findings = [];
  const lines = diff.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    // Check for dangerous code patterns
    if (/eval\s*\(/.test(line)) findings.push({ line: i, pattern: "eval()", severity: "HIGH", text: line.trim() });
    if (/child_process.*exec\(/.test(line) && !/execSync/.test(line)) findings.push({ line: i, pattern: "exec() without Sync", severity: "MEDIUM", text: line.trim() });
    if (/innerHTML\s*=/.test(line)) findings.push({ line: i, pattern: "innerHTML assignment (XSS)", severity: "HIGH", text: line.trim() });
    if (/dangerouslySetInnerHTML/.test(line)) findings.push({ line: i, pattern: "dangerouslySetInnerHTML", severity: "MEDIUM", text: line.trim() });
    if (/--no-verify/.test(line)) findings.push({ line: i, pattern: "git --no-verify (hook bypass)", severity: "HIGH", text: line.trim() });
    if (/disable.*eslint/.test(line)) findings.push({ line: i, pattern: "eslint disable", severity: "LOW", text: line.trim() });
  }

  return { name: "security", pass: !findings.some(f => f.severity === "HIGH"), findings };
}

/**
 * 3. Credential leak detection
 */
function scanCredentials(diff) {
  const leaks = [];
  const lines = diff.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    for (const cred of CREDENTIAL_PATTERNS) {
      if (cred.pattern.test(line)) {
        leaks.push({ line: i, type: cred.name, text: line.substring(0, 80).trim() });
      }
    }
  }

  return { name: "credentials", pass: leaks.length === 0, leaks };
}

/**
 * 4. CQL — Code Quality via fast model review (optional)
 */
async function scanCQL(diff, options = {}) {
  if (options.skipCQL) return { name: "cql", pass: true, skipped: true };

  try {
    const { queryModel } = await import("../dispatch/dispatch.js");

    const prompt = `You are a code quality scanner. Review this diff for:
1. Logic errors or bugs
2. Missing error handling at boundaries
3. Performance issues (O(n^2) in loops, unnecessary allocations)
4. API misuse or deprecated patterns

Be terse. Only report actual issues, not style preferences. Format:
PASS — if no issues
FAIL:<severity> <file>:<description> — one per line

Diff:
\`\`\`
${diff.substring(0, 8000)}
\`\`\``;

    const result = await queryModel("deepseek", prompt, { raw: true });
    const response = result.response || "";
    const pass = response.includes("PASS") || !response.includes("FAIL:");

    return { name: "cql", pass, response: response.substring(0, 1000), model: "deepseek" };
  } catch (err) {
    return { name: "cql", pass: true, skipped: true, error: err.message };
  }
}

/**
 * 5. Test suite (if npm test exists)
 */
function scanTests(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf-8"));
    if (!pkg.scripts?.test || pkg.scripts.test === "echo \"Error: no test specified\" && exit 1") {
      return { name: "tests", pass: true, skipped: true };
    }

    execSync("npm test", { cwd, timeout: 120000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return { name: "tests", pass: true };
  } catch (err) {
    return { name: "tests", pass: false, error: err.stderr?.toString().substring(0, 500) || "tests failed" };
  }
}

// ─── MAIN SCAN ───

/**
 * Run all pre-push scans.
 * @param {object} options
 * @param {boolean} options.full — include CQL model review
 * @param {boolean} options.skipTests — skip test suite
 * @returns {{ pass, scans, blockers }}
 */
export async function runScan(options = {}) {
  const cwd = options.cwd || ROOT;
  console.log("\nneo — Pre-Push Scan\n");

  const diff = getDiff(cwd);
  const files = getChangedFiles(cwd);
  console.log(`  ${files.length} files changed\n`);

  if (files.length === 0) {
    console.log("  Nothing to scan.\n");
    return { pass: true, scans: [] };
  }

  const scans = [];

  // 1. Syntax
  console.log("  [1/5] Syntax check...");
  const syntax = scanSyntax(cwd, files);
  scans.push(syntax);
  console.log(`    ${syntax.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${syntax.errors?.length || 0} errors`);

  // 2. Security
  console.log("  [2/5] Security patterns...");
  const security = scanSecurity(diff);
  scans.push(security);
  console.log(`    ${security.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${security.findings?.length || 0} findings`);

  // 3. Credentials
  console.log("  [3/5] Credential leak detection...");
  const creds = scanCredentials(diff);
  scans.push(creds);
  console.log(`    ${creds.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${creds.leaks?.length || 0} leaks`);

  // 4. CQL
  if (options.full) {
    console.log("  [4/5] CQL model review...");
    const cql = await scanCQL(diff, options);
    scans.push(cql);
    console.log(`    ${cql.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${cql.skipped ? "skipped" : cql.model}`);
  } else {
    console.log("  [4/5] CQL model review... (use --full to enable)");
    scans.push({ name: "cql", pass: true, skipped: true });
  }

  // 5. Tests
  if (!options.skipTests) {
    console.log("  [5/5] Test suite...");
    const tests = scanTests(cwd);
    scans.push(tests);
    console.log(`    ${tests.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${tests.skipped ? "skipped" : tests.pass ? "passed" : "failed"}`);
  }

  const blockers = scans.filter(s => !s.pass);
  const pass = blockers.length === 0;

  // Log decision
  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: [{ model: "system", seat: "pre-push-scan" }],
    context: `Pre-push scan: ${pass ? "PASS" : "BLOCKED"}`,
    type: "pre-push-scan",
    decision: `${scans.length} scans, ${blockers.length} blockers`,
    inputs: { files: files.length },
    metadata: { scans: scans.map(s => ({ name: s.name, pass: s.pass })) },
  });

  console.log(`\n  ${pass ? "\x1b[32mAll scans passed.\x1b[0m" : "\x1b[31mPush blocked — " + blockers.length + " scan(s) failed.\x1b[0m"}\n`);

  // Detail blockers
  if (!pass) {
    for (const b of blockers) {
      console.log(`  \x1b[31m${b.name}:\x1b[0m`);
      if (b.errors) for (const e of b.errors) console.log(`    ${e.file}: ${e.error}`);
      if (b.findings) for (const f of b.findings) console.log(`    [${f.severity}] ${f.pattern}: ${f.text}`);
      if (b.leaks) for (const l of b.leaks) console.log(`    [LEAK] ${l.type}: ${l.text}`);
      if (b.response) console.log(`    ${b.response.substring(0, 300)}`);
    }
  }

  return { pass, scans, blockers };
}

/**
 * Install the pre-push git hook.
 */
export function installHook(cwd) {
  const hookPath = resolve(cwd || ROOT, ".git/hooks/pre-push");
  const hookContent = `#!/bin/sh
# illuci Pre-Push Security & Quality Gate
node "${resolve(ROOT, "core/deploy/pre-push.js")}" --hook
exit $?
`;

  const { writeFileSync, chmodSync } = require("fs");
  writeFileSync(hookPath, hookContent);
  try { chmodSync(hookPath, 0o755); } catch {}

  return { installed: hookPath };
}

// ─── CLI ENTRY ───

if (process.argv.includes("--hook")) {
  runScan({ full: false }).then(result => {
    process.exit(result.pass ? 0 : 1);
  });
}

export default { runScan, installHook };
