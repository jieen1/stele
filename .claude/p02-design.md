# P0.2 Design: SARIF, CI Templates, Score (Round 2)

## Review Summary

**Round 1 findings**: Architecture (3C/3H/4M/3L) + Integration (2C/3H/4M/3L)
- 5 critical: Version drift, exit code collision, score data contract, missing score file, SARIF/JSON mutual exclusion
- 6 high: Formatter registry, SARIF/JSON guard, init --ci flow, score CI bootstrap, version parameter, missing validation
- 8 medium: All addressed below

**Round 2 fixes applied**:
- [x] Version: Single source of truth in `packages/cli/src/version.ts`
- [x] Exit code: `SCORE_BELOW_THRESHOLD: 6` added to ExitCode enum
- [x] SARIF/JSON: `--format <human|json|sarif>` replaces separate `--json` flag
- [x] Score data contract: Missing files → skip dimension, renormalize weights
- [x] Report file: Accepts formatter parameter, validates path stays in project
- [x] Formatter: `formatCheckReport` dispatch function replaces hardcoded ternary

---

## SARIF Output (`stele check --format sarif`)

### Architecture

- **Location**: `packages/cli/src/report/sarif.ts` (CLI only, NOT in core)
- **Version**: `formatViolationReportSarif(report, version)` — accepts version parameter from shared `STELE_VERSION`
- **Schema**: SARIF 2.1.0 with `$schema` and `uriBaseId: "%CWD%"` for relative paths

### SARIF Mapping

```
Violation.rule_id          → SARIF result.ruleId
Violation.severity         → SARIF result.level (error/warning/note)
Violation.cause.summary    → SARIF result.message.text (sanitized)
Violation.location.path    → SARIF artifactLocation.uri (relative, %CWD% base)
Violation.location.line    → SARIF region.startLine
Violation.fingerprint      → SARIF properties.fingerprint
Violation.cause.detail     → SARIF properties.detail (sanitized)
Violation.fix              → SARIF properties.fix_summary, fix_command
```

### CLI Integration

- **Flag**: `--format <human|json|sarif>` replaces `--json` boolean
- **Output**: Writes to stdout or `--report-file <path>`
- **Validation**: `--report-file` path validated to stay within project directory (prevents C1 traversal)
- **Backward compat**: `--json` still works as alias for `--format json`

### SARIF File (`packages/cli/src/report/sarif.ts`)

- `formatViolationReportSarif(report: ViolationReport, version: string): string`
- Only active violations in results (suppressed → properties metadata)
- `sanitizeMessage()` strips HTML tags, normalizes whitespace

### Redaction

- `sanitizeMessage()` strips `<...>` tags
- `cause.detail` and `cause.summary` sanitized before SARIF output
- `failure_witness` data NOT included in SARIF (high sensitivity)

---

## CI Templates

### Templates

```
packages/cli/templates/ci/
  github-actions.yml    # GitHub Actions workflow
  gitlab-ci.yml          # GitLab CI template
```

### Installation

- `stele init --ci <provider>` flag on init command
- Templates copied to `.github/workflows/stele.yml` or `.gitlab-ci.yml`
- Template version header: `# stele-ci-template: "1.0"` (in sync with package version)
- Skips if file exists, uses `writeIfMissing` pattern
- **Warning**: "Skipped FILENAME (already exists). Use --force to overwrite."

### Template Content

**GitHub Actions** (commit-SHA pinned):
```yaml
name: Stele Contracts
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  stele:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@b4ff...  # SHA pinned
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
      - run: pnpm install --frozen-lockfile
      - run: npx stele generate
      - run: npx stele check
      - run: python -m pytest tests/contract -q
```

---

## Score Command

### Architecture

- **Location**: `packages/cli/src/commands/score.ts` (CLI command only)
- **Reasoning**: Reads CLI-side state files. Must stay in CLI.

### Scoring

```typescript
interface ScoreResult {
  score: number;           // 0-10, rounded to 1 decimal
  maxScore: number;        // 10
  checks: ScoreCheck[];
}

interface ScoreCheck {
  name: string;
  score: number;           // 0-1, clamped
  weight: number;          // 0-1, weights sum to 1.0
  reason: string;
}
```

### Score Dimensions

| Dimension | Weight | Source | Missing File Behavior |
|-----------|--------|--------|----------------------|
| contract-coverage | 0.30 | invariants / protected files ratio (clamped 0-1) | Skip, renormalize |
| last-check-result | 0.25 | 1.0 if last check passed, 0.0 if failed | Skip, renormalize |
| baseline-freshness | 0.20 | Linear: 1.0 at 0h, 0.5 at 3.5d, 0.0 at 7d+ | Skip, renormalize |
| generation-cache | 0.10 | 1.0 if cache hit, 0.0 if missing/stale | Skip, renormalize |
| manifest-lock | 0.15 | 1.0 if manifest locked, 0.0 if not | Skip, renormalize |

**Clamping**: All dimension scores clamped to [0, 1] before weighting.
**Renormalization**: If N dimensions skipped, remaining weights divided by (1 - skipped_weight).
**Edge case**: If ALL dimensions missing → score = 0.0, score = "no data".

### CLI Flags

```
stele score [--json] [--threshold <n>]
```

- `--json`: Machine-readable output (standard for all Stele commands)
- `--threshold <n>`: Exit non-zero if score < threshold (CI gate)

### Exit Code

- 0: score >= threshold (or no threshold set)
- `ExitCode.SCORE_BELOW_THRESHOLD` (6): score < threshold

### Data Sources

| File | Purpose | Missing Behavior |
|------|---------|-----------------|
| `contract/.last-check-report.json` | Last check result | Skip last-check-result dimension |
| `contract/baseline.json` | Baseline timestamp | Skip baseline-freshness dimension |
| `contract/.manifest.json` | Lock status | Skip manifest-lock dimension |
| `stele.config.json` | Protected files list | Error: required for contract-coverage |
| `.stele/config.json` | Generation cache | Skip generation-cache dimension |

### `.gitignore` Addition

- `contract/.last-check-report.json` added to gitignore template

---

## Shared Components

### Version (`packages/cli/src/version.ts`)

```typescript
export const STELE_VERSION: string = "0.1.0";
```

Single source of truth. Imported by `index.ts`, `sarif.ts`, `format.ts`.

### Path Validation (`packages/cli/src/utils/output-path.ts`)

```typescript
/**
 * Validate that an output file path stays within the project directory.
 * Prevents directory traversal attacks on report file output.
 */
export function validateOutputPath(projectDir: string, outputPath: string): string {
  const resolved = resolve(projectDir, outputPath);
  if (!resolved.startsWith(projectDir + "/") && resolved !== projectDir) {
    throw new ConfigError(
      `Output path ${outputPath} resolves outside project directory. ` +
      `Use a path relative to ${projectDir}.`
    );
  }
  return resolved;
}
```

### Formatter Registry (`packages/cli/src/report/formatter.ts`)

```typescript
export type ReportFormatter = (report: ViolationReport) => string;

export const FORMATTERS: Record<string, ReportFormatter> = {
  human: formatCheckReportHuman,
  json: formatCheckReportJson,
  sarif: formatViolationReportSarif,
};

export function formatCheckReport(report: ViolationReport, format: string): string {
  const formatter = FORMATTERS[format];
  if (!formatter) {
    throw new ConfigError(`Unknown format: ${format}. Supported: ${Object.keys(FORMATTERS).join(", ")}`);
  }
  return formatter(report);
}
```
