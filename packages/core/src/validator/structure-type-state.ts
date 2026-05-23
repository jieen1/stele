import { compilePattern } from "@stele/call-graph-core";
import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import { describeNode, validationError } from "./structure-error.js";
import { ensureFieldUnset } from "./structure-shared.js";
import { isFixHintActionable } from "./structure-trace-policy.js";

/**
 * One `(transition (from ...) (via ...) (to ...))` entry.
 *
 * `from` is always a list — Round 1 N-4 sugar allows
 * `(from A B) (via cancel) (to Cancelled)` as a single declaration that
 * expands to one logical transition per source. We keep the list shape so
 * downstream consumers can expand or report as needed.
 *
 * @see docs/design/phase-b/03-type-state.md
 */
export interface TypeStateTransition {
  readonly from: readonly string[];
  readonly via: string;
  readonly to: string;
  readonly span: SourceSpan;
}

/**
 * One `(state-type-mapping <state> "<path>::<TypeName>" ...)` entry.
 * Used for Go separate-types representation (B.3).
 */
export interface TypeStateMapping {
  readonly state: string;
  readonly target: string;
  readonly span: SourceSpan;
}

export interface TypeStateDeclaration {
  readonly kind: "type-state";
  readonly filePath: string;
  readonly node: ListNode;
  readonly span: SourceSpan;
  readonly id: string;
  readonly target: string;
  readonly description?: string;
  readonly severity: "error" | "warning";
  readonly states: readonly string[];
  readonly initial: string;
  readonly terminal: readonly string[];
  readonly stateTypeMapping: readonly TypeStateMapping[];
  readonly transitions: readonly TypeStateTransition[];
  readonly allowedOps: ReadonlyMap<string, readonly string[]>;
  readonly fixHint?: string;
}

export interface TypeStateBindingParam {
  readonly index: number;
  readonly state: string;
  readonly span: SourceSpan;
}

export interface TypeStateBindingDeclaration {
  readonly kind: "type-state-binding";
  readonly filePath: string;
  readonly node: ListNode;
  readonly span: SourceSpan;
  readonly function: string;
  readonly params: readonly TypeStateBindingParam[];
}

const CODE_MISSING_ID = "E0340";
const CODE_BAD_TARGET = "E0342";
const CODE_EMPTY_STATES = "E0343";
const CODE_BAD_INITIAL = "E0344";
const CODE_BAD_TERMINAL = "E0345";
const CODE_BAD_TRANSITION_STATE = "E0346";
const CODE_BAD_ALLOWED_OPS_STATE = "E0347";
const CODE_TERMINAL_IN_FROM = "E0348";
const CODE_UNKNOWN_FIELD = "E0349";

const KNOWN_FIELDS = new Set([
  "description",
  "severity",
  "target",
  "states",
  "initial",
  "terminal",
  "state-type-mapping",
  "transition",
  "allowed-ops",
  "fix-hint",
]);

const KNOWN_BINDING_FIELDS = new Set(["function", "param"]);

/**
 * Parse a `(type-state ...)` top-level form. Throws SteleError on E0340-E0349.
 *
 * Duplicate-id and duplicate-target checks happen in
 * `uniqueness.ts` (cross-file), not here.
 */
