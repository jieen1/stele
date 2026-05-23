import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { runInit } from "../src/commands/init.js";
import { maybeInstallPreCommit } from "../src/commands/pre-commit.js";

const tempDirs: string[] = [];

interface PreCommitHook {
  id: string;
  name?: string;
  entry?: string;
  language?: string;
  pass_filenames?: boolean;
  stages?: string[];
  files?: string;
}

interface PreCommitRepo {
  repo: string;
  hooks?: PreCommitHook[];
  rev?: string;
}

interface PreCommitConfig {
  repos?: PreCommitRepo[];
  [key: string]: unknown;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-precommit-"));
  tempDirs.push(directory);
  return directory;
}

async function readPreCommit(dir: string): Promise<PreCommitConfig> {
  const raw = await readFile(join(dir, ".pre-commit-config.yaml"), "utf-8");
  return yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as PreCommitConfig;
}

function collectHookIds(config: PreCommitConfig): string[] {
  return (config.repos ?? []).flatMap((r) => (r.hooks ?? []).map((h) => h.id));
}

describe("stele init --pre-commit", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates .pre-commit-config.yaml when missing", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python", preCommit: true });

    const config = await readPreCommit(projectDir);
    expect(config.repos).toBeDefined();
    expect(config.repos).toHaveLength(1);
    expect(config.repos![0]!.repo).toBe("local");

    const hookIds = collectHookIds(config);
    expect(hookIds).toEqual(["stele-generate", "stele-check"]);

    const generateHook = config.repos![0]!.hooks!.find((h) => h.id === "stele-generate");
    expect(generateHook?.entry).toBe("npx stele generate");
    expect(generateHook?.pass_filenames).toBe(false);
    expect(generateHook?.stages).toEqual(["pre-commit"]);
    expect(generateHook?.files).toBe("^(contract/.*\\.stele|stele\\.config\\.json)$");

    const checkHook = config.repos![0]!.hooks!.find((h) => h.id === "stele-check");
    expect(checkHook?.entry).toBe("npx stele check");
    expect(checkHook?.pass_filenames).toBe(false);
    expect(checkHook?.stages).toEqual(["pre-commit"]);
  });

  it("is idempotent on re-run with the same flag", async () => {
    const projectDir = await createTempDir();
    const configPath = join(projectDir, ".pre-commit-config.yaml");

    await runInit(projectDir, { language: "python", preCommit: true });
    const before = await readFile(configPath, "utf-8");

    await runInit(projectDir, { language: "python", preCommit: true });
    const after = await readFile(configPath, "utf-8");

    expect(after).toBe(before);
  });

  it("appends Stele hooks to existing repo: local block missing them", async () => {
    const projectDir = await createTempDir();
    const configPath = join(projectDir, ".pre-commit-config.yaml");

    const existing: PreCommitConfig = {
      repos: [
        {
          repo: "local",
          hooks: [
            { id: "user-lint", name: "user lint", entry: "echo lint", language: "system", pass_filenames: false },
          ],
        },
      ],
    };
    await writeFile(configPath, yaml.dump(existing), "utf-8");

    await maybeInstallPreCommit(projectDir);

    const result = await readPreCommit(projectDir);
    expect(result.repos).toHaveLength(1);
    const hookIds = collectHookIds(result);
    expect(hookIds).toContain("user-lint");
    expect(hookIds).toContain("stele-generate");
    expect(hookIds).toContain("stele-check");
  });

  it("adds only missing Stele hooks when one is already present", async () => {
    const projectDir = await createTempDir();
    const configPath = join(projectDir, ".pre-commit-config.yaml");

    const existing: PreCommitConfig = {
      repos: [
        {
          repo: "local",
          hooks: [
            {
              id: "stele-check",
              name: "Stele Check",
              entry: "npx stele check",
              language: "node",
              pass_filenames: false,
              stages: ["pre-commit"],
            },
          ],
        },
      ],
    };
    await writeFile(configPath, yaml.dump(existing), "utf-8");

    await maybeInstallPreCommit(projectDir);

    const result = await readPreCommit(projectDir);
    const hookIds = collectHookIds(result);
    expect(hookIds.filter((id) => id === "stele-check")).toHaveLength(1);
    expect(hookIds.filter((id) => id === "stele-generate")).toHaveLength(1);
  });

  it("appends repo: local block when only other repos are present", async () => {
    const projectDir = await createTempDir();
    const configPath = join(projectDir, ".pre-commit-config.yaml");

    const existing: PreCommitConfig = {
      repos: [
        {
          repo: "https://github.com/pre-commit/pre-commit-hooks",
          rev: "v4.5.0",
          hooks: [{ id: "trailing-whitespace" }, { id: "end-of-file-fixer" }],
        },
      ],
    };
    await writeFile(configPath, yaml.dump(existing), "utf-8");

    await maybeInstallPreCommit(projectDir);

    const result = await readPreCommit(projectDir);
    expect(result.repos).toHaveLength(2);
    expect(result.repos!.find((r) => r.repo === "local")).toBeDefined();

    const hookIds = collectHookIds(result);
    expect(hookIds).toContain("trailing-whitespace");
    expect(hookIds).toContain("stele-generate");
    expect(hookIds).toContain("stele-check");
  });

  it("skips writing when all Stele hooks already present", async () => {
    const projectDir = await createTempDir();
    const configPath = join(projectDir, ".pre-commit-config.yaml");

    await maybeInstallPreCommit(projectDir);
    const before = await stat(configPath);
    const beforeContent = await readFile(configPath, "utf-8");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await maybeInstallPreCommit(projectDir);

    const after = await stat(configPath);
    const afterContent = await readFile(configPath, "utf-8");
    expect(afterContent).toBe(beforeContent);
    // mtime may not change because we did not write; size unchanged is the hard check
    expect(after.size).toBe(before.size);
  });

  it("does NOT install stele-lock hook", async () => {
    const projectDir = await createTempDir();
    await maybeInstallPreCommit(projectDir);

    const result = await readPreCommit(projectDir);
    const hookIds = collectHookIds(result);
    expect(hookIds).not.toContain("stele-lock");
  });

  it("preserves user-defined entries while adding Stele hooks", async () => {
    const projectDir = await createTempDir();
    const configPath = join(projectDir, ".pre-commit-config.yaml");

    const existing: PreCommitConfig = {
      repos: [
        {
          repo: "local",
          hooks: [
            {
              id: "user-format",
              name: "user format",
              entry: "echo format",
              language: "system",
              pass_filenames: false,
              stages: ["pre-commit"],
            },
          ],
        },
      ],
    };
    await writeFile(configPath, yaml.dump(existing), "utf-8");

    await maybeInstallPreCommit(projectDir);

    const result = await readPreCommit(projectDir);
    const localRepo = result.repos!.find((r) => r.repo === "local");
    expect(localRepo).toBeDefined();
    const hooks = localRepo!.hooks ?? [];
    expect(hooks.map((h) => h.id)).toEqual(["user-format", "stele-generate", "stele-check"]);
  });

  it("treats an empty .pre-commit-config.yaml as needing the local block", async () => {
    const projectDir = await createTempDir();
    const configPath = join(projectDir, ".pre-commit-config.yaml");
    await writeFile(configPath, "", "utf-8");

    await maybeInstallPreCommit(projectDir);

    const result = await readPreCommit(projectDir);
    const hookIds = collectHookIds(result);
    expect(hookIds).toContain("stele-generate");
    expect(hookIds).toContain("stele-check");
  });

  it("init without --pre-commit does not create .pre-commit-config.yaml", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python" });

    await expect(stat(join(projectDir, ".pre-commit-config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
