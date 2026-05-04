import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AstNode,
  createCoreOperatorRegistry,
  type OperatorSpec,
  type SourceSpan,
  SteleError,
  type SteleType,
} from "../src/index";

const REQUIRED_OPERATOR_NAMES = [
  "path",
  "field",
  "collection",
  "value",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "matches",
  "add",
  "sub",
  "mul",
  "div",
  "neg",
  "abs",
  "sum",
  "count",
  "avg",
  "min",
  "max",
  "distinct",
  "forall",
  "exists",
  "none",
  "and",
  "or",
  "not",
  "implies",
  "iff",
  "when",
  "if",
  "within",
  "after",
  "before",
  "modified",
  "state-before",
  "state-after",
  "exists-in",
  "unique",
  "not-null",
] as const;

describe("createCoreOperatorRegistry", () => {
  it("includes every required v0.1 operator", () => {
    const registry = createCoreOperatorRegistry();

    expect(registry.list().map((spec) => spec.name)).toEqual(REQUIRED_OPERATOR_NAMES);
    for (const name of REQUIRED_OPERATOR_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("exposes representative return types", () => {
    const registry = createCoreOperatorRegistry();

    expect(registry.get("eq")?.returnType).toBe("Boolean");
    expect(registry.get("sum")?.returnType).toBe("Number");
    expect(registry.get("forall")?.returnType).toBe("Boolean");
    expect(registry.get("path")?.returnType).toBe("Path");
    expect(registry.get("collection")?.returnType).toBe("Collection");
    expect(registry.get("state-before")?.returnType).toBe("Unknown");
  });

  it("captures representative arity for variadic, fixed, and zero-arity operators", () => {
    const registry = createCoreOperatorRegistry();

    expect(registry.get("add")).toMatchObject({ minArity: 2, maxArity: "variadic" });
    expect(registry.get("sub")).toMatchObject({ minArity: 2, maxArity: 2 });
    expect(registry.get("state-before")).toMatchObject({ minArity: 0, maxArity: 0 });
    expect(registry.get("state-after")).toMatchObject({ minArity: 0, maxArity: 0 });
  });

  it("returns a stable insertion-order list without exposing internal mutable state", () => {
    const registry = createCoreOperatorRegistry();
    const originalList = registry.list();
    const originalNames = originalList.map((spec) => spec.name);

    originalList.reverse();
    originalList[0]!.name = "mutated";
    originalList[0]!.argTypes.push("Boolean");

    expect(registry.list().map((spec) => spec.name)).toEqual(originalNames);
    expect(registry.get(originalNames[0])?.name).toBe(originalNames[0]);
    expect(registry.get(originalNames[0])?.argTypes).not.toContain("Boolean");
  });

  it("throws a SteleError with useful metadata on duplicate registration", () => {
    const registry = createCoreOperatorRegistry();
    const duplicate = registry.get("eq");

    expect(duplicate).toBeDefined();
    expect(() => registry.register(duplicate!)).toThrowError(SteleError);

    try {
      registry.register(duplicate!);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E_DUPLICATE_OPERATOR",
        category: "Registry",
      });
      expect((error as SteleError).message).toContain("eq");
    }
  });

  it("returns undefined for unknown operators", () => {
    const registry = createCoreOperatorRegistry();

    expect(registry.get("unknown-operator")).toBeUndefined();
    expect(registry.has("unknown-operator")).toBe(false);
  });

  it("exports the public AST, error, and registry contracts from the package entrypoint", () => {
    const span: SourceSpan = {
      file: "contract.stele",
      line: 1,
      column: 1,
    };

    const astNode: AstNode = {
      kind: "list",
      head: "eq",
      items: [
        { kind: "identifier", value: "left", span },
        { kind: "number", value: 1, raw: "1", span },
      ],
      span,
    };

    const operatorSpec: OperatorSpec = {
      name: "demo",
      minArity: 1,
      maxArity: 1,
      argTypes: ["Unknown"],
      returnType: "Unknown",
      description: "demo operator",
    };

    expectTypeOf(astNode).toMatchTypeOf<AstNode>();
    expectTypeOf(operatorSpec.argTypes).toMatchTypeOf<SteleType[]>();
    expect(createCoreOperatorRegistry).toBeTypeOf("function");
    expect(SteleError).toBeTypeOf("function");
  });
});