export function parseTypeStateDeclaration(
  filePath: string,
  node: ListNode,
): TypeStateDeclaration {
  const idNode = node.items[0];

  if (idNode === undefined || (idNode.kind !== "identifier" && idNode.kind !== "string")) {
    throw validationError(
      CODE_MISSING_ID,
      "Type-state declarations must start with an identifier or string id.",
      node.span,
      "The first item of a type-state form is the state machine id.",
      "Use a form like (type-state ORDER_LIFECYCLE ...).",
    );
  }

  const id = idNode.value;
  let description: string | undefined;
  let severity: "error" | "warning" | undefined;
  let target: string | undefined;
  let states: readonly string[] | undefined;
  let initial: string | undefined;
  let terminal: readonly string[] | undefined;
  let fixHint: string | undefined;
  const stateTypeMapping: TypeStateMapping[] = [];
  const transitions: TypeStateTransition[] = [];
  const allowedOpsMap = new Map<string, string[]>();
  const allowedOpsDeclared = new Set<string>();

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Type-state "${id}" contains an unsupported entry.`,
        item.span,
        `Found ${describeNode(item)} where a (field ...) list was expected.`,
        "Wrap this entry in a supported field list.",
      );
    }

    if (!KNOWN_FIELDS.has(item.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Type-state "${id}" has an unknown field "${item.head}".`,
        item.span,
        "Supported type-state fields are: description, severity, target, states, initial, terminal, state-type-mapping, transition, allowed-ops, fix-hint.",
        "Rename or remove this field.",
      );
    }

    switch (item.head) {
      case "description": {
        ensureFieldUnset(description, "description", `Type-state "${id}" description`, CODE_UNKNOWN_FIELD, item.span);
        description = readSingleStringField(item, `Type-state "${id}" description`, CODE_UNKNOWN_FIELD);
        break;
      }
      case "severity": {
        ensureFieldUnset(severity, "severity", `Type-state "${id}" severity`, CODE_UNKNOWN_FIELD, item.span);
        const value = readSingleStringField(item, `Type-state "${id}" severity`, CODE_UNKNOWN_FIELD);
        if (value !== "error" && value !== "warning") {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            `Type-state "${id}" severity must be "error" or "warning".`,
            item.span,
            `Found "${value}".`,
            'Use (severity "error") or (severity "warning").',
          );
        }
        severity = value;
        break;
      }
      case "target": {
        ensureFieldUnset(target, "target", `Type-state "${id}" target`, CODE_UNKNOWN_FIELD, item.span);
        target = readTargetField(item, id);
        break;
      }
      case "states": {
        ensureFieldUnset(states, "states", `Type-state "${id}" states`, CODE_UNKNOWN_FIELD, item.span);
        states = readSymbolList(item, id, "states", CODE_EMPTY_STATES);
        if (states.length === 0) {
          throw validationError(
            CODE_EMPTY_STATES,
            `Type-state "${id}" states must contain at least one state.`,
            item.span,
            "The states field was declared but empty.",
            "List one or more state names inside (states ...).",
          );
        }
        break;
      }
      case "initial": {
        ensureFieldUnset(initial, "initial", `Type-state "${id}" initial`, CODE_UNKNOWN_FIELD, item.span);
        initial = readSingleSymbolField(item, `Type-state "${id}" initial`, CODE_BAD_INITIAL);
        break;
      }
      case "terminal": {
        ensureFieldUnset(terminal, "terminal", `Type-state "${id}" terminal`, CODE_UNKNOWN_FIELD, item.span);
        terminal = readSymbolList(item, id, "terminal", CODE_BAD_TERMINAL);
        break;
      }
      case "state-type-mapping": {
        stateTypeMapping.push(...parseStateTypeMappingEntry(item, id));
        break;
      }
      case "transition": {
        transitions.push(...parseTransitionEntry(item, id));
        break;
      }
      case "allowed-ops": {
        const entry = parseAllowedOpsEntry(item, id);
        if (allowedOpsDeclared.has(entry.state)) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            `Type-state "${id}" declares (allowed-ops ${entry.state} ...) more than once.`,
            item.span,
            "Each state may have at most one allowed-ops entry.",
            "Merge the two allowed-ops lists for this state.",
          );
        }
        allowedOpsDeclared.add(entry.state);
        allowedOpsMap.set(entry.state, [...entry.ops]);
        break;
      }
      case "fix-hint": {
        ensureFieldUnset(fixHint, "fix-hint", `Type-state "${id}" fix-hint`, CODE_UNKNOWN_FIELD, item.span);
        const value = readSingleStringField(item, `Type-state "${id}" fix-hint`, CODE_UNKNOWN_FIELD);
        if (!isFixHintActionable(value)) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            `Type-state "${id}" fix-hint is too vague to be actionable.`,
            item.span,
            'A fix-hint must reference code (e.g. `Order.submit`) or a file:line location (e.g. "src/order.ts:42").',
            "Quote a code symbol with backticks or cite the file and line where the fix should be applied.",
          );
        }
        fixHint = value;
        break;
      }
      default:
        throw validationError(
          CODE_UNKNOWN_FIELD,
          `Type-state "${id}" has an unknown field "${item.head}".`,
          item.span,
          "This field is not recognised.",
          "Rename or remove this field.",
        );
    }
  }

  if (target === undefined) {
    throw validationError(
      CODE_BAD_TARGET,
      `Type-state "${id}" must declare a (target "<path>::<TypeName>") or NodeId glob.`,
      node.span,
      "The target field is required.",
      'Add (target "src/models/order.ts::Order").',
    );
  }

  if (states === undefined || states.length === 0) {
    throw validationError(
      CODE_EMPTY_STATES,
      `Type-state "${id}" must declare a non-empty (states ...) field.`,
      node.span,
      "Every type-state form needs at least one state.",
      "Add (states Draft Submitted ...).",
    );
  }

  if (initial === undefined) {
    throw validationError(
      CODE_BAD_INITIAL,
      `Type-state "${id}" must declare an (initial <state>) field.`,
      node.span,
      "The initial field is required.",
      "Add (initial Draft).",
    );
  }

  const stateSet = new Set(states);

  if (!stateSet.has(initial)) {
    throw validationError(
      CODE_BAD_INITIAL,
      `Type-state "${id}" initial state "${initial}" is not in (states ...).`,
      node.span,
      `States declared: ${states.join(", ")}.`,
      `Add "${initial}" to (states ...) or change (initial ...) to a declared state.`,
    );
  }

  const terminalList = terminal ?? [];
  for (const state of terminalList) {
    if (!stateSet.has(state)) {
      throw validationError(
        CODE_BAD_TERMINAL,
        `Type-state "${id}" terminal contains non-state "${state}".`,
        node.span,
        `States declared: ${states.join(", ")}.`,
        `Add "${state}" to (states ...) or remove it from (terminal ...).`,
      );
    }
  }
  const terminalSet = new Set(terminalList);

  if (transitions.length === 0) {
    // No required minimum number of transitions per the spec, but we still
    // need to validate any that were declared.
  }

  for (const transition of transitions) {
    for (const fromState of transition.from) {
      if (!stateSet.has(fromState)) {
        throw validationError(
          CODE_BAD_TRANSITION_STATE,
          `Type-state "${id}" transition.from contains non-state "${fromState}".`,
          transition.span,
          `States declared: ${states.join(", ")}.`,
          `Add "${fromState}" to (states ...) or fix the transition.`,
        );
      }
      if (terminalSet.has(fromState)) {
        throw validationError(
          CODE_TERMINAL_IN_FROM,
          `Type-state "${id}" terminal state "${fromState}" appears in (transition (from ...) ...).`,
          transition.span,
          "Terminal states cannot be the source of any transition.",
          `Remove "${fromState}" from (terminal ...) or remove this transition.`,
        );
      }
    }
    if (!stateSet.has(transition.to)) {
      throw validationError(
        CODE_BAD_TRANSITION_STATE,
        `Type-state "${id}" transition.to "${transition.to}" is not in (states ...).`,
        transition.span,
        `States declared: ${states.join(", ")}.`,
        `Add "${transition.to}" to (states ...) or fix the transition.`,
      );
    }
  }

  for (const [state] of allowedOpsMap.entries()) {
    if (!stateSet.has(state)) {
      throw validationError(
        CODE_BAD_ALLOWED_OPS_STATE,
        `Type-state "${id}" (allowed-ops ${state} ...) references a state not in (states ...).`,
        node.span,
        `States declared: ${states.join(", ")}.`,
        `Add "${state}" to (states ...) or remove this allowed-ops entry.`,
      );
    }
  }

  const allowedOps: ReadonlyMap<string, readonly string[]> = new Map(
    Array.from(allowedOpsMap.entries(), ([state, ops]) => [state, [...ops]]),
  );

  return {
    kind: "type-state",
    filePath,
    node,
    span: node.span,
    id,
    target,
    description,
    severity: severity ?? "error",
    states,
    initial,
    terminal: terminalList,
    stateTypeMapping,
    transitions,
    allowedOps,
    fixHint,
  };
}

