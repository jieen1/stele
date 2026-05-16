import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as stele from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-normalizer-agent-"));
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

function getNormalizeContract(): (contract: any) => string {
  const normalizeContract = (stele as Record<string, unknown>).normalizeContract;
  expect(normalizeContract).toBeTypeOf("function");
  return normalizeContract as (contract: any) => string;
}

function getLoadContract(): (rootPath: string) => Promise<any> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<any>;
}

describe("normalizer render functions for agent declarations", () => {
  it("renders agent declaration round-trip", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "code-reviewer"',
        '  (description "Reviews code changes.")',
        '  (allowed-paths "src/**" "tests/**")',
        '  (denied-paths "contract/**"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain('(agent "code-reviewer"');
    expect(normalized).toContain('(description "Reviews code changes."');
    expect(normalized).toContain('(allowed-paths "src/**" "tests/**"');
    expect(normalized).toContain('(denied-paths "contract/**"');
  });

  it("renders minimal agent declaration", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "minimal-agent")',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain('(agent "minimal-agent"');
    // Should NOT contain optional fields when absent
    expect(normalized).not.toContain("(description");
    expect(normalized).not.toContain("(allowed-paths");
    expect(normalized).not.toContain("(denied-paths");
  });

  it("renders scope declaration", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(scope "writer" (path "src/**") (path "tests/**"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain('(scope "writer"');
    expect(normalized).toContain('(path "src/**"');
    expect(normalized).toContain('(path "tests/**"');
  });

  it("renders inter-agent contract declaration", async () => {
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
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain('(inter-agent-contract "review-policy"');
    expect(normalized).toContain('(agents "reviewer" "writer"');
    expect(normalized).toContain('(requires');
    expect(normalized).toContain('(path "src/**"');
    expect(normalized).toContain('(approved-by "reviewer"');
  });

  it("renders conflict declaration", async () => {
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
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain("(conflict");
    expect(normalized).toContain('(path "src/core/engine.ts"');
    expect(normalized).toContain('(agents "writer" "optimizer"');
    // Normalizer renders resolution as identifier (no quotes for simple strings)
    expect(normalized).toContain("(resolution last-writer-wins");
  });

  it("renders all agent declaration types together", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "reviewer" (description "Code reviewer."))',
        '(agent "writer")',
        '(scope "reviewer" (path "src/reviews/**"))',
        '(inter-agent-contract "review-before-merge"',
        '  (agents "reviewer" "writer")',
        '  (requires "writer" (path "src/**") (approved-by "reviewer")))',
        '(conflict (path "src/core/engine.ts")',
        '  (agents "writer" "reviewer")',
        '  (resolution "manual-review"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain('(agent "reviewer"');
    expect(normalized).toContain('(agent "writer"');
    expect(normalized).toContain('(scope "reviewer"');
    expect(normalized).toContain('(inter-agent-contract "review-before-merge"');
    expect(normalized).toContain('(conflict');
  });

  it("renders conflict with fallback", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "writer")',
        '(agent "optimizer")',
        '(conflict (path "src/core/engine.ts")',
        '  (resolution "manual-review")',
        '  (fallback "contract-gated"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain("(resolution manual-review");
    expect(normalized).toContain("(fallback contract-gated");
  });

  it("renders inter-agent contract with description", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(agent "reviewer")',
        '(agent "writer")',
        '(inter-agent-contract "contract-with-desc"',
        '  (description "All changes need review.")',
        '  (agents "reviewer" "writer")',
        '  (requires "writer" (path "src/**") (approved-by "reviewer")))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    const normalized = getNormalizeContract()(contract);

    expect(normalized).toContain('(description "All changes need review."');
    expect(normalized).toContain('(inter-agent-contract "contract-with-desc"');
  });
});
