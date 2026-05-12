import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, test, expect } from "vitest";
import { runObserve } from "../src/commands/observe.js";

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "stele-observe-test-"));
}

async function writeObservations(dir: string, entries: Record<string, unknown>[]): Promise<void> {
  const agentDir = join(dir, ".stele", "agent");
  await mkdir(agentDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(agentDir, "session-observations.jsonl"), content, "utf8");
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Buffer, ...rest: unknown[]) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return true;
  };
  return {
    chunks,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

describe("stele observe command", () => {
  test("exits with error when no observation file exists", async () => {
    const dir = await createTempDir();
    const originalStderrWrite = process.stderr.write;
    const stderrChunks: string[] = [];
    process.stderr.write = (chunk: string | Buffer) => {
      if (typeof chunk === "string") stderrChunks.push(chunk);
      return true;
    };

    try {
      await runObserve(dir);
      const output = stderrChunks.join("");
      expect(output).toContain("No observation data found");
      expect(process.exitCode).toBe(1);
    } finally {
      process.stderr.write = originalStderrWrite;
      process.exitCode = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles empty observation file", async () => {
    const dir = await createTempDir();
    await writeObservations(dir, []);
    const { chunks, restore } = captureStdout();

    try {
      await runObserve(dir);
      expect(chunks.join("")).toContain("no entries");
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aggregates basic observations correctly", async () => {
    const dir = await createTempDir();
    const entries = [
      {
        timestamp: "2026-05-10T10:00:00Z",
        session_id: "session-001",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        target_paths: ["contract/main.stele"],
        material_change: true,
      },
      {
        timestamp: "2026-05-10T10:01:00Z",
        session_id: "session-001",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        target_paths: ["contract/main.stele"],
        material_change: true,
      },
      {
        timestamp: "2026-05-10T10:02:00Z",
        session_id: "session-002",
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        target_paths: ["src/app.py"],
        material_change: false,
      },
    ];
    await writeObservations(dir, entries);
    const { chunks, restore } = captureStdout();

    try {
      await runObserve(dir);
      const output = chunks.join("");
      expect(output).toContain("Total observations:");
      expect(output).toContain("Most Touched Protected Paths");
      expect(output).toContain("contract/main.stele");
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("outputs JSON format when --json flag is set", async () => {
    const dir = await createTempDir();
    const entries = [
      {
        timestamp: "2026-05-10T10:00:00Z",
        session_id: "session-001",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        target_paths: ["contract/main.stele"],
        material_change: true,
      },
    ];
    await writeObservations(dir, entries);
    const { chunks, restore } = captureStdout();

    try {
      await runObserve(dir, { json: true });
      const output = chunks.join("");
      const parsed = JSON.parse(output);
      expect(parsed.total_observations).toBe(1);
      expect(parsed.total_material_changes).toBe(1);
      expect(parsed.total_sessions).toBe(1);
      expect(parsed.top_paths.length).toBe(1);
      expect(parsed.top_tools.length).toBe(1);
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("filters by --since date", async () => {
    const dir = await createTempDir();
    const entries = [
      {
        timestamp: "2026-05-09T10:00:00Z",
        session_id: "session-001",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        target_paths: ["contract/main.stele"],
        material_change: true,
      },
      {
        timestamp: "2026-05-10T10:00:00Z",
        session_id: "session-001",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        target_paths: ["contract/main.stele"],
        material_change: true,
      },
    ];
    await writeObservations(dir, entries);
    const { chunks, restore } = captureStdout();

    try {
      await runObserve(dir, { json: true, since: "2026-05-10T00:00:00Z" });
      const output = chunks.join("");
      const parsed = JSON.parse(output);
      expect(parsed.total_observations).toBe(1);
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("identifies risky sessions", async () => {
    const dir = await createTempDir();
    const entries = [
      {
        timestamp: "2026-05-10T10:00:00Z",
        session_id: "session-risky",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        target_paths: ["contract/main.stele"],
        material_change: true,
      },
      {
        timestamp: "2026-05-10T10:01:00Z",
        session_id: "session-safe",
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        target_paths: ["src/app.py"],
        material_change: false,
      },
    ];
    await writeObservations(dir, entries);
    const { chunks, restore } = captureStdout();

    try {
      await runObserve(dir, { json: true });
      const output = chunks.join("");
      const parsed = JSON.parse(output);
      const risky = parsed.sessions.filter((s: Record<string, unknown>) => (s as Record<string, number>).material_changes > 0);
      expect(risky.length).toBe(1);
      expect(risky[0].session_id).toBe("session-risky");
    } finally {
      restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
