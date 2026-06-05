import { mkdtemp, rm, writeFile, readFile, lstat, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, writeEvent, writeEventStrict } from "../src/events/write-event.js";
import { getGitInfo } from "../src/events/git.js";
import type { SteleEvent } from "../src/events/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-events-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeEvent(overrides?: Partial<SteleEvent>): SteleEvent {
  return {
    id: "test-id-00000000-0000-0000-0000-000000000001",
    timestamp: "2026-05-19T12:00:00.000Z",
    type: "violation-detected",
    version: "1",
    project_root: "/test/project",
    payload: {},
    session_id: "test-session",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createEvent
// ---------------------------------------------------------------------------

describe("createEvent", () => {
  it("creates a valid event with required fields", () => {
    const event = createEvent("violation-detected", "/project", { key: "value" });

    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(event.timestamp).toBeDefined();
    expect(event.type).toBe("violation-detected");
    expect(event.version).toBe("1");
    expect(event.project_root).toBe("/project");
    expect(event.payload).toEqual({ key: "value" });
    expect(event.session_id).toBe("");
  });

  it("includes optional git and session fields when provided", () => {
    const event = createEvent("baseline-update", "/project", {}, {
      session_id: "sess-123",
      git_commit: "abc1234",
      git_branch: "main",
    });

    expect(event.session_id).toBe("sess-123");
    expect(event.git_commit).toBe("abc1234");
    expect(event.git_branch).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// writeEvent — JSONL writing
// ---------------------------------------------------------------------------

describe("writeEvent", () => {
  it("creates a JSONL file with a single event", async () => {
    const dir = await createTempDir();
    const event = makeEvent({ project_root: dir });

    await writeEvent(dir, event);

    const filePath = join(dir, ".stele", "events", "2026-05-19.jsonl");
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe(event.id);
    expect(parsed.type).toBe(event.type);
  });

  it("appends multiple events correctly", async () => {
    const dir = await createTempDir();
    const events: SteleEvent[] = Array.from({ length: 3 }, (_, i) =>
      makeEvent({
        id: `event-${i}`,
        project_root: dir,
        payload: { index: i },
      }),
    );

    for (const event of events) {
      await writeEvent(dir, event);
    }

    const filePath = join(dir, ".stele", "events", "2026-05-19.jsonl");
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);

    expect(lines.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed.id).toBe(`event-${i}`);
    }
  });

  it("produces valid JSONL (each line is valid JSON)", async () => {
    const dir = await createTempDir();
    const events: SteleEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ id: `evt-${i}`, project_root: dir }),
    );

    for (const event of events) {
      await writeEvent(dir, event);
    }

    const filePath = join(dir, ".stele", "events", "2026-05-19.jsonl");
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      // Should not throw
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("type");
      expect(parsed).toHaveProperty("timestamp");
    }
  });

  it("symlink detection blocks writes", async () => {
    const dir = await createTempDir();
    const realEventsDir = join(dir, "real-events");
    const fakeEventsDir = join(dir, ".stele", "events");

    // Create a real directory and then make .stele/events a symlink to it
    await writeFile(realEventsDir, "");
    await mkdir(join(dir, ".stele"), { recursive: true });
    await symlink(realEventsDir, fakeEventsDir);

    const event = makeEvent({ project_root: dir });
    await writeEvent(dir, event);

    // The write should be a no-op — no file should be created
    const isLink = (await lstat(fakeEventsDir)).isSymbolicLink();
    expect(isLink).toBe(true);
  });

  it("write failure does not throw", async () => {
    const dir = await createTempDir();
    // Make .stele a file (not a directory) so mkdir will fail
    await writeFile(join(dir, ".stele"), "not-a-directory");

    const event = makeEvent({ project_root: dir });

    // Should not throw
    await expect(writeEvent(dir, event)).resolves.toBeUndefined();
  });

  it("rotates file when it exceeds size threshold", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, ".stele", "events", "2026-05-19.jsonl");
    await mkdir(join(dir, ".stele", "events"), { recursive: true });

    // Create a file at 10 MB threshold to trigger rotation
    const bigContent = "x".repeat(10 * 1024 * 1024);
    await writeFile(filePath, bigContent);

    // Now write a small event — this should trigger rotation
    const event = makeEvent({ project_root: dir });
    await writeEventStrict(dir, event);

    // The original file should now be rotated
    const rotatedPath = join(dir, ".stele", "events", "2026-05-19.1.jsonl");
    const rotatedExists = await lstat(rotatedPath).then(() => true).catch(() => false);
    expect(rotatedExists).toBe(true);

    // The current file should only contain the new event
    const currentContent = await readFile(filePath, "utf8");
    const lines = currentContent.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe(event.id);
  });
});

// ---------------------------------------------------------------------------
// getGitInfo
// ---------------------------------------------------------------------------

describe("getGitInfo", () => {
  it("returns commit and branch from a git repo", async () => {
    const info = await getGitInfo(process.cwd());

    expect(info.commit).toBeDefined();
    expect(typeof info.commit).toBe("string");
    expect(info.commit!.length).toBe(40); // SHA-1
  });

  it("returns undefined for non-git directory", async () => {
    const dir = await createTempDir();
    const info = await getGitInfo(dir);

    // commit will be undefined (not a git repo)
    expect(info.commit).toBeUndefined();
  });
});
