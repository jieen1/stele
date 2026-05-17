/**
 * Default protected file patterns used by Stele.
 * These patterns define which files are locked from direct agent edits.
 *
 * This constant is the single source of truth for default protection.
 * All packages (core, cli, mcp-server, agent-hooks) import from here.
 */
export const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "tests/contract/**/*",
];
