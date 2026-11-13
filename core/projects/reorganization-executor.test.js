import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { executeProjectReorganization } from "./reorganization-executor.js";

const tempDirs = [];

function makeTempRoot(prefix) {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reorganization executor", () => {
  it("does not mutate the workspace in dry-run mode", () => {
    const projectRoot = makeTempRoot("illuci-exec-dryrun");
    mkdirSync(join(projectRoot, "cli"), { recursive: true });
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    writeFileSync(join(projectRoot, "cli", "illuci.js"), `import "../core/foo.js";\n`, "utf-8");
    writeFileSync(join(projectRoot, "core", "foo.js"), `export const foo = 1;\n`, "utf-8");

    const result = executeProjectReorganization(projectRoot, { dryRun: true, logDecision: false });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.report.moveMap.length).toBeGreaterThan(0);
    expect(existsSync(join(projectRoot, "apps"))).toBe(false);
    expect(existsSync(join(projectRoot, "cli", "illuci.js"))).toBe(true);
    expect(existsSync(join(projectRoot, "packages", "core", "foo.js"))).toBe(false);
  });

  it("applies governed moves and rewrites references on execute", () => {
    const projectRoot = makeTempRoot("illuci-exec-apply");
    mkdirSync(join(projectRoot, "cli"), { recursive: true });
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    mkdirSync(join(projectRoot, "scripts"), { recursive: true });

    writeFileSync(
      join(projectRoot, "cli", "illuci.js"),
      [
        `import { foo } from "../core/foo.js";`,
        `import "../scripts/task.js";`,
        `console.log("cli/illuci.js", "core/foo.js");`,
        `export { foo };`,
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(projectRoot, "core", "foo.js"), `export const foo = 1;\n`, "utf-8");
    writeFileSync(join(projectRoot, "scripts", "task.js"), `import "../core/foo.js";\n`, "utf-8");
    writeFileSync(join(projectRoot, "README.md"), `See cli/illuci.js and core/foo.js\n`, "utf-8");

    const result = executeProjectReorganization(projectRoot, {
      dryRun: false,
      logDecision: false,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(existsSync(join(projectRoot, "tooling", "cli", "illuci.js"))).toBe(true);
    expect(existsSync(join(projectRoot, "packages", "core", "foo.js"))).toBe(true);
    expect(existsSync(join(projectRoot, "tooling", "scripts", "task.js"))).toBe(true);
    expect(existsSync(join(projectRoot, "cli"))).toBe(false);
    expect(existsSync(join(projectRoot, "core"))).toBe(false);
    expect(existsSync(join(projectRoot, "scripts"))).toBe(false);

    const movedCli = readFileSync(join(projectRoot, "tooling", "cli", "illuci.js"), "utf-8");
    const movedTask = readFileSync(join(projectRoot, "tooling", "scripts", "task.js"), "utf-8");
    const readme = readFileSync(join(projectRoot, "README.md"), "utf-8");

    expect(movedCli).toContain(`../../packages/core/foo.js`);
    expect(movedCli).toContain(`../scripts/task.js`);
    expect(movedTask).toContain(`../../packages/core/foo.js`);
    expect(readme).toContain(`tooling/cli/illuci.js`);
    expect(readme).toContain(`packages/core/foo.js`);
    expect(existsSync(join(projectRoot, "illuci-governance.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".illuci", "project.json"))).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);
  });

  it("blocks apply when unresolved decisions remain and no batch is selected", () => {
    const projectRoot = makeTempRoot("illuci-exec-blocked");
    mkdirSync(join(projectRoot, "projects"), { recursive: true });

    const result = executeProjectReorganization(projectRoot, {
      dryRun: false,
      logDecision: false,
    });

    expect(result.ok).toBe(false);
    expect(result.planStatus).toBe("needs-operator-review");
    expect(result.reason).toContain("Operator decisions remain unresolved");
    expect(existsSync(join(projectRoot, "apps"))).toBe(false);
  });

  it("enforces batch order during apply", () => {
    const projectRoot = makeTempRoot("illuci-exec-batch-order");
    mkdirSync(join(projectRoot, "visualizer"), { recursive: true });
    writeFileSync(join(projectRoot, "visualizer", "package.json"), `{"name":"illuci-ide"}\n`, "utf-8");

    const result = executeProjectReorganization(projectRoot, {
      dryRun: false,
      batchIds: ["operator-surfaces"],
      logDecision: false,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(`governance-normalization`);
    expect(existsSync(join(projectRoot, "apps", "ide"))).toBe(false);
  });
});
