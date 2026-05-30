import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type IncidentDraft,
  draftJsonPath,
  fixCommitterDate,
  incidentScratchDir,
  parseDraftInput,
  proofsScratchDir,
  readDraftJson,
  resolveFixAndParent,
  slugifyIncidentId,
  validateIncidentId,
  writeDraftJson,
} from "../src/commands/incident/shared.js";

const execFileAsync = promisify(execFile);

describe("slugifyIncidentId", () => {
  it("slugifies a sentence", () => {
    expect(slugifyIncidentId("Payments double-charge on retry!")).toBe(
      "payments-double-charge-on-retry",
    );
  });

  it("collapses and trims separators", () => {
    expect(slugifyIncidentId("  Foo___Bar  ")).toBe("foo-bar");
  });

  it("throws when nothing alphanumeric remains", () => {
    expect(() => slugifyIncidentId("   !!!   ")).toThrow(/Cannot derive incident id/);
  });
});

describe("validateIncidentId", () => {
  it("accepts a valid id", () => {
    expect(validateIncidentId("valid-id-1")).toBe("valid-id-1");
  });

  for (const bad of [
    "../escape",
    ".hidden",
    "Has Space",
    "a/b",
    "a\\b",
    "UPPER",
    "trailing-",
    "-leading",
    "double--hyphen",
    "",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => validateIncidentId(bad)).toThrow(/Invalid incident id/);
    });
  }
});

describe("scratch path containment", () => {
  it("resolves the incident dir under .stele/incident", () => {
    const projectDir = "/tmp/proj";
    expect(incidentScratchDir(projectDir, "ok")).toBe(
      resolve(projectDir, ".stele/incident/ok"),
    );
  });

  it("resolves the proofs dir under .stele/proofs", () => {
    const projectDir = "/tmp/proj";
    expect(proofsScratchDir(projectDir, "ok")).toBe(
      resolve(projectDir, ".stele/proofs/ok"),
    );
  });

  it("draftJsonPath nests draft.json under the incident dir", () => {
    const projectDir = "/tmp/proj";
    expect(draftJsonPath(projectDir, "ok")).toBe(
      join(resolve(projectDir, ".stele/incident/ok"), "draft.json"),
    );
  });

  it("rejects an escaping id", () => {
    expect(() => incidentScratchDir("/tmp/proj", "../escape")).toThrow();
  });
});

describe("parseDraftInput", () => {
  it("parses a happy-path payload", () => {
    const out = parseDraftInput(
      JSON.stringify({
        invariantCdl: "(invariant x)",
        negativeTest: "def test_x(): assert False",
        testFilename: "test_x.py",
      }),
    );
    expect(out).toEqual({
      invariantCdl: "(invariant x)",
      negativeTest: "def test_x(): assert False",
      testFilename: "test_x.py",
    });
  });

  it("defaults testFilename to undefined when absent", () => {
    const out = parseDraftInput(
      JSON.stringify({ invariantCdl: "a", negativeTest: "b" }),
    );
    expect(out.testFilename).toBeUndefined();
  });

  it("rejects missing invariantCdl", () => {
    expect(() =>
      parseDraftInput(JSON.stringify({ negativeTest: "b" })),
    ).toThrow(/invariantCdl/);
  });

  it("rejects empty negativeTest", () => {
    expect(() =>
      parseDraftInput(JSON.stringify({ invariantCdl: "a", negativeTest: "" })),
    ).toThrow(/negativeTest/);
  });

  it("rejects a traversal testFilename", () => {
    expect(() =>
      parseDraftInput(
        JSON.stringify({ invariantCdl: "a", negativeTest: "b", testFilename: "../evil.py" }),
      ),
    ).toThrow(/testFilename/);
  });

  it("rejects a testFilename with a separator", () => {
    expect(() =>
      parseDraftInput(
        JSON.stringify({ invariantCdl: "a", negativeTest: "b", testFilename: "sub/t.py" }),
      ),
    ).toThrow(/testFilename/);
  });

  it("rejects a non-.py testFilename", () => {
    expect(() =>
      parseDraftInput(
        JSON.stringify({ invariantCdl: "a", negativeTest: "b", testFilename: "notpy.txt" }),
      ),
    ).toThrow(/testFilename/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseDraftInput("{not json")).toThrow(/not valid JSON/);
  });
});

describe("draft.json IO", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "incident-shared-io-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const draft: IncidentDraft = {
    intent: "Payments double-charge on retry",
    fixSha: "a".repeat(40),
    parentSha: "b".repeat(40),
    invariantCdl: "(invariant no-double-charge)",
    negativeTest: "def test_x():\n    assert False\n",
    testFilename: "test_incident_demo.py",
  };

  it("round-trips and is byte-stable with fixed key order", async () => {
    await writeDraftJson(dir, "demo", draft);
    const got = await readDraftJson(dir, "demo");
    expect(got).toEqual(draft);

    const expected =
      JSON.stringify(
        {
          intent: draft.intent,
          fixSha: draft.fixSha,
          parentSha: draft.parentSha,
          invariantCdl: draft.invariantCdl,
          negativeTest: draft.negativeTest,
          testFilename: draft.testFilename,
        },
        null,
        2,
      ) + "\n";
    const onDisk = await readFile(
      join(dir, ".stele/incident/demo/draft.json"),
      "utf8",
    );
    expect(onDisk).toBe(expected);
  });

  it("throws a typed error when the draft is missing", async () => {
    await expect(readDraftJson(dir, "missing")).rejects.toThrow(/No incident draft/);
  });
});

describe("git resolution", () => {
  let repo: string;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "incident-shared-git-"));
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "T"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await mkdir(repo, { recursive: true });
    await writeFileInRepo(repo, "a.txt", "1");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "first"], { cwd: repo, env });
    await writeFileInRepo(repo, "a.txt", "2");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "second"], { cwd: repo, env });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("resolves fix and parent to 40-char SHAs", async () => {
    const { fixSha, parentSha } = await resolveFixAndParent(repo, "HEAD");
    expect(fixSha).toMatch(/^[0-9a-f]{40}$/);
    expect(parentSha).toMatch(/^[0-9a-f]{40}$/);
    const first = (
      await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: repo })
    ).stdout.trim();
    expect(parentSha).toBe(first);
  });

  it("throws on a root commit (no parent)", async () => {
    await expect(resolveFixAndParent(repo, "HEAD~1")).rejects.toThrow(/root commit/);
  });

  it("throws on an unknown rev", async () => {
    await expect(resolveFixAndParent(repo, "does-not-exist")).rejects.toThrow();
  });

  it("returns the committer date injected via GIT_COMMITTER_DATE", async () => {
    const { fixSha } = await resolveFixAndParent(repo, "HEAD");
    const date = await fixCommitterDate(repo, fixSha);
    expect(date).toBe("2026-01-02T03:04:05+00:00");
  });
});

async function writeFileInRepo(repo: string, name: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(repo, name), content, "utf8");
}
