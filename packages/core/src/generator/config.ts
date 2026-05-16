import { resolve } from "node:path";
import type { GenerationConfig } from "./types.js";
import { DEFAULT_GENERATED_OUTPUT_DIR } from "./types.js";
import { normalizeRelativeDirectoryPath } from "./path-safety.js";
import { generationError } from "./errors.js";

export type ResolvedGenerationConfig = {
  projectRoot: string;
  outputDir: string;
};

export function resolveGenerationConfig(config: GenerationConfig): ResolvedGenerationConfig {
  if (typeof config.projectRoot !== "string" || config.projectRoot.length === 0) {
    throw generationError(
      "E0502",
      "Generation config requires a projectRoot.",
      "Expected projectRoot to be a non-empty filesystem path.",
      "Pass the repository or project root path when coordinating generation.",
    );
  }

  return {
    projectRoot: resolve(config.projectRoot),
    outputDir: normalizeRelativeDirectoryPath(config.outputDir ?? DEFAULT_GENERATED_OUTPUT_DIR, "generation output directory"),
  };
}
