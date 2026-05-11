import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const JAVA_RUNTIME_PATH = "src/test/java/contract/_stele_runtime.java";

let cachedRuntimeSource: string | undefined;

/** Return the canonical content of the generated _stele_runtime.java helper. */
export function getJavaRuntimeSource(): string {
  if (cachedRuntimeSource !== undefined) {
    return cachedRuntimeSource;
  }
  cachedRuntimeSource = readFileSync(join(__dirname, "runtime", "_stele_runtime.java"), "utf8");
  return cachedRuntimeSource;
}
