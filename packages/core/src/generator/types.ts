import type { Contract } from "../validator/structure.js";

export const DEFAULT_GENERATED_OUTPUT_DIR = "tests/contract";

export type GeneratedFile = {
  path: string;
  content: string;
};

export type GenerationConfig = {
  projectRoot: string;
  outputDir?: string;
};

export interface LanguageBackend {
  name: string;
  framework: string;
  fileExtension: string;
  version: string;
  generate(contract: Contract, config: GenerationConfig): GeneratedFile[];
  supportFiles?(contract: Contract, config: GenerationConfig): GeneratedFile[];
  /**
   * v0.2: emit fixture-specific test bootstrap (conftest.py / vitest setup / setup_test.go).
   * Called by tests/conformance/ runner before invoking the test runner.
   */
  writeFixtureBootstrap?(fixture: ConformanceFixture, tmpdir: string): Promise<void>;
}

/**
 * v0.2: Conformance fixture descriptor passed to LanguageBackend.writeFixtureBootstrap.
 *
 * Backends consume `appState` (parsed app-state.json) to emit the fixture-specific
 * test runner setup (conftest.py for Python, conftest.ts for TypeScript, setup_test.go for Go).
 */
export interface ConformanceFixture {
  /** Stable id, e.g. "01-simple-invariant". */
  id: string;
  /** Absolute path to the source fixture directory in tests/conformance/fixtures/. */
  dir: string;
  /** Parsed app-state.json (conformance runner injects this into stele_context). */
  appState: unknown;
}

export type GeneratedVerificationStatus = "missing" | "changed" | "extra" | "unchanged";

export type GeneratedVerificationFile = {
  path: string;
  status: GeneratedVerificationStatus;
  expectedContent?: string;
  actualContent?: string;
};

export type GeneratedVerificationResult = {
  ok: boolean;
  outputDir: string;
  unchanged: string[];
  missing: string[];
  changed: string[];
  extra: string[];
  files: GeneratedVerificationFile[];
};
