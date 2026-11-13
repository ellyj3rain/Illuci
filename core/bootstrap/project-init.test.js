import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bootstrap } from "./project-init.js";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("project bootstrap", () => {
  it("defaults new projects to a root-level monorepo product posture", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "illuci-bootstrap-"));
    tempDirs.push(projectRoot);

    const { manifest } = bootstrap(projectRoot, "Cold Install Product");

    for (const dir of [
      "apps",
      "packages",
      "services",
      "infra",
      "tooling",
      "docs",
      "decisions",
      "design",
      "pipelines/accountability",
    ]) {
      expect(existsSync(join(projectRoot, dir))).toBe(true);
    }

    expect(manifest.version).toBe("1.3");
    expect(manifest.governance.standard.id).toBe("gzs-governance-standard");
    expect(manifest.governance.standard.name).toBe("Ground Zero Solutions Governance Standard");
    expect(manifest.governance.standard.product).toBe("Illuci");
    expect(manifest.governance.workspace.defaultPosture).toBe("root-level-monorepo-product");
    expect(manifest.governance.workspace.productKind).toBe("product");
    expect(manifest.governance.workspace.releaseSurface).toBe("ide");
    expect(manifest.governance.workspace.internalOperatorSurfaces).toEqual(["cli", "tui"]);
    expect(manifest.governance.bootstrapProtocols.executionOrder).toEqual([
      "standards-assessment",
      "reorganization-protocol",
    ]);
    expect(manifest.governance.bootstrapProtocols.standardsAssessment.standardId).toBe("gzs-governance-standard");
    expect(manifest.governance.bootstrapProtocols.standardsAssessment.postureOwner).toBe("illuci");
    expect(manifest.governance.bootstrapProtocols.standardsAssessment.entrypoint).toBe("illuci project assess");
    expect(manifest.governance.bootstrapProtocols.standardsAssessment.status).toBe("required-before-major-work");
    expect(manifest.governance.bootstrapProtocols.reorganizationProtocol.entrypoint).toBe("illuci project plan-reorg");
    expect(manifest.governance.bootstrapProtocols.reorganizationProtocol.executionEntrypoint).toBe("illuci project execute-reorg");
    expect(manifest.governance.bootstrapProtocols.reorganizationProtocol.status).toBe("required-before-structural-change");
    expect(existsSync(join(projectRoot, "illuci-governance.json"))).toBe(true);
  });
});
