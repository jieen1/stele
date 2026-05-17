import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROTECTED_PATTERNS, loadContract, SteleError } from "@stele/core";
import type { SteleConfig } from "../util/stele-config-types.js";

/**
 * Cursor-rules installer.
 *
 * Generates `.cursor/rules/stele.md` (and optionally a composer-rule shell
 * hook under `.cursor/composer/`) for projects that use Stele. Unlike the
 * Claude Code plugin, Cursor cannot hard-block tool calls; static rules are
 * advisory and may be ignored. Hard enforcement still requires
 * `@stele/github-action` (or another CI gate).
 *
 * The generated rules file always begins with {@link AUTO_MARKER}; subsequent
 * runs use the marker to detect whether the file was hand-edited and refuse
 * to overwrite without `--force`.
 */

/** First-line sentinel used to detect Stele-managed cursor rules files. */
export const AUTO_MARKER = "<!-- stele-auto:v1 -->";

/**
 * Sanitize invariant text for safe rendering in agent-facing markdown.
 * Whitelist ASCII alphanumeric, basic punctuation, and whitespace.
 */
function sanitizeInvariantText(raw: string, maxLength = 200): string {
  const truncated = raw.slice(0, maxLength);
  return truncated.replace(/[^A-Za-z0-9_\- ./(),;:!?']/g, "");
}

/** Options accepted by {@link install}. */
export interface CursorInstallOptions {
  /** Also write a composer-rule shell hook to `.cursor/composer/stele-check.sh`. */
  enableShell?: boolean;
  /** Overwrite an existing non-Stele-managed rules file. */
  force?: boolean;
}

/**
 * Read Stele config from the project directory.
 * Reads only the fields needed by cursor-installer, avoiding a hard
 * dependency on `@stele/cli` and the circular import it would create.
 */
async function loadSteleConfig(projectRoot: string): Promise<SteleConfig> {
  const defaults: SteleConfig = {
    version: "0.1",
    contractDir: "contract",
    entry: "contract/main.stele",
    generatedDir: "tests/contract",
    checkerImplDir: "contract/checker_impls",
    manifestPath: "contract/.manifest.json",
    targetLanguage: "python",
    testFramework: "pytest",
    pathMode: "auto",
    protected: [...DEFAULT_PROTECTED_PATTERNS],
  };

  let parsed: Record<string, unknown> = {};
  try {
    const raw = await readFile(path.join(projectRoot, "stele.config.json"), "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // No config file — use defaults
  }

  return {
    version: typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : defaults.version,
    contractDir: String(parsed.contractDir ?? defaults.contractDir),
    entry: String(parsed.entry ?? defaults.entry),
    generatedDir: String(parsed.generatedDir ?? defaults.generatedDir),
    checkerImplDir: String(parsed.checkerImplDir ?? defaults.checkerImplDir),
    manifestPath: String(parsed.manifestPath ?? defaults.manifestPath),
    targetLanguage: String(parsed.targetLanguage ?? defaults.targetLanguage),
    testFramework: String(parsed.testFramework ?? defaults.testFramework),
    pathMode: String(parsed.pathMode ?? defaults.pathMode),
    protected: Array.isArray(parsed.protected) ? parsed.protected : defaults.protected,
  };
}

/** Install Stele Cursor integration into `projectRoot`. */
export async function install(projectRoot: string, opts: CursorInstallOptions = {}): Promise<void> {
  const config = await loadSteleConfig(projectRoot);
  const rulesDir = path.join(projectRoot, ".cursor", "rules");
  const rulesFile = path.join(rulesDir, "stele.md");

  await assertSafeToWrite(rulesFile, opts.force ?? false);

  const contract = await tryLoadContract(projectRoot, config);
  await mkdir(rulesDir, { recursive: true });
  await writeFile(rulesFile, renderRulesMarkdown(config, contract), "utf-8");

  if (opts.enableShell) {
    await writeComposerHook(projectRoot);
  }

  process.stdout.write(formatInstallMessage(rulesFile, opts.enableShell ?? false));
}

/** Remove the Stele-managed Cursor files. Idempotent. */
export async function uninstall(projectRoot: string): Promise<void> {
  const rulesFile = path.join(projectRoot, ".cursor", "rules", "stele.md");
  const composerScript = path.join(projectRoot, ".cursor", "composer", "stele-check.sh");

  await rm(rulesFile, { force: true });
  await rm(composerScript, { force: true });

  process.stdout.write("Removed Stele Cursor integration.\n");
}

/** Render the static rules markdown. Always starts with {@link AUTO_MARKER}. */
export function renderRulesMarkdown(
  config: SteleConfig,
  contract: { invariants: ReadonlyArray<{ id: string; severity: string; description: string }> } | null,
): string {
  const invariants = contract?.invariants ?? [];
  const max = 30;
  const head = invariants.slice(0, max);
  const overflow = invariants.length > max ? `\n\n_(+ ${invariants.length - max} more)_` : "";

  const sections = [
    AUTO_MARKER,
    "# Stele Contract Rules (auto-generated)",
    "",
    "> This project uses Stele for contract enforcement. Direct edits to protected paths are blocked by CI.",
    "> Do not edit this file; it is regenerated by `stele install --agent cursor`.",
    "> For custom rules, create `.cursor/rules/stele.user.md` (Cursor reads all .md in rules/).",
    "",
    "## Protected Paths",
    "",
    config.protected.map((p) => `- \`${p}\``).join("\n"),
    "",
    "## Active Invariants",
    "",
    invariants.length === 0
      ? "_(none currently defined)_"
      : head.map((inv) => `- **${sanitizeInvariantText(inv.id, 64)}** (${sanitizeInvariantText(inv.severity, 32)}): ${sanitizeInvariantText(inv.description)}`).join("\n") + overflow,
    "",
    "## Rules for Agent",
    "",
    "1. Do not edit files under `contract/` or `tests/contract/` directly.",
    "2. To add a new invariant, run `stele propose invariant --apply ...`.",
    "3. To modify or delete an existing invariant, ask the human user; this requires human review.",
    "4. Run `stele check` after edits to verify contracts still pass.",
    "",
    "_Generated by stele install --agent cursor._",
    "",
  ];

  return sections.join("\n");
}

async function assertSafeToWrite(rulesFile: string, force: boolean): Promise<void> {
  let existing: string;
  try {
    existing = await readFile(rulesFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }

  if (existing.startsWith(AUTO_MARKER) || force) {
    return;
  }

  throw new SteleError(
    "E_CURSOR_RULES_OVERWRITE",
    "AgentHooksError",
    `${rulesFile} exists and was not auto-generated. Use --force to overwrite.`,
    undefined,
    undefined,
    "Move custom rules to a separate file like .cursor/rules/stele.user.md (Cursor reads all .md in rules/).",
  );
}

async function tryLoadContract(
  projectRoot: string,
  config: SteleConfig,
): Promise<{ invariants: ReadonlyArray<{ id: string; severity: string; description: string }> } | null> {
  try {
    const contract = await loadContract(path.resolve(projectRoot, config.entry));
    return {
      invariants: contract.invariants.map((inv) => ({
        id: inv.id,
        severity: inv.severity,
        description: inv.description,
      })),
    };
  } catch {
    return null;
  }
}

async function writeComposerHook(projectRoot: string): Promise<void> {
  const composerDir = path.join(projectRoot, ".cursor", "composer");
  await mkdir(composerDir, { recursive: true });
  const script =
    "#!/usr/bin/env bash\n" +
    "set -e\n" +
    "# Generated by `stele install --agent cursor --enable-shell`.\n" +
    "# Runs `stele check` after composer-rule actions and saves the JSON report.\n" +
    "npx stele check --json | tee .cursor/last-stele-report.json\n";
  await writeFile(path.join(composerDir, "stele-check.sh"), script, { mode: 0o755 });
}

function formatInstallMessage(rulesFile: string, enableShell: boolean): string {
  return [
    `Installed Stele rules into ${rulesFile}.`,
    enableShell ? "Composer shell hook installed at .cursor/composer/stele-check.sh." : "",
    "Note: Cursor static rules are best-effort; agents may ignore them.",
    "For hard enforcement use @stele/github-action.",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n") + "\n";
}
