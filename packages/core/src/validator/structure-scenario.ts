import type { AstNode, ListNode } from "../ast/types.js";
import { describeNode, validationError } from "./structure-error.js";
import { ensureFieldUnset, readSingleExpression } from "./structure-shared.js";
import type {
  ScenarioCall,
  ScenarioDeclaration,
  ScenarioExecutor,
  ScenarioOperation,
  ScenarioSandbox,
  ScenarioStepDeclaration,
  ScenarioCaptureStateDeclaration,
} from "./structure-types.js";

export function parseScenarioDeclaration(filePath: string, node: ListNode): ScenarioDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      "Scenario declarations must start with an identifier.",
      node.span,
      "The first scenario item should be the scenario id.",
      'Use a form like (scenario fund-pnl-flow ...).',
    );
  }

  let sandbox: ScenarioSandbox | undefined;
  let executor: ScenarioExecutor | undefined;
  const steps: ScenarioOperation[] = [];

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0317",
        `Scenario "${idNode.value}" contains an unsupported field entry.`,
        field.span,
        "Scenario fields must be nested list forms such as (sandbox transactional) or (step ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (field.head) {
      case "sandbox":
        ensureFieldUnset(sandbox, "sandbox", `Scenario "${idNode.value}" sandbox`, "E0317", field.span);
        sandbox = parseScenarioSandbox(field, idNode.value);
        break;
      case "executor":
        ensureFieldUnset(executor, "executor", `Scenario "${idNode.value}" executor`, "E0317", field.span);
        executor = parseScenarioExecutor(field, idNode.value);
        break;
      case "step":
        steps.push(parseScenarioStep(filePath, field, idNode.value));
        break;
      case "capture-state":
        steps.push(parseScenarioCaptureState(filePath, field, idNode.value));
        break;
      default:
        throw validationError(
          "E0317",
          `Scenario "${idNode.value}" has an unknown field "${field.head}".`,
          field.span,
          'Supported scenario fields are: sandbox, executor, step, capture-state.',
          "Rename or remove this field.",
        );
    }
  }

  if (sandbox === undefined) {
    throw validationError(
      "E0317",
      `Scenario "${idNode.value}" is missing a sandbox field.`,
      node.span,
      "Scenarios must declare which sandbox mode they require.",
      "Add a field such as (sandbox transactional).",
    );
  }

  if (executor === undefined) {
    throw validationError(
      "E0317",
      `Scenario "${idNode.value}" is missing an executor field.`,
      node.span,
      "Scenarios must declare which executor will run their calls.",
      "Add a field such as (executor python-import).",
    );
  }

  if (steps.length === 0) {
    throw validationError(
      "E0317",
      `Scenario "${idNode.value}" must declare at least one step.`,
      node.span,
      "A scenario without steps cannot produce captured state for invariants.",
      "Add one or more (step ...) or (capture-state ...) forms.",
    );
  }

  return {
    kind: "scenario",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    sandbox,
    executor,
    steps,
  };
}

export function parseScenarioSandbox(node: ListNode, scenarioId: string): ScenarioSandbox {
  const sandboxNode = readSingleExpression(node, `Scenario "${scenarioId}" sandbox`, "E0317");

  if (sandboxNode.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" sandbox must be an identifier.`,
      sandboxNode.span,
      `Found ${describeNode(sandboxNode)} instead.`,
      "Use transactional for the v0.1 sandbox mode.",
    );
  }

  if (sandboxNode.value !== "transactional") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" sandbox "${sandboxNode.value}" is not supported.`,
      sandboxNode.span,
      'The Python vertical slice currently supports only (sandbox transactional).',
      "Change the sandbox to transactional for this version.",
    );
  }

  return sandboxNode.value;
}

export function parseScenarioExecutor(node: ListNode, scenarioId: string): ScenarioExecutor {
  const executorNode = readSingleExpression(node, `Scenario "${scenarioId}" executor`, "E0317");

  if (executorNode.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" executor must be an identifier.`,
      executorNode.span,
      `Found ${describeNode(executorNode)} instead.`,
      "Use python-import for the v0.1 executor.",
    );
  }

  if (executorNode.value !== "python-import") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" executor "${executorNode.value}" is not supported.`,
      executorNode.span,
      "The Python vertical slice currently supports only the python-import executor.",
      "Change the executor to python-import for this version.",
    );
  }

  return executorNode.value;
}

