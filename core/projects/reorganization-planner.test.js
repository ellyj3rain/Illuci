import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bootstrap } from "../bootstrap/project-init.js";
import { planProjectReorganization } from "./reorganization-planner.js";

const tempDirs = [];

function writeProjectConfig(projectRoot, overrides = {}) {
  const configDir = join(projectRoot, ".illuci");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "project.json"), JSON.stringify({
    name: "test-project",
    projectKind: "product",
    workspacePosture: "root-level-monorepo-product",
    workspaceExceptions: [],
    governanceStandardId: "gzs-governance-standard",
    governanceStandardName: "Ground Zero Solutions Governance Standard",
    governanceManifest: "illuci-governance.json",
    requiredBootstrapProtocols: ["standards-assessment", "reorganization-protocol"],
    ...overrides,
  }, null, 2), "utf-8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reorganization planner", () => {
  it("produces a no-op plan for standard workspaces", () => {
    const projectRoot = join(tmpdir(), `illuci-plan-standard-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    bootstrap(projectRoot, "Standard Workspace");
    writeProjectConfig(projectRoot);

    const plan = planProjectReorganization(projectRoot);

    expect(plan.planStatus).toBe("no-op");
    expect(plan.governanceActions).toEqual([]);
    expect(plan.laneActions).toEqual([]);
    expect(plan.moveMap).toEqual([]);
    expect(plan.unresolvedDecisions).toEqual([]);
  });

  it("creates lane actions, move actions, and unresolved decisions for transitional workspaces", () => {
    const projectRoot = join(tmpdir(), `illuci-plan-transitional-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, "cli", "commands"), { recursive: true });
    mkdirSync(join(projectRoot, "scripts"), { recursive: true });
    mkdirSync(join(projectRoot, "visualizer"), { recursive: true });
    mkdirSync(join(projectRoot, "projects"), { recursive: true });
    writeFileSync(join(projectRoot, "cli", "illuci.js"), "console.log('illuci');", "utf-8");
    writeFileSync(join(projectRoot, "scripts", "task.py"), "print('task')", "utf-8");
    writeFileSync(join(projectRoot, "visualizer", "package.json"), "{\n  \"name\": \"illuci-ide\"\n}\n", "utf-8");

    const plan = planProjectReorganization(projectRoot);

    expect(plan.planStatus).toBe("needs-operator-review");
    expect(plan.governanceActions.map((action) => action.kind)).toContain("materialize-project-config");
    expect(plan.governanceActions.map((action) => action.kind)).toContain("materialize-governance-manifest");
    expect(plan.laneActions.some((action) => action.path === "apps")).toBe(true);
    expect(plan.moveMap.some((move) => move.from === "cli" && move.to === "tooling/cli")).toBe(true);
    expect(plan.moveMap.some((move) => move.from === "scripts" && move.to === "tooling/scripts")).toBe(true);
    expect(plan.moveMap.some((move) => move.from === "visualizer" && move.to === "apps/ide")).toBe(true);
    expect(plan.unresolvedDecisions.some((decision) => decision.path === "projects")).toBe(true);
  });

  it("keeps exception-bearing workspaces in operator review status", () => {
    const projectRoot = join(tmpdir(), `illuci-plan-exception-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    bootstrap(projectRoot, "Exception Workspace");
    writeProjectConfig(projectRoot, {
      workspacePosture: "single-package-service",
      workspaceExceptions: ["Approved single-package service repository."],
    });

    const plan = planProjectReorganization(projectRoot);

    expect(plan.planStatus).toBe("needs-operator-review");
    expect(plan.sourceAssessment.verdict).toBe("exception-bearing");
    expect(plan.blockingIssues).toEqual([]);
  });

  it("blocks planning when governance standard is not GZS", () => {
    const projectRoot = join(tmpdir(), `illuci-plan-blocked-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    bootstrap(projectRoot, "Blocked Workspace");
    writeProjectConfig(projectRoot, {
      governanceStandardId: "other-standard",
      governanceStandardName: "Other Standard",
    });

    const plan = planProjectReorganization(projectRoot);

    expect(plan.planStatus).toBe("blocked");
    expect(plan.blockingIssues.length).toBeGreaterThan(0);
    expect(plan.sourceAssessment.verdict).toBe("blocked");
  });
});
