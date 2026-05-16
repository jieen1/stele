import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedContractFile } from "../src/index";
import { SteleError, parseFile } from "../src/index";
import {
  buildContract,
  collectImportDeclarations,
} from "../src/validator/structure-parse";

const ROOT_DIR = path.resolve("/tmp/stele-fake-root");
const ROOT_PATH = path.join(ROOT_DIR, "main.stele");

function loaded(filePath: string, source: string): LoadedContractFile {
  return {
    path: filePath,
    parsed: parseFile(source, filePath),
  };
}

describe("buildContract", () => {
  it("returns an empty contract when given an empty files array", () => {
    const contract = buildContract(ROOT_PATH, []);

    expect(contract.rootPath).toBe(ROOT_PATH);
    expect(contract.files).toEqual([]);
    expect(contract.metadata).toEqual([]);
    expect(contract.imports).toEqual([]);
    expect(contract.operators).toEqual([]);
    expect(contract.checkers).toEqual([]);
    expect(contract.scenarios).toEqual([]);
    expect(contract.groups).toEqual([]);
    expect(contract.invariants).toEqual([]);
    expect(contract.codeShapes).toEqual([]);
  });

  it("aggregates declarations from a single file into the contract", () => {
    const source = [
      '(metadata (project "demo"))',
      "(operator my-op)",
      "(checker my-checker)",
      "(invariant INV_1",
      '  (description "An invariant.")',
      "  (severity high)",
      "  (assert (eq 1 1)))",
    ].join("\n");

    const contract = buildContract(ROOT_PATH, [loaded(ROOT_PATH, source)]);

    expect(contract.rootPath).toBe(ROOT_PATH);
    expect(contract.files).toHaveLength(1);
    expect(contract.metadata).toHaveLength(1);
    expect(contract.metadata[0].filePath).toBe(ROOT_PATH);
    expect(contract.operators.map((o) => o.id)).toEqual(["my-op"]);
    expect(contract.checkers.map((c) => c.id)).toEqual(["my-checker"]);
    expect(contract.invariants.map((i) => i.id)).toEqual(["INV_1"]);
    expect(contract.invariants[0].filePath).toBe(ROOT_PATH);
  });

  it("flattens declarations from multiple files into one contract", () => {
    const moduleA = path.join(ROOT_DIR, "a.stele");
    const moduleB = path.join(ROOT_DIR, "b.stele");

    const fileA = loaded(
      moduleA,
      [
        "(invariant INV_A",
        '  (description "A side")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const fileB = loaded(
      moduleB,
      [
        "(invariant INV_B",
        '  (description "B side")',
        "  (severity low)",
        "  (assert (eq 2 2)))",
      ].join("\n"),
    );

    const contract = buildContract(ROOT_PATH, [fileA, fileB]);
    expect(contract.files).toHaveLength(2);
    expect(contract.invariants.map((i) => i.id).sort()).toEqual(["INV_A", "INV_B"]);
    expect(contract.invariants.find((i) => i.id === "INV_A")?.filePath).toBe(moduleA);
    expect(contract.invariants.find((i) => i.id === "INV_B")?.filePath).toBe(moduleB);
  });

  it("captures groups and lifts their nested invariants to the top-level list", () => {
    const source = [
      "(group account-rules",
      '  (description "Rules for accounts.")',
      "  (invariant ACCT_1",
      '    (description "First.")',
      "    (severity high)",
      "    (assert (eq 1 1)))",
      "  (invariant ACCT_2",
      '    (description "Second.")',
      "    (severity high)",
      "    (assert (eq 2 2))))",
    ].join("\n");

    const contract = buildContract(ROOT_PATH, [loaded(ROOT_PATH, source)]);

    expect(contract.groups).toHaveLength(1);
    expect(contract.groups[0].id).toBe("account-rules");
    expect(contract.groups[0].description).toBe("Rules for accounts.");
    expect(contract.groups[0].invariants).toHaveLength(2);
    expect(contract.invariants).toHaveLength(2);
    for (const inv of contract.invariants) {
      expect(inv.groupId).toBe("account-rules");
    }
  });

  it("captures imports as ImportDeclaration entries with resolvedPath", () => {
    const source = [
      '(import "module.stele")',
      "(invariant ROOT_1",
      '  (description "Root.")',
      "  (severity high)",
      "  (assert (eq 1 1)))",
    ].join("\n");

    const contract = buildContract(ROOT_PATH, [loaded(ROOT_PATH, source)]);
    expect(contract.imports).toHaveLength(1);
    const declaration = contract.imports[0];
    expect(declaration.kind).toBe("import");
    expect(declaration.value).toBe("module.stele");
    expect(declaration.resolvedPath).toBe(path.join(ROOT_DIR, "module.stele"));
    expect(declaration.filePath).toBe(ROOT_PATH);
  });

  it("captures code-shape declarations across all five kinds", () => {
    const source = [
      "(boundary api_b",
      "  (lang python)",
      '  (target "src/api/*.py"))',
      "(class-shape svc",
      "  (lang python)",
      '  (target "src/svc.py::S"))',
      "(function-shape fn",
      "  (lang python)",
      '  (target "src/fn.py::handle"))',
      "(type-policy types",
      "  (lang python)",
      '  (target "src/**/*.py")',
      '  (deny-type "Any"))',
      "(file-policy files",
      "  (lang python)",
      '  (target "src/x.py")',
      '  (must-contain "from __future__"))',
    ].join("\n");

    const contract = buildContract(ROOT_PATH, [loaded(ROOT_PATH, source)]);
    expect(contract.codeShapes.map((s) => s.kind)).toEqual([
      "boundary",
      "class-shape",
      "function-shape",
      "type-policy",
      "file-policy",
    ]);
  });

  it("throws E0301 when a top-level form is an atom rather than a list", () => {
    const file = loaded(ROOT_PATH, "loose-atom");

    expect(() => buildContract(ROOT_PATH, [file])).toThrowError(SteleError);

    try {
      buildContract(ROOT_PATH, [file]);
    } catch (err) {
      expect(err).toMatchObject({ code: "E0301", category: "Validation Error" });
      expect((err as SteleError).message).toContain("Unknown top-level declaration");
    }
  });

  it("throws E0301 when the top-level head is not a recognized declaration", () => {
    const file = loaded(ROOT_PATH, "(rule active)");

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0301" });
      expect((err as SteleError).message).toContain('Unknown top-level declaration "rule"');
    }
  });

  it("throws E0302 when a single file declares more than one metadata block", () => {
    const file = loaded(
      ROOT_PATH,
      [
        '(metadata (project "first"))',
        '(metadata (project "second"))',
      ].join("\n"),
    );

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0302" });
      expect((err as SteleError).message).toContain("metadata may appear at most once");
    }
  });

  it("throws E0303 when an operator declaration is missing its identifier", () => {
    const file = loaded(ROOT_PATH, "(operator)");

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0303" });
      expect((err as SteleError).message).toContain(
        "Operator declarations must start with an identifier",
      );
    }
  });

  it("throws E0303 when a checker declaration is missing its identifier", () => {
    const file = loaded(ROOT_PATH, "(checker)");

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0303" });
      expect((err as SteleError).message).toContain(
        "Checker declarations must start with an identifier",
      );
    }
  });

  it("throws E0304 when a group is missing its identifier", () => {
    const file = loaded(ROOT_PATH, "(group)");

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0304" });
      expect((err as SteleError).message).toContain(
        "Group declarations must start with an identifier",
      );
    }
  });

  it("throws E0304 when a group contains an unsupported child form", () => {
    const file = loaded(
      ROOT_PATH,
      [
        "(group g1",
        "  (operator nested-op))",
      ].join("\n"),
    );

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0304" });
      expect((err as SteleError).message).toContain('Unsupported group item "operator"');
    }
  });

  it("throws E0304 when a group contains an atom child", () => {
    const file = loaded(
      ROOT_PATH,
      [
        "(group g2",
        "  loose-atom)",
      ].join("\n"),
    );

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0304" });
      expect((err as SteleError).message).toContain("Unsupported group item");
    }
  });

  it("throws E0304 when a group declares description twice", () => {
    const file = loaded(
      ROOT_PATH,
      [
        "(group g3",
        '  (description "first")',
        '  (description "second"))',
      ].join("\n"),
    );

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0304" });
      expect((err as SteleError).message).toContain("may declare description only once");
    }
  });

  it("propagates E0305 from nested invariant parsing inside groups", () => {
    const file = loaded(
      ROOT_PATH,
      [
        "(group g4",
        "  (invariant BAD",
        "    (severity high)",
        "    (assert (eq 1 1))))",
      ].join("\n"),
    );

    try {
      buildContract(ROOT_PATH, [file]);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0305" });
      expect((err as SteleError).message).toContain("missing a description field");
    }
  });

  it("retains duplicate top-level invariant ids without erroring (uniqueness is validated separately)", () => {
    const moduleA = path.join(ROOT_DIR, "a.stele");
    const moduleB = path.join(ROOT_DIR, "b.stele");

    const fileA = loaded(
      moduleA,
      [
        "(invariant DUP",
        '  (description "A copy")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    const fileB = loaded(
      moduleB,
      [
        "(invariant DUP",
        '  (description "B copy")',
        "  (severity low)",
        "  (assert (eq 2 2)))",
      ].join("\n"),
    );

    const contract = buildContract(ROOT_PATH, [fileA, fileB]);
    expect(contract.invariants).toHaveLength(2);
    expect(contract.invariants.every((i) => i.id === "DUP")).toBe(true);
  });
});

