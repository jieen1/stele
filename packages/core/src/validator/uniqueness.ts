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
  | "Effect-policy"
  | "Extern-alias";

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
  validateEffectNameReferences(contract);
  validateDuplicateIds(
    [...contract.externAliases],
    "E0362",
    "Extern-alias",
    "Use a globally unique extern-alias logical name across all loaded contract files.",
  );

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

const EFFECT_GLOB_META = /[*]/;

/**
 * Cross-form check (E0350): every effect name referenced by an
 * `(effect-policy ... forbid/allow-only ...)`, an
 * `(effect-suppression ... suppresses ...)`, or an
 * `(effect-annotation ... annotates ...)` must resolve to a member of the
 * declared `(effect-declarations ...)` set.
 *
 * - An exact (non-glob) reference must be a declared effect name verbatim.
 *   A typo like `forbid "netork"` therefore fails here instead of silently
 *   enforcing nothing.
 * - A glob reference (`payment.*`, or the bare `*`) must match at least one
 *   declared effect; a glob that matches nothing is the same footgun as a
 *   misspelled exact name.
 *
 * Per-form parsing in `structure-effect.ts` deliberately defers this check
 * because resolving references requires the whole contract (declarations may
 * live in a different imported file than the policy that references them).
 */
function validateEffectNameReferences(contract: Contract): void {
  const declared = new Set<string>();
  for (const block of contract.effectDeclarations) {
    for (const effect of block.effects) {
      declared.add(effect.name);
    }
  }
  const declaredList = [...declared].sort();
  const declaredRendered =
    declaredList.length === 0 ? "<none>" : `[${declaredList.join(", ")}]`;

  const isGlob = (ref: string): boolean => EFFECT_GLOB_META.test(ref);

  const compileGlob = (pattern: string): RegExp => {
    let re = "^";
    for (const ch of pattern) {
      if (ch === "*") {
        re += "[a-z0-9._-]+";
      } else if (/[.+^$|(){}\\\][?]/.test(ch)) {
        re += `\\${ch}`;
      } else {
        re += ch;
      }
    }
    re += "$";
    return new RegExp(re);
  };

  const resolves = (ref: string): boolean => {
    if (!isGlob(ref)) {
      return declared.has(ref);
    }
    if (ref === "*") {
      return declared.size > 0;
    }
    const compiled = compileGlob(ref);
    for (const name of declared) {
      if (compiled.test(name)) {
        return true;
      }
    }
    return false;
  };

  const check = (
    ref: string,
    context: string,
    span: Contract["effectPolicies"][number]["span"],
  ): void => {
    if (resolves(ref)) {
      return;
    }
    const kind = isGlob(ref)
      ? `Effect glob "${ref}" matches no declared effect`
      : `Unknown effect name "${ref}"`;
    throw new SteleError(
      "E0350",
      "Validation Error",
      `${kind} in ${context}.`,
      span,
      `Declared effects are ${declaredRendered}. Effect references must resolve to a name in the (effect-declarations ...) set.`,
      isGlob(ref)
        ? "Fix the glob so it matches a declared effect, or declare the effect in (effect-declarations ...)."
        : "Fix the typo, or declare this effect in the (effect-declarations ...) block.",
    );
  };

  for (const policy of contract.effectPolicies) {
    for (const ref of policy.forbid ?? []) {
      check(ref, `effect-policy "${policy.id}" (forbid ...)`, policy.span);
    }
    for (const ref of policy.allowOnly ?? []) {
      check(ref, `effect-policy "${policy.id}" (allow-only ...)`, policy.span);
    }
  }
  for (const suppression of contract.effectSuppressions) {
    for (const ref of suppression.suppresses) {
      check(
        ref,
        `effect-suppression for target "${suppression.target}" (suppresses ...)`,
        suppression.span,
      );
    }
  }
  for (const annotation of contract.effectAnnotations) {
    for (const ref of annotation.annotates) {
      check(ref, `effect-annotation (annotates ...)`, annotation.span);
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
