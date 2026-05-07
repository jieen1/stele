#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { runAddChecker } from "./commands/addChecker.js";
import {
  formatBaselineSummary,
  runBaselineInit,
  runBaselineUpdate,
  type BaselineCommandOptions,
  type BaselineCommandSummary,
} from "./commands/baseline.js";
import {
  checkProject,
  formatCheckReportHuman,
  formatCheckReportJson,
  isCheckCommandError,
  type CheckCommandOptions,
  type CheckCommandResult,
  type CheckSummary,
  writeCheckReportFile,
} from "./commands/check.js";
import { runAgentContext, type AgentContextOptions } from "./commands/agentContext.js";
import { runExplain, type ExplainOptions } from "./commands/explain.js";
import { runGenerate, type GenerateOptions, type GenerateSummary } from "./commands/generate.js";
import { runInit, SUPPORTED_LANGUAGES } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { lockProject, type LockOptions, type LockSummary } from "./commands/lock.js";
import { runMaintenanceSummary, type MaintenanceSummaryOptions } from "./commands/maintenance.js";
import { runPropose, type ProposeOptions } from "./commands/propose.js";
import { runRules, type RulesOptions } from "./commands/rules.js";
import { runWhy, type WhyOptions } from "./commands/why.js";
import { runDev, type DevOptions } from "./commands/dev.js";
import { runDoc, type DocOptions } from "./commands/doc.js";
import { unlockProject, type UnlockOptions, type UnlockSummary } from "./commands/unlock.js";
import { getExitCode } from "./errors.js";

