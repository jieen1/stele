import {
  createExtractor as createTsextractor,
  type ExtractorOptions,
} from "@stele/architecture-core";

/**
 * Delegate to @stele/architecture-core for TypeScript import extraction.
 *
 * All TypeScript AST-based extraction is handled by the architecture-core
 * package to avoid bundling TypeScript in this package.
 */
export function createExtractor(options: ExtractorOptions) {
  return createTsextractor(options);
}

export type { ExtractorOptions };
