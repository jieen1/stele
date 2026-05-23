import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("trace-policy uniqueness (E0331)", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects two trace-policy declarations with the same id", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(trace-policy DUP",
        '  (target "**::S::*")',
        '  (deny-direct "extern:fs::*"))',
        "(trace-policy DUP",
        '  (target "**::S2::*")',
        '  (must-transit "**::R::*"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0331",
      messageIncludes: 'Trace-policy id "DUP" is already defined',
    });
  });

  it("accepts two distinct trace-policy ids", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(trace-policy P1",
        '  (target "**::S::*")',
        '  (deny-direct "extern:fs::*"))',
        "(trace-policy P2",
        '  (target "**::S2::*")',
        '  (must-transit "**::R::*"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.tracePolicies).toHaveLength(2);
    expect(contract.tracePolicies.map((p: { id: string }) => p.id)).toEqual([
      "P1",
      "P2",
    ]);
  });
});

// --- helpers (copied from validator-structure.test.ts) -----------------------

async function expectSteleError(
  promise: Promise<unknown>,
  expectation: { code: string; messageIncludes: string },
): Promise<void> {
  await expect(promise).rejects.toThrowError(SteleError);

  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SteleError);
    expect(err).toMatchObject({ code: expectation.code });
    expect((err as SteleError).message).toContain(expectation.messageIncludes);
  }
}

async function createTempProject(
  files: Record<string, string>,
): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-tp-uniq-"));
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

function getLoadContract(): (rootPath: string) => Promise<{
  tracePolicies: { id: string }[];
}> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<{
    tracePolicies: { id: string }[];
  }>;
}