/**
 * Parse a `(type-state-binding ...)` top-level form. Throws SteleError on
 * E0349 for any malformed shape. Per Round 2 synthesis, this form reuses
 * E0349 for all binding errors to avoid encroaching on the effect range
 * (E0350-E0359).
 */
export function parseTypeStateBindingDeclaration(
  filePath: string,
  node: ListNode,
): TypeStateBindingDeclaration {
  let functionId: string | undefined;
  const params: TypeStateBindingParam[] = [];
  const seenIndices = new Set<number>();

  for (const item of node.items) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        "Type-state-binding contains an unsupported entry.",
        item.span,
        `Found ${describeNode(item)} where a (field ...) list was expected.`,
        "Wrap this entry in a (function ...) or (param ...) list.",
      );
    }

    if (!KNOWN_BINDING_FIELDS.has(item.head)) {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Type-state-binding has an unknown field "${item.head}".`,
        item.span,
        "Supported type-state-binding fields are: function, param.",
        "Rename or remove this field.",
      );
    }

    switch (item.head) {
      case "function": {
        ensureFieldUnset(functionId, "function", "Type-state-binding function", CODE_UNKNOWN_FIELD, item.span);
        const value = readSingleStringField(item, "Type-state-binding function", CODE_UNKNOWN_FIELD);
        if (value.trim().length === 0) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            "Type-state-binding function must be a non-empty NodeId string.",
            item.span,
            "Empty function NodeId cannot resolve to any frame.",
            'Provide a NodeId such as "src/order/handler.ts::OrderHandler::process(1)".',
          );
        }
        functionId = value;
        break;
      }
      case "param": {
        const param = parseBindingParamEntry(item);
        if (seenIndices.has(param.index)) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            `Type-state-binding declares param index ${param.index} more than once.`,
            item.span,
            "Each parameter index may appear at most once.",
            "Remove the duplicate (param ...) clause.",
          );
        }
        seenIndices.add(param.index);
        params.push(param);
        break;
      }
      default:
        throw validationError(
          CODE_UNKNOWN_FIELD,
          `Type-state-binding has an unknown field "${item.head}".`,
          item.span,
          "This field is not recognised.",
          "Rename or remove this field.",
        );
    }
  }

  if (functionId === undefined) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Type-state-binding must declare a (function \"<NodeId>\") field.",
      node.span,
      "The function field is required.",
      'Add (function "src/order/handler.ts::OrderHandler::process(1)").',
    );
  }

  if (params.length === 0) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Type-state-binding must declare at least one (param <index> state <state>) clause.",
      node.span,
      "A binding without any parameter annotation imposes no rule.",
      "Add (param 0 state Submitted) or similar.",
    );
  }

  return {
    kind: "type-state-binding",
    filePath,
    node,
    span: node.span,
    function: functionId,
    params,
  };
}

function parseBindingParamEntry(item: ListNode): TypeStateBindingParam {
  // Expected shape: (param <index> state <state>)
  if (item.items.length !== 3) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Type-state-binding (param ...) clause expects 3 items: <index> state <state>.",
      item.span,
      `Found ${item.items.length} item(s) inside (param ...).`,
      "Use (param 0 state Submitted).",
    );
  }

  const indexNode = item.items[0]!;
  const stateKeywordNode = item.items[1]!;
  const stateNode = item.items[2]!;

  if (indexNode.kind !== "number" || !Number.isInteger(indexNode.value) || indexNode.value < 0) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Type-state-binding (param ...) index must be a non-negative integer.",
      indexNode.span,
      `Found ${describeNode(indexNode)}.`,
      "Use a non-negative integer such as 0, 1, 2.",
    );
  }

  if (stateKeywordNode.kind !== "identifier" || stateKeywordNode.value !== "state") {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Type-state-binding (param ...) must use the keyword 'state'.",
      stateKeywordNode.span,
      `Found ${describeNode(stateKeywordNode)} where 'state' was expected.`,
      "Use (param <index> state <state-name>).",
    );
  }

  if (stateNode.kind !== "identifier" && stateNode.kind !== "string") {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Type-state-binding (param ...) state must be an identifier or string.",
      stateNode.span,
      `Found ${describeNode(stateNode)}.`,
      "Provide a state name as identifier (Submitted) or string (\"Submitted\").",
    );
  }

  const stateValue = stateNode.value;
  if (stateValue.trim().length === 0) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      "Type-state-binding (param ...) state must be a non-empty string.",
      stateNode.span,
      "Empty state names cannot resolve to any declared state.",
      "Provide a non-empty state name.",
    );
  }

  return {
    index: indexNode.value,
    state: stateValue,
    span: item.span,
  };
}

function parseTransitionEntry(item: ListNode, id: string): TypeStateTransition[] {
  let fromStates: string[] | undefined;
  let via: string | undefined;
  let to: string | undefined;

  for (const child of item.items) {
    if (child.kind !== "list") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Type-state "${id}" (transition ...) contains an unsupported entry.`,
        child.span,
        `Found ${describeNode(child)} where (from ...), (via ...), or (to ...) was expected.`,
        "Wrap this entry in a supported clause.",
      );
    }

    switch (child.head) {
      case "from": {
        if (fromStates !== undefined) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            `Type-state "${id}" (transition ...) declares (from ...) more than once.`,
            child.span,
            "Each transition has exactly one (from ...) clause.",
            "Merge the source states into a single (from A B ...) clause.",
          );
        }
        fromStates = readSymbolListItems(child, `Type-state "${id}" transition.from`, CODE_BAD_TRANSITION_STATE);
        if (fromStates.length === 0) {
          throw validationError(
            CODE_BAD_TRANSITION_STATE,
            `Type-state "${id}" transition.from must list at least one state.`,
            child.span,
            "Empty (from) is not allowed.",
            "Add one or more state names.",
          );
        }
        break;
      }
      case "via": {
        if (via !== undefined) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            `Type-state "${id}" (transition ...) declares (via ...) more than once.`,
            child.span,
            "Each transition has exactly one (via ...) clause.",
            "Keep a single (via <method>) clause.",
          );
        }
        via = readSingleSymbolField(child, `Type-state "${id}" transition.via`, CODE_UNKNOWN_FIELD);
        break;
      }
      case "to": {
        if (to !== undefined) {
          throw validationError(
            CODE_UNKNOWN_FIELD,
            `Type-state "${id}" (transition ...) declares (to ...) more than once.`,
            child.span,
            "Each transition has exactly one (to ...) clause.",
            "Keep a single (to <state>) clause.",
          );
        }
        to = readSingleSymbolField(child, `Type-state "${id}" transition.to`, CODE_BAD_TRANSITION_STATE);
        break;
      }
      default:
        throw validationError(
          CODE_UNKNOWN_FIELD,
          `Type-state "${id}" (transition ...) has an unknown clause "${child.head}".`,
          child.span,
          "Supported transition clauses are: from, via, to.",
          "Rename or remove this clause.",
        );
    }
  }

  if (fromStates === undefined) {
    throw validationError(
      CODE_BAD_TRANSITION_STATE,
      `Type-state "${id}" (transition ...) is missing (from ...).`,
      item.span,
      "Each transition must declare its source state(s).",
      "Add (from <state>).",
    );
  }
  if (via === undefined) {
    throw validationError(
      CODE_UNKNOWN_FIELD,
      `Type-state "${id}" (transition ...) is missing (via ...).`,
      item.span,
      "Each transition must declare the method/operation that triggers it.",
      "Add (via <method>).",
    );
  }
  if (to === undefined) {
    throw validationError(
      CODE_BAD_TRANSITION_STATE,
      `Type-state "${id}" (transition ...) is missing (to ...).`,
      item.span,
      "Each transition must declare its target state.",
      "Add (to <state>).",
    );
  }

  // Multi-source sugar (Round 1 N-4): keep the from list intact and emit a
  // single transition per logical declaration so callers can reason about
  // the original CDL source while still iterating per from-state.
  return [
    {
      from: [...fromStates],
      via,
      to,
      span: item.span,
    },
  ];
}

