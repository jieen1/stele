import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("reference validation", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  describe("cross-file checker references", () => {
    it("resolves checker references across imported files", async () => {
      const project = await createTempProject({
        "main.stele": [
          '(import "lib/checkers.stele")',
          "(invariant CROSS_FILE_CHECKER",
          "  (severity high)",
          '  (description "Uses a checker declared in another file.")',
          "  (uses-checker lib_checker))",
        ].join("\n"),
        "lib/checkers.stele": [
          "(checker lib_checker",
          '  (description "Checker defined in a separate module."))',
        ].join("\n"),
      });

      const contract = await getLoadContract()(project.rootPath);
      expect(contract.checkers).toHaveLength(1);
      expect(contract.checkers[0].id).toBe("lib_checker");
      expect(contract.invariants).toHaveLength(1);
      expect(contract.invariants[0].usesChecker?.checkerId).toBe("lib_checker");
    });

    it("rejects checker references to a file that was never imported", async () => {
      const project = await createTempProject({
        "main.stele": [
          "(invariant MISSING_CHECKER_REF",
          "  (severity high)",
          '  (description "References a checker that does not exist.")',
          "  (uses-checker orphan_checker))",
        ].join("\n"),
        "other.stele": [
          "(checker orphan_checker",
          '  (description "Declared but never imported."))',
        ].join("\n"),
      });

      await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

      try {
        await getLoadContract()(project.rootPath);
      } catch (error) {
        expect(error).toBeInstanceOf(SteleError);
        expect(error).toMatchObject({ code: "E0307" });
        expect((error as SteleError).message).toContain('Unknown checker "orphan_checker"');
      }
    });
  });

  describe("self-referential depends-on", () => {
    it("allows an invariant to reference itself in depends-on", async () => {
      const project = await createTempProject({
        "main.stele": [
          "(invariant SELF_REF",
          "  (severity low)",
          '  (description "Self-referential dependency is valid as the id exists.")',
          "  (assert (eq 1 1))",
          "  (depends-on SELF_REF))",
        ].join("\n"),
      });

      const contract = await getLoadContract()(project.rootPath);
      expect(contract.invariants).toHaveLength(1);
      expect(contract.invariants[0].id).toBe("SELF_REF");
      expect(contract.invariants[0].dependsOn).toHaveLength(1);
      expect(contract.invariants[0].dependsOn[0].id).toBe("SELF_REF");
    });

    it("rejects depends-on to a non-existent invariant id", async () => {
      const project = await createTempProject({
        "main.stele": [
          "(invariant BROKEN_DEP",
          "  (severity high)",
          '  (description "References a non-existent invariant.")',
          "  (assert (eq 1 1))",
          "  (depends-on GHOST_INVARIANT))",
        ].join("\n"),
      });

      await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

      try {
        await getLoadContract()(project.rootPath);
      } catch (error) {
        expect(error).toBeInstanceOf(SteleError);
        expect(error).toMatchObject({ code: "E0308" });
        expect((error as SteleError).message).toContain('Unknown invariant dependency "GHOST_INVARIANT"');
      }
    });
  });

  describe("multiple invariants referencing same checker", () => {
    it("allows multiple invariants to share a single checker reference", async () => {
      const project = await createTempProject({
        "main.stele": [
          "(checker shared_checker",
          '  (description "Shared checker used by multiple invariants."))',
          "(invariant INV_ALPHA",
          "  (severity high)",
          '  (description "First invariant using shared checker.")',
          "  (uses-checker shared_checker))",
          "(invariant INV_BETA",
          "  (severity medium)",
          '  (description "Second invariant using shared checker.")',
          "  (uses-checker shared_checker))",
          "(invariant INV_GAMMA",
          "  (severity low)",
          '  (description "Third invariant using shared checker.")',
          "  (uses-checker shared_checker))",
        ].join("\n"),
      });

      const contract = await getLoadContract()(project.rootPath);
      expect(contract.checkers).toHaveLength(1);
      expect(contract.invariants).toHaveLength(3);
      for (const invariant of contract.invariants) {
        expect(invariant.usesChecker?.checkerId).toBe("shared_checker");
      }
    });

    it("allows multiple invariants to share a single invariant dependency", async () => {
      const project = await createTempProject({
        "main.stele": [
          "(invariant BASE_RULE",
          "  (severity high)",
          '  (description "Base rule that others depend on.")',
          "  (assert (eq 1 1)))",
          "(invariant DEPENDING_A",
          "  (severity medium)",
          '  (description "First dependent rule.")',
          "  (assert (eq 2 2))",
          "  (depends-on BASE_RULE))",
          "(invariant DEPENDING_B",
          "  (severity low)",
          '  (description "Second dependent rule.")',
          "  (assert (eq 3 3))",
          "  (depends-on BASE_RULE))",
        ].join("\n"),
      });

      const contract = await getLoadContract()(project.rootPath);
      expect(contract.invariants).toHaveLength(3);
      const base = contract.invariants.find((inv: any) => inv.id === "BASE_RULE");
      const depA = contract.invariants.find((inv: any) => inv.id === "DEPENDING_A");
      const depB = contract.invariants.find((inv: any) => inv.id === "DEPENDING_B");
      expect(base!.dependsOn).toEqual([]);
      expect(depA!.dependsOn).toHaveLength(1);
      expect(depA!.dependsOn[0].id).toBe("BASE_RULE");
      expect(depB!.dependsOn).toHaveLength(1);
      expect(depB!.dependsOn[0].id).toBe("BASE_RULE");
    });
  });

  describe("cross-file invariant dependencies", () => {
    it("resolves depends-on across imported files", async () => {
      const project = await createTempProject({
        "main.stele": [
          '(import "lib/rules.stele")',
          "(invariant ROOT_INVARIANT",
          "  (severity high)",
          '  (description "Depends on an imported invariant.")',
          "  (assert (eq 1 1))",
          "  (depends-on IMPORTED_RULE))",
        ].join("\n"),
        "lib/rules.stele": [
          "(invariant IMPORTED_RULE",
          "  (severity medium)",
          '  (description "Defined in an imported file.")',
          "  (assert (eq 2 2)))",
        ].join("\n"),
      });

      const contract = await getLoadContract()(project.rootPath);
      expect(contract.invariants).toHaveLength(2);
      const root = contract.invariants.find((inv: any) => inv.id === "ROOT_INVARIANT");
      expect(root).toBeDefined();
      expect(root!.dependsOn).toHaveLength(1);
      expect(root!.dependsOn[0].id).toBe("IMPORTED_RULE");
    });
  });

  describe("agent cross-reference validation", () => {
    it("resolves scope agent references to declared agents", async () => {
      const project = await createTempProject({
        "main.stele": [
          '(agent "code-reviewer")',
          '(scope "code-reviewer" (path "src/**"))',
        ].join("\n"),
      });

      const contract = await getLoadContract()(project.rootPath);
      expect(contract.scopes).toHaveLength(1);
      expect(contract.scopes[0].agentId).toBe("code-reviewer");
    });

    it("rejects scope referencing undeclared agent", async () => {
      const project = await createTempProject({
        "main.stele": [
          '(scope "nonexistent" (path "src/**"))',
        ].join("\n"),
      });

      await expect(getLoadContract()(project.rootPath)).rejects.toThrowError(SteleError);

      try {
        await getLoadContract()(project.rootPath);
      } catch (error) {
        expect(error).toBeInstanceOf(SteleError);
        expect(error).toMatchObject({ code: "E0320" });
        expect((error as SteleError).message).toContain('Unknown agent "nonexistent"');
      }
    });

    it("resolves inter-agent contract agent references", async () => {
      const project = await createTempProject({
        "main.stele": [
          '(agent "reviewer")',
          '(agent "writer")',
          '(inter-agent-contract "review-contract"',
          '  (agents "reviewer" "writer")',
          '  (requires "writer" (path "src/**") (approved-by "reviewer")))',
        ].join("\n"),
      });

      const contract = await getLoadContract()(project.rootPath);
      expect(contract.interAgentContracts).toHaveLength(1);
      expect(contract.interAgentContracts[0].agents).toEqual(["reviewer", "writer"]);
    });

    it("rejects inter-agent contract with undeclared agent", async () => {
      const project = await createTempProject({
        "main.stele": [
          '(agent "reviewer")',
          '(inter-agent-contract "bad-contract"',
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

    it("rejects self-approval in requires clause", async () => {
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

    it("resolves conflict with declared agents", async () => {
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
      expect(contract.conflicts[0].agents).toEqual(["writer", "optimizer"]);
    });
  });
});

function getLoadContract(): (rootPath: string) => Promise<any> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<any>;
}

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-validator-ref-"));
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
