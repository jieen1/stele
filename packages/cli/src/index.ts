#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { runAddChecker } from "./commands/addChecker.js";
import { checkProject, type CheckSummary } from "./commands/check.js";
import { runExplain } from "./commands/explain.js";
import { runGenerate } from "./commands/generate.js";
import { runInit, SUPPORTED_LANGUAGES } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { lockProject, type LockOptions, type LockSummary } from "./commands/lock.js";
import { getExitCode } from "./errors.js";

type ProgramDependencies = {
  cwd?: () => string;
  runCheck?: (projectDir: string) => Promise<CheckSummary | void>;
  runGenerate?: typeof runGenerate;
  runLock?: (projectDir: string, options: LockOptions) => Promise<LockSummary | void>;
  runInit?: typeof runInit;
  runList?: typeof runList;
  runExplain?: typeof runExplain;
  runAddChecker?: typeof runAddChecker;
};

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const check = dependencies.runCheck ?? checkProject;
  const generate = dependencies.runGenerate ?? runGenerate;
  const lock = dependencies.runLock ?? lockProject;
  const init = dependencies.runInit ?? runInit;
  const list = dependencies.runList ?? runList;
  const explain = dependencies.runExplain ?? runExplain;
  const addChecker = dependencies.runAddChecker ?? runAddChecker;
  const program = new Command();

  program.name("stele").description("Contract management for AI-assisted development").version("0.1.0");

  program.command("check").action(async () => {
    const result = await check(cwd());
    if (isCheckSummary(result)) {
      process.stdout.write(formatCheckSummary(result));
    }
  });
  program.command("generate").option("--force").action((options) => generate(cwd(), options));
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

function isCheckSummary(value: CheckSummary | void): value is CheckSummary {
  return typeof value === "object" && value !== null && "invariantCount" in value && "generatedFileCount" in value;
}

function isLockSummary(value: LockSummary | void): value is LockSummary {
  return typeof value === "object" && value !== null && "manifestPath" in value && "protectedFileCount" in value;
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
