import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import type {
  AgentDeclaration,
  AgentSingleValueField,
  ConflictDeclaration,
  ConflictResolutionStrategy,
  InterAgentContractDeclaration,
  RequiresClause,
  ScopeDeclaration,
} from "./structure-types.js";
import { validationError } from "./structure-error.js";
import { ensureFieldUnset } from "./structure-shared.js";

// -- Agent declaration --

export function parseAgentDeclaration(filePath: string, node: ListNode): AgentDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "string" && idNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      "Agent declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the agent id.",
      'Use a form like (agent "code-reviewer" ...).',
    );
  }

  let description: AgentSingleValueField | undefined;
  const allowedPaths: string[] = [];
  const deniedPaths: string[] = [];

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        "E0317",
        `Agent "${idNode.value}" contains an unsupported field entry.`,
        item.span,
        "Agent fields must be nested list forms such as (allowed-paths ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "description":
        ensureFieldUnset(description, "description", `Agent "${idNode.value}" description`, "E0317", item.span);
        description = readSingleValueField(item, "description");
        break;
      case "allowed-paths":
        allowedPaths.push(...readStringList(item, `Agent "${idNode.value}" allowed-paths`));
        break;
      case "denied-paths":
        deniedPaths.push(...readStringList(item, `Agent "${idNode.value}" denied-paths`));
        break;
      default:
        throw validationError(
          "E0317",
          `Agent "${idNode.value}" has an unknown field "${item.head}".`,
          item.span,
          "Supported agent fields are: description, allowed-paths, denied-paths.",
          "Rename or remove this field.",
        );
    }
  }

  return {
    kind: "agent",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    description,
    allowedPaths,
    deniedPaths,
  };
}

// -- Scope declaration --

export function parseScopeDeclaration(filePath: string, node: ListNode): ScopeDeclaration {
  const agentIdNode = node.items[0];

  if (agentIdNode?.kind !== "string" && agentIdNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      "Scope declarations must start with an agent identifier or string.",
      node.span,
      "The first item should be the agent id.",
      'Use a form like (scope "agent-name" ...).',
    );
  }

  const paths: string[] = [];

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list" || item.head !== "path") {
      throw validationError(
        "E0317",
        `Scope "${agentIdNode.value}" contains an unsupported field entry.`,
        item.span,
        "Scope bodies must contain (path ...) forms.",
        'Use a form like (scope "agent" (path "src/**")).',
      );
    }

    const pathItem = item.items[0];
    if (pathItem?.kind !== "string") {
      throw validationError(
        "E0317",
        `Scope "${agentIdNode.value}" has a path that is not a string.`,
        item.span,
        "Path entries must be string literals.",
        'Use a form like (path "src/**").',
      );
    }

    paths.push(pathItem.value);
  }

  if (paths.length === 0) {
    throw validationError(
      "E0317",
      `Scope "${agentIdNode.value}" must declare at least one path.`,
      node.span,
      "Scope declarations need at least one (path ...) form.",
      'Add a path like (path "src/**").',
    );
  }

  return {
    kind: "scope",
    filePath,
    node,
    span: node.span,
    agentId: agentIdNode.value,
    paths,
  };
}

// -- Inter-agent contract declaration --

