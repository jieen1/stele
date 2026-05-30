import type { Command } from "commander";

import { registerIncidentApprove } from "./approve.js";
import { runIncidentDraft } from "./draft.js";
import { registerIncidentTeeth } from "./teeth.js";

/**
 * Registers the `stele incident` parent command and its subcommands. The parent
 * is created exactly once here; teeth + approve attach their own subcommands to
 * the same parent via the registrar functions they export (added in their slices).
 */
export function addIncidentCommand(program: Command): void {
  const incident = program
    .command("incident")
    .description(
      "Incident-to-contract wedge: turn an incident + fix into a locked invariant with a teeth proof.",
    );

  incident
    .command("draft")
    .description(
      "Draft a candidate invariant + negative test from an injected draft (--draft-from). Writes only to .stele/incident/<id>/.",
    )
    .requiredOption("--intent <sentence>", "one-sentence description of the incident")
    .requiredOption("--fix <rev>", "git revision of the fix commit")
    .requiredOption(
      "--draft-from <path>",
      "path to the draft JSON ({invariantCdl,negativeTest,testFilename?}), or '-' for stdin",
    )
    .option("--id <slug>", "incident id (defaults to a slug derived from --intent)")
    .action(async (opts: { intent: string; fix: string; draftFrom: string; id?: string }) => {
      await runIncidentDraft(process.cwd(), {
        intent: opts.intent,
        fix: opts.fix,
        draftFrom: opts.draftFrom,
        id: opts.id,
      });
    });

  registerIncidentTeeth(incident);
  registerIncidentApprove(incident);
}
