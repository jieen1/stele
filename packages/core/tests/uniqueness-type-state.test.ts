import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("type-state uniqueness (E0341)", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects two type-state declarations with the same id", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(type-state DUP',
        '  (target "src/a.ts::A")',
        '  (states X) (initial X))',
        '(type-state DUP',
        '  (target "src/b.ts::B")',
        '  (states Y) (initial Y))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0341",
      messageIncludes: 'Type-state id "DUP" is already defined',
    });
  });

  it("rejects two type-state declarations with the same target", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(type-state A',
        '  (target "src/order.ts::Order")',
        '  (states X) (initial X))',
        '(type-state B',
        '  (target "src/order.ts::Order")',
        '  (states Y) (initial Y))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0341",
      messageIncludes: 'target "src/order.ts::Order" is already declared',
    });
  });

  it("accepts two distinct type-state ids with distinct targets", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(type-state A',
        '  (target "src/a.ts::A")',
        '  (states X) (initial X))',
        '(type-state B',
        '  (target "src/b.ts::B")',
        '  (states Y) (initial Y))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.typeStates).toHaveLength(2);
    expect(contract.typeStates.map((t: { id: string }) => t.id)).toEqual(["A", "B"]);
  });
});

describe("type-state-binding uniqueness (E0349)", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects two type-state-binding declarations for the same function", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(type-state-binding',
        '  (function "src/h.ts::H::process(1)")',
        '  (param 0 state Submitted))',
        '(type-state-binding',
        '  (function "src/h.ts::H::process(1)")',
        '  (param 0 state Paid))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0349",
      messageIncludes: 'function "src/h.ts::H::process(1)" is already declared',
    });
  });

  it("accepts bindings for distinct functions", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(type-state-binding',
        '  (function "src/h.ts::H::process(1)")',
        '  (param 0 state Submitted))',
        '(type-state-binding',
        '  (function "src/h.ts::H::settle(1)")',
        '  (param 0 state Paid))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.typeStateBindings).toHaveLength(2);
  });
});

// --- helpers (copied from uniqueness-trace-policy.test.ts) ------------------

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
  const directory = await mkdtemp(join(tmpdir(), "stele-core-ts-uniq-"));
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
  typeStates: { id: string }[];
  typeStateBindings: { function: string }[];
}> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<{
    typeStates: { id: string }[];
    typeStateBindings: { function: string }[];
  }>;
}
