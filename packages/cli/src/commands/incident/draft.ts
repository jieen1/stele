import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { loadContract, parseFile } from "@stele/core";

import { ExitCode } from "../../errors.js";
import { readOptionalFile } from "../../utils/shared-utils.js";
import {
  type DraftInput,
  type IncidentDraft,
  parseDraftInput,
  resolveFixAndParent,
  slugifyIncidentId,
  validateIncidentId,
  writeCandidateTest,
  writeDraftJson,
} from "./shared.js";

export type IncidentDraftOptions = {
  intent: string;
  fix: string;
  /**
   * Where to read the injected draft from: a file path, or '-' for stdin. When
   * `draftInput` is supplied directly (the MCP / programmatic seam — the calling
   * agent IS the model) this is ignored.
   */
  draftFrom: string;
  /**
   * In-memory draft supplied by a programmatic caller (the MCP tools). When set,
   * it bypasses the `--draft-from` file/stdin read entirely — the same
   * deterministic payload, just injected as an object instead of bytes.
   */
  draftInput?: DraftInput;
  id?: string;
};

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads the draft payload from a file path, or from stdin when draftFrom === '-'.
 * stdin is injectable for tests; a TTY (no piped input) is a clear error rather
 * than a hang.
 */
export async function readDraftSource(
  projectDir: string,
  draftFrom: string,
  deps: { stdin?: Readable & { isTTY?: boolean } } = {},
): Promise<string> {
  if (draftFrom === "-") {
    const stdin = deps.stdin ?? process.stdin;
    if (stdin.isTTY) {
      throw new Error(
        "--draft-from - requires piped stdin (no data on a terminal).",
      );
    }
    return readStream(stdin);
  }
  const path = draftFrom;
  const raw = await readOptionalFile(path);
  if (raw === undefined) {
    throw new Error(`Draft file not found: ${draftFrom}`);
  }
  return raw;
}

function fail(message: string): void {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = ExitCode.USER_ERROR;
}

/**
 * Full compile gate (read-only): prove the candidate invariant does not just
 * PARSE but actually COMPILES — the same `loadContract` structure/reference/type
 * validation approve/propose rely on. A parseable-but-non-compiling invariant
 * (missing/duplicate assert-or-checker, non-predicate assert, malformed field) is
 * rejected HERE rather than slipping through to approve, where it would otherwise
 * surface only after the protected apply→generate→lock had begun.
 *
 * The candidate is compiled STANDALONE: it is written to a throwaway entry and
 * `loadContract`-ed on its own. We deliberately do NOT import the project
 * contract — importing it would couple a single draft to the validity of the
 * ENTIRE existing contract (and to placeholder fixtures that may not independently
 * compile), turning an unrelated contract problem into a spurious draft failure.
 * Cross-contract concerns (duplicate id, dangling checker reference against the
 * real contract) are `approve`'s job: it appends to the contract and runs
 * loadContract over the whole thing under its atomic snapshot/rollback. Draft's
 * contract here is precisely "this invariant, on its own, is a well-formed
 * compilable rule".
 *
 * The throwaway entry lives at the project root (not under .stele/incident or
 * .stele/proofs), is always removed in a finally, never touches contract/**, and
 * is never hashed (C2).
 */
async function fullCompileCheck(projectDir: string, id: string, invariantCdl: string): Promise<void> {
  const checkEntry = join(projectDir, `.stele-incident-compile-check-${id}.stele`);
  await writeFile(checkEntry, `${invariantCdl}\n`, "utf8");
  try {
    await loadContract(checkEntry);
  } finally {
    await rm(checkEntry, { force: true });
  }
}

/**
 * Orchestrates: read draft source → derive/validate id → resolve <fix>+<fix>^ →
 * dry-run compile invariantCdl via parseFile → write ONLY under
 * .stele/incident/<id>/ → print proposed block + dry-run result.
 *
 * All parse/validate/resolve/compile steps run BEFORE any filesystem write, so a
 * failed draft never leaves a partial scratch dir behind.
 */
export async function runIncidentDraft(
  projectDir: string,
  options: IncidentDraftOptions,
  deps: { stdin?: Readable & { isTTY?: boolean }; stdout?: NodeJS.WritableStream } = {},
): Promise<void> {
  const out = deps.stdout ?? process.stdout;
  try {
    if (!options.intent || options.intent.trim().length === 0) {
      throw new Error("--intent is required and must be non-empty.");
    }
    if (!options.fix || options.fix.trim().length === 0) {
      throw new Error("--fix <rev> is required.");
    }
    if (!options.draftFrom || options.draftFrom.length === 0) {
      throw new Error("--draft-from <path|-> is required.");
    }

    const id =
      options.id !== undefined
        ? validateIncidentId(options.id)
        : validateIncidentId(slugifyIncidentId(options.intent));

    // The MCP / programmatic seam: an in-memory draft is re-serialized and run
    // through the SAME parseDraftInput validator the file/stdin path uses, so
    // the path-escape and shape checks apply identically. void Readable keeps
    // the named import live for the lib wrapper's stdin-injection path.
    void Readable;
    const input: DraftInput =
      options.draftInput !== undefined
        ? parseDraftInput(JSON.stringify(options.draftInput))
        : parseDraftInput(
            await readDraftSource(projectDir, options.draftFrom, { stdin: deps.stdin }),
          );

    const { fixSha, parentSha } = await resolveFixAndParent(projectDir, options.fix);

    // Dry-run compile in two stages. (1) parseFile throws on a parse / single-
    // form syntax error. (2) fullCompileCheck runs the candidate through the same
    // loadContract validation approve/propose use, so a parseable-but-non-
    // compiling invariant (missing/duplicate assert-or-checker, type error,
    // malformed field) is rejected HERE, not silently passed to approve. Both
    // stages are read-only — never a protected write.
    try {
      parseFile(input.invariantCdl, `incident/${id}/invariant.stele`);
    } catch (error) {
      throw new Error(
        `invariantCdl failed to compile: ${(error as Error).message}`,
      );
    }
    try {
      await fullCompileCheck(projectDir, id, input.invariantCdl);
    } catch (error) {
      throw new Error(
        `invariantCdl does not compile: ${(error as Error).message}`,
      );
    }

    const testFilename = input.testFilename ?? `test_incident_${id}.py`;
    const draft: IncidentDraft = {
      intent: options.intent,
      fixSha,
      parentSha,
      invariantCdl: input.invariantCdl,
      negativeTest: input.negativeTest,
      testFilename,
    };

    await writeDraftJson(projectDir, id, draft);
    const testPath = await writeCandidateTest(projectDir, id, draft);

    out.write(`Proposed invariant (dry-run OK):\n\n`);
    out.write(`${input.invariantCdl.trim()}\n\n`);
    out.write(`incident id:   ${id}\n`);
    out.write(`fix:           ${fixSha}\n`);
    out.write(`parent (^):    ${parentSha}\n`);
    out.write(`draft.json:    .stele/incident/${id}/draft.json\n`);
    out.write(`candidate test ${testPath}\n`);
    out.write(`\nNext: stele incident teeth --id ${id}\n`);
  } catch (error) {
    fail((error as Error).message);
  }
}
