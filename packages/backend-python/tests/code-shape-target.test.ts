import { describe, expect, it } from "vitest";
import {
  parseCodeShapeTarget,
  fileToModulePath,
  codeShapeTestPrefix,
} from "../src/code-shape-target.js";
import type { CodeShapeDeclaration } from "@stele/core";

describe("parseCodeShapeTarget", () => {
  it("parses plain path pattern without selector", () => {
    const result = parseCodeShapeTarget("src/**/*.py");
    expect(result.pathPattern).toBe("src/**/*.py");
    expect(result.selectorName).toBeUndefined();
  });

  it("parses path with class selector", () => {
    const result = parseCodeShapeTarget("app/account.py::Account");
    expect(result.pathPattern).toBe("app/account.py");
    expect(result.selectorName).toBe("Account");
  });

  it("parses path with selector and filter", () => {
    const result = parseCodeShapeTarget("app/account.py::Account[User]");
    expect(result.pathPattern).toBe("app/account.py");
    expect(result.selectorName).toBe("Account");
    expect(result.selectorFilter).toBe("User");
  });
});

describe("codeShapeTestPrefix", () => {
  it.each([
    ["boundary", "boundary"],
    ["class-shape", "class_shape"],
    ["function-shape", "function_shape"],
    ["type-policy", "type_policy"],
    ["file-policy", "file_policy"],
  ])(`returns %s for %s`, (kind, expected) => {
    expect(codeShapeTestPrefix(kind as any)).toBe(expected);
  });
});

describe("fileToModulePath", () => {
  function makeDeclaration(id: string): CodeShapeDeclaration {
    return {
      kind: "class-shape",
      id,
      filePath: "contract/main.stele",
      lang: "python",
      target: "app/account.py::Account",
      mustHaveFields: [],
      mustHaveMethods: [],
      mustExtend: [],
      node: { kind: "list", head: "class-shape", items: [], span: { file: "", line: 1, column: 1 } },
      span: { file: "", line: 1, column: 1 },
    };
  }

  it("converts path to dotted module path", () => {
    const decl = makeDeclaration("TEST");
    const result = fileToModulePath(decl, "app/account.py");
    expect(result).toBe("app.account");
  });

  it("handles nested paths", () => {
    const decl = makeDeclaration("TEST");
    const result = fileToModulePath(decl, "src/lib/models.py");
    expect(result).toBe("src.lib.models");
  });

  it("strips __init__.py", () => {
    const decl = makeDeclaration("TEST");
    const result = fileToModulePath(decl, "pkg/__init__.py");
    expect(result).toBe("pkg");
  });

  it("rejects glob patterns with selector", () => {
    const decl = makeDeclaration("TEST");
    expect(() => fileToModulePath(decl, "src/**/*.py")).toThrow("glob metacharacters");
  });

  it("rejects non-.py paths", () => {
    const decl = makeDeclaration("TEST");
    expect(() => fileToModulePath(decl, "app/account.txt")).toThrow('must end with ".py"');
  });

  it("rejects invalid Python identifiers", () => {
    const decl = makeDeclaration("TEST");
    expect(() => fileToModulePath(decl, "my-app/account.py")).toThrow("not a valid Python identifier");
  });
});
