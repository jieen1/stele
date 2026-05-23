/**
 * Default protected file patterns used by Stele.
 * These patterns define which files are locked from direct agent edits.
 *
 * This constant is the single source of truth for default protection.
 * All packages (core, cli, mcp-server, agent-hooks) import from here.
 */
export const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  // Contract surface — agent never edits these
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "contract/design/**/*",
  "contract/generated/**/*",
  "tests/contract/**/*",
  // Hook scripts — direct edit = complete kill switch (Round 3 Reviewer G P0-3)
  "packages/claude-code-plugin/scripts/*.js",
  "packages/claude-code-plugin/hooks/hooks.json",
  // Project config — tampering changes which files are protected
  "stele.config.json",
  // Stele runtime state — Stop hook loop-guard fingerprint store
  // (without this, an agent can pre-fill stop-state.json to bypass the
  // two-attempt human floor; see Round 3 Reviewer G P0-1).
  // Note: `.stele/events/**` is intentionally excluded — those are append-only
  // observation logs that change every Stop hook fire. `.stele/maintenance/**`
  // and `.stele/agent/**` are likewise dynamic marker / summary stores. We only
  // freeze the security-critical control-plane file here.
  ".stele/stop-state.json",
];
