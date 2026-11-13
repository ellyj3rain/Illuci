import test from "node:test";
import assert from "node:assert/strict";

import { buildMandate } from "./mandate.js";
import { composeSeatFrame } from "./frame.js";

test("seat frame places skill frameworks after flat skills and before task", () => {
  const frame = composeSeatFrame({
    mandate: buildMandate({ prompt: "Use the framework.", topologyId: "dev-team" }),
    seatDef: { id: "architect", label: "Architect", relationships: [] },
    seatLabels: { architect: "Architect" },
    skillsBlock: "[Skills]\n- code-review: review code",
    skillFrameworksBlock: "[Skill Frameworks]\n- gitops-review: atoms gitops.check-evidence.",
    task: "Project this framework through the seat.",
  });

  const skillsAt = frame.indexOf("[Skills]");
  const frameworksAt = frame.indexOf("[Skill Frameworks]");
  const taskAt = frame.indexOf("[Task]");

  assert.ok(skillsAt > -1);
  assert.ok(frameworksAt > skillsAt);
  assert.ok(taskAt > frameworksAt);
});

test("seat frame places workspace context before task", () => {
  const frame = composeSeatFrame({
    mandate: buildMandate({ prompt: "Audit the repo.", topologyId: "peer-review-ring" }),
    seatDef: { id: "reviewer", label: "Reviewer", relationships: [] },
    seatLabels: { reviewer: "Reviewer" },
    workspaceBlock: "[Workspace context]\nWorkspace root: C:/repo\nTool access: model-only single-shot.",
    task: "Inspect the target honestly.",
  });

  const workspaceAt = frame.indexOf("[Workspace context]");
  const taskAt = frame.indexOf("[Task]");

  assert.ok(workspaceAt > -1);
  assert.ok(taskAt > workspaceAt);
});