describe("collectImportDeclarations", () => {
  it("returns an empty array when there are no imports", () => {
    const parsed = parseFile(
      [
        "(invariant SOLO",
        '  (description "no imports")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
      ROOT_PATH,
    );

    expect(collectImportDeclarations(ROOT_PATH, parsed)).toEqual([]);
  });

  it("returns one ImportDeclaration for a single (import \"...\") form", () => {
    const parsed = parseFile('(import "module.stele")', ROOT_PATH);

    const declarations = collectImportDeclarations(ROOT_PATH, parsed);
    expect(declarations).toHaveLength(1);

    const declaration = declarations[0];
    expect(declaration.kind).toBe("import");
    expect(declaration.value).toBe("module.stele");
    expect(declaration.resolvedPath).toBe(path.join(ROOT_DIR, "module.stele"));
    expect(declaration.filePath).toBe(ROOT_PATH);
  });

  it("returns multiple ImportDeclarations and ignores non-import forms", () => {
    const parsed = parseFile(
      [
        '(import "a.stele")',
        "(checker my_checker)",
        '(import "sub/b.stele")',
      ].join("\n"),
      ROOT_PATH,
    );

    const declarations = collectImportDeclarations(ROOT_PATH, parsed);
    expect(declarations.map((d) => d.value)).toEqual(["a.stele", "sub/b.stele"]);
    expect(declarations.map((d) => d.resolvedPath)).toEqual([
      path.join(ROOT_DIR, "a.stele"),
      path.join(ROOT_DIR, "sub", "b.stele"),
    ]);
  });

  it("throws E0202 for an import with no arguments", () => {
    const parsed = parseFile("(import)", ROOT_PATH);

    expect(() => collectImportDeclarations(ROOT_PATH, parsed)).toThrowError(SteleError);

    try {
      collectImportDeclarations(ROOT_PATH, parsed);
    } catch (err) {
      expect(err).toMatchObject({ code: "E0202", category: "Loader Error" });
      expect((err as SteleError).message).toContain(
        'Import declarations must be of the form (import "relative/path.stele")',
      );
    }
  });

  it("throws E0202 for an import whose argument is not a string", () => {
    const parsed = parseFile("(import bare-identifier)", ROOT_PATH);

    try {
      collectImportDeclarations(ROOT_PATH, parsed);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0202" });
      expect((err as SteleError).message).toContain("Import declarations must be of the form");
    }
  });

  it("throws E0202 for an import with multiple arguments", () => {
    const parsed = parseFile('(import "a.stele" "b.stele")', ROOT_PATH);

    try {
      collectImportDeclarations(ROOT_PATH, parsed);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0202" });
    }
  });

  it("throws E0204 when an import path escapes the contract directory and project root", () => {
    const parsed = parseFile('(import "../../../etc/passwd")', ROOT_PATH);

    try {
      collectImportDeclarations(ROOT_PATH, parsed);
      throw new Error("expected SteleError");
    } catch (err) {
      expect(err).toMatchObject({ code: "E0204" });
      expect((err as SteleError).message).toContain(
        "Import path escapes the contract directory and project root",
      );
    }
  });

  it("ignores top-level atoms (no imports collected, no error)", () => {
    const parsed = parseFile(
      [
        "(checker c1)",
        "(operator op1)",
      ].join("\n"),
      ROOT_PATH,
    );

    expect(collectImportDeclarations(ROOT_PATH, parsed)).toEqual([]);
  });
});
