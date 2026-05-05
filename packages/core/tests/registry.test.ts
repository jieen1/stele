import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AstNode,
  createCoreOperatorRegistry,
  createOperatorRegistry,
  type OperatorParameterSpec,
  type OperatorSpec,
  type SourceSpan,
  SteleError,
  type SteleType,
} from "../src/index";

type ExpectedSignature = Pick<
  OperatorSpec,
  "name" | "minArity" | "maxArity" | "argTypes" | "parameters" | "returnType" | "valueType"
>;

const EXPECTED_SIGNATURES: ExpectedSignature[] = [
  signature("path", 1, "variadic", ["Symbol"], parameters(required("Symbol"), variadic("Symbol")), "Path", "Unknown"),
  signature("field", 2, 2, ["Path", "Symbol"], parameters(required("Path"), required("Symbol")), "Path", "Unknown"),
  signature("collection", 1, 1, ["Symbol"], parameters(required("Symbol")), "Collection"),
  signature("value", 1, 1, ["Unknown"], parameters(required("Unknown")), "Unknown"),
  signature("eq", 2, 2, ["Unknown", "Unknown"], parameters(required("Unknown"), required("Unknown")), "Boolean"),
  signature("neq", 2, 2, ["Unknown", "Unknown"], parameters(required("Unknown"), required("Unknown")), "Boolean"),
  signature("gt", 2, 2, ["Number", "Number"], parameters(required("Number"), required("Number")), "Boolean"),
  signature("gte", 2, 2, ["Number", "Number"], parameters(required("Number"), required("Number")), "Boolean"),
  signature("lt", 2, 2, ["Number", "Number"], parameters(required("Number"), required("Number")), "Boolean"),
  signature("lte", 2, 2, ["Number", "Number"], parameters(required("Number"), required("Number")), "Boolean"),
  signature("in", 2, 2, ["Unknown", "Collection"], parameters(required("Unknown"), required("Collection")), "Boolean"),
  signature("matches", 2, 2, ["String", "String"], parameters(required("String"), required("String")), "Boolean"),
  signature("add", 2, "variadic", ["Number", "Number"], parameters(required("Number"), required("Number"), variadic("Number")), "Number"),
  signature("sub", 2, 2, ["Number", "Number"], parameters(required("Number"), required("Number")), "Number"),
  signature("mul", 2, "variadic", ["Number", "Number"], parameters(required("Number"), required("Number"), variadic("Number")), "Number"),
  signature("div", 2, 2, ["Number", "Number"], parameters(required("Number"), required("Number")), "Number"),
  signature("neg", 1, 1, ["Number"], parameters(required("Number")), "Number"),
  signature("abs", 1, 1, ["Number"], parameters(required("Number")), "Number"),
  signature("sum", 1, 2, ["Collection", "Path"], parameters(required("Collection"), optional("Path")), "Number"),
  signature("count", 1, 1, ["Collection"], parameters(required("Collection")), "Number"),
  signature("avg", 1, 2, ["Collection", "Path"], parameters(required("Collection"), optional("Path")), "Number"),
  signature("min", 1, 2, ["Collection", "Path"], parameters(required("Collection"), optional("Path")), "Number"),
  signature("max", 1, 2, ["Collection", "Path"], parameters(required("Collection"), optional("Path")), "Number"),
  signature("distinct", 1, 2, ["Collection", "Path"], parameters(required("Collection"), optional("Path")), "Collection"),
  signature("where", 3, 3, ["Symbol", "Collection", "Predicate"], parameters(required("Symbol"), required("Collection"), required("Predicate")), "Collection"),
  signature("forall", 3, 3, ["Symbol", "Collection", "Predicate"], parameters(required("Symbol"), required("Collection"), required("Predicate")), "Boolean"),
  signature("exists", 3, 3, ["Symbol", "Collection", "Predicate"], parameters(required("Symbol"), required("Collection"), required("Predicate")), "Boolean"),
  signature("none", 3, 3, ["Symbol", "Collection", "Predicate"], parameters(required("Symbol"), required("Collection"), required("Predicate")), "Boolean"),
  signature("and", 1, "variadic", ["Predicate"], parameters(required("Predicate"), variadic("Predicate")), "Boolean"),
  signature("or", 1, "variadic", ["Predicate"], parameters(required("Predicate"), variadic("Predicate")), "Boolean"),
  signature("not", 1, 1, ["Predicate"], parameters(required("Predicate")), "Boolean"),
  signature("implies", 2, 2, ["Boolean", "Boolean"], parameters(required("Boolean"), required("Boolean")), "Boolean"),
  signature("iff", 2, 2, ["Boolean", "Boolean"], parameters(required("Boolean"), required("Boolean")), "Boolean"),
  signature("when", 2, 2, ["Boolean", "Predicate"], parameters(required("Boolean"), required("Predicate")), "Boolean"),
  signature("if", 3, 3, ["Boolean", "Unknown", "Unknown"], parameters(required("Boolean"), required("Unknown"), required("Unknown")), "Unknown"),
  signature("within", 2, 2, ["Unknown", "TimeRange"], parameters(required("Unknown"), required("TimeRange")), "Boolean"),
  signature("after", 2, 2, ["Unknown", "Unknown"], parameters(required("Unknown"), required("Unknown")), "Boolean"),
  signature("before", 2, 2, ["Unknown", "Unknown"], parameters(required("Unknown"), required("Unknown")), "Boolean"),
  signature("modified", 1, 1, ["Path"], parameters(required("Path")), "Boolean"),
  signature("state-before", 0, 0, [], parameters(), "Unknown"),
  signature("state-after", 0, 0, [], parameters(), "Unknown"),
  signature("exists-in", 2, 2, ["Unknown", "Collection"], parameters(required("Unknown"), required("Collection")), "Boolean"),
  signature("unique", 1, 2, ["Collection", "Path"], parameters(required("Collection"), optional("Path")), "Boolean"),
  signature("not-null", 1, 1, ["Path"], parameters(required("Path")), "Boolean"),
];