function parseAllowedOpsEntry(item: ListNode, id: string): { state: string; ops: string[] } {
  if (item.items.length < 2) {
    throw validationError(
      CODE_BAD_ALLOWED_OPS_STATE,
      `Type-state "${id}" (allowed-ops ...) expects <state> <method> [<method> ...].`,
      item.span,
      `Found ${item.items.length} item(s) inside (allowed-ops ...).`,
      "Use (allowed-ops Draft addItem submit).",
    );
  }

  const stateNode = item.items[0]!;
  if (stateNode.kind !== "identifier" && stateNode.kind !== "string") {
    throw validationError(
      CODE_BAD_ALLOWED_OPS_STATE,
      `Type-state "${id}" (allowed-ops ...) state must be an identifier or string.`,
      stateNode.span,
      `Found ${describeNode(stateNode)}.`,
      "Use a state name as identifier (Draft) or string (\"Draft\").",
    );
  }

  const ops: string[] = [];
  for (const opNode of item.items.slice(1)) {
    if (opNode.kind !== "identifier" && opNode.kind !== "string") {
      throw validationError(
        CODE_UNKNOWN_FIELD,
        `Type-state "${id}" (allowed-ops ...) methods must be identifiers or strings.`,
        opNode.span,
        `Found ${describeNode(opNode)}.`,
        "Use method names as identifiers or strings.",
      );
    }
    ops.push(opNode.value);
  }

  return { state: stateNode.value, ops };
}

