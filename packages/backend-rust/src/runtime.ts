import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const RUST_RUNTIME_PATH = "_stele_runtime.rs";

/**
 * Read the Rust runtime source file and return it as a string.
 * The runtime is shipped as a `.rs` file so it can be copied verbatim.
 */
export function getRustRuntimeSource(): string {
    return readFileSync(join(__dirname, "runtime", RUST_RUNTIME_PATH), "utf8");
}
