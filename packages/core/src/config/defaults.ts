/**
 * Default protected file patterns used by Stele.
 * These patterns define which files are locked from direct agent edits.
 *
 * This constant is the single source of truth for default protection.
 * All packages (core, cli, mcp-server, agent-hooks) import from here.
 */
/**
 * Default protected patterns used by Stele.
 *
 * SINGLE SOURCE OF TRUTH (Round 4 D-13): three call sites previously kept
 * their own copies of this list and drifted freely. Both
 * `packages/cli/src/config/defaults.ts#DEFAULT_CONFIG.protected` and
 * `packages/claude-code-plugin/scripts/pre-tool-protect.js#DEFAULT_PROTECTED`
 * MUST be byte-equal to this array (modulo ordering); the
 * `default-protected-consistent` self-protection checker enforces it on
 * every `pytest tests/contract` run.
 *
 * When adding an entry: edit this file first, then mirror into the other
 * two declarations (cli/defaults.ts + plugin/pre-tool-protect.js) verbatim.
 * The checker will fail loudly if you forget.
 */
export const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  // Contract surface — agent never edits these
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "contract/design/**/*",
  "contract/design/proposals/**/*",
  // Round 4 D-02: approval records gate `stele design generate`. If the
  // approvals directory is editable by the agent, the gate is a no-op.
  "contract/design/approvals/**/*",
  "contract/generated/**/*",
  "tests/contract/**/*",
  // Hook scripts — direct edit = complete kill switch (Round 3 Reviewer G P0-3)
  "packages/claude-code-plugin/scripts/pre-tool-protect.js",
  "packages/claude-code-plugin/scripts/stop-validate.js",
  "packages/claude-code-plugin/scripts/observation-hook.js",
  "packages/claude-code-plugin/scripts/lifecycle-context.js",
  "packages/claude-code-plugin/hooks/hooks.json",
  // Project config — tampering changes which files are protected
  "stele.config.json",
  // Stele runtime state — Stop hook loop-guard fingerprint store
  // (without this, an agent can pre-fill stop-state.json to bypass the
  // two-attempt human floor; see Round 3 Reviewer G P0-1).
  // Note: `.stele/events/**` is intentionally excluded — those are append-only
  // observation logs that change every Stop hook fire. `.stele/maintenance/**`
  // and `.stele/agent/**` are likewise dynamic marker / summary stores. We
  // only freeze the security-critical control-plane file here.
  ".stele/stop-state.json",
  // Round 4 E-09: supply-chain shape. Tampering with any of these can
  // ship a typeless package, skip the workspace-protocol guard, alter
  // CI gates, or swap deps. They are not source code but they ARE the
  // build contract; pre-tool-protect blocks edits and the manifest
  // hashes them.
  "pnpm-lock.yaml",
  "package.json",
  "packages/*/package.json",
  "packages/*/tsup.config.ts",
  ".github/workflows/**",
  "scripts/publish-npm.mjs",
  "scripts/verify-packed-adoption.mjs",
  // Round 9 P-02: workspace topology + base TS config are part of the
  // supply-chain shape. `pnpm-workspace.yaml` controls which packages
  // pnpm links; an unprotected edit could introduce a malicious linked
  // package. `tsconfig.base.json` defines `strict: true` and module
  // resolution for the whole monorepo; flipping it elsewhere defeats
  // the strict-mode invariant.
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
];
