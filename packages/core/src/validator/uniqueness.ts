import { SteleError } from "../errors/SteleError.js";
import type { ArchitectureDeclaration, Contract, CoreNodeDeclaration } from "./structure-types.js";

export function validateUniqueness(contract: Contract): Contract {
  validateDuplicateIds(
    contract.invariants,
    "E0306",
    "Invariant",
    "Use a globally unique invariant id across all imported files and groups.",
  );
  validateDuplicateIds(
    contract.checkers,
    "E0312",
    "Checker",
    "Use a globally unique checker id so uses-checker references resolve unambiguously.",
  );
  validateDuplicateIds(
    contract.groups,
    "E0313",
    "Group",
    "Use a globally unique group id across the loaded contract files.",
  );
  validateDuplicateIds(
    contract.scenarios,
    "E0315",
    "Scenario",
    "Use a globally unique scenario id across the loaded contract files.",
  );
  validateDuplicateIds(
    contract.operators,
    "E0314",
    "Operator",
    "Use a globally unique operator id across the loaded contract files.",
  );
  validateDuplicateIds(
    contract.codeShapes,
    "E0319",
    "Code-shape",
    "Use a globally unique id across boundary, class-shape, function-shape, type-policy, and file-policy declarations.",
  );
  validateDuplicateIds(
    contract.agents,
    "E0321",
    "Agent",
    "Use a globally unique agent id across all loaded contract files.",
  );
  validateDuplicateIds(
    contract.architectures,
    "E0325",
    "Architecture",
    "Use a globally unique architecture id across all loaded contract files.",
  );
  validateDuplicateIds(
    contract.coreNodes,
    "E0326",
    "Core-node",
    "Use a globally unique core-node id across all loaded contract files.",
  );

  return contract;
}

function validateDuplicateIds<T extends { id: string; span: { file: string; line: number; column: number }; filePath: string }>(
  items: T[],
  code: string,
  label: "Invariant" | "Checker" | "Group" | "Scenario" | "Operator" | "Code-shape" | "Agent" | "Architecture" | "Core-node",
  hint: string,
): void {
  const seen = new Map<string, { filePath: string }>();

  for (const item of items) {
    const existing = seen.get(item.id);

    if (existing !== undefined) {
      throw new SteleError(
        code,
        "Validation Error",
        `${label} id "${item.id}" is already defined.`,
        item.span,
        `First defined in ${existing.filePath}.`,
        hint,
      );
    }

    seen.set(item.id, { filePath: item.filePath });
  }
}
