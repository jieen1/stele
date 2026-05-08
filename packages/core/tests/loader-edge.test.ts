import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("loader edge cases", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("detects 3-file circular import cycles beyond simple 2-file cycles", async () => {
    const project = await createTempProject({
      "a.stele": '(import "b.stele")',
      "b.stele": '(import "c.stele")',
      "c.stele": '(import "a.stele")',
    });

    const rootPath = join(project.directory, "a.stele");
    await expect(getLoadContract()(rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0203" });
      const message = (error as SteleError).message;
      expect(message).toContain("Circular import");
      const detail = (error as SteleError).detail ?? "";
      expect(detail).toContain("a.stele");
      expect(detail).toContain("b.stele");
      expect(detail).toContain("c.stele");
    }
  });

  it("detects 4-file circular import chains", async () => {
    const project = await createTempProject({
      "a.stele": '(import "b.stele")',
      "b.stele": '(import "c.stele")',
      "c.stele": '(import "d.stele")',
      "d.stele": '(import "a.stele")',
    });

    const rootPath = join(project.directory, "a.stele");
    await expect(getLoadContract()(rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0203" });
      const detail = (error as SteleError).detail ?? "";
      for (const file of ["a.stele", "b.stele", "c.stele", "d.stele"]) {
        expect(detail).toContain(file);
      }
    }
  });

  it("rejects missing import targets with E0201", async () => {
    const project = await createTempProject({
      "main.stele": '(import "missing.stele")',
    });

    await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(project.rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0201" });
      expect((error as SteleError).message).toContain("Unable to read contract file");
    }
  });

  it("rejects non-existent root file with E0201", async () => {
    const project = await createTempProject({});
    const nonExistentPath = join(project.directory, "does-not-exist.stele");
    await expect(getLoadContract()(nonExistentPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(nonExistentPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0201" });
      expect((error as SteleError).message).toContain("Unable to read contract file");
    }
  });

  it("handles deeply nested import chains without crashing", async () => {
    const files: Record<string, string> = {};

    for (let i = 0; i < 20; i++) {
      const current = `chain_${String(i).padStart(2, "0")}.stele`;
      if (i < 19) {
        const next = `chain_${String(i + 1).padStart(2, "0")}.stele`;
        files[current] = `(import "${next}")`;
      } else {
        files[current] = [
          "(invariant DEEP_CHAIN",
          "  (severity low)",
          '  (description "End of deep chain.")',
          "  (assert (eq 1 1)))",
        ].join("\n");
      }
    }

    const project = await createTempProject(files);
    const rootPath = join(project.directory, "chain_00.stele");
    const contract = await getLoadContract()(rootPath);
    expect(contract.files).toHaveLength(20);
    expect(contract.invariants).toHaveLength(1);
    expect(contract.invariants[0].id).toBe("DEEP_CHAIN");
  });

  it("detects self-referential import (file importing itself)", async () => {
    const project = await createTempProject({
      "self.stele": '(import "self.stele")',
    });

    const rootPath = join(project.directory, "self.stele");
    await expect(getLoadContract()(rootPath)).rejects.toThrowError(SteleError);

    try {
      await getLoadContract()(rootPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({ code: "E0203" });
      expect((error as SteleError).message).toContain("Circular import");
    }
  });

  it("handles diamond import pattern without duplicating files", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "a.stele")',
        '(import "b.stele")',
        "(invariant MAIN_RULE",
        "  (severity low)",
        '  (description "Main rule.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "a.stele": [
        '(import "shared.stele")',
        "(invariant A_RULE",
        "  (severity low)",
        '  (description "A rule.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "b.stele": [
        '(import "shared.stele")',
        "(invariant B_RULE",
        "  (severity low)",
        '  (description "B rule.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "shared.stele": [
        "(invariant SHARED_RULE",
        "  (severity low)",
        '  (description "Shared rule.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.files).toHaveLength(4);
    expect(contract.invariants).toHaveLength(4);
  });
});

function getLoadContract(): (rootPath: string) => Promise<any> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<any>;
}

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-loader-edge-"));
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
