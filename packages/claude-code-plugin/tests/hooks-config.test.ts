import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hooksPath = resolve(pluginDir, "hooks", "hooks.json");
const commandsDir = resolve(pluginDir, "commands");
const agentPath = resolve(pluginDir, "agents", "contract-author.md");

describe("plugin hooks config", () => {
  it("uses the nested official hook schema with plugin-root script paths", async () => {
    const hooksConfig = JSON.parse(await readFile(hooksPath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
        Stop: Array<{
          hooks: Array<{ type: string; command: string }>;
        }>;
      };
    };

    expect(hooksConfig.hooks.PreToolUse).toHaveLength(1);
    expect(hooksConfig.hooks.PreToolUse[0]?.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit|Bash");
    expect(hooksConfig.hooks.PreToolUse[0]?.hooks).toHaveLength(1);
    expect(hooksConfig.hooks.PreToolUse[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: expect.stringContaining("${CLAUDE_PLUGIN_ROOT}"),
    });
    expect(hooksConfig.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("/scripts/pre-tool-protect.js");

    expect(hooksConfig.hooks.Stop).toHaveLength(1);
    expect(hooksConfig.hooks.Stop[0]?.hooks).toHaveLength(1);
    expect(hooksConfig.hooks.Stop[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: expect.stringContaining("${CLAUDE_PLUGIN_ROOT}"),
    });
    expect(hooksConfig.hooks.Stop[0]?.hooks[0]?.command).toContain("/scripts/stop-validate.js");
  });

  it("exposes the planned slash command names through command basenames", async () => {
    for (const commandName of ["init", "check", "add", "explain"]) {
      const commandPath = resolve(commandsDir, `${commandName}.md`);
      const commandContent = await readFile(commandPath, "utf8");

      await expect(stat(commandPath)).resolves.toBeDefined();
      expect(commandContent).toContain(`/stele:${commandName}`);
    }

    for (const legacyName of ["stele-init.md", "stele-check.md", "stele-add.md", "stele-explain.md"]) {
      await expect(stat(resolve(commandsDir, legacyName))).rejects.toThrow();
    }
  });

  it("defines contract-author as a discoverable plugin agent with frontmatter", async () => {
    const agentContent = await readFile(agentPath, "utf8");
    const frontmatterMatch = agentContent.match(/^---\r?\n([\s\S]*?)\r?\n---/u);

    expect(frontmatterMatch).not.toBeNull();

    const frontmatter = frontmatterMatch?.[1] ?? "";
    expect(frontmatter).toContain("name: contract-author");
    expect(frontmatter).toMatch(/description:\s*.+/u);
    expect(frontmatter).toContain("model:");
    expect(frontmatter).toContain("effort:");
    expect(frontmatter).toContain("maxTurns:");
  });
});