export function parseInterAgentContractDeclaration(filePath: string, node: ListNode): InterAgentContractDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "string" && idNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      "Inter-agent contract declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the contract id.",
      'Use a form like (inter-agent-contract "review-before-merge" ...).',
    );
  }

  let description: AgentSingleValueField | undefined;
  const agents: string[] = [];
  const requires: RequiresClause[] = [];
  let requiresClauseSeen = false;

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        "E0317",
        `Inter-agent contract "${idNode.value}" contains an unsupported field entry.`,
        item.span,
        "Inter-agent contract fields must be nested list forms.",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "description":
        ensureFieldUnset(description, "description", `Inter-agent contract "${idNode.value}" description`, "E0317", item.span);
        description = readSingleValueField(item, "description");
        break;
      case "agents":
        agents.push(...readStringList(item, `Inter-agent contract "${idNode.value}" agents`));
        break;
      case "requires": {
        if (requiresClauseSeen) {
          throw validationError(
            "E0317",
            `Inter-agent contract "${idNode.value}" requires may only be declared once.`,
            item.span,
            "This field already appeared earlier in the same declaration.",
            "Merge the values into one field.",
          );
        }
        requiresClauseSeen = true;
        requires.push(parseRequiresClause(item));
        break;
      }
      default:
        throw validationError(
          "E0317",
          `Inter-agent contract "${idNode.value}" has an unknown field "${item.head}".`,
          item.span,
          "Supported inter-agent contract fields are: description, agents, requires.",
          "Rename or remove this field.",
        );
    }
  }

  if (agents.length === 0) {
    throw validationError(
      "E0317",
      `Inter-agent contract "${idNode.value}" must declare at least one agent.`,
      node.span,
      "Inter-agent contracts need at least one agent.",
      'Add an agent like (agents "reviewer" "writer").',
    );
  }

  if (requires.length === 0) {
    throw validationError(
      "E0317",
      `Inter-agent contract "${idNode.value}" must declare at least one requirement.`,
      node.span,
      "Inter-agent contracts need at least one (requires ...) clause.",
      'Add a requirement like (requires "reviewer" (path "src/**") approved-by "reviewer").',
    );
  }

  return {
    kind: "inter-agent-contract",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    agents,
    requires,
    description,
  };
}

// -- Conflict declaration --

export function parseConflictDeclaration(filePath: string, node: ListNode): ConflictDeclaration {
  const pathNode = node.items[0];

  if (pathNode?.kind !== "list" || pathNode.head !== "path") {
    throw validationError(
      "E0317",
      "Conflict declarations must start with a (path ...) form.",
      node.span,
      "The first item should be the path to protect.",
      'Use a form like (conflict (path "src/core/engine.ts") ...).',
    );
  }

  const pathItem = pathNode.items[0];
  if (pathItem?.kind !== "string") {
    throw validationError(
      "E0317",
      "Conflict path must be a string literal.",
      pathNode.span,
      "Path entries must be string literals.",
      'Use a form like (path "src/core/engine.ts").',
    );
  }

  let resolution: ConflictResolutionStrategy | undefined;
  let fallback: ConflictResolutionStrategy | undefined;
  const agents: string[] = [];

  const VALID_STRATEGIES: ConflictResolutionStrategy[] = [
    "last-writer-wins",
    "manual-review",
    "merge-strategy",
    "contract-gated",
  ];

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        "E0317",
        `Conflict for "${pathItem.value}" contains an unsupported field entry.`,
        item.span,
        "Conflict fields must be nested list forms.",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "agents":
        agents.push(...readStringList(item, `Conflict "${pathItem.value}" agents`));
        break;
      case "resolution": {
        ensureFieldUnset(resolution, "resolution", `Conflict "${pathItem.value}" resolution`, "E0317", item.span);
        const strategy = readSingleString(item, `Conflict "${pathItem.value}" resolution`);
        if (!VALID_STRATEGIES.includes(strategy as ConflictResolutionStrategy)) {
          throw validationError(
            "E0317",
            `Invalid conflict resolution strategy "${strategy}".`,
            item.span,
            `Valid strategies are: ${VALID_STRATEGIES.join(", ")}.`,
            "Use a valid strategy.",
          );
        }
        resolution = strategy as ConflictResolutionStrategy;
        break;
      }
      case "fallback": {
        ensureFieldUnset(fallback, "fallback", `Conflict "${pathItem.value}" fallback`, "E0317", item.span);
        const strategy = readSingleString(item, `Conflict "${pathItem.value}" fallback`);
        if (!VALID_STRATEGIES.includes(strategy as ConflictResolutionStrategy)) {
          throw validationError(
            "E0317",
            `Invalid conflict fallback strategy "${strategy}".`,
            item.span,
            `Valid strategies are: ${VALID_STRATEGIES.join(", ")}.`,
            "Use a valid strategy.",
          );
        }
        fallback = strategy as ConflictResolutionStrategy;
        break;
      }
      default:
        throw validationError(
          "E0317",
          `Conflict for "${pathItem.value}" has an unknown field "${item.head}".`,
          item.span,
          "Supported conflict fields are: agents, resolution, fallback.",
          "Rename or remove this field.",
        );
    }
  }

  if (resolution === undefined) {
    throw validationError(
      "E0317",
      `Conflict for "${pathItem.value}" must declare a resolution strategy.`,
      node.span,
      "Conflict declarations need a (resolution ...) field.",
      'Add a resolution like (resolution "last-writer-wins").',
    );
  }

  return {
    kind: "conflict",
    filePath,
    node,
    span: node.span,
    path: pathItem.value,
    agents,
    resolution,
    fallback,
  };
}

