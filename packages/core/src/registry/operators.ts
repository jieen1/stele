import type { SteleType } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";

export type OperatorParameterOccurrence = "required" | "optional" | "variadic";

export type OperatorParameterSpec = {
  type: SteleType;
  occurrence: OperatorParameterOccurrence;
};

export type OperatorSpec = {
  name: string;
  minArity: number;
  maxArity: number | "variadic";
  argTypes: SteleType[];
  parameters: OperatorParameterSpec[];
  returnType: SteleType;
  valueType?: SteleType;
  description: string;
};

export interface OperatorRegistry {
  register(spec: OperatorSpec): void;
  get(name: string): OperatorSpec | undefined;
  has(name: string): boolean;
  list(): OperatorSpec[];
}

class InMemoryOperatorRegistry implements OperatorRegistry {
  readonly #operators = new Map<string, OperatorSpec>();


  get(name: string): OperatorSpec | undefined {
    const spec = this.#operators.get(name);
    return spec === undefined ? undefined : cloneOperatorSpec(spec);
  }

  has(name: string): boolean {
    return this.#operators.has(name);
  }

  list(): OperatorSpec[] {
    return Array.from(this.#operators.values(), (spec) => cloneOperatorSpec(spec));
  }
}

export function createOperatorRegistry(initialSpecs: Iterable<OperatorSpec> = []): OperatorRegistry {
  const registry = new InMemoryOperatorRegistry();

  for (const spec of initialSpecs) {
    registry.register(spec);
  }

  return registry;
}

export function createCoreOperatorRegistry(): OperatorRegistry {
  return createOperatorRegistry(CORE_OPERATOR_SPECS);
}

export const CORE_OPERATOR_SPECS: OperatorSpec[] = [
  defineOperator({
    name: "path",
    parameters: [required("Symbol"), variadic("Symbol")],
    returnType: "Path",
    valueType: "Unknown",
    description: "Resolve a data path from one or more symbols.",
  }),
  defineOperator({
    name: "field",
    parameters: [required("Path"), required("Symbol")],
    returnType: "Path",
    valueType: "Unknown",
    description: "Append a field symbol to an existing path.",
  }),
  defineOperator({
    name: "collection",
    parameters: [required("Symbol")],
    returnType: "Collection",
    description: "Reference a named collection.",
  }),
  defineOperator({
    name: "value",
    parameters: [required("Unknown")],
    returnType: "Unknown",
    description: "Wrap a literal value.",
  }),
  defineOperator({
    name: "eq",
    parameters: [required("Unknown"), required("Unknown")],
    returnType: "Boolean",
    description: "Check whether two values are equal.",
  }),
  defineOperator({
    name: "neq",
    parameters: [required("Unknown"), required("Unknown")],
    returnType: "Boolean",
    description: "Check whether two values are not equal.",
  }),
  defineOperator({
    name: "gt",
    parameters: [required("Number"), required("Number")],
    returnType: "Boolean",
    description: "Check whether the first number is greater than the second.",
  }),
  defineOperator({
    name: "gte",
    parameters: [required("Number"), required("Number")],
    returnType: "Boolean",
    description: "Check whether the first number is greater than or equal to the second.",
  }),
  defineOperator({
    name: "lt",
    parameters: [required("Number"), required("Number")],
    returnType: "Boolean",
    description: "Check whether the first number is less than the second.",
  }),
  defineOperator({
    name: "lte",
    parameters: [required("Number"), required("Number")],
    returnType: "Boolean",
    description: "Check whether the first number is less than or equal to the second.",
  }),
  defineOperator({
    name: "in",
    parameters: [required("Unknown"), required("Collection")],
    returnType: "Boolean",
    description: "Check whether a value exists inside a collection.",
  }),
  defineOperator({
    name: "matches",
    parameters: [required("String"), required("String")],
    returnType: "Boolean",
    description: "Match a string against a regular expression.",
  }),
  defineOperator({
    name: "add",
    parameters: [required("Number"), required("Number"), variadic("Number")],
    returnType: "Number",
    description: "Add two or more numbers.",
  }),
  defineOperator({
    name: "sub",
    parameters: [required("Number"), required("Number")],
    returnType: "Number",
    description: "Subtract the second number from the first.",
  }),
  defineOperator({
    name: "mul",
    parameters: [required("Number"), required("Number"), variadic("Number")],
    returnType: "Number",
    description: "Multiply two or more numbers.",
  }),
  defineOperator({
    name: "div",
    parameters: [required("Number"), required("Number")],
    returnType: "Number",
    description: "Divide the first number by the second.",
  }),
  defineOperator({
    name: "neg",
    parameters: [required("Number")],
    returnType: "Number",
    description: "Negate a number.",
  }),
  defineOperator({
    name: "abs",
    parameters: [required("Number")],
    returnType: "Number",
    description: "Return the absolute value of a number.",
  }),
  defineOperator({
    name: "sum",
    parameters: [required("Collection"), optional("Path")],
    returnType: "Number",
    description: "Sum a collection, optionally by a path.",
  }),
  defineOperator({
    name: "count",
    parameters: [required("Collection")],
    returnType: "Number",
    description: "Count items in a collection.",
  }),
  defineOperator({
    name: "avg",
    parameters: [required("Collection"), optional("Path")],
    returnType: "Number",
    description: "Average a collection, optionally by a path.",
  }),
  defineOperator({
    name: "min",
    parameters: [required("Collection"), optional("Path")],
    returnType: "Number",
    description: "Find the minimum value in a collection, optionally by a path.",
  }),
  defineOperator({
    name: "max",
    parameters: [required("Collection"), optional("Path")],
    returnType: "Number",
    description: "Find the maximum value in a collection, optionally by a path.",
  }),
  defineOperator({
    name: "distinct",
    parameters: [required("Collection"), optional("Path")],
    returnType: "Collection",
    description: "Remove duplicate values from a collection, optionally by a path.",
  }),
  defineOperator({
    name: "where",
    parameters: [required("Symbol"), required("Collection"), required("Predicate")],
    returnType: "Collection",
    description: "Filter a collection by a predicate evaluated against each bound item.",
  }),
  defineOperator({
    name: "forall",
    parameters: [required("Symbol"), required("Collection"), required("Predicate")],
    returnType: "Boolean",
    description: "Check whether all items in a collection satisfy a predicate.",
  }),
  defineOperator({
    name: "exists",
    parameters: [required("Symbol"), required("Collection"), required("Predicate")],
    returnType: "Boolean",
    description: "Check whether any item in a collection satisfies a predicate.",
  }),
  defineOperator({
    name: "none",
    parameters: [required("Symbol"), required("Collection"), required("Predicate")],
    returnType: "Boolean",
    description: "Check whether no items in a collection satisfy a predicate.",
  }),
  defineOperator({
    name: "and",
    parameters: [required("Predicate"), variadic("Predicate")],
    returnType: "Boolean",
    description: "Return true when every predicate is true.",
  }),
  defineOperator({
    name: "or",
    parameters: [required("Predicate"), variadic("Predicate")],
    returnType: "Boolean",
    description: "Return true when any predicate is true.",
  }),
  defineOperator({
    name: "not",
    parameters: [required("Predicate")],
    returnType: "Boolean",
    description: "Invert a predicate result.",
  }),
  defineOperator({
    name: "implies",
    parameters: [required("Boolean"), required("Boolean")],
    returnType: "Boolean",
    description: "Evaluate logical implication.",
  }),
  defineOperator({
    name: "iff",
    parameters: [required("Boolean"), required("Boolean")],
    returnType: "Boolean",
    description: "Evaluate logical equivalence.",
  }),
  defineOperator({
    name: "when",
    parameters: [required("Boolean"), required("Predicate")],
    returnType: "Boolean",
    description: "Evaluate a predicate only when its condition is true.",
  }),
  defineOperator({
    name: "if",
    parameters: [required("Boolean"), required("Unknown"), required("Unknown")],
    returnType: "Unknown",
    description: "Choose between two values based on a condition.",
  }),
  defineOperator({
    name: "within",
    parameters: [required("Unknown"), required("TimeRange")],
    returnType: "Boolean",
    description: "Check whether an event falls within a time range.",
  }),
  defineOperator({
    name: "after",
    parameters: [required("Unknown"), required("Unknown")],
    returnType: "Boolean",
    description: "Check whether one event occurs after another.",
  }),
  defineOperator({
    name: "before",
    parameters: [required("Unknown"), required("Unknown")],
    returnType: "Boolean",
    description: "Check whether one event occurs before another.",
  }),
  defineOperator({
    name: "modified",
    parameters: [required("Path")],
    returnType: "Boolean",
    description: "Check whether a path was modified.",
  }),
  defineOperator({
    name: "state-before",
    parameters: [],
    returnType: "Unknown",
    description: "Reference the state before an operation.",
  }),
  defineOperator({
    name: "state-after",
    parameters: [],
    returnType: "Unknown",
    description: "Reference the state after an operation.",
  }),
  defineOperator({
    name: "exists-in",
    parameters: [required("Unknown"), required("Collection")],
    returnType: "Boolean",
    description: "Check whether an identifier exists inside a collection.",
  }),
  defineOperator({
    name: "unique",
    parameters: [required("Collection"), optional("Path")],
    returnType: "Boolean",
    description: "Check whether collection items are unique, optionally by a path.",
  }),
  defineOperator({
    name: "not-null",
    parameters: [required("Path")],
    returnType: "Boolean",
    description: "Check whether a path resolves to a non-null value.",
  }),
  defineOperator({
    name: "between",
    parameters: [required("Number"), required("Number"), required("Number")],
    returnType: "Boolean",
    description: "Check whether a number falls within an inclusive range [low, high].",
  }),
  defineOperator({
    name: "approx-eq",
    parameters: [required("Number"), required("Number"), required("Number")],
    returnType: "Boolean",
    description: "Check whether two numbers are equal within an absolute tolerance.",
  }),
  defineOperator({
    name: "contains",
    parameters: [required("String"), required("String")],
    returnType: "Boolean",
    description: "Check whether a string contains a substring.",
  }),
  defineOperator({
    name: "is-empty",
    parameters: [required("Collection")],
    returnType: "Boolean",
    description: "Check whether a collection is empty.",
  }),
  defineOperator({
    name: "starts-with",
    parameters: [required("String"), required("String")],
    returnType: "Boolean",
    description: "Check whether a string starts with a prefix.",
  }),
  defineOperator({
    name: "ends-with",
    parameters: [required("String"), required("String")],
    returnType: "Boolean",
    description: "Check whether a string ends with a suffix.",
  }),
  defineOperator({
    name: "has-length",
    parameters: [required("Collection"), required("Number")],
    returnType: "Boolean",
    description: "Check whether a collection has the expected length.",
  }),
  // EP04 batch 1: collection (4)
  defineOperator({
    name: "length",
    parameters: [required("Collection")],
    returnType: "Number",
    description: "Number of elements in a collection (empty -> 0).",
  }),
  defineOperator({
    name: "concat",
    parameters: [required("Collection"), variadic("Collection")],
    returnType: "Collection",
    description: "Concatenate one or more collections in order, preserving duplicates.",
  }),
  defineOperator({
    name: "sort-by",
    parameters: [required("Collection"), required("Path")],
    returnType: "Collection",
    description: "Stable ascending sort of a collection by a path projection.",
  }),
  defineOperator({
    name: "sort-by-desc",
    parameters: [required("Collection"), required("Path")],
    returnType: "Collection",
    description: "Stable descending sort of a collection by a path projection.",
  }),
  // EP04 batch 1: arithmetic (5)
  defineOperator({
    name: "mod",
    parameters: [required("Number"), required("Number")],
    returnType: "Number",
    description: "Sign-of-divisor modulo (Python semantics): mod(-7, 3) = 2.",
  }),
  defineOperator({
    name: "pow",
    parameters: [required("Number"), required("Number")],
    returnType: "Number",
    description: "IEEE-754 double power; negative base with non-integer exponent yields NaN.",
  }),
  defineOperator({
    name: "round",
    parameters: [required("Number"), optional("Number")],
    returnType: "Number",
    description: "Banker's rounding (half to even); optional digits parameter defaults to 0.",
  }),
  defineOperator({
    name: "ceil",
    parameters: [required("Number")],
    returnType: "Number",
    description: "Round toward positive infinity; NaN propagates.",
  }),
  defineOperator({
    name: "floor",
    parameters: [required("Number")],
    returnType: "Number",
    description: "Round toward negative infinity; NaN propagates.",
  }),
  // EP04 batch 1: string (5)
  defineOperator({
    name: "trim",
    parameters: [required("String")],
    returnType: "String",
    description: "Strip leading and trailing Unicode whitespace.",
  }),
  defineOperator({
    name: "lower",
    parameters: [required("String")],
    returnType: "String",
    description: "Locale-independent Unicode lowercase conversion.",
  }),
  defineOperator({
    name: "upper",
    parameters: [required("String")],
    returnType: "String",
    description: "Locale-independent Unicode uppercase conversion.",
  }),
  defineOperator({
    name: "split",
    parameters: [required("String"), required("String")],
    returnType: "Collection",
    description: "Split a string by a literal separator; empty separator raises SteleRuntimeError.",
  }),
  defineOperator({
    name: "join",
    parameters: [required("Collection"), required("String")],
    returnType: "String",
    description: "Join a collection of strings with a separator; mixed types fail at validation.",
  }),
  // EP04 batch 1: data access (1)
  defineOperator({
    name: "type-of",
    parameters: [required("Unknown")],
    returnType: "String",
    description: "Return the structural type tag (number, string, boolean, collection, object, null, undefined).",
  }),
  // EP04 batch 1: FP promoted from EP13 (3 + 1 alias)
  defineOperator({
    name: "map",
    parameters: [required("Collection"), required("Path")],
    returnType: "Collection",
    description: "Project each item in a collection by a path; missing paths skipped silently.",
  }),
  defineOperator({
    name: "first",
    parameters: [required("Collection")],
    returnType: "Unknown",
    description: "Return the first element; raises SteleRuntimeError on empty collection.",
  }),
  defineOperator({
    name: "last",
    parameters: [required("Collection")],
    returnType: "Unknown",
    description: "Return the last element; raises SteleRuntimeError on empty collection.",
  }),
  defineOperator({
    name: "filter",
    parameters: [required("Symbol"), required("Collection"), required("Predicate")],
    returnType: "Collection",
    description: "Alias for where: filter a collection by a predicate evaluated against each bound item.",
  }),
  defineOperator({
    name: "json-path",
    parameters: [required("String"), required("String")],
    returnType: "String",
    description: "Extract a value from a JSON string using a JSON path expression.",
  }),
  defineOperator({
    name: "decimal-eq",
    parameters: [required("Number"), required("Number")],
    returnType: "Boolean",
    description: "Compare two numbers with exact decimal precision, avoiding floating point errors.",
  }),
];

type DefineOperatorInput = {
  name: string;
  parameters: OperatorParameterSpec[];
  returnType: SteleType;
  valueType?: SteleType;
  description: string;
};

function defineOperator(input: DefineOperatorInput): OperatorSpec {
  const signature = deriveSignatureShape(input.parameters);

  return {
    name: input.name,
    minArity: signature.minArity,
    maxArity: signature.maxArity,
    argTypes: signature.argTypes,
    parameters: input.parameters.map(cloneOperatorParameterSpec),
    returnType: input.returnType,
    valueType: input.valueType,
    description: input.description,
  };
}

function normalizeOperatorSpec(spec: OperatorSpec): OperatorSpec {
  const normalized: OperatorSpec = {
    ...spec,
    argTypes: [...spec.argTypes],
    parameters: spec.parameters.map(cloneOperatorParameterSpec),
  };

  const derived = deriveSignatureShape(normalized.parameters);

  if (
    normalized.minArity !== derived.minArity ||
    normalized.maxArity !== derived.maxArity ||
    !sameTypes(normalized.argTypes, derived.argTypes)
  ) {
    throw new SteleError(
      "E_INVALID_OPERATOR_SIGNATURE",
      "Registry",
      `Operator "${normalized.name}" has inconsistent signature metadata.`,
      undefined,
      `expected: ${formatDerivedMetadata(derived)}\nincoming: ${formatProvidedMetadata(normalized)}`,
      "Keep minArity, maxArity, and argTypes aligned with the explicit parameters list.",
    );
  }

  return normalized;
}

function deriveSignatureShape(parameters: OperatorParameterSpec[]): {
  minArity: number;
  maxArity: number | "variadic";
  argTypes: SteleType[];
} {
  let minArity = 0;
  let maxArity = 0;
  let hasVariadic = false;
  let optionalSeen = false;
  let variadicSeen = false;
  const argTypes: SteleType[] = [];

  for (const [index, parameter] of parameters.entries()) {
    if (variadicSeen) {
      throw new SteleError(
        "E_INVALID_OPERATOR_SIGNATURE",
        "Registry",
        "Operator parameters cannot appear after a variadic parameter.",
        undefined,
        `index: ${index}\nparameter: ${parameter.type} (${parameter.occurrence})`,
      );
    }

    if (parameter.occurrence === "required") {
      if (optionalSeen) {
        throw new SteleError(
          "E_INVALID_OPERATOR_SIGNATURE",
          "Registry",
          "Required parameters cannot follow optional parameters.",
          undefined,
          `index: ${index}\nparameter: ${parameter.type} (${parameter.occurrence})`,
        );
      }

      minArity += 1;
      maxArity += 1;
      argTypes.push(parameter.type);
      continue;
    }

    if (parameter.occurrence === "optional") {
      optionalSeen = true;
      maxArity += 1;
      argTypes.push(parameter.type);
      continue;
    }

    variadicSeen = true;
    hasVariadic = true;
  }

  return {
    minArity,
    maxArity: hasVariadic ? "variadic" : maxArity,
    argTypes,
  };
}

function formatOperatorSignature(spec: OperatorSpec): string {
  const parameters = spec.parameters
    .map((parameter) => {
      if (parameter.occurrence === "optional") {
        return `[${parameter.type}]`;
      }

      if (parameter.occurrence === "variadic") {
        return `...${parameter.type}`;
      }

      return parameter.type;
    })
    .join(", ");

  const valueContext = spec.valueType === undefined ? "" : ` [value: ${spec.valueType}]`;

  return `${spec.name}(${parameters}) -> ${spec.returnType}${valueContext}`;
}

function formatDerivedMetadata(metadata: {
  minArity: number;
  maxArity: number | "variadic";
  argTypes: SteleType[];
}): string {
  return `minArity=${metadata.minArity}, maxArity=${metadata.maxArity}, argTypes=[${metadata.argTypes.join(", ")}]`;
}

function formatProvidedMetadata(spec: OperatorSpec): string {
  return `minArity=${spec.minArity}, maxArity=${spec.maxArity}, argTypes=[${spec.argTypes.join(", ")}]`;
}

function sameTypes(left: SteleType[], right: SteleType[]): boolean {
  return left.length === right.length && left.every((type, index) => type === right[index]);
}

function required(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "required" };
}

function optional(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "optional" };
}

function variadic(type: SteleType): OperatorParameterSpec {
  return { type, occurrence: "variadic" };
}

function cloneOperatorSpec(spec: OperatorSpec): OperatorSpec {
  return {
    ...spec,
    argTypes: [...spec.argTypes],
    parameters: spec.parameters.map(cloneOperatorParameterSpec),
  };
}

function cloneOperatorParameterSpec(parameter: OperatorParameterSpec): OperatorParameterSpec {
  return { ...parameter };
}
