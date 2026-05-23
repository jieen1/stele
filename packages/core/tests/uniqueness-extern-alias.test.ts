import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("extern-alias uniqueness (E0362)", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects two extern-alias declarations with the same logical name", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(extern-alias stripe (typescript "stripe"))',
        '(extern-alias stripe (python "stripe"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0362",
      messageIncludes: 'Extern-alias id "stripe" is already defined',
    });
  });

  it("accepts distinct logical names", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(extern-alias stripe (typescript "stripe"))',
        '(extern-alias paypal (typescript "paypal"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.externAliases).toHaveLength(2);
    expect(contract.externAliases.map((a) => a.id)).toEqual([
      "stripe",
      "paypal",
    ]);
  });
});

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
  const directory = await mkdtemp(join(tmpdir(), "stele-core-ea-uniq-"));
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
  externAliases: readonly { id: string }[];
}> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<{
    externAliases: readonly { id: string }[];
  }>;
}
