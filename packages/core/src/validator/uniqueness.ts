import { SteleError } from "../errors/SteleError.js";
import type { Contract } from "./structure.js";

export function validateUniqueness(contract: Contract): Contract {
  const invariantIds = new Map<string, { filePath: string }>();

  for (const invariant of contract.invariants) {
    const existing = invariantIds.get(invariant.id);

    if (existing !== undefined) {
      throw new SteleError(
        "E0306",
        "Validation Error",
        `Invariant id "${invariant.id}" is already defined.`,
        invariant.span,
        `First defined in ${existing.filePath}.`,
        "Use a globally unique invariant id across all imported files and groups.",
      );
    }

    invariantIds.set(invariant.id, { filePath: invariant.filePath });
  }

  return contract;
}
