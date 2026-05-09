import { describe, expect, it } from "vitest";
import type { ListNode } from "../src/index";
import { SteleError, parseFile } from "../src/index";
import {
  parseBoundaryDeclaration,
  parseClassShapeDeclaration,
  parseClassShapeFieldRequirement,
  parseCodeShapeDeclaration,
  parseFilePolicyDeclaration,
  parseFunctionShapeDeclaration,
  parseTypePolicyDeclaration,
  readCodeShapeNameList,
  readCodeShapeStringList,
} from "../src/validator/structure-code-shape.js";

const FILE_PATH = "test.stele";

function parseTopList(source: string): ListNode {
  const parsed = parseFile(source, FILE_PATH);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error(`Expected top-level list node, got ${node?.kind ?? "undefined"}`);
  }

  return node;
}

function expectSteleError(
  fn: () => unknown,
  expectation: { code: string; messageIncludes: string },
): void {
  expect(fn).toThrowError(SteleError);

  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SteleError);
    expect((err as SteleError).code).toBe(expectation.code);
    expect((err as SteleError).message).toContain(expectation.messageIncludes);
  }
}

describe("parseCodeShapeDeclaration", () => {
  it("dispatches to boundary parser", () => {
    const node = parseTopList('(boundary api_b (lang python) (target "src/api/*.py"))');
    const result = parseCodeShapeDeclaration(FILE_PATH, node);
    expect(result.kind).toBe("boundary");
    expect(result.id).toBe("api_b");
  });

  it("dispatches to class-shape parser", () => {
    const node = parseTopList('(class-shape svc (lang python) (target "src/s.py::S"))');
    const result = parseCodeShapeDeclaration(FILE_PATH, node);
    expect(result.kind).toBe("class-shape");
    expect(result.id).toBe("svc");
  });

  it("dispatches to function-shape parser", () => {
    const node = parseTopList('(function-shape fn (lang python) (target "src/h.py::handle"))');
    const result = parseCodeShapeDeclaration(FILE_PATH, node);
    expect(result.kind).toBe("function-shape");
    expect(result.id).toBe("fn");
  });

  it("dispatches to type-policy parser", () => {
    const node = parseTopList('(type-policy tp (lang python) (target "src/**/*.py") (deny-type "Any"))');
    const result = parseCodeShapeDeclaration(FILE_PATH, node);
    expect(result.kind).toBe("type-policy");
    expect(result.id).toBe("tp");
  });

  it("dispatches to file-policy parser", () => {
    const node = parseTopList('(file-policy fp (lang python) (target "x.py") (must-contain "foo"))');
    const result = parseCodeShapeDeclaration(FILE_PATH, node);
    expect(result.kind).toBe("file-policy");
    expect(result.id).toBe("fp");
  });

  it("rejects unknown declaration heads", () => {
    // Build a list manually - use a known kind via parseFile but rename head
    // The fastest way: parse a regular list and mutate head before passing.
    const parsed = parseFile("(boundary x)", FILE_PATH);
    const baseNode = parsed.body[0];
    if (baseNode === undefined || baseNode.kind !== "list") {
      throw new Error("expected list");
    }
    const node: ListNode = { ...baseNode, head: "rule" };
    expectSteleError(() => parseCodeShapeDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: 'Unknown code-shape declaration "rule"',
    });
  });
});

