import type { HookDecision, StopHook } from "../protocol.js";
import type { SteleConfig } from "../util/stele-config-types.js";

/**
 * Result shape returned by the injected `runStele` callback. Mirrors what
 * the Claude Code plugin's `stop-validate.js` collects from the spawned CLI.
 */
export interface SteleRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Build a {@link StopHook} that runs `stele check --json` (via the injected
 * runner) and converts its exit code into a {@link HookDecision}.
 *
 * - exit 0  -> allow
 * - exit 3  -> deny with manifest-drift hint (run `stele lock --reason`)
 * - other   -> deny with violation count from the JSON report (best effort)
 *
 * The runner is injected so adapters can reuse their own command-resolution
 * logic (project-local node_modules/.bin, .venv, PATH) and to keep the
 * handler pure for unit tests.
 */
export function createStopValidate(
  _config: SteleConfig,
  runStele: (args: string[]) => Promise<SteleRunResult>,
): StopHook {
  return async (): Promise<HookDecision> => {
    const result = await runStele(["check", "--json"]);

    if (result.exitCode === 0) {
      return { action: "allow" };
    }

    if (result.exitCode === 3) {
      return {
        action: "deny",
        reason: "Manifest drift detected. Run `stele lock --reason \"...\"` to update.",
      };
    }

    const report = tryParseJson(result.stdout);
    const violationCount = countViolations(report);
    const summary = violationCount === null ? "?" : String(violationCount);
    return {
      action: "deny",
      reason:
        `Contract check failed (${summary} violation${violationCount === 1 ? "" : "s"}). ` +
        "Fix or suppress with `stele baseline-update` before finishing.",
    };
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function countViolations(report: unknown): number | null {
  if (typeof report !== "object" || report === null) {
    return null;
  }
  const violations = (report as { violations?: unknown }).violations;
  return Array.isArray(violations) ? violations.length : null;
}
