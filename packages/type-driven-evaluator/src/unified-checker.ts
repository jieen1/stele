import type { Contract, Violation } from "@stele/core";
// Future Phase B fills in this dispatch by importing per-form checkers:
//   import { checkBrandedIds } from "./branded-id-checker.js";
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
 * Round 4 F-C-06: Phase B type-state + effect evaluators shipped as their
 * own packages (`@stele/type-state-evaluator`, `@stele/effect-evaluator`)
 * with the CLI dispatching directly to them at the stage level — so the
 * "future unified entry" this stub anticipated never materialised. The
 * function remains here as a thin compatibility shim for any external
 * consumer that imported it; new code should call the per-form
 * checkers (`checkBrandedIds`, `evaluateTypeStates`, `evaluateEffects`)
 * directly.
 */
export async function runTypeDrivenChecks(
  options: TypeDrivenCheckOptions,
): Promise<TypeDrivenCheckResult> {
  void options;
  return { violations: [] };
}
