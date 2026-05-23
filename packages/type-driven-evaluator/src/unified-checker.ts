import type { Contract, Violation } from "@stele/core";
// Future Phase B fills in this dispatch by importing per-form checkers:
//   import { checkBrandedIds } from "./branded-id-checker.js";
//   import { checkSmartConstructors } from "./smart-ctor-checker.js";
//   import { checkTypeStates } from "./type-state-checker.js";
//   import { checkEffects } from "./effect-checker.js";
// Today the cli calls those entry points directly so each declaration
// keeps its own rule_id; this file is reserved for the unified entry.

export interface TypeDrivenCheckOptions {
  projectDir: string;
  tsconfigPath: string;
  contract: Contract;
}

export interface TypeDrivenCheckResult {
  violations: Violation[];
}

/**
 * Run all type-driven checkers configured in the contract.
 *
 * Phase A scope: branded-id + smart-ctor. Phase B will add type-state +
 * effect. This entry point is a forward-looking dispatch helper; the cli
 * currently calls the per-form checkers (`checkBrandedIds`,
 * `checkSmartConstructors`) directly so it can attribute violations to
 * the right `rule_id` per declaration.
 */
export async function runTypeDrivenChecks(
  options: TypeDrivenCheckOptions,
): Promise<TypeDrivenCheckResult> {
  const violations: Violation[] = [];
  // Phase A scope: per-form dispatch lives in the cli (check-stages-type-driven.ts)
  // so each declaration can mint its own rule_id. This stub will be filled in
  // when type-state and effect checkers land — at that point the cli will
  // migrate to this unified entry. Keep the no-op deterministic so importing
  // the function never throws.
  void options;
  return { violations };
}
