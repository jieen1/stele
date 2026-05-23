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
  protected: [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    STELE_BASELINE_FILE,
    "contract/.manifest.json",
    "tests/contract/**/*",
    // Design profile files
    "contract/design/**/*",
    "contract/design/proposals/**/*",
    "contract/generated/ddd-typedriven.stele",
    // Hook scripts - security-critical, must not be editable by agents
    "packages/claude-code-plugin/scripts/pre-tool-protect.js",
    "packages/claude-code-plugin/scripts/stop-validate.js",
    "packages/claude-code-plugin/scripts/observation-hook.js",
    "packages/claude-code-plugin/scripts/lifecycle-context.js",
    "packages/claude-code-plugin/hooks/hooks.json",
    // Config files - protect against tampering
    "stele.config.json",
  ],
};
