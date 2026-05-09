import { describe, expect, it } from "vitest";
import {
  createCoreOperatorRegistry,
  type OperatorParameterSpec,
  type SteleType,
} from "../src/index.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function req(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "required" };
}

function opt(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "optional" };
}

function var_(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "variadic" };
}

function computeArity(parameters: OperatorParameterSpec[]): {
  minArity: number;
  maxArity: number | "variadic";
} {
  let minArity = 0;
  let maxArity = 0;
  let hasVariadic = false;

  for (const param of parameters) {
    if (param.occurrence === "required") {
      minArity += 1;
      maxArity += 1;
    } else if (param.occurrence === "optional") {
      maxArity += 1;
    } else {
      hasVariadic = true;
    }
  }

  return { minArity, maxArity: hasVariadic ? "variadic" : maxArity };
}

function deriveArgTypes(parameters: OperatorParameterSpec[]): SteleType[] {
  return parameters
    .filter((p) => p.occurrence !== "variadic")
    .map((p) => p.type);
}

/* ------------------------------------------------------------------ */
/*  Operator catalogue                                               */
/* ------------------------------------------------------------------ */

type OperatorExpectation = {
  name: string;
  parameters: OperatorParameterSpec[];
  returnType: SteleType;
  valueType?: SteleType;
};

