import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pluginDir, "scripts", "observation-hook.js");

describe("observation hook", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("records PostToolUse observations for material source edits without surfacing output", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      tool_name: "Edit",
      tool_input: {
        file_path: "src/payments/service.py",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    const lines = (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim().split("\n");
    const observation = JSON.parse(lines[0]!);

    expect(observation).toMatchObject({
      session_id: "session-1",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      target_paths: ["src/payments/service.py"],
      material_change: true,
    });
  });

  it("records Bash write targets and marks protected contract writes as non-material additions candidates", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      tool_name: "Bash",
      tool_input: {
        command: "cat > contract/main.stele <<'EOF'\ncontent\nEOF",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse((await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim());
    expect(observation.target_paths).toEqual(["contract/main.stele"]);
    expect(observation.material_change).toBe(false);
  });

  it("stays silent when Stele is not configured", async () => {
    const projectDir = await createTempDir();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      tool_name: "Edit",
      tool_input: {
        file_path: "src/app.py",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).rejects.toThrow();
  });
});

async function createProject(): Promise<string> {
  const projectDir = await createTempDir();
  await writeProjectFile(
    projectDir,
    "stele.config.json",
    JSON.stringify({
      version: "0.1",
      entry: "contract/main.stele",
      protected: ["contract/**/*.stele", "tests/contract/**/*"],
    }),
  );
  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-observation-hook-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function runHook(projectDir: string, payload: unknown) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: pluginDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
    },
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
  });
}
