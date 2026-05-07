import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PYTEST_RUNTIME_PATH = "tests/contract/_stele_runtime.py";

const RUNTIME_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime", "_stele_runtime.py");

let cachedSource: string | undefined;

export function getPythonRuntimeSource(): string {
  if (cachedSource) {
    return cachedSource;
  }
  cachedSource = readFileSync(RUNTIME_FILE, "utf8");
  return cachedSource;
}
