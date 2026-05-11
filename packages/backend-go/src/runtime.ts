import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Go runtime helpers used by generated `_stele_runtime.go` consumers.
 *
 * The actual implementation lives in `runtime/_stele_runtime.go`; this module
 * reads that source from disk so generated test files can import it verbatim
 * AND so runtime helpers can be unit-tested directly without round-tripping
 * through a string template.
 */
export const GO_RUNTIME_PATH = "tests/contract/_stele_runtime.go";

const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime");
const RUNTIME_FILE = path.join(RUNTIME_DIR, "_stele_runtime.go");

let cachedRuntimeSource: string | undefined;

/** Return the canonical content of the generated `_stele_runtime.go` helper. */
export function getGoRuntimeSource(): string {
  if (cachedRuntimeSource !== undefined) {
    return cachedRuntimeSource;
  }
  cachedRuntimeSource = readFileSync(RUNTIME_FILE, "utf8");
  return cachedRuntimeSource;
}
