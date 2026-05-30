import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runIncidentDraft } from "../src/commands/incident/draft.js";

const execFileAsync = promisify(execFile);

const VALID_INVARIANT = `(invariant no-double-charge
  (severity error)
  (description "Payments must not double-charge on retry")
  (assert (eq 1 1)))`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(rel: string): Promise<void> {
    const abs = join(dir, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(childRel);
      } else {
        out[childRel] = await readFile(join(dir, childRel), "utf8");
      }
    }
  }
  await walk("");
  return out;
}

describe("runIncidentDraft", () => {
  let repo: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(async () => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    repo = await mkdtemp(join(tmpdir(), "incident-draft-"));
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await mkdir(join(repo, "contract"), { recursive: true });
    await writeFile(join(repo, "contract", "main.stele"), "(contract demo)\n", "utf8");
    await writeFile(
      join(repo, "stele.config.json"),
      JSON.stringify({ contract: "contract/main.stele" }, null, 2) + "\n",
      "utf8",
    );
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "first"], { cwd: repo, env: GIT_ENV });
    await writeFile(join(repo, "contract", "main.stele"), "(contract demo v2)\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "the fix"], { cwd: repo, env: GIT_ENV });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    process.exitCode = savedExitCode;
  });

  function captureStdout(): { stdout: NodeJS.WritableStream; text: () => string } {
    let buf = "";
    const stdout = {
      write(chunk: string | Uint8Array): boolean {
        buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    return { stdout, text: () => buf };
  }

  async function writeDraftFile(content: unknown): Promise<string> {
    const p = join(repo, "draft-input.json");
    await writeFile(p, JSON.stringify(content), "utf8");
    return p;
  }

  it("happy path writes only under .stele/incident/<id>/ and never touches contract/", async () => {
    const before = await snapshotDir(join(repo, "contract"));
    const draftFrom = await writeDraftFile({
      invariantCdl: VALID_INVARIANT,
      negativeTest: "def test_no_double_charge():\n    assert False\n",
    });
    const cap = captureStdout();

    await runIncidentDraft(
      repo,
      { intent: "Payments double-charge on retry", fix: "HEAD", draftFrom },
      { stdout: cap.stdout },
    );

    expect(process.exitCode).toBeUndefined();
    const id = "payments-double-charge-on-retry";
    expect(await pathExists(join(repo, ".stele/incident", id, "draft.json"))).toBe(true);
    expect(
      await pathExists(join(repo, ".stele/incident", id, "test_incident_" + id + ".py")),
    ).toBe(true);

    const after = await snapshotDir(join(repo, "contract"));
    expect(after).toEqual(before);

    const text = cap.text();
    expect(text).toContain("(invariant ");
    expect(text).toContain("dry-run OK");
  });

  it("compile-fail sets exit 1 and creates no scratch dir", async () => {
    const draftFrom = await writeDraftFile({
      invariantCdl: "(invariant broken (assert ",
      negativeTest: "def test_x():\n    assert False\n",
    });
    await runIncidentDraft(
      repo,
      { intent: "Some incident", fix: "HEAD", draftFrom },
      { stdout: captureStdout().stdout },
    );
    expect(process.exitCode).toBe(1);
    expect(await pathExists(join(repo, ".stele/incident/some-incident"))).toBe(false);
  });

  it("malformed JSON sets exit 1 and creates no scratch dir", async () => {
    const p = join(repo, "bad.json");
    await writeFile(p, "{not json", "utf8");
    await runIncidentDraft(
      repo,
      { intent: "Bad json incident", fix: "HEAD", draftFrom: p },
      { stdout: captureStdout().stdout },
    );
    expect(process.exitCode).toBe(1);
    expect(await pathExists(join(repo, ".stele/incident/bad-json-incident"))).toBe(false);
  });

  it("derives id from intent, and --id overrides", async () => {
    const draftFrom = await writeDraftFile({
      invariantCdl: VALID_INVARIANT,
      negativeTest: "def test_x():\n    assert False\n",
    });
    await runIncidentDraft(
      repo,
      { intent: "Derived Slug Here", fix: "HEAD", draftFrom, id: "custom-id" },
      { stdout: captureStdout().stdout },
    );
    expect(process.exitCode).toBeUndefined();
    expect(await pathExists(join(repo, ".stele/incident/custom-id/draft.json"))).toBe(true);
    expect(await pathExists(join(repo, ".stele/incident/derived-slug-here"))).toBe(false);
  });

  it("reads from stdin when --draft-from is '-'", async () => {
    const payload = JSON.stringify({
      invariantCdl: VALID_INVARIANT,
      negativeTest: "def test_x():\n    assert False\n",
    });
    const stdin = Readable.from([payload]) as Readable & { isTTY?: boolean };
    stdin.isTTY = false;
    await runIncidentDraft(
      repo,
      { intent: "Stdin incident", fix: "HEAD", draftFrom: "-" },
      { stdin, stdout: captureStdout().stdout },
    );
    expect(process.exitCode).toBeUndefined();
    expect(await pathExists(join(repo, ".stele/incident/stdin-incident/draft.json"))).toBe(true);
  });

  it("refuses a root commit (no parent) with exit 1 and no scratch write", async () => {
    const draftFrom = await writeDraftFile({
      invariantCdl: VALID_INVARIANT,
      negativeTest: "def test_x():\n    assert False\n",
    });
    const root = (
      await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: repo })
    ).stdout.trim();
    await runIncidentDraft(
      repo,
      { intent: "Root commit incident", fix: root, draftFrom },
      { stdout: captureStdout().stdout },
    );
    expect(process.exitCode).toBe(1);
    expect(await pathExists(join(repo, ".stele/incident/root-commit-incident"))).toBe(false);
  });

  it("rejects a parseable-but-non-compiling invariant (no assert/check) with exit 1 and no scratch", async () => {
    // This invariant PARSES fine as an S-expression (so the OLD parse-only gate
    // would have passed it on to approve), but it does NOT compile: loadContract
    // requires exactly one of (assert ...) / (uses-checker ...). The full compile
    // gate must reject it at draft time.
    const before = await snapshotDir(join(repo, "contract"));
    const draftFrom = await writeDraftFile({
      invariantCdl:
        "(invariant inc-noassert\n  (severity error)\n  (description \"missing assert\"))",
      negativeTest: "def test_x():\n    assert False\n",
    });
    await runIncidentDraft(
      repo,
      { intent: "No assert incident", fix: "HEAD", draftFrom, id: "noassert-incident" },
      { stdout: captureStdout().stdout },
    );
    expect(process.exitCode).toBe(1);
    expect(await pathExists(join(repo, ".stele/incident/noassert-incident"))).toBe(false);
    // contract/ untouched and the throwaway compile-check file is cleaned up.
    expect(await snapshotDir(join(repo, "contract"))).toEqual(before);
    expect(
      await pathExists(join(repo, ".stele-incident-compile-check-noassert-incident.stele")),
    ).toBe(false);
  });

  it("accepts an invariant that compiles", async () => {
    // VALID_INVARIANT has an (assert ...); it compiles cleanly standalone, so the
    // full compile gate passes and the draft is written.
    const draftFrom = await writeDraftFile({
      invariantCdl: VALID_INVARIANT,
      negativeTest: "def test_x():\n    assert False\n",
    });
    await runIncidentDraft(
      repo,
      { intent: "Compiles fine", fix: "HEAD", draftFrom, id: "compiles-fine" },
      { stdout: captureStdout().stdout },
    );
    expect(process.exitCode).toBeUndefined();
    expect(await pathExists(join(repo, ".stele/incident/compiles-fine/draft.json"))).toBe(true);
    expect(
      await pathExists(join(repo, ".stele-incident-compile-check-compiles-fine.stele")),
    ).toBe(false);
  });
});
