import type { SteleType } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";

export type OperatorSpec = {
  name: string;
  minArity: number;
  maxArity: number | "variadic";
  argTypes: SteleType[];
  returnType: SteleType;
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

  register(spec: OperatorSpec): void {
    if (this.#operators.has(spec.name)) {
      throw new SteleError(
        "E_DUPLICATE_OPERATOR",
        "Registry",
        `Operator "${spec.name}" is already registered.`,
        undefined,
        "Operator names must be unique within a registry.",
        "Reuse the existing operator spec or pick a different name.",
      );
    }

    this.#operators.set(spec.name, cloneOperatorSpec(spec));
  }

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

const CORE_OPERATOR_SPECS: OperatorSpec[] = [
  defineOperator("path", 1, "variadic", ["Symbol"], "Path", "Resolve a data path from one or more symbols."),
  defineOperator("field", 2, 2, ["Path", "Symbol"], "Path", "Append a field symbol to an existing path."),
  defineOperator("collection", 1, 1, ["Symbol"], "Collection", "Reference a named collection."),
  defineOperator("value", 1, 1, ["Unknown"], "Unknown", "Wrap a literal value."),
  defineOperator("eq", 2, 2, ["Unknown", "Unknown"], "Boolean", "Check whether two values are equal."),
  defineOperator("neq", 2, 2, ["Unknown", "Unknown"], "Boolean", "Check whether two values are not equal."),
  defineOperator("gt", 2, 2, ["Number", "Number"], "Boolean", "Check whether the first number is greater than the second."),
  defineOperator("gte", 2, 2, ["Number", "Number"], "Boolean", "Check whether the first number is greater than or equal to the second."),
  defineOperator("lt", 2, 2, ["Number", "Number"], "Boolean", "Check whether the first number is less than the second."),
  defineOperator("lte", 2, 2, ["Number", "Number"], "Boolean", "Check whether the first number is less than or equal to the second."),
  defineOperator("in", 2, 2, ["Unknown", "Collection"], "Boolean", "Check whether a value exists inside a collection."),
  defineOperator("matches", 2, 2, ["String", "String"], "Boolean", "Match a string against a regular expression."),
  defineOperator("add", 2, "variadic", ["Number", "Number"], "Number", "Add two or more numbers."),
  defineOperator("sub", 2, 2, ["Number", "Number"], "Number", "Subtract the second number from the first."),
  defineOperator("mul", 2, "variadic", ["Number", "Number"], "Number", "Multiply two or more numbers."),
  defineOperator("div", 2, 2, ["Number", "Number"], "Number", "Divide the first number by the second."),
  defineOperator("neg", 1, 1, ["Number"], "Number", "Negate a number."),
  defineOperator("abs", 1, 1, ["Number"], "Number", "Return the absolute value of a number."),
  defineOperator("sum", 1, 2, ["Collection", "Path"], "Number", "Sum a collection, optionally by a path."),
  defineOperator("count", 1, 1, ["Collection"], "Number", "Count items in a collection."),
  defineOperator("avg", 1, 2, ["Collection", "Path"], "Number", "Average a collection, optionally by a path."),
  defineOperator("min", 1, 2, ["Collection", "Path"], "Number", "Find the minimum value in a collection, optionally by a path."),
  defineOperator("max", 1, 2, ["Collection", "Path"], "Number", "Find the maximum value in a collection, optionally by a path."),
  defineOperator("distinct", 1, 2, ["Collection", "Path"], "Collection", "Remove duplicate values from a collection, optionally by a path."),
  defineOperator("forall", 3, 3, ["Symbol", "Collection", "Predicate"], "Boolean", "Check whether all items in a collection satisfy a predicate."),
  defineOperator("exists", 3, 3, ["Symbol", "Collection", "Predicate"], "Boolean", "Check whether any item in a collection satisfies a predicate."),
  defineOperator("none", 3, 3, ["Symbol", "Collection", "Predicate"], "Boolean", "Check whether no items in a collection satisfy a predicate."),
  defineOperator("and", 1, "variadic", ["Predicate"], "Boolean", "Return true when every predicate is true."),
  defineOperator("or", 1, "variadic", ["Predicate"], "Boolean", "Return true when any predicate is true."),
  defineOperator("not", 1, 1, ["Predicate"], "Boolean", "Invert a predicate result."),
  defineOperator("implies", 2, 2, ["Boolean", "Boolean"], "Boolean", "Evaluate logical implication."),
  defineOperator("iff", 2, 2, ["Boolean", "Boolean"], "Boolean", "Evaluate logical equivalence."),
  defineOperator("when", 2, 2, ["Boolean", "Predicate"], "Boolean", "Evaluate a predicate only when its condition is true."),
  defineOperator("if", 3, 3, ["Boolean", "Unknown", "Unknown"], "Unknown", "Choose between two values based on a condition."),
  defineOperator("within", 2, 2, ["Unknown", "TimeRange"], "Boolean", "Check whether an event falls within a time range."),
  defineOperator("after", 2, 2, ["Unknown", "Unknown"], "Boolean", "Check whether one event occurs after another."),
  defineOperator("before", 2, 2, ["Unknown", "Unknown"], "Boolean", "Check whether one event occurs before another."),
  defineOperator("modified", 1, 1, ["Path"], "Boolean", "Check whether a path was modified."),
  defineOperator("state-before", 0, 0, [], "Unknown", "Reference the state before an operation."),
  defineOperator("state-after", 0, 0, [], "Unknown", "Reference the state after an operation."),
  defineOperator("exists-in", 2, 2, ["Unknown", "Collection"], "Boolean", "Check whether an identifier exists inside a collection."),
  defineOperator("unique", 1, 2, ["Collection", "Path"], "Boolean", "Check whether collection items are unique, optionally by a path."),
  defineOperator("not-null", 1, 1, ["Path"], "Boolean", "Check whether a path resolves to a non-null value."),
];

function defineOperator(
  name: string,
  minArity: number,
  maxArity: number | "variadic",
  argTypes: SteleType[],
  returnType: SteleType,
  description: string,
): OperatorSpec {
  return {
    name,
    minArity,
    maxArity,
    argTypes,
    returnType,
    description,
  };
}

function cloneOperatorSpec(spec: OperatorSpec): OperatorSpec {
  return {
    ...spec,
    argTypes: [...spec.argTypes],
  };
}
