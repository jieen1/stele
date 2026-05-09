import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Generated runtime helpers used by `_stele_runtime.ts` consumers.
 *
 * Phase A scope (EP01): minimum runtime helpers for path / comparison / logic.
 *
 *   - `path`               -> steleGetPath
 *   - `eq` / `neq`         -> steleEq / steleNeq
 *   - `gt` / `gte`         -> steleGt / steleGte
 *   - `lt` / `lte`         -> steleLt / steleLte
 *   - `and` / `or` / `not` -> emitted inline as &&, ||, !
 *   - `assert`             -> emitted inline as expect(...).toBe(true)
 *
 * Phase B scope (extends Phase A with):
 *
 *   - Arithmetic: `add`, `sub`, `mul`, `div`, `neg`, `abs`
 *     -> emitted inline (+, -, *, /, unary -) plus `steleAbs` runtime helper.
 *   - Aggregates: `sum`, `count`, `avg`, `min`, `max`, `distinct`, `unique`,
 *     `has-length`, `is-empty`, `exists-in` -> dispatched to `stele<Op>` helpers.
 *   - String: `contains`, `starts-with`, `ends-with`, `matches` -> dispatched
 *     to `steleContains`, `steleStartsWith`, `steleEndsWith`, `steleMatches`.
 *   - Control: `when`, `if`, `implies`, `iff` -> emitted inline (ternary or
 *     short-circuit). `not-null` -> `steleNotNull`. `between` -> `steleBetween`.
 *     `approx-eq` -> `steleApproxEq`.
 *
 * Phase C scope (extends Phase B with):
 *
 *   - Quantifier: `forall`, `exists`, `where`, `none` — dispatched to
 *     `steleForall`, `steleExists`, `steleWhere`, `steleNone`. Failure throws
 *     `SteleAssertionFailed` carrying a `FailureWitness` per EP07.
 *   - Temporal: `modified`, `state-before`, `state-after`, `within`, `before`,
 *     `after` — dispatched to `steleIsModified`, `steleStateBefore`,
 *     `steleStateAfter`, `steleWithin`, `steleBefore`, `steleAfter`.
 *   - Scenario / checker: `(uses-scenario ...)` translates to
 *     `runtime.steleRunScenario(...)`; `(uses-checker ...)` translates to
 *     `runtime.steleCallChecker(...)`. Context merging via
 *     `steleMergeContexts`.
 *
 * The actual implementation lives in `runtime/_stele_runtime.ts`; this module
 * reads that source from disk so generated test files can import it verbatim
 * AND so runtime helpers can be unit-tested directly without round-tripping
 * through a string template.
 *
 * `getTypeScriptSetupSource()` returns the canonical `_stele_setup.ts`
 * content — a Vitest `afterEach` hook that records witnesses on
 * `task.meta.steleWitnesses` so test runners can extract them. The setup
 * file is optional; users wire it via `setupFiles` in `vitest.config.ts`.
 */
export const TYPESCRIPT_RUNTIME_PATH = "tests/contract/_stele_runtime.ts";
export const TYPESCRIPT_SETUP_PATH = "tests/contract/_stele_setup.ts";

const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime");
const RUNTIME_FILE = path.join(RUNTIME_DIR, "_stele_runtime.ts");
const SETUP_FILE = path.join(RUNTIME_DIR, "_stele_setup.ts");

let cachedRuntimeSource: string | undefined;
let cachedSetupSource: string | undefined;

/** Return the canonical content of the generated `_stele_runtime.ts` helper. */
export function getTypeScriptRuntimeSource(): string {
  if (cachedRuntimeSource !== undefined) {
    return cachedRuntimeSource;
  }
  cachedRuntimeSource = readFileSync(RUNTIME_FILE, "utf8");
  return cachedRuntimeSource;
}

/**
 * Return the canonical content of the generated `_stele_setup.ts` helper.
 *
 * The setup file is auto-generated alongside `_stele_runtime.ts`. Users wire
 * it into `vitest.config.ts` via:
 *
 *   ```typescript
 *   export default defineConfig({
 *     test: { setupFiles: ["./tests/contract/_stele_setup.ts"] },
 *   });
 *   ```
 *
 * It hooks `afterEach` to capture `SteleAssertionFailed.witness` payloads
 * on `task.meta.steleWitnesses` so `stele check` (or any test-runner-aware
 * adapter) can attach them to `ViolationCause.failure_witness`.
 */
export function getTypeScriptSetupSource(): string {
  if (cachedSetupSource !== undefined) {
    return cachedSetupSource;
  }
  cachedSetupSource = readFileSync(SETUP_FILE, "utf8");
  return cachedSetupSource;
}
