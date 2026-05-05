import type { AstNode, ListNode, SteleType } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import { createCoreOperatorRegistry, type OperatorSpec } from "../registry/operators.js";
import type { Contract } from "./structure.js";

type TypeContext = {
  boundNames: Set<string>;
};

type InferredType = {
  structuralType: SteleType;
  valueType?: SteleType;
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
): InferredType {
  if (node.kind === "list") {
    return inferListType(node, context, registry);
  }

  if (node.kind === "number") {
    return { structuralType: "Number" };
  }

  if (node.kind === "string") {
    return { structuralType: "String" };
  }

  if (node.kind === "identifier") {
    return context.boundNames.has(node.value)
      ? { structuralType: "Symbol", valueType: "Unknown" }
      : { structuralType: "Symbol" };
  }

  return { structuralType: "Symbol" };
}

function inferListType(
  node: ListNode,
  context: TypeContext,
  registry: ReturnType<typeof createCoreOperatorRegistry>,
): InferredType {
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

  if (isBindingCollectionPredicateOperator(spec.name)) {
    return inferBindingCollectionPredicateType(node, context, registry, spec);
  }

  const argumentTypes = node.items.map((argument) => inferExpressionType(argument, context, registry));

  for (const [index, argument] of node.items.entries()) {
    const expectedType = getExpectedArgumentType(spec, index);
    const actualType = argumentTypes[index]!;
    assertTypeAssignable(expectedType, actualType, argument, spec.name, undefined, index);
  }

  if (spec.name === "eq" || spec.name === "neq") {
    assertEqualityOperandCompatibility(spec.name, argumentTypes[0]!, node.items[0]!, argumentTypes[1]!, node.items[1]!);
  }

  return {
    structuralType: spec.returnType,
    valueType: spec.valueType,
  };
}

function inferBindingCollectionPredicateType(
  node: ListNode,
  context: TypeContext,
  registry: ReturnType<typeof createCoreOperatorRegistry>,
  spec: OperatorSpec,
): InferredType {
  const binding = node.items[0]!;
  const collection = node.items[1]!;
  const predicate = node.items[2]!;
  const operatorLabel = spec.name === "where" ? 'Operator "where"' : `Quantifier "${node.head}"`;

  if (binding.kind !== "identifier") {
    throw new SteleError(
      "E0310",
      "Validation Error",
      `${operatorLabel} must bind an identifier symbol.`,
      binding.span,
      `The first ${spec.name === "where" ? "where" : "quantifier"} argument names the element available inside the predicate body.`,
      "Replace the binding with an identifier such as txn or item.",
    );
  }

  const collectionType = inferExpressionType(collection, context, registry);
  assertCollectionArgument(node.head, collectionType, collection);

  const nextContext: TypeContext = {
    boundNames: new Set(context.boundNames).add(binding.value),
  };

  const predicateType = inferExpressionType(predicate, nextContext, registry);
  assertTypeAssignable("Predicate", predicateType, predicate, node.head, undefined, 2);

  return { structuralType: spec.returnType, valueType: spec.valueType };
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
  actualType: InferredType,
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
    `${target}: Expected ${expectedType} but found ${actualType.structuralType}.`,
    node.span,
    `${invariantDetail}The type checker could prove this mismatch statically.`,
    "Adjust the literal, operator, or surrounding expression so the types line up.",
  );
}

function assertCollectionArgument(operatorName: string, actualType: InferredType, node: AstNode): void {
  if (isTypeAssignable("Collection", actualType)) {
    return;
  }

  if (actualType.structuralType === "Path" && node.kind === "list" && node.head === "path") {
    throw new SteleError(
      "E0310",
      "Validation Error",
      `Argument 2 of "${operatorName}": Expected Collection but found Path. ${formatPathAsCollectionHint(node)}`,
      node.span,
      "The collection operand iterates over a named collection from stele_context. A path expression reads a scalar/value path.",
      "Use (collection name) for collection operands, and keep (path ...) for item fields and scalar values.",
    );
  }

  assertTypeAssignable("Collection", actualType, node, operatorName, undefined, 1);
}

function isTypeAssignable(expectedType: SteleType, actualType: InferredType): boolean {
  if (expectedType === actualType.structuralType) {
    return true;
  }

  if (expectedType === "Unknown") {
    return true;
  }

  if (expectedType === "Predicate" && actualType.structuralType === "Boolean") {
    return true;
  }

  if (expectedType === "Boolean" && actualType.structuralType === "Predicate") {
    return true;
  }

  if (isValueSlotType(expectedType) && isUnknownValue(actualType)) {
    return true;
  }

  return false;
}

function isBindingCollectionPredicateOperator(name: string): boolean {
  return name === "forall" || name === "exists" || name === "none" || name === "where";
}

function formatPathAsCollectionHint(node: ListNode): string {
  const pathText = formatSimplePathExpression(node);
  const first = node.items[0];

  if (node.items.length === 1 && first?.kind === "identifier") {
    return `Use (collection ${first.value}) instead of ${pathText}.`;
  }

  return `Use (collection name) for a top-level collection instead of ${pathText}.`;
}

function formatSimplePathExpression(node: ListNode): string {
  const parts = node.items.map((item) => {
    if (item.kind === "identifier") {
      return item.value;
    }

    if (item.kind === "keyword") {
      return `:${item.value}`;
    }

    return item.kind;
  });

  return `(path ${parts.join(" ")})`;
}

function assertEqualityOperandCompatibility(
  operatorName: "eq" | "neq",
  leftType: InferredType,
  leftNode: AstNode,
  rightType: InferredType,
  rightNode: AstNode,
): void {
  if (isUnknownValue(leftType) || isUnknownValue(rightType)) {
    return;
  }

  if (areEquivalentKnownTypes(leftType.structuralType, rightType.structuralType)) {
    return;
  }

  throw new SteleError(
    "E0310",
    "Validation Error",
    `Operands of "${operatorName}" must have matching types, but found ${leftType.structuralType} and ${rightType.structuralType}.`,
    rightNode.span,
    "Equality and inequality only reject cases where both operand types are statically known and incompatible.",
    "Use operands with matching known types, or compare against a value whose type is not statically fixed.",
  );
}

function isUnknownValue(type: InferredType): boolean {
  return type.structuralType === "Unknown" || type.valueType === "Unknown";
}

function isValueSlotType(type: SteleType): boolean {
  return type !== "Collection" && type !== "Path" && type !== "Symbol" && type !== "TimeRange";
}

function areEquivalentKnownTypes(left: SteleType, right: SteleType): boolean {
  return left === right || (left === "Boolean" && right === "Predicate") || (left === "Predicate" && right === "Boolean");
}
