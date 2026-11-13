import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bootstrap } from "../bootstrap/project-init.js";
import { assessProjectStandards } from "./standards-assessment.js";

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

describe("standards assessment", () => {
  it("classifies a fully bootstrapped default workspace as standard", () => {
    const projectRoot = join(tmpdir(), `illuci-assess-standard-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    bootstrap(projectRoot, "Standard Workspace");
    writeProjectConfig(projectRoot);

    const report = assessProjectStandards(projectRoot);

    expect(report.verdict).toBe("standard");
    expect(report.reorganization.decision).toBe("optional");
    expect(report.evidence.requiredDirectories.missing).toEqual([]);
    expect(report.driftInventory).toEqual([]);
    expect(report.score).toBeGreaterThanOrEqual(95);
  });

  it("classifies drifted default workspaces as transitional", () => {
    const projectRoot = join(tmpdir(), `illuci-assess-transitional-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(join(projectRoot, "scripts"), { recursive: true });
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeProjectConfig(projectRoot);

    const report = assessProjectStandards(projectRoot);

    expect(report.verdict).toBe("transitional");
    expect(report.reorganization.decision).toBe("mandatory");
    expect(report.evidence.requiredDirectories.missing).toContain("apps");
    expect(report.evidence.unexpectedRootDirectories).toContain("src");
    expect(report.driftInventory.some((entry) => entry.type === "root-drift")).toBe(true);
  });

  it("classifies explicitly non-default postures as exception-bearing", () => {
    const projectRoot = join(tmpdir(), `illuci-assess-exception-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(join(projectRoot, "docs"), { recursive: true });

    bootstrap(projectRoot, "Exception Workspace");
    writeProjectConfig(projectRoot, {
      workspacePosture: "single-package-service",
      workspaceExceptions: ["Approved single-package service repository."],
    });

    const report = assessProjectStandards(projectRoot);

    expect(report.verdict).toBe("exception-bearing");
    expect(report.reorganization.decision).toBe("optional");
    expect(report.explicitExceptions).toContain("Approved single-package service repository.");
  });

  it("blocks assessment when a non-GZS governance standard is declared", () => {
    const projectRoot = join(tmpdir(), `illuci-assess-blocked-${Date.now()}`);
    tempDirs.push(projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    bootstrap(projectRoot, "Blocked Workspace");
    writeProjectConfig(projectRoot, {
      governanceStandardId: "other-standard",
      governanceStandardName: "Other Standard",
    });

    const report = assessProjectStandards(projectRoot);

    expect(report.verdict).toBe("blocked");
    expect(report.reorganization.decision).toBe("blocked");
    expect(report.driftInventory.some((entry) => entry.type === "governance-standard")).toBe(true);
    expect(report.score).toBe(0);
  });
});
