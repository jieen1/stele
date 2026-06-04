#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { Command, Option } from "commander";
import { commandName } from "@stele/core";

export { DEFAULT_CONFIG, type SteleConfig } from "./config/defaults.js";
export { loadConfig } from "./config/loadConfig.js";

/**
 * Phase 1.5 self-dogfooding helper: validate a CLI command name through
 * the `commandName` smart constructor, then concatenate any positional
 * argument spec (e.g. `<node-id>`, `[options]`) Commander accepts in the
 * first argument of `program.command(...)`. The CommandName branded type
 * only admits lowercase-with-dashes — positional specs would fail the
 * shape check, so we keep them outside the brand.
 */
function cmdSpec(name: string, positional = ""): string {
  const validated = commandName(name);
  return positional ? `${validated} ${positional}` : validated;
}

import { runAddChecker } from "./commands/addChecker.js";
import { formatCacheClean, formatCacheInfo, runCacheClean, runCacheInfo } from "./commands/cache.js";
import {
  formatBaselineSummary,
  runBaselineInit,
  runBaselineUpdate,
  type BaselineCommandOptions,
  type BaselineCommandSummary,
} from "./commands/baseline.js";
import {
  checkProject,
  formatCheckSummary,
  isCheckCommandError,
  type CheckCommandOptions,
  type CheckCommandResult,
  writeCheckReportFile,
} from "./commands/check.js";
import { runCheckRecursive } from "./commands/check-recursive.js";
import { formatCheckReport } from "./report/formatter.js";
import { runAgentContext, type AgentContextOptions } from "./commands/agentContext.js";
import { runExplain, type ExplainOptions } from "./commands/explain.js";
import { runExplainEffect, type ExplainEffectOptions } from "./commands/explain-effect.js";
import { runGenerate, runGenerateRecursive, type GenerateOptions, type GenerateSummary } from "./commands/generate.js";
import { runInit, SUPPORTED_LANGUAGES, type InitOptions } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { lockProject, runLockRecursive, type LockOptions, type LockSummary } from "./commands/lock.js";
import { runMaintenanceSummary, type MaintenanceSummaryOptions } from "./commands/maintenance.js";
import { runObserve, type ObserveOptions } from "./commands/observe.js";
import { startMcpServer } from "./commands/mcp.js";
import { runPropose, type ProposeOptions } from "./commands/propose.js";
import { runRules, type RulesOptions } from "./commands/rules.js";
import { runWhy, type WhyOptions } from "./commands/why.js";
import { runDev, type DevOptions } from "./commands/dev.js";
import { runDoc, type DocOptions } from "./commands/doc.js";
import { addDesignCommand } from "./commands/design/index.js";
import { addIncidentCommand } from "./commands/incident/index.js";
export {
  runIncidentDraft,
  runIncidentTeeth,
  runIncidentApprove,
  type IncidentDraftResult,
  type IncidentTeethResult,
  type IncidentApproveResult,
} from "./commands/incident/lib.js";
export type { IncidentDraftOptions } from "./commands/incident/draft.js";
export type { IncidentTeethOptions } from "./commands/incident/teeth.js";
export type { IncidentApproveOptions } from "./commands/incident/approve.js";
import { unlockProject, type UnlockOptions, type UnlockSummary } from "./commands/unlock.js";
import { runComplexitySuggest, runComplexityMeasure, type ComplexityOptions } from "./commands/complexity.js";
import { getExitCode } from "./errors.js";
import { runScore } from "./commands/score.js";
import { runPluginInstall, type PluginInstallOptions } from "./commands/plugin-install.js";
import { runDoctor, type DoctorOptions } from "./commands/doctor.js";
import { STELE_VERSION } from "./version.js";

