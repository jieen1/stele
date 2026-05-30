import { Readable } from "node:stream";

import { parseFile } from "@stele/core";

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

    // Dry-run compile: parseFile throws on parse / single-form compile error.
    // In-memory only — never writes to any protected path.
    try {
      parseFile(input.invariantCdl, `incident/${id}/invariant.stele`);
    } catch (error) {
      throw new Error(
        `invariantCdl failed to compile: ${(error as Error).message}`,
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
