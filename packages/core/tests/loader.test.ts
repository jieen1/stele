import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("loadContract loader", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("loads contracts recursively, resolves imports relative to the importing file, and includes every loaded file", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(metadata",
        '  (stele-version "0.1")',
        '  (project "ledger")',
        "  (target-language python))",
        '(import "modules/account.stele")',
        "(checker account_checker",
        '  (description "Shared checker"))',
        "(invariant ROOT_BALANCE",
        "  (severity high)",
        '  (description "Root contract can depend on imported invariants.")',
        "  (uses-checker account_checker)",
        "  (depends-on ACCOUNT_TOTALS))",
      ].join("\n"),
      "modules/account.stele": [
        "(group account-group",
        '  (description "Account consistency rules")',
        "  (invariant ACCOUNT_TOTALS",
        "    (severity critical)",
        '    (description "Positions plus cash must equal total.")',
        "    (assert",
        "      (eq",
        "        (path account total)",
        "        (add (path account cash) (sum (collection positions) (path value)))))))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);

    expect(contract.rootPath).toBe(project.rootPath);
    expect(contract.files.map((file: { path: string }) => relative(project.directory, file.path)).sort()).toEqual([
      "main.stele",
      "modules\\account.stele",
    ]);
    expect(contract.checkers.map((checker: { id: string }) => checker.id)).toEqual(["account_checker"]);
    expect(contract.groups).toMatchObject([
      {
        id: "account-group",
        invariants: [{ id: "ACCOUNT_TOTALS" }],
      },
    ]);
    expect(contract.invariants.map((invariant: { id: string }) => invariant.id).sort()).toEqual([
      "ACCOUNT_TOTALS",
      "ROOT_BALANCE",
    ]);
  });

  it("rejects import cycles with E0203 and points at the offending import", async () => {
    const project = await createTempProject({
      "main.stele": '(import "modules/account.stele")',
      "modules/account.stele": '(import "../main.stele")',
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E0203",
        category: "Loader Error",
        span: {
          file: join(project.directory, "modules", "account.stele"),
          line: 1,
          column: 1,
        },
      });
      expect((error as SteleError).message).toContain("Circular import");
      expect((error as SteleError).detail).toContain("main.stele");
      expect((error as SteleError).detail).toContain("modules\\account.stele");
    }
  });
});

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-loader-"));
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