describe("parseBoundaryDeclaration", () => {
  it("returns minimal boundary with no optional fields", () => {
    const node = parseTopList('(boundary api_b (lang python) (target "src/api/*.py"))');
    const result = parseBoundaryDeclaration(FILE_PATH, node);

    expect(result).toMatchObject({
      kind: "boundary",
      filePath: FILE_PATH,
      id: "api_b",
      lang: "python",
      target: "src/api/*.py",
      denyImports: [],
      denyCalls: [],
      allowTargets: [],
    });
    expect(result.node).toBe(node);
    expect(result.span).toBe(node.span);
  });

  it("collects deny-import, deny-call, and allow-target lists", () => {
    const node = parseTopList(
      [
        "(boundary api_b",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (deny-import "requests" "urllib3")',
        '  (deny-call "eval" "exec")',
        '  (allow-target "src/api/safe.py"))',
      ].join("\n"),
    );
    const result = parseBoundaryDeclaration(FILE_PATH, node);

    expect(result.denyImports).toEqual(["requests", "urllib3"]);
    expect(result.denyCalls).toEqual(["eval", "exec"]);
    expect(result.allowTargets).toEqual(["src/api/safe.py"]);
  });

  it("concatenates multiple deny-import field occurrences", () => {
    const node = parseTopList(
      [
        "(boundary api_b",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (deny-import "a")',
        '  (deny-import "b" "c"))',
      ].join("\n"),
    );
    const result = parseBoundaryDeclaration(FILE_PATH, node);

    expect(result.denyImports).toEqual(["a", "b", "c"]);
  });

  it("rejects boundary missing identifier id", () => {
    const node = parseTopList('(boundary "stringId" (lang python) (target "src/x.py"))');
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "Boundary declarations must start with an identifier",
    });
  });

  it("rejects boundary missing lang field", () => {
    const node = parseTopList('(boundary no_lang (target "src/x.py"))');
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "is missing a lang field",
    });
  });

  it("rejects boundary missing target field", () => {
    const node = parseTopList("(boundary no_target (lang python))");
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "is missing a target field",
    });
  });

  it("rejects unknown field in boundary", () => {
    const node = parseTopList(
      '(boundary api_b (lang python) (target "src/api/*.py") (must-have-call "eval"))',
    );
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: 'has an unknown field "must-have-call"',
    });
  });

  it("rejects duplicate lang declaration", () => {
    const node = parseTopList(
      '(boundary api_b (lang python) (lang python) (target "src/api/*.py"))',
    );
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "may only be declared once",
    });
  });

  it("rejects non-list field entries", () => {
    const node = parseTopList('(boundary api_b (lang python) (target "src/api/*.py") bare_atom)');
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "contains an unsupported field entry",
    });
  });

  it("rejects unsupported language", () => {
    const node = parseTopList('(boundary api_b (lang typescript) (target "src/x.ts"))');
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: 'lang "typescript" is not supported',
    });
  });

  it("rejects non-identifier lang value", () => {
    const node = parseTopList('(boundary api_b (lang "python") (target "src/x.py"))');
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "lang must be an identifier",
    });
  });

  it("rejects non-string target", () => {
    const node = parseTopList("(boundary api_b (lang python) (target src_dir))");
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "target must be a string literal",
    });
  });

  it("rejects multi-value lang", () => {
    const node = parseTopList(
      '(boundary api_b (lang python python) (target "src/api/*.py"))',
    );
    expectSteleError(() => parseBoundaryDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "expects exactly one value",
    });
  });
});

describe("parseClassShapeDeclaration", () => {
  it("returns minimal class shape with no requirements", () => {
    const node = parseTopList('(class-shape svc (lang python) (target "src/s.py::S"))');
    const result = parseClassShapeDeclaration(FILE_PATH, node);

    expect(result).toMatchObject({
      kind: "class-shape",
      filePath: FILE_PATH,
      id: "svc",
      lang: "python",
      target: "src/s.py::S",
      mustHaveFields: [],
      mustHaveMethods: [],
      mustExtend: [],
    });
  });

  it("collects must-have-field, must-have-method, and must-extend", () => {
    const node = parseTopList(
      [
        "(class-shape svc",
        "  (lang python)",
        '  (target "src/s.py::S")',
        '  (must-have-field id "UUID")',
        "  (must-have-field created_at)",
        "  (must-have-method save)",
        "  (must-have-method delete)",
        "  (must-extend BaseService))",
      ].join("\n"),
    );
    const result = parseClassShapeDeclaration(FILE_PATH, node);

    expect(result.mustHaveFields).toMatchObject([
      { name: "id", type: "UUID" },
      { name: "created_at", type: undefined },
    ]);
    expect(result.mustHaveMethods).toEqual(["save", "delete"]);
    expect(result.mustExtend).toEqual(["BaseService"]);
  });

  it("rejects unknown field in class-shape", () => {
    const node = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (deny-import "x"))',
    );
    expectSteleError(() => parseClassShapeDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: 'has an unknown field "deny-import"',
    });
  });

  it("rejects class-shape with empty must-have-field", () => {
    const node = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field))',
    );
    expectSteleError(() => parseClassShapeDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "must-have-field expects a field name",
    });
  });
});