export function parseScenarioStep(filePath: string, node: ListNode, scenarioId: string): ScenarioStepDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" step declarations must start with an identifier.`,
      node.span,
      "The first step item should be the step id.",
      'Use a form like (step setup-fund ...).',
    );
  }

  let call: ScenarioCall | undefined;
  let capture: string | undefined;

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0317",
        `Scenario step "${idNode.value}" contains an unsupported field entry.`,
        field.span,
        "Scenario steps may contain call and capture forms.",
        "Replace this item with (call ...) or (capture ...).",
      );
    }

    if (field.head === "call") {
      ensureFieldUnset(call, "call", `Scenario step "${idNode.value}" call`, "E0317", field.span);
      call = parseScenarioCall(field, `Scenario step "${idNode.value}"`);
      continue;
    }

    if (field.head === "capture") {
      if (capture !== undefined) {
        ensureFieldUnset(capture, "capture", `Scenario step "${idNode.value}" capture`, "E0317", field.span);
      }
      capture = parseScenarioCaptureName(field, `Scenario step "${idNode.value}" capture`);
      continue;
    }

    throw validationError(
      "E0317",
      `Scenario step "${idNode.value}" has an unknown field "${field.head}".`,
      field.span,
      "Scenario steps may contain call and capture forms in v0.1.",
      "Rename or remove this field.",
    );
  }

  if (call === undefined) {
    throw validationError(
      "E0317",
      `Scenario step "${idNode.value}" is missing a call field.`,
      node.span,
      "Each scenario step must describe which function to execute.",
      'Add a field such as (call "tests.contract_scenarios:create_fund").',
    );
  }

  return {
    kind: "step",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    call,
    capture,
  };
}

export function parseScenarioCaptureState(filePath: string, node: ListNode, scenarioId: string): ScenarioCaptureStateDeclaration {
  const captureNode = node.items[0];

  if (captureNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" capture-state declarations must start with an identifier.`,
      node.span,
      "The first capture-state item should be the capture id.",
      'Use a form like (capture-state pnl ...).',
    );
  }

  let call: ScenarioCall | undefined;

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0317",
        `Scenario capture-state "${captureNode.value}" contains an unsupported field entry.`,
        field.span,
        "capture-state may only contain a call form in v0.1.",
        "Replace this item with (call ...).",
      );
    }

    if (field.head !== "call") {
      throw validationError(
        "E0317",
        `Scenario capture-state "${captureNode.value}" has an unknown field "${field.head}".`,
        field.span,
        "capture-state may only contain a call form in v0.1.",
        "Rename or remove this field.",
      );
    }

    ensureFieldUnset(call, "call", `Scenario capture-state "${captureNode.value}" call`, "E0317", field.span);
    call = parseScenarioCall(field, `Scenario capture-state "${captureNode.value}"`);
  }

  if (call === undefined) {
    throw validationError(
      "E0317",
      `Scenario capture-state "${captureNode.value}" is missing a call field.`,
      node.span,
      "capture-state must invoke a Python function that returns the captured state.",
      'Add a field such as (call "tests.contract_scenarios:get_pnl" ...).',
    );
  }

  return {
    kind: "capture-state",
    filePath,
    node,
    span: node.span,
    capture: captureNode.value,
    call,
  };
}

export function parseScenarioCall(node: ListNode, label: string): ScenarioCall {
  const targetNode = node.items[0];

  if (targetNode?.kind !== "string") {
    throw validationError(
      "E0317",
      `${label} call target must be a string literal.`,
      targetNode?.span ?? node.span,
      `Found ${targetNode === undefined ? "nothing" : describeNode(targetNode)} instead of a string literal target.`,
      'Use a form like (call "tests.contract_scenarios:create_fund" ...).',
    );
  }

  if (!isValidPythonImportTarget(targetNode.value)) {
    throw validationError(
      "E0317",
      `${label} call target must use "module:function" with non-empty parts.`,
      targetNode.span,
      `Found "${targetNode.value}", which cannot be imported by the python-import executor.`,
      'Use a string like "tests.contract_scenarios:create_fund".',
    );
  }

  let body: AstNode | undefined;

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list" || field.head !== "body") {
      throw validationError(
        "E0317",
        `${label} call has an unsupported field.`,
        field.span,
        "Scenario calls may contain an optional body form after the target string.",
        "Replace this item with (body ...), or remove it.",
      );
    }

    ensureFieldUnset(body, "body", `${label} call body`, "E0317", field.span);
    body = readSingleExpression(field, `${label} call body`, "E0317");
  }

  return {
    node,
    span: node.span,
    target: targetNode.value,
    body,
  };
}

// -- helpers --

function parseScenarioCaptureName(node: ListNode, label: string): string {
  const captureNode = readSingleExpression(node, label, "E0317");

  if (captureNode.kind !== "identifier") {
    throw validationError(
      "E0317",
      `${label} must be an identifier.`,
      captureNode.span,
      `Found ${describeNode(captureNode)} instead.`,
      "Use a simple identifier such as fund or pnl.",
    );
  }

  return captureNode.value;
}

function isValidPythonImportTarget(target: string): boolean {
  const separatorIndex = target.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex !== target.lastIndexOf(":")) {
    return false;
  }

  if (separatorIndex >= target.length - 1) {
    return false;
  }

  const moduleSegment = target.slice(0, separatorIndex);
  const functionPart = target.slice(separatorIndex + 1);

  // Only allow Python-import-safe identifiers for the module segment.
  // This prevents "../exploit:evil" or "os:system" style paths.
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(moduleSegment)) {
    return false;
  }

  // Function segment must be a valid Python identifier
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionPart);
}

