import test from "node:test";
import assert from "node:assert/strict";

import { buildExecuteCommandPrompt } from "./execute-prompt.js";

test("execute command prompt requires target-repo evidence instead of generic examples", () => {
  const prompt = buildExecuteCommandPrompt({
    seatLabel: "Test",
    input: "Plan an OTL topology integration.",
    workspaceRoot: "C:/repo/otl",
    projectId: "otl",
  });

  assert.ok(prompt.includes("return [] instead of guessing"));
  assert.ok(prompt.includes("Workspace root: C:/repo/otl"));
  assert.ok(prompt.includes("Project id: otl"));
  assert.equal(prompt.includes("npm test"), false);
  assert.equal(prompt.includes("node --check src/index.js"), false);
});