const OPERATORS: OperatorExpectation[] = [
  // Path / data access
  { name: "path", parameters: [req("Symbol"), var_("Symbol")], returnType: "Path", valueType: "Unknown" },
  { name: "field", parameters: [req("Path"), req("Symbol")], returnType: "Path", valueType: "Unknown" },
  { name: "collection", parameters: [req("Symbol")], returnType: "Collection" },
  { name: "value", parameters: [req("Unknown")], returnType: "Unknown" },

  // Equality
  { name: "eq", parameters: [req("Unknown"), req("Unknown")], returnType: "Boolean" },
  { name: "neq", parameters: [req("Unknown"), req("Unknown")], returnType: "Boolean" },

  // Comparison
  { name: "gt", parameters: [req("Number"), req("Number")], returnType: "Boolean" },
  { name: "gte", parameters: [req("Number"), req("Number")], returnType: "Boolean" },
  { name: "lt", parameters: [req("Number"), req("Number")], returnType: "Boolean" },
  { name: "lte", parameters: [req("Number"), req("Number")], returnType: "Boolean" },

  // Membership / pattern
  { name: "in", parameters: [req("Unknown"), req("Collection")], returnType: "Boolean" },
  { name: "matches", parameters: [req("String"), req("String")], returnType: "Boolean" },

  // Arithmetic
  { name: "add", parameters: [req("Number"), req("Number"), var_("Number")], returnType: "Number" },
  { name: "sub", parameters: [req("Number"), req("Number")], returnType: "Number" },
  { name: "mul", parameters: [req("Number"), req("Number"), var_("Number")], returnType: "Number" },
  { name: "div", parameters: [req("Number"), req("Number")], returnType: "Number" },
  { name: "neg", parameters: [req("Number")], returnType: "Number" },
  { name: "abs", parameters: [req("Number")], returnType: "Number" },

  // Aggregation
  { name: "sum", parameters: [req("Collection"), opt("Path")], returnType: "Number" },
  { name: "count", parameters: [req("Collection")], returnType: "Number" },
  { name: "avg", parameters: [req("Collection"), opt("Path")], returnType: "Number" },
  { name: "min", parameters: [req("Collection"), opt("Path")], returnType: "Number" },
  { name: "max", parameters: [req("Collection"), opt("Path")], returnType: "Number" },

  // Collection
  { name: "distinct", parameters: [req("Collection"), opt("Path")], returnType: "Collection" },
  { name: "where", parameters: [req("Symbol"), req("Collection"), req("Predicate")], returnType: "Collection" },
  { name: "forall", parameters: [req("Symbol"), req("Collection"), req("Predicate")], returnType: "Boolean" },
  { name: "exists", parameters: [req("Symbol"), req("Collection"), req("Predicate")], returnType: "Boolean" },
  { name: "none", parameters: [req("Symbol"), req("Collection"), req("Predicate")], returnType: "Boolean" },

  // Logic
  { name: "and", parameters: [req("Predicate"), var_("Predicate")], returnType: "Boolean" },
  { name: "or", parameters: [req("Predicate"), var_("Predicate")], returnType: "Boolean" },
  { name: "not", parameters: [req("Predicate")], returnType: "Boolean" },
  { name: "implies", parameters: [req("Boolean"), req("Boolean")], returnType: "Boolean" },
  { name: "iff", parameters: [req("Boolean"), req("Boolean")], returnType: "Boolean" },
  { name: "when", parameters: [req("Boolean"), req("Predicate")], returnType: "Boolean" },
  { name: "if", parameters: [req("Boolean"), req("Unknown"), req("Unknown")], returnType: "Unknown" },

  // Temporal
  { name: "within", parameters: [req("Unknown"), req("TimeRange")], returnType: "Boolean" },
  { name: "after", parameters: [req("Unknown"), req("Unknown")], returnType: "Boolean" },
  { name: "before", parameters: [req("Unknown"), req("Unknown")], returnType: "Boolean" },

  // State
  { name: "modified", parameters: [req("Path")], returnType: "Boolean" },
  { name: "state-before", parameters: [], returnType: "Unknown" },
  { name: "state-after", parameters: [], returnType: "Unknown" },

  // Extra
  { name: "exists-in", parameters: [req("Unknown"), req("Collection")], returnType: "Boolean" },
  { name: "unique", parameters: [req("Collection"), opt("Path")], returnType: "Boolean" },
  { name: "not-null", parameters: [req("Path")], returnType: "Boolean" },
  { name: "between", parameters: [req("Number"), req("Number"), req("Number")], returnType: "Boolean" },
  { name: "approx-eq", parameters: [req("Number"), req("Number"), req("Number")], returnType: "Boolean" },
  { name: "contains", parameters: [req("String"), req("String")], returnType: "Boolean" },
  { name: "is-empty", parameters: [req("Collection")], returnType: "Boolean" },
  { name: "starts-with", parameters: [req("String"), req("String")], returnType: "Boolean" },
  { name: "ends-with", parameters: [req("String"), req("String")], returnType: "Boolean" },
  { name: "has-length", parameters: [req("Collection"), req("Number")], returnType: "Boolean" },

  // EP04 batch 1: collection (4)
  { name: "length", parameters: [req("Collection")], returnType: "Number" },
  { name: "concat", parameters: [req("Collection"), var_("Collection")], returnType: "Collection" },
  { name: "sort-by", parameters: [req("Collection"), req("Path")], returnType: "Collection" },
  { name: "sort-by-desc", parameters: [req("Collection"), req("Path")], returnType: "Collection" },

  // EP04 batch 1: arithmetic (5)
  { name: "mod", parameters: [req("Number"), req("Number")], returnType: "Number" },
  { name: "pow", parameters: [req("Number"), req("Number")], returnType: "Number" },
  { name: "round", parameters: [req("Number"), opt("Number")], returnType: "Number" },
  { name: "ceil", parameters: [req("Number")], returnType: "Number" },
  { name: "floor", parameters: [req("Number")], returnType: "Number" },

  // EP04 batch 1: string (5)
  { name: "trim", parameters: [req("String")], returnType: "String" },
  { name: "lower", parameters: [req("String")], returnType: "String" },
  { name: "upper", parameters: [req("String")], returnType: "String" },
  { name: "split", parameters: [req("String"), req("String")], returnType: "Collection" },
  { name: "join", parameters: [req("Collection"), req("String")], returnType: "String" },

  // EP04 batch 1: data access (1)
  { name: "type-of", parameters: [req("Unknown")], returnType: "String" },

  // EP04 batch 1: FP promoted (3 + 1 alias)
  { name: "map", parameters: [req("Collection"), req("Path")], returnType: "Collection" },
  { name: "first", parameters: [req("Collection")], returnType: "Unknown" },
  { name: "last", parameters: [req("Collection")], returnType: "Unknown" },
  { name: "filter", parameters: [req("Symbol"), req("Collection"), req("Predicate")], returnType: "Collection" },
];

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("operator behavioral contract", () => {
  const registry = createCoreOperatorRegistry();

  it(`registers all ${OPERATORS.length} operators`, () => {
    expect(registry.list()).toHaveLength(OPERATORS.length);
  });

  for (const expected of OPERATORS) {
    const { name, parameters: expectedParams, returnType, valueType } = expected;
    const { minArity, maxArity } = computeArity(expectedParams);
    const expectedArgTypes = deriveArgTypes(expectedParams);

    describe(`operator "${name}"`, () => {
      it("exists in the registry", () => {
        expect(registry.has(name)).toBe(true);
        expect(registry.get(name)).toBeDefined();
      });

      it("has correct minArity / maxArity", () => {
        const spec = registry.get(name)!;
        expect(spec.minArity).toBe(minArity);
        expect(spec.maxArity).toBe(maxArity);
      });

      it("has correct return type", () => {
        const spec = registry.get(name)!;
        expect(spec.returnType).toBe(returnType);
      });

      it("has correct argTypes", () => {
        const spec = registry.get(name)!;
        expect(spec.argTypes).toEqual(expectedArgTypes);
      });

      it("has correct parameter spec", () => {
        const spec = registry.get(name)!;
        expect(spec.parameters).toEqual(expectedParams);
      });

      it("has the right value type", () => {
        const spec = registry.get(name)!;
        if (valueType !== undefined) {
          expect(spec.valueType).toBe(valueType);
        } else {
          expect(spec.valueType).toBeUndefined();
        }
      });

      it("has a non-empty description", () => {
        const spec = registry.get(name)!;
        expect(spec.description.length).toBeGreaterThan(0);
      });
    });
  }

  it("returns undefined for non-existent operators", () => {
    expect(registry.get("non-existent-operator")).toBeUndefined();
    expect(registry.has("non-existent-operator")).toBe(false);
  });

  it("derives variadic argTypes correctly (variadic params excluded)", () => {
    const addSpec = registry.get("add")!;
    expect(addSpec.argTypes).toEqual(["Number", "Number"]);
  });

  it("derives zero-arity correctly for state-before / state-after", () => {
    for (const name of ["state-before", "state-after"]) {
      const spec = registry.get(name)!;
      expect(spec.minArity).toBe(0);
      expect(spec.maxArity).toBe(0);
      expect(spec.argTypes).toEqual([]);
      expect(spec.parameters).toEqual([]);
    }
  });

  it("derives optional arity correctly for operators with trailing optional", () => {
    const sumSpec = registry.get("sum")!;
    expect(sumSpec.minArity).toBe(1);
    expect(sumSpec.maxArity).toBe(2);
    expect(sumSpec.argTypes).toEqual(["Collection", "Path"]);
  });
});