describe("createCoreOperatorRegistry", () => {
  it("locks the full v0.1 operator signature table in stable order", () => {
    const registry = createCoreOperatorRegistry();

    expect(registry.list().map(toSignatureSnapshot)).toEqual(EXPECTED_SIGNATURES);
    expect(registry.list().map((spec) => spec.name)).toEqual(EXPECTED_SIGNATURES.map((spec) => spec.name));
  });

  it("returns get() results without leaking mutable nested state", () => {
    const registry = createCoreOperatorRegistry();
    const received = registry.get("path");

    expect(received).toBeDefined();

    received!.name = "mutated";
    received!.description = "mutated";
    received!.argTypes.push("Boolean");
    received!.parameters[0]!.type = "Boolean";
    received!.parameters[1]!.occurrence = "optional";
    received!.valueType = "Path";

    expect(toSignatureSnapshot(registry.get("path")!)).toEqual(EXPECTED_SIGNATURES[0]);
    expect(toSignatureSnapshot(registry.list()[0]!)).toEqual(EXPECTED_SIGNATURES[0]);
  });

  it("returns a stable insertion-order list without exposing nested mutable state", () => {
    const registry = createCoreOperatorRegistry();
    const listed = registry.list();

    listed.reverse();
    listed[0]!.name = "mutated";
    listed[0]!.argTypes[0] = "Boolean";
    listed[0]!.parameters[0]!.type = "Boolean";
    listed[0]!.parameters[0]!.occurrence = "optional";

    expect(registry.list().map(toSignatureSnapshot)).toEqual(EXPECTED_SIGNATURES);
  });

  it("throws a SteleError with existing and incoming signatures on duplicate registration", () => {
    const registry = createCoreOperatorRegistry();
    const duplicate: OperatorSpec = {
      name: "path",
      minArity: 1,
      maxArity: 1,
      argTypes: ["Symbol"],
      parameters: [required("Symbol")],
      returnType: "Path",
      valueType: "Path",
      description: "incoming duplicate",
    };

    expect(() => registry.register(duplicate)).toThrowError(SteleError);

    try {
      registry.register(duplicate);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E_DUPLICATE_OPERATOR",
        category: "Registry",
      });

      const diagnostic = `${(error as SteleError).message}\n${(error as SteleError).detail ?? ""}`;

      expect(diagnostic).toContain('Operator "path" is already registered.');
      expect(diagnostic).toContain("existing:");
      expect(diagnostic).toContain("incoming:");
      expect(diagnostic).toContain("path(Symbol, ...Symbol) -> Path [value: Unknown]");
      expect(diagnostic).toContain("path(Symbol) -> Path [value: Path]");
    }
  });

  it("rejects registration when explicit parameters disagree with signature metadata", () => {
    const registry = createOperatorRegistry();
    const invalid: OperatorSpec = {
      name: "invalid-collection",
      minArity: 2,
      maxArity: 2,
      argTypes: ["Collection", "Path"],
      parameters: [required("Collection")],
      returnType: "Collection",
      description: "invalid explicit signature metadata",
    };

    expect(() => registry.register(invalid)).toThrowError(SteleError);

    try {
      registry.register(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E_INVALID_OPERATOR_SIGNATURE",
        category: "Registry",
      });

      const diagnostic = `${(error as SteleError).message}\n${(error as SteleError).detail ?? ""}`;

      expect(diagnostic).toContain('Operator "invalid-collection" has inconsistent signature metadata.');
      expect(diagnostic).toContain("expected:");
      expect(diagnostic).toContain("incoming:");
      expect(diagnostic).toContain("expected: minArity=1, maxArity=1, argTypes=[Collection]");
      expect(diagnostic).toContain("incoming: minArity=2, maxArity=2, argTypes=[Collection, Path]");
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
      maxArity: 2,
      argTypes: ["Collection", "Path"],
      parameters: [required("Collection"), optional("Path")],
      returnType: "Number",
      valueType: "Number",
      description: "demo operator",
    };

    expectTypeOf(astNode).toMatchTypeOf<AstNode>();
    expectTypeOf(operatorSpec.argTypes).toMatchTypeOf<SteleType[]>();
    expectTypeOf(operatorSpec.parameters).toMatchTypeOf<OperatorParameterSpec[]>();
    expectTypeOf(operatorSpec.valueType).toMatchTypeOf<SteleType | undefined>();
    expect(createCoreOperatorRegistry).toBeTypeOf("function");
    expect(SteleError).toBeTypeOf("function");
  });
});

function required(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "required" };
}

function optional(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "optional" };
}

function variadic(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "variadic" };
}

function parameters(...items: OperatorParameterSpec[]): OperatorParameterSpec[] {
  return items;
}

function signature(
  name: string,
  minArity: number,
  maxArity: number | "variadic",
  argTypes: SteleType[],
  parameters: OperatorParameterSpec[],
  returnType: SteleType,
  valueType?: SteleType,
): ExpectedSignature {
  return {
    name,
    minArity,
    maxArity,
    argTypes,
    parameters,
    returnType,
    valueType,
  };
}

function toSignatureSnapshot(spec: OperatorSpec): ExpectedSignature {
  return {
    name: spec.name,
    minArity: spec.minArity,
    maxArity: spec.maxArity,
    argTypes: [...spec.argTypes],
    parameters: spec.parameters.map((parameter) => ({ ...parameter })),
    returnType: spec.returnType,
    valueType: spec.valueType,
  };
}
