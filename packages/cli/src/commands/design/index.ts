import { Command } from "commander";
import { commandName } from "@stele/core";
import { runDesignInit } from "./init.js";
import { runDesignGenerate } from "./generate.js";
import { runDesignCheck } from "./check.js";
import { runDesignExplain } from "./explain.js";
import { runDesignDiff } from "./diff.js";
import { runDesignPropose } from "./propose.js";
import { runDesignApprove } from "./approve.js";

export function addDesignCommand(program: Command): void {
  const cmd = new Command(commandName("design"));
  cmd.description("Manage DDD + Type-Driven design profiles");

  cmd.addCommand(makeInitCmd());
  cmd.addCommand(makeGenerateCmd());
  cmd.addCommand(makeCheckCmd());
  cmd.addCommand(makeExplainCmd());
  cmd.addCommand(makeDiffCmd());
  cmd.addCommand(makeProposeCmd());
  cmd.addCommand(makeApproveCmd());

  program.addCommand(cmd);
}

function makeInitCmd(): Command {
  const cmd = new Command(commandName("init"));
  cmd.description("Create a design profile from a preset");
  cmd.option("--preset <name>", "preset name (e.g. ddd-typedriven)");
  cmd.option("--answers <path>", "path to answers YAML file");
  cmd.option("--dry-run", "show output without writing");
  cmd.option("--generate", "generate contracts after init");
  cmd.option("--replace", "overwrite existing profile (protected contract change)");
  cmd.action((opts) => runDesignInit(opts));
  return cmd;
}

function makeGenerateCmd(): Command {
  const cmd = new Command(commandName("generate"));
  cmd.description("Compile design profile into generated contracts");
  cmd.option("--dry-run", "show output without writing");
  cmd.option("--force", "force overwrite of generated outputs");
  cmd.option("--reason <reason>", "reason for force overwrite");
  cmd.action((opts) => runDesignGenerate(opts));
  return cmd;
}

function makeCheckCmd(): Command {
  const cmd = new Command(commandName("check"));
  cmd.description("Verify design profile integrity and generated-output drift");
  cmd.option("--profile-only", "validate schema and paths without requiring generation");
  cmd.option("--json", "output JSON");
  cmd.action((opts) => runDesignCheck(opts));
  return cmd;
}

function makeExplainCmd(): Command {
  const cmd = new Command(commandName("explain"));
  cmd.description("Explain a generated rule's design profile origin");
  cmd.argument("<target>", 'e.g. "context:billing", "rule:architecture.ddd.billing.domain.infrastructure", "type:InvoiceId"');
  cmd.option("--json", "output JSON");
  cmd.action((target, opts) => runDesignExplain(target, opts));
  return cmd;
}

function makeDiffCmd(): Command {
  const cmd = new Command(commandName("diff"));
  cmd.description("Compare two design profiles and classify changes");
  cmd.option("--from <ref>", "base commit or ref (e.g. main)");
  cmd.option("--json", "output JSON");
  cmd.action((opts) => runDesignDiff(opts));
  return cmd;
}

function makeProposeCmd(): Command {
  const cmd = new Command(commandName("propose"));
  cmd.description("Propose an add-only design change (agent-safe path)");
  cmd.argument(
    "<type>",
    "type of proposal: invariant, branded-id, aggregate, " +
      "trace-policy, type-state, effect-policy, effect-suppression " +
      "(Round 4 F-A-07: Phase B kinds added)",
  );
  cmd.option("--id <id>", "proposal id");
  cmd.option("--description <text>", "description");
  cmd.option("--evolvability <value>", "evolvability (for invariants)");
  cmd.option("--type-name <name>", "type name (for branded-id)");
  cmd.option("--target <path>", "target path (for branded-id)");
  cmd.action((type, opts) => runDesignPropose(type, opts));
  return cmd;
}

function makeApproveCmd(): Command {
  const cmd = new Command(commandName("approve"));
  cmd.description("Write explicit approval evidence for reviewed profile changes");
  cmd.option("--from <ref>", "base commit or ref");
  cmd.option("--reason <text>", "reason for approval");
  cmd.action((opts) => runDesignApprove(opts));
  return cmd;
}
