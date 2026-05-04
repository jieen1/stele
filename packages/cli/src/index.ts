#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { runAddChecker } from "./commands/addChecker.js";
import { runCheck } from "./commands/check.js";
import { runExplain } from "./commands/explain.js";
import { runGenerate } from "./commands/generate.js";
import { runInit, SUPPORTED_LANGUAGES } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { runLock } from "./commands/lock.js";

type ProgramDependencies = {
  cwd?: () => string;
  runCheck?: typeof runCheck;
  runGenerate?: typeof runGenerate;
  runLock?: typeof runLock;
  runInit?: typeof runInit;
  runList?: typeof runList;
  runExplain?: typeof runExplain;
  runAddChecker?: typeof runAddChecker;
};

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const check = dependencies.runCheck ?? runCheck;
  const generate = dependencies.runGenerate ?? runGenerate;
  const lock = dependencies.runLock ?? runLock;
  const init = dependencies.runInit ?? runInit;
  const list = dependencies.runList ?? runList;
  const explain = dependencies.runExplain ?? runExplain;
  const addChecker = dependencies.runAddChecker ?? runAddChecker;
  const program = new Command();

  program.name("stele").description("Contract management for AI-assisted development").version("0.1.0");

  program.command("check").action(() => check(cwd()));
  program.command("generate").option("--force").action((options) => generate(cwd(), options));
  program.command("lock").option("--reason <reason>").action((options) => lock(cwd(), options));
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

export async function runCli(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