describe("parseFunctionShapeDeclaration", () => {
  it("returns minimal function shape with no requirements", () => {
    const node = parseTopList('(function-shape fn (lang python) (target "src/h.py::handle"))');
    const result = parseFunctionShapeDeclaration(FILE_PATH, node);

    expect(result).toMatchObject({
      kind: "function-shape",
      filePath: FILE_PATH,
      id: "fn",
      lang: "python",
      target: "src/h.py::handle",
      mustHaveCalls: [],
      mustHaveDecorators: [],
      mustHaveParameters: [],
    });
  });

  it("collects must-have-call, must-have-decorator, and must-have-parameter", () => {
    const node = parseTopList(
      [
        "(function-shape fn",
        "  (lang python)",
        '  (target "src/h.py::handle")',
        '  (must-have-call "transaction.atomic")',
        "  (must-have-decorator login_required)",
        "  (must-have-parameter request))",
      ].join("\n"),
    );
    const result = parseFunctionShapeDeclaration(FILE_PATH, node);

    expect(result.mustHaveCalls).toEqual(["transaction.atomic"]);
    expect(result.mustHaveDecorators).toEqual(["login_required"]);
    expect(result.mustHaveParameters).toEqual(["request"]);
  });

  it("rejects unknown field in function-shape", () => {
    const node = parseTopList(
      '(function-shape fn (lang python) (target "src/h.py::handle") (must-extend Base))',
    );
    expectSteleError(() => parseFunctionShapeDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: 'has an unknown field "must-extend"',
    });
  });

  it("rejects empty must-have-call list", () => {
    const node = parseTopList(
      '(function-shape fn (lang python) (target "src/h.py::handle") (must-have-call))',
    );
    expectSteleError(() => parseFunctionShapeDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "expects at least one name",
    });
  });
});

describe("parseTypePolicyDeclaration", () => {
  it("returns minimal type policy with no rules", () => {
    const node = parseTopList('(type-policy tp (lang python) (target "src/**/*.py"))');
    const result = parseTypePolicyDeclaration(FILE_PATH, node);

    expect(result).toMatchObject({
      kind: "type-policy",
      filePath: FILE_PATH,
      id: "tp",
      lang: "python",
      target: "src/**/*.py",
      denyTypes: [],
      requireTypes: [],
    });
  });

  it("collects deny-type and require-type values", () => {
    const node = parseTopList(
      [
        "(type-policy tp",
        "  (lang python)",
        '  (target "src/**/*.py")',
        '  (deny-type "Any" "object")',
        '  (require-type "Decimal"))',
      ].join("\n"),
    );
    const result = parseTypePolicyDeclaration(FILE_PATH, node);

    expect(result.denyTypes).toEqual(["Any", "object"]);
    expect(result.requireTypes).toEqual(["Decimal"]);
  });

  it("rejects unknown field in type-policy", () => {
    const node = parseTopList(
      '(type-policy tp (lang python) (target "src/**/*.py") (must-contain "x"))',
    );
    expectSteleError(() => parseTypePolicyDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: 'has an unknown field "must-contain"',
    });
  });

  it("rejects deny-type with non-string value", () => {
    const node = parseTopList(
      "(type-policy tp (lang python) (target \"src/**/*.py\") (deny-type Any))",
    );
    expectSteleError(() => parseTypePolicyDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "values must be string literals",
    });
  });
});

describe("parseFilePolicyDeclaration", () => {
  it("returns minimal file policy with no rules", () => {
    const node = parseTopList('(file-policy fp (lang python) (target "x.py"))');
    const result = parseFilePolicyDeclaration(FILE_PATH, node);

    expect(result).toMatchObject({
      kind: "file-policy",
      filePath: FILE_PATH,
      id: "fp",
      lang: "python",
      target: "x.py",
      mustContain: [],
      mustEndWith: [],
    });
  });

  it("collects must-contain and must-end-with values", () => {
    const node = parseTopList(
      [
        "(file-policy fp",
        "  (lang python)",
        '  (target "x.py")',
        '  (must-contain "from __future__ import annotations")',
        '  (must-end-with "\\n"))',
      ].join("\n"),
    );
    const result = parseFilePolicyDeclaration(FILE_PATH, node);

    expect(result.mustContain).toEqual(["from __future__ import annotations"]);
    expect(result.mustEndWith).toEqual(["\n"]);
  });

  it("rejects unknown field in file-policy", () => {
    const node = parseTopList(
      '(file-policy fp (lang python) (target "x.py") (require-type "Decimal"))',
    );
    expectSteleError(() => parseFilePolicyDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: 'has an unknown field "require-type"',
    });
  });

  it("rejects file-policy missing identifier id", () => {
    // Force a non-identifier id to exercise the header guard branch
    const node = parseTopList(
      '(file-policy "stringId" (lang python) (target "x.py"))',
    );
    expectSteleError(() => parseFilePolicyDeclaration(FILE_PATH, node), {
      code: "E0318",
      messageIncludes: "File policy declarations must start with an identifier",
    });
  });
});

