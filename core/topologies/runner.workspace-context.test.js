import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildWorkspaceContextBlock } from "./runner.js";

test("workspace context reports model-only seats honestly", () => {
  const block = buildWorkspaceContextBlock({
    dispatchOpts: { workspaceRoot: process.cwd(), seatLoop: null, workspaceContext: "minimal" },
    seatId: "reviewer",
    mode: "respond",
  });

  assert.match(block, /\[Workspace context\]/);
  assert.match(block, /Workspace root:/);
  assert.match(block, /model-only single-shot/);
  assert.doesNotMatch(block, /Top-level entries/);
});

test("workspace context reports run-control tool seats honestly", () => {
  const block = buildWorkspaceContextBlock({
    dispatchOpts: { workspaceRoot: process.cwd(), seatLoop: true, workspaceContext: "minimal" },
    seatId: "reviewer",
    mode: "respond",
  });

  assert.match(block, /governed tool boundary active/);
  assert.match(block, /governed tool boundary/);
});

test("workspace context reports runner-mediated phases honestly", () => {
  const block = buildWorkspaceContextBlock({
    dispatchOpts: { workspaceRoot: process.cwd(), seatLoop: null, workspaceContext: "minimal" },
    seatId: "reader",
    mode: "read",
  });

  assert.match(block, /runner-mediated read phase/);
});

test("workspace context can inventory top-level entries without leaking local state folders", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-workspace-context-"));
  try {
    writeFileSync(join(root, "README.md"), "# fixture\n");
    writeFileSync(join(root, ".env"), "TOKEN=fixture\n");
    writeFileSync(join(root, "prod.key"), "fixture\n");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src"));

    const block = buildWorkspaceContextBlock({
      dispatchOpts: { workspaceRoot: root },
      seatId: "reviewer",
      mode: "respond",
    });

    assert.match(block, /Top-level entries/);
    assert.match(block, /README\.md/);
    assert.match(block, /src\//);
    assert.doesNotMatch(block, /\.git/);
    assert.doesNotMatch(block, /\.env/);
    assert.doesNotMatch(block, /prod\.key/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace context can be disabled", () => {
  assert.equal(buildWorkspaceContextBlock({ dispatchOpts: { workspaceContext: "off" } }), null);
  assert.equal(buildWorkspaceContextBlock({ dispatchOpts: { workspaceContext: false } }), null);
});