function parseStateTypeMappingEntry(item: ListNode, id: string): TypeStateMapping[] {
  if (item.items.length === 0 || item.items.length % 2 !== 0) {
    throw validationError(
      CODE_BAD_TARGET,
      `Type-state "${id}" (state-type-mapping ...) expects pairs of <state> "<path>::<TypeName>".`,
      item.span,
      `Found ${item.items.length} item(s); a mapping has 2 items per state.`,
      'Use (state-type-mapping Draft "src/order.ts::DraftOrder" Submitted "src/order.ts::SubmittedOrder").',
    );
  }

  const mappings: TypeStateMapping[] = [];
  for (let i = 0; i < item.items.length; i += 2) {
    const stateNode = item.items[i]!;
    const targetNode = item.items[i + 1]!;

    if (stateNode.kind !== "identifier" && stateNode.kind !== "string") {
      throw validationError(
        CODE_BAD_TARGET,
        `Type-state "${id}" (state-type-mapping ...) state must be an identifier or string.`,
        stateNode.span,
        `Found ${describeNode(stateNode)}.`,
        "Use a state name as identifier or string.",
      );
    }

    if (targetNode.kind !== "string") {
      throw validationError(
        CODE_BAD_TARGET,
        `Type-state "${id}" (state-type-mapping ...) target must be a string literal.`,
        targetNode.span,
        `Found ${describeNode(targetNode)}.`,
        'Provide the target as a string such as "src/order.ts::DraftOrder".',
      );
    }

    validateTargetSyntax(targetNode.value, targetNode.span, `Type-state "${id}" state-type-mapping`);
    mappings.push({ state: stateNode.value, target: targetNode.value, span: item.span });
  }

  return mappings;
}

