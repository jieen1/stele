import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-agent-ref-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return {
    directory,
    rootPath: join(directory, "main.stele"),
  };
}

function getLoadContract(): (rootPath: string) => Promise<any> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<any>;
}

describe("agent uniqueness validation", () => {
  it("accepts unique agent ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "code-reviewer")',
        '(agent "feature-writer")',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.agents).toHaveLength(2);
  });

  it("rejects duplicate agent ids in same file", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "code-reviewer")',
        '(agent "code-reviewer")',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0321" });
      expect((error as SteleError).message).toContain('Agent id "code-reviewer" is already defined');
    }
  });
});

describe("agent scope references", () => {
  it("accepts scope referencing declared agent", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(scope "writer" (path "src/**"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.scopes).toHaveLength(1);
  });

  it("rejects scope referencing undeclared agent", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(scope "unknown-agent" (path "src/**"))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0320" });
      expect((error as SteleError).message).toContain('Unknown agent "unknown-agent"');
    }
  });
});

describe("inter-agent contract references", () => {
  it("accepts contract with all declared agents", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "reviewer")',
        '(agent "writer")',
        '(inter-agent-contract "review-policy"',
        '  (agents "reviewer" "writer")',
        '  (requires "writer" (path "src/**") (approved-by "reviewer")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.interAgentContracts).toHaveLength(1);
  });

  it("rejects contract with undeclared agent", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "reviewer")',
        '(inter-agent-contract "bad"',
        '  (agents "reviewer" "ghost")',
        '  (requires "reviewer" (path "src/**") (approved-by "reviewer")))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0320" });
      expect((error as SteleError).message).toContain('Unknown agent "ghost"');
    }
  });

  it("rejects self-approval", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(inter-agent-contract "self-approve"',
        '  (agents "writer")',
        '  (requires "writer" (path "src/**") (approved-by "writer")))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0320" });
      expect((error as SteleError).message).toContain("cannot approve its own changes");
    }
  });
});

describe("conflict references", () => {
  it("accepts conflict with declared agents", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(agent "optimizer")',
        '(conflict (path "src/core/engine.ts")',
        '  (agents "writer" "optimizer")',
        '  (resolution "last-writer-wins"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.conflicts).toHaveLength(1);
  });

  it("rejects conflict with undeclared agent", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(conflict (path "src/core/engine.ts")',
        '  (agents "writer" "ghost")',
        '  (resolution "last-writer-wins"))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0320" });
      expect((error as SteleError).message).toContain('Unknown agent "ghost"');
    }
  });
});
