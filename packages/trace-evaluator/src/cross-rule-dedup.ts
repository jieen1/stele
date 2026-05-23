/**
 * Round 3 P1-4: the cross-rule annotation logic now lives in `@stele/core`
 * so it can apply to violations from *every* Phase B evaluator (trace,
 * type-state, effect) at the post-merge layer in CLI `check`. This module
 * re-exports the helper for any code still importing it via the
 * `@stele/trace-evaluator` entry point.
 *
 * Prefer importing from `@stele/core` in new code.
 */

export { annotateCrossRuleViolations } from "@stele/core";
