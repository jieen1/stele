export const STELE_CONFIG_FILE = "stele.config.json";
export const STELE_BASELINE_FILE = "contract/.baseline.json";

/** Maximum buffer size for child process output capture (16 MB). */
export const MAX_CHILD_PROCESS_BUFFER = 16 * 1024 * 1024;

/** Maximum size before rotating event log files (10 MB). */
export const MAX_EVENT_LOG_SIZE = 10 * 1024 * 1024;

/** Maximum size for single file read (1 MB). */
export const MAX_FILE_READ_SIZE = 1024 * 1024;

export type SteleConfig = {
  version: string;
  contractDir: string;
  entry: string;
  generatedDir: string;
  checkerImplDir: string;
  manifestPath: string;
  targetLanguage: string;
  testFramework: string;
  pathMode: string;
  protected: string[];
};

export const DEFAULT_CONFIG: SteleConfig = {
  version: "0.1",
  contractDir: "contract",
  entry: "contract/main.stele",
  generatedDir: "tests/contract",
  checkerImplDir: "contract/checker_impls",
  manifestPath: "contract/.manifest.json",
  targetLanguage: "python",
  testFramework: "pytest",
  pathMode: "auto",
  // Round 4 D-13: this list MUST stay byte-equal (modulo ordering) to
  // `DEFAULT_PROTECTED_PATTERNS` in `@stele/core/src/config/defaults.ts`
  // and `DEFAULT_PROTECTED` in `packages/claude-code-plugin/scripts/
  // pre-tool-protect.js`. The `default-protected-consistent` self-
  // protection checker parses all three on every pytest run and fails
  // loudly on any divergence.
  protected: [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    // Note: kept as a literal (not STELE_BASELINE_FILE) so the
    // default-protected-consistent checker can byte-compare the three
    // independent lists via string-literal extraction.
    "contract/.baseline.json",
    "contract/.manifest.json",
    "contract/design/**/*",
    "contract/design/proposals/**/*",
    "contract/design/approvals/**/*",
    "contract/generated/**/*",
    "tests/contract/**/*",
    "packages/claude-code-plugin/scripts/pre-tool-protect.js",
    "packages/claude-code-plugin/scripts/stop-validate.js",
    "packages/claude-code-plugin/scripts/observation-hook.js",
    "packages/claude-code-plugin/scripts/lifecycle-context.js",
    "packages/claude-code-plugin/hooks/hooks.json",
    "stele.config.json",
    ".stele/stop-state.json",
  ],
};
