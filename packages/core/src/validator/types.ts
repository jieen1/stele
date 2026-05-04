import type { AstNode, ListNode, SteleType } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import { createCoreOperatorRegistry, type OperatorSpec } from "../registry/operators.js";
import type { Contract } from "./structure.js";

type TypeContext = {
  boundNames: Set<string>;
};

export function validateTypes(contract: Contract): Contract {
  const registry = createCoreOperatorRegistry();

  for (const invariant of contract.invariants) {
    if (invariant.assertExpression !== undefined) {
      const actualType = inferExpressionType(invariant.assertExpression, { boundNames: new Set() }, registry);
      assertTypeAssignable("Predicate", actualType, invariant.assertExpression, "<assert>", invariant.id);
    }

    if (invariant.whenExpression !== undefined) {
      const actualType = inferExpressionType(invariant.whenExpression, { boundNames: new Set() }, registry);
      assertTypeAssignable("Predicate", actualType, invariant.whenExpression, "<when>", invariant.id);
    }
  }

  return contract;
}

function inferExpressionType(
  node: AstNode,
  context: TypeContext,
  registry: ReturnType<typeof createCoreOperatorRegistry>,
): SteleType {
  if (node.kind === "list") {
    return inferListType(node, context, registry);
  }

  if (node.kind === "number") {
    return "Number";
  }

  if (node.kind === "string") {
    return "String";
  }

  if (node.kind === "identifier") {
    return context.boundNames.has(node.value) ? "Unknown" : "Symbol";
  }

  return "Symbol";
}

function inferListType(
  node: ListNode,
  context: TypeContext,
  registry: ReturnType<typeof createCoreOperatorRegistry>,
): SteleType {
  const spec = registry.get(node.head);

  if (spec === undefined) {
    throw new SteleError(
      "E0311",
      "Validation Error",
      `Unknown operator "${node.head}".`,
      node.span,
      "The type checker only knows operators from the registered operator table.",
      "Register the operator before using it or fix the operator name.",
    );
  }

  validateArity(spec, node);

  if (isQuantifier(spec.name)) {
    return inferQuantifierType(node, context, registry);
  }

  for (const [index, argument] of node.items.entries()) {
    const expectedType = getExpectedArgumentType(spec, index);
    const actualType = inferExpressionType(argument, context, registry);
    assertTypeAssignable(expectedType, actualType, argument, spec.name, undefined, index);
  }

  return spec.valueType ?? spec.returnType;
}

function inferQuantifierType(
  node: ListNode,
  context: TypeContext,
  registry: ReturnType<typeof createCoreOperatorRegistry>,
): SteleType {
  const binding = node.items[0]!;
  const collection = node.items[1]!;
  const predicate = node.items[2]!;

  if (binding.kind !== "identifier") {
    throw new SteleError(
      "E0310",
      "Validation Error",
      `Quantifier "${node.head}" must bind an identifier symbol.`,
      binding.span,
      "The first quantifier argument names the element available inside the predicate body.",
      "Replace the binding with an identifier such as txn or item.",
    );
  }

  const collectionType = inferExpressionType(collection, context, registry);
  assertTypeAssignable("Collection", collectionType, collection, node.head, undefined, 1);

  const nextContext: TypeContext = {
    boundNames: new Set(context.boundNames).add(binding.value),
  };

  const predicateType = inferExpressionType(predicate, nextContext, registry);
  assertTypeAssignable("Predicate", predicateType, predicate, node.head, undefined, 2);

  return "Boolean";
}

function validateArity(spec: OperatorSpec, node: ListNode): void {
  const received = node.items.length;

  if (received < spec.minArity) {
    throw new SteleError(
      "E0309",
      "Validation Error",
      formatArityMessage(spec, received),
      node.span,
      `Operator "${spec.name}" received ${received} argument(s).`,
      "Add the missing argument(s) required by the operator signature.",
    );
  }

  if (spec.maxArity !== "variadic" && received > spec.maxArity) {
    throw new SteleError(
      "E0309",
      "Validation Error",
      formatArityMessage(spec, received),
      node.span,
      `Operator "${spec.name}" received ${received} argument(s).`,
      "Remove the extra argument(s) or use a different operator.",
    );
  }
}

function formatArityMessage(spec: OperatorSpec, received: number): string {
  if (spec.maxArity === "variadic") {
    return `Operator "${spec.name}" expects at least ${spec.minArity} arguments but received ${received}.`;
  }

  if (spec.minArity === spec.maxArity) {
    return `Operator "${spec.name}" expects ${spec.minArity} arguments but received ${received}.`;
  }

  return `Operator "${spec.name}" expects between ${spec.minArity} and ${spec.maxArity} arguments but received ${received}.`;
}

function getExpectedArgumentType(spec: OperatorSpec, index: number): SteleType {
  const parameter = spec.parameters[index] ?? spec.parameters[spec.parameters.length - 1];

  if (parameter === undefined) {
    return "Unknown";
  }

  return parameter.type;
}

function assertTypeAssignable(
  expectedType: SteleType,
  actualType: SteleType,
  node: AstNode,
  operatorName: string,
  invariantId?: string,
  argumentIndex?: number,
): void {
  if (isTypeAssignable(expectedType, actualType)) {
    return;
  }

  const target = operatorName.startsWith("<")
    ? `Invariant ${operatorName} expression`
    : `Argument ${argumentIndex === undefined ? "?" : argumentIndex + 1} of "${operatorName}"`;
  const invariantDetail = invariantId === undefined ? "" : `Invariant "${invariantId}". `;

  throw new SteleError(
    "E0310",
    "Validation Error",
    `${target}: Expected ${expectedType} but found ${actualType}.`,
    node.span,
    `${invariantDetail}The type checker could prove this mismatch statically.`,
    "Adjust the literal, operator, or surrounding expression so the types line up.",
  );
}

function isTypeAssignable(expectedType: SteleType, actualType: SteleType): boolean {
  if (expectedType === actualType) {
    return true;
  }

  if (expectedType === "Unknown" || actualType === "Unknown") {
    return true;
  }

  if (expectedType === "Predicate" && actualType === "Boolean") {
    return true;
  }

  if (expectedType === "Boolean" && actualType === "Predicate") {
    return true;
  }

  return false;
}

function isQuantifier(name: string): boolean {
  return name === "forall" || name === "exists" || name === "none";
}