type ProgramDependencies = {
  cwd?: () => string;
  runBaselineInit?: (projectDir: string, options: BaselineCommandOptions) => Promise<BaselineCommandSummary | void>;
  runBaselineUpdate?: (projectDir: string, options: BaselineCommandOptions) => Promise<BaselineCommandSummary | void>;
  runCheck?: (projectDir: string, options: CheckCommandOptions) => Promise<CheckCommandResult | void>;
  runGenerate?: (projectDir: string, options: GenerateOptions) => Promise<GenerateSummary | void>;
  runLock?: (projectDir: string, options: LockOptions) => Promise<LockSummary | void>;
  runInit?: typeof runInit;
  runList?: typeof runList;
  runExplain?: (projectDir: string, invariantId: string, options?: ExplainOptions) => Promise<void>;
  runAddChecker?: typeof runAddChecker;
  runRules?: (projectDir: string, options?: RulesOptions) => Promise<void>;
  runAgentContext?: (projectDir: string, options?: AgentContextOptions) => Promise<void>;
  runWhy?: (projectDir: string, idOrFingerprint: string, options?: WhyOptions) => Promise<void>;
  runPropose?: (projectDir: string, options: ProposeOptions) => Promise<void>;
  runMaintenanceSummary?: (projectDir: string, options?: MaintenanceSummaryOptions) => Promise<void>;
  runObserve?: (projectDir: string, options?: ObserveOptions) => Promise<void>;
};

