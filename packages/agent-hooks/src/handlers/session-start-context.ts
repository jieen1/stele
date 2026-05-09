import path from "node:path";
import { loadContract } from "@stele/core";
import type { SessionStartHook } from "../protocol.js";
import type { SteleConfig } from "../util/stele-config-types.js";

/**
 * Build a {@link SessionStartHook} that loads the project contract and
 * returns a context blob for injection into the agent prompt. The format
 * mirrors what `stele agent-context` produces for the Claude Code plugin
 * but is shorter (suitable for static rules / SessionStart messages).
 *
 * Failures (missing contract, parse errors, etc.) produce an empty context
 * string so the host agent can continue without Stele context.
 */
export function createSessionStartContext(config: SteleConfig): SessionStartHook {
  return async ({ projectRoot }) => {
    try {
      const contract = await loadContract(path.resolve(projectRoot, config.entry));
      const summary = renderInvariantSummary(contract.invariants);
      const context = [
        "# Stele Contract Context",
        `Project has ${contract.invariants.length} invariant${contract.invariants.length === 1 ? "" : "s"} under ${config.contractDir}/.`,
        `Protected paths: ${config.protected.join(", ")}.`,
        "",
        "Direct edits to protected paths are blocked. Use `stele propose` for new invariants.",
        "",
        "## Active Invariants",
        summary,
      ].join("\n");
      return { context };
    } catch {
      return { context: "" };
    }
  };
}

function renderInvariantSummary(invariants: ReadonlyArray<{ id: string; severity: string; description: string }>): string {
  if (invariants.length === 0) {
    return "_(none)_";
  }

  const max = 30;
  const slice = invariants.slice(0, max);
  const rendered = slice.map((inv) => `- **${inv.id}** (${inv.severity}): ${inv.description}`).join("\n");

  if (invariants.length > max) {
    return `${rendered}\n_(+ ${invariants.length - max} more)_`;
  }

  return rendered;
}
