import { SteleError } from "../errors/SteleError.js";
import type { Contract } from "./structure-types.js";

type LabelTag =
  | "Invariant"
  | "Checker"
  | "Group"
  | "Scenario"
  | "Operator"
  | "Code-shape"
  | "Architecture"
  | "Core-node"
  | "Branded-id"
  | "Smart-ctor"
  | "Trace-policy"
  | "Type-state"
  | "Effect-policy";

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
  validateDuplicateIds(
    contract.brandedIds,
    "E0327",
    "Branded-id",
    "Use a globally unique branded-id id across all loaded contract files.",
  );
  validateDuplicateIds(
    contract.smartCtors,
    "E0328",
    "Smart-ctor",
    "Use a globally unique smart-ctor id across all loaded contract files.",
  );
  validateDuplicateIds(
    [...contract.tracePolicies],
    "E0331",
    "Trace-policy",
    "Use a globally unique trace-policy id across all loaded contract files.",
  );
  validateDuplicateIds(
    [...contract.typeStates],
    "E0341",
    "Type-state",
    "Use a globally unique type-state id across all loaded contract files.",
  );
  validateDuplicateTypeStateTargets([...contract.typeStates]);
  validateDuplicateBindingFunctions([...contract.typeStateBindings]);
  validateDuplicateIds(
    [...contract.effectPolicies],
    "E0359",
    "Effect-policy",
    "Use a globally unique effect-policy id across all loaded contract files.",
  );
  validateEffectDeclarationsBlocks([...contract.effectDeclarations]);
  validateEffectNamesUnique([...contract.effectDeclarations]);

  return contract;
}

function validateEffectDeclarationsBlocks(
  blocks: Contract["effectDeclarations"][number][] | [],
): void {
  const seenByFile = new Map<string, { span: { line: number; column: number } }>();
  for (const block of blocks) {
    const existing = seenByFile.get(block.filePath);
    if (existing !== undefined) {
      throw new SteleError(
        "E0351",
        "Validation Error",
        `Effect-declarations block declared more than once in ${block.filePath}.`,
        block.span,
        `First block at line ${existing.span.line}, column ${existing.span.column}.`,
        "Each file may declare at most one (effect-declarations ...) block. Merge the entries into a single block.",
      );
    }
    seenByFile.set(block.filePath, { span: { line: block.span.line, column: block.span.column } });
  }
}

function validateEffectNamesUnique(
  blocks: Contract["effectDeclarations"][number][] | [],
): void {
  const seen = new Map<string, { filePath: string; line: number; column: number }>();
  for (const block of blocks) {
    for (const effect of block.effects) {
      const existing = seen.get(effect.name);
      if (existing !== undefined) {
        throw new SteleError(
          "E0352",
          "Validation Error",
          `Effect "${effect.name}" is declared in multiple effect-declarations blocks.`,
          effect.span,
          `First declared in ${existing.filePath} at line ${existing.line}, column ${existing.column}.`,
          "An effect name may be declared only once across the whole contract. Remove the duplicate (effect ...) entry.",
        );
      }
      seen.set(effect.name, {
        filePath: block.filePath,
        line: effect.span.line,
        column: effect.span.column,
      });
    }
  }
}

function validateDuplicateTypeStateTargets(items: Contract["typeStates"][number][] | []): void {
  const seen = new Map<string, { filePath: string; id: string }>();

  for (const item of items) {
    const existing = seen.get(item.target);
    if (existing !== undefined) {
      throw new SteleError(
        "E0341",
        "Validation Error",
        `Type-state target "${item.target}" is already declared by type-state "${existing.id}".`,
        item.span,
        `First defined in ${existing.filePath}.`,
        "A type can have only one state machine. Merge the two type-state declarations or change one target.",
      );
    }
    seen.set(item.target, { filePath: item.filePath, id: item.id });
  }
}

function validateDuplicateBindingFunctions(items: Contract["typeStateBindings"][number][] | []): void {
  const seen = new Map<string, { filePath: string }>();

  for (const item of items) {
    const existing = seen.get(item.function);
    if (existing !== undefined) {
      throw new SteleError(
        "E0349",
        "Validation Error",
        `Type-state-binding function "${item.function}" is already declared.`,
        item.span,
        `First defined in ${existing.filePath}.`,
        "Merge the two (type-state-binding ...) declarations for this function or remove the duplicate.",
      );
    }
    seen.set(item.function, { filePath: item.filePath });
  }
}

function validateDuplicateIds<T extends { id: string; span: { file: string; line: number; column: number }; filePath: string }>(
  items: T[],
  code: string,
  label: LabelTag,
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