const STELE_CLI_VERSION = "0.1.0";

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
};

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
  const program = new Command();

  program
    .name("stele")
    .description("Contract management for AI-assisted development")
    .version(STELE_CLI_VERSION)
    .option("--stele-version", "print Stele CLI version")
    .action((options: { steleVersion?: boolean }) => {
      if (options.steleVersion) {
        process.stdout.write(formatVersion());
        return;
      }

      program.help();
    });

  program.command("version").description("Print Stele CLI version.").action(() => {
    process.stdout.write(formatVersion());
  });
  program
    .command("baseline-init")
    .description("Initialize a baseline to suppress known contract violations.")
    .requiredOption("--reason <reason>", "reason for creating the baseline")
    .action(async (options: BaselineCommandOptions) => {
      const result = await baselineInit(cwd(), options);
      if (isBaselineSummary(result)) {
        process.stdout.write(formatBaselineSummary("initialized", result));
      }
    });
  program
    .command("baseline-update")
    .description("Update an existing baseline with the latest contract state.")
    .requiredOption("--reason <reason>", "reason for updating the baseline")
    .action(async (options: BaselineCommandOptions) => {
      const result = await baselineUpdate(cwd(), options);
      if (isBaselineSummary(result)) {
        process.stdout.write(formatBaselineSummary("updated", result));
      }
    });
  program
    .command("check")
    .description("Verify contract invariants against generated tests and protected files.")
    .option("--diff-from <base>", "limit failures to files changed since the given git base")
    .option("--json", "emit the check report as JSON")
    .option("--report-file <path>", "write the JSON check report to a file")
    .option("--lenient", "skip code-shape checks (faster)")
    .action(async (options: CheckCommandOptions) => {
      try {
        const result = await check(cwd(), options);

        if (isCheckCommandResult(result)) {
          if (options.reportFile) {
            await writeCheckReportFile(cwd(), options.reportFile, result.report);
          }

          process.stdout.write(options.json ? formatCheckReportJson(result.report) : formatCheckSummary(result.summary));
        }
      } catch (error) {
        if (!isCheckCommandError(error)) {
          throw error;
        }

        if (options.reportFile) {
          await writeCheckReportFile(cwd(), options.reportFile, error.report);
        }

        if (options.json) {
          process.stdout.write(formatCheckReportJson(error.report));
        } else {
          process.stderr.write(formatCheckReportHuman(error.report));
        }

        process.exitCode = getExitCode(error) ?? 1;
      }
    });
  program
    .command("generate")
    .description("Generate contract test files from the contract source.")
    .option("--force", "overwrite existing generated files")
    .action(async (options) => {
      const result = await generate(cwd(), options);
      if (isGenerateSummary(result)) {
        process.stdout.write(formatGenerateSummary(result));
      }
    });
  program
    .command("lock")
    .description("Lock the manifest by recording SHA-256 hashes of all protected files.")
    .option("--reason <reason>", "reason for locking the manifest")
    .action(async (options) => {
      const result = await lock(cwd(), options);
      if (isLockSummary(result)) {
        process.stdout.write(formatLockSummary(result));
      }
    });
  program
    .command("list")
    .description("List all contract invariants with their metadata.")
    .option("--severity <severity>", "filter by severity level")
    .option("--category <category>", "filter by category")
    .option("--tag <tag>", "filter by tag")
    .option("--format <format>", "output format (table|json)", "table")
    .action((options) => list(cwd(), options));
  program
    .command("rules")
    .description("Display the contract rule inventory with severity and category details.")
    .option("--json", "emit machine-readable rule inventory")
    .action((options: RulesOptions) => rules(cwd(), options));
  program
    .command("explain <id>")
    .description("Explain a specific contract invariant by its ID.")
    .option("--json", "emit machine-readable rule explanation")
    .action((id, options: ExplainOptions) => explain(cwd(), id, options));
  program
    .command("agent-context")
    .description("Generate context for AI agents about the current contract state.")
    .option("--json", "emit machine-readable agent context")
    .option("--focus <paths...>", "focus context on one or more changed files")
    .action((options: AgentContextOptions) => agentContext(cwd(), options));
  program
    .command("why <id-or-fingerprint>")
    .description("Show the rationale behind a contract violation.")
    .option("--json", "emit machine-readable why output")
    .action((idOrFingerprint, options: WhyOptions) => why(cwd(), idOrFingerprint, options));
  program
    .command("add-checker <checker-id>")
    .description("Add a new checker implementation for external validation.")
    .action((checkerId) => addChecker(cwd(), checkerId));
  program
    .command("propose")
    .description("Add contract knowledge through constrained proposal commands.")
    .command("invariant")
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
    .command("maintenance-summary")
    .description("Summarize contract maintenance activity across changes.")
    .option("--from <git-ref>", "compare against the given git reference")
    .option("--output <path>", "write the summary to a file")
    .action((options: MaintenanceSummaryOptions) => maintenanceSummary(cwd(), options));
  program
    .command("init")
    .description("Initialize Stele in the current project.")
    .addOption(new Option("--language <language>", "target language").default("python").choices(SUPPORTED_LANGUAGES))
    .action((options) => init(cwd(), options));
  program
    .command("dev")
    .description("Watch for contract changes and auto-regenerate")
    .option("--once", "run once and exit (no watch)")
    .action(async (options: DevOptions) => {
      await runDev(cwd(), options);
    });
  program
    .command("unlock")
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
    .command("doc")
    .description("Generate contract documentation")
    .option("--format <format>", "output format (markdown|html)", "markdown")
    .option("--output <path>", "output directory")
    .action(async (options: DocOptions) => {
      await runDoc(cwd(), options);
    });

  return program;
}

function formatCheckSummary(summary: CheckSummary): string {
  return `OK ${summary.invariantCount} invariant${summary.invariantCount === 1 ? "" : "s"} checked; ${summary.generatedFileCount} generated file${summary.generatedFileCount === 1 ? "" : "s"} and ${summary.protectedFileCount} protected file${summary.protectedFileCount === 1 ? "" : "s"} verified.\n`;
}

function formatLockSummary(summary: LockSummary): string {
  return `OK manifest locked: ${summary.manifestPath} (${summary.invariantCount} invariant${summary.invariantCount === 1 ? "" : "s"}, ${summary.protectedFileCount} protected file${summary.protectedFileCount === 1 ? "" : "s"}).\n`;
}

function formatGenerateSummary(summary: GenerateSummary): string {
  return `OK generated ${summary.generatedFileCount} file${summary.generatedFileCount === 1 ? "" : "s"} in ${summary.generatedDir}.\n`;
}

function formatVersion(): string {
  return `${STELE_CLI_VERSION}\n`;
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