describe("parseClassShapeFieldRequirement", () => {
  it("returns name only when type omitted", () => {
    const outer = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field created_at))',
    );
    // Drill into the must-have-field list — fourth item.
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected must-have-field list");
    }
    const result = parseClassShapeFieldRequirement(fieldNode, "svc");
    expect(result.name).toBe("created_at");
    expect(result.type).toBeUndefined();
    expect(result.span).toBe(fieldNode.span);
  });

  it("returns name and type when both supplied", () => {
    const outer = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field id "UUID"))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected must-have-field list");
    }
    const result = parseClassShapeFieldRequirement(fieldNode, "svc");
    expect(result.name).toBe("id");
    expect(result.type).toBe("UUID");
  });

  it("accepts string-literal name", () => {
    const outer = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field "weird name"))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected must-have-field list");
    }
    const result = parseClassShapeFieldRequirement(fieldNode, "svc");
    expect(result.name).toBe("weird name");
  });

  it("rejects empty must-have-field", () => {
    const outer = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected must-have-field list");
    }
    expectSteleError(() => parseClassShapeFieldRequirement(fieldNode, "svc"), {
      code: "E0318",
      messageIncludes: "must-have-field expects a field name",
    });
  });

  it("rejects must-have-field with too many values", () => {
    const outer = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field id "UUID" extra))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected must-have-field list");
    }
    expectSteleError(() => parseClassShapeFieldRequirement(fieldNode, "svc"), {
      code: "E0318",
      messageIncludes: "accepts only a name and an optional type",
    });
  });

  it("rejects must-have-field with non-identifier non-string name", () => {
    const outer = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field 42))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected must-have-field list");
    }
    expectSteleError(() => parseClassShapeFieldRequirement(fieldNode, "svc"), {
      code: "E0318",
      messageIncludes: "name must be an identifier or string literal",
    });
  });

  it("rejects must-have-field with non-string type", () => {
    const outer = parseTopList(
      '(class-shape svc (lang python) (target "src/s.py::S") (must-have-field id 42))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected must-have-field list");
    }
    expectSteleError(() => parseClassShapeFieldRequirement(fieldNode, "svc"), {
      code: "E0318",
      messageIncludes: "type must be a string literal",
    });
  });
});

describe("readCodeShapeStringList", () => {
  it("returns string values from a list of string literals", () => {
    const outer = parseTopList('(boundary b (lang python) (target "x.py") (deny-import "a" "b" "c"))');
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expect(readCodeShapeStringList(fieldNode, "test label")).toEqual(["a", "b", "c"]);
  });

  it("rejects empty list", () => {
    const outer = parseTopList('(boundary b (lang python) (target "x.py") (deny-import))');
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expectSteleError(() => readCodeShapeStringList(fieldNode, "Boundary deny-import"), {
      code: "E0318",
      messageIncludes: "Boundary deny-import expects at least one string literal",
    });
  });

  it("rejects identifier value (not a string)", () => {
    const outer = parseTopList('(boundary b (lang python) (target "x.py") (deny-import bare_id))');
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expectSteleError(() => readCodeShapeStringList(fieldNode, "Boundary deny-import"), {
      code: "E0318",
      messageIncludes: "Boundary deny-import values must be string literals",
    });
  });

  it("rejects numeric value", () => {
    const outer = parseTopList('(boundary b (lang python) (target "x.py") (deny-import 42))');
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expectSteleError(() => readCodeShapeStringList(fieldNode, "Boundary deny-import"), {
      code: "E0318",
      messageIncludes: "values must be string literals",
    });
  });
});

describe("readCodeShapeNameList", () => {
  it("returns names from a list of identifiers", () => {
    const outer = parseTopList(
      '(class-shape c (lang python) (target "x.py::C") (must-extend Base Helper))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expect(readCodeShapeNameList(fieldNode, "test label")).toEqual(["Base", "Helper"]);
  });

  it("returns names from mixed identifiers and string literals", () => {
    const outer = parseTopList(
      '(class-shape c (lang python) (target "x.py::C") (must-extend Base "Helper.Mixin"))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expect(readCodeShapeNameList(fieldNode, "test label")).toEqual(["Base", "Helper.Mixin"]);
  });

  it("rejects empty list", () => {
    const outer = parseTopList(
      '(class-shape c (lang python) (target "x.py::C") (must-extend))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expectSteleError(() => readCodeShapeNameList(fieldNode, "Class shape must-extend"), {
      code: "E0318",
      messageIncludes: "Class shape must-extend expects at least one name",
    });
  });

  it("rejects numeric value", () => {
    const outer = parseTopList(
      '(class-shape c (lang python) (target "x.py::C") (must-extend 42))',
    );
    const fieldNode = outer.items[3];
    if (fieldNode === undefined || fieldNode.kind !== "list") {
      throw new Error("expected list");
    }
    expectSteleError(() => readCodeShapeNameList(fieldNode, "Class shape must-extend"), {
      code: "E0318",
      messageIncludes: "values must be identifiers or string literals",
    });
  });
});