/** Alias for complexity contract targeting. */
export { createProgram as createSteleProgram };

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const baselineInit = dependencies.runBaselineInit ?? runBaselineInit;
  const baselineUpdate = dependencies.runBaselineUpdate ?? runBaselineUpdate;
  const check = dependencies.runCheck ?? checkProject;
  const generate = dependencies.runGenerate ?? runGenerate;
  const lock = dependencies.runLock ?? lockProject;
  const init = dependencies.runInit ?? runInit;
  const list = dependencies.runList ?? runList;
  const explain = dependencies.runExplain ?? runExplain;
  const addChecker = dependencies.runAddChecker ?? runAddChecker;
  const rules = dependencies.runRules ?? runRules;
  const agentContext = dependencies.runAgentContext ?? runAgentContext;
  const why = dependencies.runWhy ?? runWhy;
  const propose = dependencies.runPropose ?? runPropose;
  const maintenanceSummary = dependencies.runMaintenanceSummary ?? runMaintenanceSummary;
  const observe = dependencies.runObserve ?? runObserve;
  const program = new Command();

  program
    .name("stele")
    .description("Contract management for AI-assisted development")
    .version(STELE_VERSION)
    .option("--stele-version", "print Stele CLI version")
    .action((options: { steleVersion?: boolean }) => {
      if (options.steleVersion) {
        process.stdout.write(formatVersion());
        return;
      }

      program.help();
    });

  program.command(cmdSpec("version")).description("Print Stele CLI version.").action(() => {
    process.stdout.write(formatVersion());
  });
  program
    .command(cmdSpec("baseline-init"))
    .description("Initialize a baseline to suppress known contract violations.")
    .requiredOption("--reason <reason>", "reason for creating the baseline")
    .action(async (options: BaselineCommandOptions) => {
      const result = await baselineInit(cwd(), options);
      if (isBaselineSummary(result)) {
        process.stdout.write(formatBaselineSummary("initialized", result));
      }
    });
  program
    .command(cmdSpec("baseline-update"))
    .description("Update an existing baseline with the latest contract state.")
    .requiredOption("--reason <reason>", "reason for updating the baseline")
    .action(async (options: BaselineCommandOptions) => {
      const result = await baselineUpdate(cwd(), options);
      if (isBaselineSummary(result)) {
        process.stdout.write(formatBaselineSummary("updated", result));
      }
    });
  program
    .command(cmdSpec("check"))
    .description("Verify contract invariants against generated tests and protected files.")
    .option("--diff [ref]", "only check invariants in contract files that changed since the given git ref (default: HEAD)")
    .option("--diff-from <base>", "limit failures to files changed since the given git base")
    .option("--format <format>", "output format (human|json|sarif)", "human")
    .option("--json", "deprecated; use --format json")
    .option("--report-file <path>", "write the JSON check report to a file")
    .option("--lenient", "skip code-shape checks (faster)")
    .option("--architecture-only", "only check architecture constraints (skip code-shape)", false)
    .option("--complexity-only", "only check complexity metrics (skip code-shape)", false)
    .option("--recursive", "auto-discover stele.config.json files and check each project", false)
    .action(async (options: CheckCommandOptions) => {
      const fmt = options.json ? "json" : (options.format ?? "human");
      const isJson = fmt !== "human";

      if (options.recursive) {
        try {
          const result = await runCheckRecursive(cwd(), { ...options, json: isJson }, {
            stdout: (chunk) => process.stdout.write(chunk),
            stderr: (chunk) => process.stderr.write(chunk),
          });
          if (result.exitCode !== 0) {
            process.exitCode = result.exitCode;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`${message}\n`);
          process.exitCode = getExitCode(error) ?? 1;
        }
        return;
      }

      try {
        const result = await check(cwd(), options);

        if (isCheckCommandResult(result)) {
          if (options.reportFile) {
            await writeCheckReportFile(cwd(), options.reportFile, result.report);
          }

          process.stdout.write(isJson ? formatCheckReport(result.report, fmt) : formatCheckSummary(result.summary));
        }
      } catch (error) {
        if (!isCheckCommandError(error)) {
          throw error;
        }

        if (options.reportFile) {
          await writeCheckReportFile(cwd(), options.reportFile, error.report);
        }

        if (isJson) {
          process.stdout.write(formatCheckReport(error.report, fmt));
        } else {
          process.stderr.write(formatCheckReport(error.report, "human"));
        }

        process.exitCode = getExitCode(error) ?? 1;
      }
    });
  program
    .command(cmdSpec("generate"))
    .description("Generate contract test files from the contract source.")
    .option("--force", "ignore the incremental cache; regenerate every file")
    .option("--no-cache", "skip cache (do not read or write); always regenerate")
    .option("--json", "emit aggregate JSON output (only with --recursive)")
    .option("--recursive", "auto-discover stele.config.json files and generate for each project", false)
    .action(async (rawOptions: GenerateOptions & { cache?: boolean }) => {
      // Commander's `--no-cache` flag emits `cache: false` when set; translate
      // to the GenerateOptions `noCache: true` shape.
      const options: GenerateOptions = {
        force: rawOptions.force,
        noCache: rawOptions.cache === false ? true : rawOptions.noCache,
        recursive: rawOptions.recursive,
        json: rawOptions.json,
      };
      if (options.recursive) {
        try {
          const result = await runGenerateRecursive(cwd(), options, {
            stdout: (chunk) => process.stdout.write(chunk),
            stderr: (chunk) => process.stderr.write(chunk),
          });
          if (result.exitCode !== 0) {
            process.exitCode = result.exitCode;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`${message}\n`);
          process.exitCode = getExitCode(error) ?? 1;
        }
        return;
      }

      const result = await generate(cwd(), options);
      if (isGenerateSummary(result)) {
        process.stdout.write(formatGenerateSummary(result));
      }
    });
  program
    .command(cmdSpec("lock"))
    .description("Lock the manifest by recording SHA-256 hashes of all protected files.")
    .option("--reason <reason>", "reason for locking the manifest")
    .option("--json", "emit aggregate JSON output (only with --recursive)")
    .option("--recursive", "auto-discover stele.config.json files and lock each project", false)
    .action(async (options: LockOptions) => {
      if (options.recursive) {
        try {
          const result = await runLockRecursive(cwd(), options, {
            stdout: (chunk) => process.stdout.write(chunk),
            stderr: (chunk) => process.stderr.write(chunk),
          });
          if (result.exitCode !== 0) {
            process.exitCode = result.exitCode;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`${message}\n`);
          process.exitCode = getExitCode(error) ?? 1;
        }
        return;
      }

      const result = await lock(cwd(), options);
      if (isLockSummary(result)) {
        process.stdout.write(formatLockSummary(result));
      }
    });
  program
    .command(cmdSpec("list"))
    .description("List all contract invariants with their metadata.")
    .option("--severity <severity>", "filter by severity level")
    .option("--category <category>", "filter by category")
    .option("--tag <tag>", "filter by tag")
    .option("--format <format>", "output format (table|json)", "table")
    .action((options) => list(cwd(), options));
  program
    .command(cmdSpec("rules"))
    .description("Display the contract rule inventory with severity and category details.")
    .option("--json", "emit machine-readable rule inventory")
    .action((options: RulesOptions) => rules(cwd(), options));
  const explainCommand = program
    .command(cmdSpec("explain"))
    .description("Explain a contract rule or effect propagation chain.");
  explainCommand
    .argument("[id]", "invariant id (or use a subcommand)")
    .option("--json", "emit machine-readable rule explanation")
    .action(async (id: string | undefined, options: ExplainOptions) => {
      if (id === undefined) {
        explainCommand.help();
        return;
      }
      await explain(cwd(), id, options);
    });
  const effectSubcommand = explainCommand
    .command(cmdSpec("effect", "<node-id>"))
    .description("Show effect propagation chain and applicable policies for a node.")
    .option("--no-cache", "force re-extraction of the call graph (skip on-disk cache).")
    .action(async (nodeId: string) => {
      // `--json` is declared on the parent `explain` command so the existing
      // `stele explain <id> --json` syntax keeps working. Commander does not
      // duplicate-detect across parent and child, so we read the merged
      // options here via `optsWithGlobals()`.
      const merged = effectSubcommand.optsWithGlobals() as {
        json?: boolean;
        cache?: boolean;
      };
      const explainEffectOptions: ExplainEffectOptions = {
        json: merged.json,
        noCache: merged.cache === false,
      };
      const result = await runExplainEffect(cwd(), nodeId, explainEffectOptions);
      process.stdout.write(result.output);
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    });
  program
    .command(cmdSpec("agent-context"))
    .description("Generate context for AI agents about the current contract state.")
    .option("--json", "emit machine-readable agent context")
    .option("--focus <paths...>", "focus context on one or more changed files")
    .action((options: AgentContextOptions) => agentContext(cwd(), options));
  program
    .command(cmdSpec("why", "<id-or-fingerprint>"))
    .description("Show the rationale behind a contract violation.")
    .option("--json", "emit machine-readable why output")
    .action((idOrFingerprint, options: WhyOptions) => why(cwd(), idOrFingerprint, options));
  program
    .command(cmdSpec("add-checker", "<checker-id>"))
    .description("Add a new checker implementation for external validation.")
    .action((checkerId) => addChecker(cwd(), checkerId));
  program
    .command(cmdSpec("propose"))
    .description("Add contract knowledge through constrained proposal commands.")
    .command(cmdSpec("invariant"))
    .description("Propose a new contract invariant.")
    .requiredOption("--id <id>", "unique invariant identifier")
    .requiredOption("--severity <severity>", "severity level (error|warning|info)")
    .requiredOption("--description <description>", "human-readable description of the invariant")
    .requiredOption("--assert <assert>", "CDL assertion expression")
    .option("--category <category>", "invariant category")
    .option("--rationale <rationale>", "rationale explaining why this invariant exists")
    .option("--apply", "apply the invariant immediately")
    .action((options) =>
      propose(cwd(), {
        kind: "invariant",
        id: options.id,
        severity: options.severity,
        description: options.description,
        assert: options.assert,
        category: options.category,
        rationale: options.rationale,
        apply: options.apply,
      }),
    );
  program
    .command(cmdSpec("maintenance-summary"))
    .description("Summarize contract maintenance activity across changes.")
    .option("--from <git-ref>", "compare against the given git reference")
    .option("--output <path>", "write the summary to a file")
    .action((options: MaintenanceSummaryOptions) => maintenanceSummary(cwd(), options));
  program
    .command(cmdSpec("observe"))
    .description("Analyze agent observation data for invariant health trends.")
    .option("--json", "emit the observation summary as JSON")
    .option("--since <iso-date>", "filter observations since the given ISO date")
    .action((options: ObserveOptions) => observe(cwd(), options));
  program
    .command(cmdSpec("mcp"))
    .description("Start MCP server for AI agent integration")
    .action(() => startMcpServer());
  program
    .command(cmdSpec("init"))
    .description("Initialize Stele in the current project.")
    .addOption(new Option("--language <language>", "target language").default("python").choices(SUPPORTED_LANGUAGES))
    .option("--dry-run", "show what files would be created without writing")
    .option("--pre-commit", "install Stele hooks into .pre-commit-config.yaml", false)
    .option("--ci <provider>", "add CI workflow (github-actions|gitlab-ci)")
    .option("--with-example-fixtures", "scaffold example checker implementations and richer context fixture (python + typescript only)", false)
    .action((options: InitOptions) => init(cwd(), options));
  program
    .command(cmdSpec("dev"))
    .description("Watch for contract changes and auto-regenerate")
    .option("--once", "run once and exit (no watch)")
    .action(async (options: DevOptions) => {
      await runDev(cwd(), options);
    });
  program
    .command(cmdSpec("unlock"))
    .description("Temporarily remove manifest and baseline locks (emergency only)")
    .requiredOption("--reason <reason>")
    .option("--confirm")
    .action(async (options: UnlockOptions) => {
      try {
        const result = await unlockProject(cwd(), options);
        if (isUnlockSummary(result)) {
          process.stdout.write(
            `[stele] Unlocked: removed ${result.manifestPath} and ${result.baselinePath}.\n` +
              `[stele] Edit contract files manually, then re-run:\n` +
              `  stele generate --force\n` +
              `  stele lock --reason "your reason"\n`,
          );
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[stele] ${err}\n`);
        process.exitCode = 1;
      }
    });
  program
    .command(cmdSpec("doc"))
    .description("Generate contract documentation")
    .option("--format <format>", "output format (markdown|html)", "markdown")
    .option("--output <path>", "output directory")
    .action(async (options: DocOptions) => {
      await runDoc(cwd(), options);
    });
  program
    .command(cmdSpec("score"))
    .description("Compute a 0-10 contract health score.")
    .option("--json", "emit score as JSON")
    .option("--threshold <n>", "fail with exit code 6 if score is below threshold", parseFloat)
    .action(async (options: { json?: boolean; threshold?: number }) => {
      await runScore(cwd(), options);
    });

  const complexityCommand = program
    .command(cmdSpec("complexity"))
    .description("Analyze code complexity and core-node metrics.");

  complexityCommand
    .command(cmdSpec("suggest"))
    .description("Scan project for classes that should have core-node contracts.")
    .option("--json", "emit JSON output")
    .option("--output <path>", "write results to a file")
    .action(async (options: ComplexityOptions) => {
      await runComplexitySuggest(cwd(), options);
    });

  complexityCommand
    .command(cmdSpec("measure"))
    .description("Measure declared core-node metrics.")
    .option("--json", "emit JSON output")
    .option("--output <path>", "write results to a file")
    .action(async (options: ComplexityOptions) => {
      await runComplexityMeasure(cwd(), options);
    });

  program
    .command(cmdSpec("install"))
    .description("Install Stele integration with an agent IDE (currently: cursor).")
    .requiredOption("--agent <name>", "agent name (cursor | claude-code | continue-dev)")
    .option("--enable-shell", "Enable composer-rule shell hooks (Cursor only)", false)
    .option("--uninstall", "Remove the agent integration", false)
    .option("--force", "Overwrite existing manually-edited rule files (Cursor only)", false)
    .action(async (options: { agent: string; enableShell?: boolean; uninstall?: boolean; force?: boolean }) => {
      await runInstallCommand(cwd(), options);
    });
  const pluginCommand = program
    .command(cmdSpec("plugin"))
    .description("Manage Stele editor plugin integrations.");

  pluginCommand
    .command(cmdSpec("install"))
    .description("Install Stele integration for an editor.")
    .option("--claude-code", "register the @stele/claude-code-plugin with Claude Code", false)
    .option("--user-config-dir <dir>", "override ~/.claude (default: $HOME/.claude)")
    .option("--project-dir <dir>", "project root to register (default: cwd)")
    .option("--dry-run", "show what files would be modified without writing")
    .action(async (options: PluginInstallOptions) => {
      await runPluginInstall(cwd(), options);
    });

  program
    .command(cmdSpec("doctor"))
    .description("Diagnose your Stele setup.")
    .option("--json", "emit findings as JSON instead of human-readable")
    .action(async (options: DoctorOptions) => {
      await runDoctor(cwd(), options);
    });

  addDesignCommand(program);
  addIncidentCommand(program);

  const cacheCommand = program
    .command(cmdSpec("cache"))
    .description("Manage Stele incremental generation cache (contract/.cache/hash-manifest.json).");

  cacheCommand
    .command(cmdSpec("clean"))
    .description("Delete contract/.cache/hash-manifest.json (forces full regeneration on next 'stele generate').")
    .action(async () => {
      const result = await runCacheClean(cwd());
      process.stdout.write(formatCacheClean(result));
    });

  cacheCommand
    .command(cmdSpec("info"))
    .description("Show incremental cache stats (entries, size, generated_at).")
    .action(async () => {
      const result = await runCacheInfo(cwd());
      process.stdout.write(formatCacheInfo(result));
    });

  return program;
}

function formatLockSummary(summary: LockSummary): string {
  return `OK manifest locked: ${summary.manifestPath} (${summary.invariantCount} invariant${summary.invariantCount === 1 ? "" : "s"}, ${summary.protectedFileCount} protected file${summary.protectedFileCount === 1 ? "" : "s"}).\n`;
}

function formatGenerateSummary(summary: GenerateSummary): string {
  const total = summary.generatedFileCount;
  const totalNoun = `${total} file${total === 1 ? "" : "s"}`;
  const breakdown = summary.fullInvalidate
    ? `(${summary.written} written, full regenerate)`
    : `(${summary.written} written, ${summary.skipped} skipped${summary.deleted > 0 ? `, ${summary.deleted} deleted` : ""})`;
  return `OK generated ${totalNoun} in ${summary.generatedDir} ${breakdown}.\n`;
}

function formatVersion(): string {
  return `${STELE_VERSION}\n`;
}

function isCheckCommandResult(value: CheckCommandResult | void): value is CheckCommandResult {
  return typeof value === "object" && value !== null && "summary" in value && "report" in value;
}

function isBaselineSummary(value: BaselineCommandSummary | void): value is BaselineCommandSummary {
  return typeof value === "object" && value !== null && "baselinePath" in value && "violationCount" in value;
}

function isLockSummary(value: LockSummary | void): value is LockSummary {
  return typeof value === "object" && value !== null && "manifestPath" in value && "protectedFileCount" in value;
}

function isGenerateSummary(value: GenerateSummary | void): value is GenerateSummary {
  return typeof value === "object" && value !== null && "generatedDir" in value && "generatedFileCount" in value;
}

function isUnlockSummary(value: UnlockSummary | void): value is UnlockSummary {
  return typeof value === "object" && value !== null && "manifestPath" in value && "baselinePath" in value;
}

export async function runCli(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = getExitCode(error) ?? 1;
  }
}

async function runInstallCommand(
  projectDir: string,
  options: { agent: string; enableShell?: boolean; uninstall?: boolean; force?: boolean },
): Promise<void> {
  const { SteleError } = await import("@stele/core");

  if (options.agent === "cursor") {
    const installerModule = await loadAgentHooksInstaller();
    if (options.uninstall) {
      await installerModule.uninstall(projectDir);
    } else {
      await installerModule.install(projectDir, { enableShell: options.enableShell, force: options.force });
    }
    return;
  }

  if (options.agent === "claude-code") {
    process.stdout.write(
      "Claude Code uses the @stele/claude-code-plugin package directly; no install step is required here.\n",
    );
    return;
  }

  if (options.agent === "continue-dev") {
    throw new SteleError(
      "E_AGENT_NOT_IMPLEMENTED",
      "AgentHooksError",
      "continue-dev adapter is a Phase 3 candidate and not yet implemented.",
    );
  }

  throw new SteleError(
    "E_UNSUPPORTED_AGENT",
    "AgentHooksError",
    `Agent ${options.agent} not supported. Supported: cursor, claude-code, continue-dev.`,
  );
}

async function loadAgentHooksInstaller(): Promise<{
  install: (projectDir: string, opts: { enableShell?: boolean; force?: boolean }) => Promise<void>;
  uninstall: (projectDir: string) => Promise<void>;
}> {
  const dynamicSpecifier = ["@stele", "agent-hooks/install/cursor-installer"].join("/");
  const mod = (await import(dynamicSpecifier)) as {
    install: (projectDir: string, opts: { enableShell?: boolean; force?: boolean }) => Promise<void>;
    uninstall: (projectDir: string) => Promise<void>;
  };
  return mod;
}

{
  const argvScript = process.argv[1];
  let isDirect = false;
  if (argvScript !== undefined) {
    try {
      const realArgv = realpathSync(argvScript);
      const realMeta = fileURLToPath(import.meta.url);
      // Normalize to POSIX for cross-platform comparison
      const argvPosix = posix.normalize(realArgv);
      const metaPosix = posix.normalize(realMeta);
      isDirect = argvPosix === metaPosix;
    } catch {
      // realpath or path conversion failed — fall back to URL comparison
      isDirect = import.meta.url === pathToFileURL(argvScript).href;
    }
  }
  if (isDirect) {
    await runCli();
  }
}