function readTargetField(item: ListNode, id: string): string {
  if (item.items.length !== 1) {
    throw validationError(
      CODE_BAD_TARGET,
      `Type-state "${id}" (target ...) expects exactly one value.`,
      item.span,
      `Found ${item.items.length} value(s).`,
      'Use (target "src/order.ts::Order") or (target "src/order/**::Order").',
    );
  }

  const value = item.items[0]!;
  if (value.kind !== "string") {
    throw validationError(
      CODE_BAD_TARGET,
      `Type-state "${id}" (target ...) must be a string literal.`,
      value.span,
      `Found ${describeNode(value)}.`,
      'Wrap the target in double quotes.',
    );
  }

  validateTargetSyntax(value.value, value.span, `Type-state "${id}" target`);
  return value.value;
}

/**
 * Validate the target string. Accepts either a `path::TypeName` form or a
 * NodeId glob (any pattern compilePattern accepts). We use a heuristic: if
 * the pattern contains glob metacharacters (`*`, `?`, `{`, `[`) we route it
 * through compilePattern; otherwise we require it to contain `::` so we
 * don't accept bare paths as targets.
 */
function validateTargetSyntax(value: string, span: SourceSpan, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(
      CODE_BAD_TARGET,
      `${label} must be a non-empty string.`,
      span,
      "Empty or whitespace-only targets do not match any type.",
      'Provide "src/order.ts::Order" or a NodeId glob.',
    );
  }

  if (value.endsWith("::")) {
    throw validationError(
      CODE_BAD_TARGET,
      `${label} has a trailing "::" separator.`,
      span,
      `Target "${value}" is missing the TypeName segment after the final "::".`,
      "Add the TypeName (e.g. \"::Order\") after the last container.",
    );
  }

  if (!value.includes("::")) {
    throw validationError(
      CODE_BAD_TARGET,
      `${label} must be of the form "<path>::<TypeName>" or a NodeId glob.`,
      span,
      `Target "${value}" does not contain a "::" separator.`,
      'Provide a target such as "src/order.ts::Order".',
    );
  }

  const isGlob = /[*?{[\\]/.test(value);
  if (isGlob) {
    // compilePattern throws on syntactically invalid patterns; surface them
    // as E0342 to keep the type-state error range contiguous.
    try {
      compilePattern(value);
    } catch (err) {
      throw validationError(
        CODE_BAD_TARGET,
        `${label} pattern is invalid.`,
        span,
        err instanceof Error ? err.message : String(err),
        "Provide a valid NodeId glob.",
      );
    }
  }
}

function readSymbolList(item: ListNode, id: string, fieldName: string, code: string): readonly string[] {
  return readSymbolListItems(item, `Type-state "${id}" ${fieldName}`, code);
}

function readSymbolListItems(item: ListNode, label: string, code: string): string[] {
  const values: string[] = [];
  for (const child of item.items) {
    if (child.kind !== "identifier" && child.kind !== "string") {
      throw validationError(
        code,
        `${label} entries must be identifiers or strings.`,
        child.span,
        `Found ${describeNode(child)}.`,
        "Use a symbol name as identifier or string.",
      );
    }
    if (child.value.trim().length === 0) {
      throw validationError(
        code,
        `${label} entries must be non-empty.`,
        child.span,
        "Empty state names are not allowed.",
        "Provide a non-empty state name.",
      );
    }
    values.push(child.value);
  }
  return values;
}

function readSingleSymbolField(item: ListNode, label: string, code: string): string {
  if (item.items.length !== 1) {
    throw validationError(
      code,
      `${label} expects exactly one value.`,
      item.span,
      `Found ${item.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }
  const value = item.items[0]!;
  return readSymbolValue(value, label, code);
}

function readSymbolValue(value: AstNode, label: string, code: string): string {
  if (value.kind !== "identifier" && value.kind !== "string") {
    throw validationError(
      code,
      `${label} must be an identifier or string.`,
      value.span,
      `Found ${describeNode(value)}.`,
      "Use a name as identifier or string.",
    );
  }
  if (value.value.trim().length === 0) {
    throw validationError(
      code,
      `${label} must be a non-empty string.`,
      value.span,
      "Empty values are not allowed here.",
      "Provide a non-empty name.",
    );
  }
  return value.value;
}

function readSingleStringField(node: ListNode, label: string, code: string): string {
  if (node.items.length !== 1) {
    throw validationError(
      code,
      `${label} expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }
  const value = node.items[0]!;
  if (value.kind !== "string") {
    throw validationError(
      code,
      `${label} must be a string literal.`,
      value.span,
      `Found ${describeNode(value)} instead of a string literal.`,
      "Wrap the value in double quotes.",
    );
  }
  return value.value;
}
