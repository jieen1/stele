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
  const directory = await mkdtemp(join(tmpdir(), "stele-core-agent-path-"));
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

describe("agent path safety validation", () => {
  it("accepts relative glob paths", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer" (allowed-paths "src/**") (denied-paths "config/**"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.agents).toHaveLength(1);
  });

  it("rejects absolute path in allowed-paths (Unix)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer" (allowed-paths "/etc/secrets"))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0322" });
      expect((error as SteleError).message).toContain("absolute path");
    }
  });

  it("rejects absolute path in allowed-paths (Windows drive letter)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer" (allowed-paths "C:/Windows/System32"))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0322" });
      expect((error as SteleError).message).toContain("absolute path");
    }
  });

  it("rejects path traversal in allowed-paths", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer" (allowed-paths "../../../secret"))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0322" });
      expect((error as SteleError).message).toContain("path traversal");
    }
  });

  it("rejects path traversal in denied-paths", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer" (denied-paths "../contract/main.stele"))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0322" });
      expect((error as SteleError).message).toContain("path traversal");
    }
  });

  it("rejects empty path in scope", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(scope "writer" (path ""))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0322" });
      expect((error as SteleError).message).toContain("empty path");
    }
  });

  it("accepts scope with valid paths", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(scope "writer" (path "src/**") (path "tests/**"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.scopes).toHaveLength(1);
  });

  it("rejects conflict path with absolute path", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(agent "optimizer")',
        '(conflict (path "/etc/passwd") (agents "writer" "optimizer") (resolution "last-writer-wins"))',
      ].join("\n"),
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0322" });
      expect((error as SteleError).message).toContain("absolute path");
    }
  });
});