// -- Helpers --

function readSingleValueField(node: ListNode, name: string): AgentSingleValueField {
  if (node.items.length !== 1) {
    throw validationError(
      "E0317",
      `Field "${name}" expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }

  const valueNode = node.items[0]!;
  if (valueNode.kind !== "string" && valueNode.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Field "${name}" must be a string or identifier.`,
      valueNode.span,
      "Expected a string literal or identifier.",
      "Wrap the value in double quotes.",
    );
  }

  return {
    kind: "field",
    name,
    node,
    span: node.span,
    valueNode,
  };
}

function readStringList(node: ListNode, label: string): string[] {
  const result: string[] = [];
  for (const item of node.items) {
    if (item.kind === "string" || item.kind === "identifier") {
      result.push(item.value);
    }
  }
  return result;
}

function readSingleString(node: ListNode, label: string): string {
  if (node.items.length !== 1) {
    throw validationError(
      "E0317",
      `${label} expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }

  const item = node.items[0]!;
  if (item.kind !== "string" && item.kind !== "identifier") {
    throw validationError(
      "E0317",
      `${label} must be a string or identifier.`,
      item.span,
      "Expected a string literal or identifier.",
      "Wrap the value in double quotes.",
    );
  }

  return item.value;
}

function parseRequiresClause(node: ListNode): RequiresClause {
  if (node.items.length < 3) {
    throw validationError(
      "E0317",
      "Requires clause must have at least 3 arguments: agent-id, (path ...), approved-by.",
      node.span,
      "A requires clause specifies which agent must approve changes to a path.",
      'Use a form like (requires "reviewer" (path "src/**") approved-by "reviewer").',
    );
  }

  const agentIdItem = node.items[0];
  if (agentIdItem?.kind !== "string" && agentIdItem?.kind !== "identifier") {
    throw validationError(
      "E0317",
      "Requires clause must start with an agent identifier or string.",
      node.span,
      "The first argument should be the agent id.",
      'Use a form like (requires "reviewer" ...).',
    );
  }

  const pathNode = node.items[1];
  if (pathNode?.kind !== "list" || pathNode.head !== "path") {
    throw validationError(
      "E0317",
      "Requires clause second argument must be a (path ...) form.",
      pathNode?.span ?? node.span,
      "The second argument should be a path pattern.",
      'Use a form like (path "src/**").',
    );
  }

  const pathItem = pathNode.items[0];
  if (pathItem?.kind !== "string") {
    throw validationError(
      "E0317",
      "Requires path must be a string literal.",
      pathNode.span,
      "Path entries must be string literals.",
      'Use a form like (path "src/**").',
    );
  }

  const approvedByNode = node.items[2];
  if (approvedByNode?.kind !== "list" || approvedByNode.head !== "approved-by") {
    throw validationError(
      "E0317",
      "Requires clause third argument must be (approved-by ...) form.",
      approvedByNode?.span ?? node.span,
      "The third argument should specify who approves.",
      'Use a form like (approved-by "reviewer").',
    );
  }

  const approvedById = approvedByNode.items[0];
  if (approvedById?.kind !== "string" && approvedById?.kind !== "identifier") {
    throw validationError(
      "E0317",
      "Approved-by value must be a string or identifier.",
      approvedByNode.span,
      "Expected a string literal or identifier for the approver.",
      'Use a form like (approved-by "reviewer").',
    );
  }

  return {
    agentId: agentIdItem.value,
    pathPattern: pathItem.value,
    approvedBy: approvedById.value,
    span: node.span,
  };
}
