import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Contract } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("normalizeContract", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("canonicalizes invariant field order and stable whitespace", async () => {
    const projectA = await createTempProject({
      "main.stele": [
        "(invariant STABLE_HASH",
        "  (tags ledger critical-path)",
        '  (description "Canonical output ignores source whitespace.")',
        '  (rationale "Deterministic normalization matters for hashing.")',
        '  (since "2026-05-04")',
        "  (assert",
        "      (and",
        "       (eq 1 1)",
        "       (gt 2 1)))",
        "  (severity high))",
      ].join("\n"),
    });
    const projectB = await createTempProject({
      "main.stele": [
        "(invariant STABLE_HASH",
        '  (since    "2026-05-04")',
        "  (severity     high)",
        "  (assert (and (eq 1 1) (gt 2 1)))",
        '  (description "Canonical output ignores source whitespace.")',
        "  (tags    ledger   critical-path)",
        '  (rationale "Deterministic normalization matters for hashing."))',
      ].join("\n"),
    });

    const normalizedA = normalizeContract(await loadContract(projectA.rootPath));
    const normalizedB = normalizeContract(await loadContract(projectB.rootPath));

    expect(normalizedA).toBe(normalizedB);
    expect(normalizedA).toBe([
      "(invariant STABLE_HASH",
      "  (severity high)",
      '  (description "Canonical output ignores source whitespace.")',
      "  (assert (and (eq 1 1) (gt 2 1)))",
      "  (tags ledger critical-path)",
      '  (rationale "Deterministic normalization matters for hashing.")',
      '  (since "2026-05-04"))',
    ].join("\n"));
  });

  it("normalizes imported files independently after sorting by file path", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "z-last.stele")',
        '(import "a-first.stele")',
        "(invariant ROOT_RULE",
        "  (severity medium)",
        '  (description "Root file stays isolated from imported formatting.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "a-first.stele": [
        "(invariant A_RULE",
        '  (description "Imported A file.")',
        "  (assert (eq 1 1))",
        "  (severity low))",
      ].join("\n"),
      "z-last.stele": [
        "(invariant Z_RULE",
        "  (severity high)",
        '  (description "Imported Z file.")',
        "  (assert",
        "    (eq 2 2)))",
      ].join("\n"),
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);
    const independentlyNormalizedFiles = contract.files
      .slice()
      .sort((left, right) => stele.stableStringCompare(left.path, right.path))
      .map((file) => normalizeContract(createSingleFileContract(contract, file)));

    expect(normalized).toBe(independentlyNormalizedFiles.join("\n"));
    expect(normalized).toBe([
      "(invariant A_RULE",
      "  (severity low)",
      '  (description "Imported A file.")',
      "  (assert (eq 1 1)))",
      '(import "z-last.stele")',
      '(import "a-first.stele")',
      "(invariant ROOT_RULE",
      "  (severity medium)",
      '  (description "Root file stays isolated from imported formatting.")',
      "  (assert (eq 1 1)))",
      "(invariant Z_RULE",
      "  (severity high)",
      '  (description "Imported Z file.")',
      "  (assert (eq 2 2)))",
    ].join("\n"));
  });

  it("preserves leading colons for keyword atoms in expressions and optional fields", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant KEYWORD_RULE",
        "  (severity high)",
        '  (description "Keyword atoms must round-trip through normalization.")',
        "  (assert (eq :status :active))",
        "  (tags :ledger :critical-path)",
        "  (applies-to (scope :account :customer)))",
      ].join("\n"),
    });

    const normalized = normalizeContract(await loadContract(project.rootPath));

    expect(normalized).toBe([
      "(invariant KEYWORD_RULE",
      "  (severity high)",
      '  (description "Keyword atoms must round-trip through normalization.")',
      "  (assert (eq :status :active))",
      "  (tags :ledger :critical-path)",
      "  (applies-to (scope :account :customer)))",
    ].join("\n"));
  });

  it("preserves string-literal severities so normalized output can be reloaded", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant STRING_SEVERITY",
        '  (severity "1")',
        '  (description "String literal severities must stay valid after normalization.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const normalizedPath = join(project.directory, "normalized.stele");
    const normalized = normalizeContract(await loadContract(project.rootPath));

    expect(normalized).toContain('(severity "1")');

    await writeFile(normalizedPath, normalized, "utf8");

    const reloaded = await loadContract(normalizedPath);
    const normalizedSource = await readFile(normalizedPath, "utf8");

    expect(reloaded.invariants[0]).toMatchObject({
      id: "STRING_SEVERITY",
      severity: "1",
    });
    expect(normalizedSource).toContain('(severity "1")');
  });
});

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-normalizer-"));
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

function loadContract(rootPath: string): Promise<Contract> {
  const loadContractValue = (stele as Record<string, unknown>).loadContract;

  expect(loadContractValue).toBeTypeOf("function");

  return (loadContractValue as (path: string) => Promise<Contract>)(rootPath);
}

function normalizeContract(contract: Contract): string {
  const normalizeContractValue = (stele as Record<string, unknown>).normalizeContract;

  expect(normalizeContractValue).toBeTypeOf("function");

  return (normalizeContractValue as (value: Contract) => string)(contract);
}

function createSingleFileContract(_contract: Contract, file: Contract["files"][number]): Contract {
  return {
    rootPath: _contract.rootPath,
    files: [file],
    metadata: file.metadata === undefined ? [] : [file.metadata],
    imports: [...file.imports],
    operators: [...file.operators],
    checkers: [...file.checkers],
    scenarios: [...(file.scenarios ?? [])],
    groups: [...file.groups],
    invariants: [...file.invariants],
    codeShapes: [...file.codeShapes],
    coreNodes: [...(file.coreNodes ?? [])],
    architectures: [...(file.architectures ?? [])],
    brandedIds: [...(file.brandedIds ?? [])],
    tracePolicies: [...(file.tracePolicies ?? [])],
    typeStates: [...(file.typeStates ?? [])],
    typeStateBindings: [...(file.typeStateBindings ?? [])],
    effectDeclarations: [...(file.effectDeclarations ?? [])],
    effectAnnotations: [...(file.effectAnnotations ?? [])],
    effectPolicies: [...(file.effectPolicies ?? [])],
    effectSuppressions: [...(file.effectSuppressions ?? [])],
    externAliases: [...(file.externAliases ?? [])],
  };
}
