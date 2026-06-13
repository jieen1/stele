import * as core from "@actions/core";
import { runCheck } from "./modes/check.js";
import { runGenerate } from "./modes/generate.js";
import { runReverify } from "./modes/reverify.js";

export interface MainDeps {
  getInput?: (name: string) => string;
  setFailed?: (message: string) => void;
  runCheck?: () => Promise<void>;
  runGenerate?: () => Promise<void>;
  runReverify?: () => Promise<void>;
}

const LOCK_REJECTION_MESSAGE =
  "mode=lock is not supported. It was removed in @stele/github-action v0.2 because auto-lock would silently approve manifest drift. Run `stele lock` locally after review, or wire a manual `workflow_dispatch` job that you trigger explicitly.";

export async function main(deps: MainDeps = {}): Promise<void> {
  const getInput = deps.getInput ?? ((name: string) => core.getInput(name));
  const setFailed = deps.setFailed ?? ((message: string) => core.setFailed(message));
  const check = deps.runCheck ?? runCheck;
  const generate = deps.runGenerate ?? runGenerate;
  const reverify = deps.runReverify ?? runReverify;

  const mode = (getInput("mode") || "check").trim();

  try {
    switch (mode) {
      case "check":
        await check();
        return;
      case "generate":
        await generate();
        return;
      case "reverify":
        await reverify();
        return;
      case "lock":
        setFailed(LOCK_REJECTION_MESSAGE);
        return;
      default:
        setFailed(`Unsupported mode: ${mode}. Allowed: check | generate | reverify.`);
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setFailed(`Stele Action failed: ${message}`);
  }
}

// Run main() only when this module is the entrypoint (i.e. when ncc-bundled
// `dist/index.js` is invoked by GitHub). Skip during tests.
const isEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv.length > 1 &&
  process.argv[1] !== undefined &&
  /github-action[\\/]dist[\\/]index\.js$/.test(process.argv[1] ?? "");

if (isEntrypoint) {
  void main();
}
