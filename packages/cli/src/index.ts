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
import { runExplain } from "./commands/explain.js";
import { runGenerate, type GenerateOptions, type GenerateSummary } from "./commands/generate.js";
import { runInit, SUPPORTED_LANGUAGES } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { lockProject, type LockOptions, type LockSummary } from "./commands/lock.js";
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
  runExplain?: typeof runExplain;
  runAddChecker?: typeof runAddChecker;
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
  program.command("baseline-init").requiredOption("--reason <reason>").action(async (options: BaselineCommandOptions) => {
    const result = await baselineInit(cwd(), options);
    if (isBaselineSummary(result)) {
      process.stdout.write(formatBaselineSummary("initialized", result));
    }
  });
  program.command("baseline-update").requiredOption("--reason <reason>").action(async (options: BaselineCommandOptions) => {
    const result = await baselineUpdate(cwd(), options);
    if (isBaselineSummary(result)) {
      process.stdout.write(formatBaselineSummary("updated", result));
    }
  });
  program
    .command("check")
    .option("--diff-from <base>", "limit failures to files changed since the given git base")
    .option("--json", "emit the check report as JSON")
    .option("--report-file <path>", "write the JSON check report to a file")
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
  program.command("generate").option("--force").action(async (options) => {
    const result = await generate(cwd(), options);
    if (isGenerateSummary(result)) {
      process.stdout.write(formatGenerateSummary(result));
    }
  });
  program.command("lock").option("--reason <reason>").action(async (options) => {
    const result = await lock(cwd(), options);
    if (isLockSummary(result)) {
      process.stdout.write(formatLockSummary(result));
    }
  });
  program
    .command("list")
    .option("--severity <severity>")
    .option("--category <category>")
    .option("--tag <tag>")
    .action((options) => list(cwd(), options));
  program.command("explain <id>").action((id) => explain(cwd(), id));
  program.command("add-checker <checker-id>").action((checkerId) => addChecker(cwd(), checkerId));
  program
    .command("init")
    .addOption(new Option("--language <language>", "target language").default("python").choices(SUPPORTED_LANGUAGES))
    .action((options) => init(cwd(), options));

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
