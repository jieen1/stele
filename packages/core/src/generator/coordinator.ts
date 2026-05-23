import type { Contract } from "../validator/structure.js";
import {
  type GeneratedFile,
  type GenerationConfig,
  type GeneratedVerificationResult,
  type LanguageBackend,
} from "./types.js";
import { buildCanonicalGeneratedPaths, normalizeGeneratedFiles, mergeExpectedGeneratedPaths, assertGeneratedFilesMatchExpectedLayout } from "./layout.js";
import { resolveGenerationConfig } from "./config.js";
import { verifyFiles } from "./file-walk.js";
import { generationError } from "./errors.js";

// Re-export types for external use
export {
  DEFAULT_GENERATED_OUTPUT_DIR,
  type GeneratedFile,
  type GenerationConfig,
  type GeneratedVerificationStatus,
  type GeneratedVerificationFile,
  type GeneratedVerificationResult,
  type LanguageBackend,
  type ConformanceFixture,
} from "./types.js";

export function coordinateGeneration(
  contract: Contract,
  backend: LanguageBackend,
  config: GenerationConfig,
): GeneratedFile[] {
  const resolvedConfig = resolveGenerationConfig(config);
  const canonicalPaths = buildCanonicalGeneratedPaths(contract, backend, resolvedConfig.outputDir);
  const generatedFiles = backend.generate(contract, resolvedConfig);
  const supportFiles = backend.supportFiles?.(contract, resolvedConfig) ?? [];

  if (!Array.isArray(generatedFiles)) {
    throw generationError(
      "E0501",
      `Backend "${backend.name}" returned an invalid generated file list.`,
      "Expected generate() to return an array of { path, content } objects.",
      "Return a deterministic array of generated files from the backend.",
    );
  }

  if (!Array.isArray(supportFiles)) {
    throw generationError(
      "E0501",
      `Backend "${backend.name}" returned an invalid support file list.`,
      "Expected supportFiles() to return an array of { path, content } objects.",
      "Return a deterministic array of generated support files from backend.supportFiles().",
    );
  }

  const normalizedSupportFiles = normalizeGeneratedFiles(supportFiles, resolvedConfig.outputDir);
  const expectedPaths = mergeExpectedGeneratedPaths(canonicalPaths, normalizedSupportFiles.map((file) => file.path));
  const normalizedFiles = normalizeGeneratedFiles([...generatedFiles, ...supportFiles], resolvedConfig.outputDir);
  assertGeneratedFilesMatchExpectedLayout(normalizedFiles, expectedPaths, backend.name);
  return normalizedFiles;
}

export async function verifyGenerated(
  contract: Contract,
  backend: LanguageBackend,
  config: GenerationConfig,
): Promise<GeneratedVerificationResult> {
  const resolvedConfig = resolveGenerationConfig(config);
  const expectedFiles = coordinateGeneration(contract, backend, resolvedConfig);

  return verifyFiles(resolvedConfig.projectRoot, resolvedConfig.outputDir, expectedFiles);
}
