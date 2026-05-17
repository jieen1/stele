import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_PROTECTED_PATTERNS } from "@stele/core";
import type { McpResult } from "../types.js";
import { parseContractFromFile, listContractFiles } from "../contract-cache.js";
import { validateProjectDir } from "../path-validation.js";

/**
 * MCP tool: stele-context
 *
 * Generate contract context for agent sessions.
 * Returns a structured summary of project invariants, severity levels,
 * and protected paths that an AI agent should respect.
 */
export function createContextTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<McpResult>;
} {
  return {
    name: "stele-context",
    description:
      "Generate contract context for AI agent sessions. Returns structured summary of invariants, severity levels, and protected paths.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        focusPaths: {
          type: "array",
          items: { type: "string" },
          description: "Focus context on specific file paths",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Output format (default: markdown)",
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>): Promise<McpResult> => {
      const validated = validateProjectDir(args.projectDir);
      if (validated.error) {
        return {
          content: [{ type: "text", text: validated.error }],
          isError: true,
        };
      }
      const projectDir = validated.path!;
      const focusPaths = args.focusPaths as string[] ?? [];
      const format = (args.format as string) ?? "markdown";

      // Validate focusPaths stay within project directory
      for (const fp of focusPaths) {
        const resolved = resolve(projectDir, fp);
        const relPath = relative(projectDir, resolved);
        const normalized = relPath.replace(/\\/g, "/");
        if (normalized.startsWith("../") || isAbsolute(relPath)) {
          return {
            content: [{ type: "text", text: `focusPath escapes project directory: ${fp}` }],
            isError: true,
          };
        }
      }
      const context = await buildContext(projectDir, focusPaths);

      if (context.error) {
        return {
          content: [{ type: "text", text: `[stele-context] Error building context: ${context.error}` }],
          isError: true,
        };
      }

      if (format === "json") {
        return {
          content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: formatMarkdown(context) }],
        isError: false,
      };
    },
  };
}

interface Context {
  projectDir: string;
  hasConfig: boolean;
  hasContracts: boolean;
  invariants: Array<{
    id: string;
    severity: string;
    description: string;
  }>;
  checkers: Array<{
    id: string;
    description: string;
  }>;
  protectedPatterns: string[];
  invariantCount: number;
  checkerCount: number;
  error?: string;
}

async function buildContext(projectDir: string, focusPaths: string[]): Promise<Context> {
  const contractDir = join(projectDir, "contract");
  const context: Context = {
    projectDir,
    hasConfig: false,
    hasContracts: false,
    invariants: [],
    checkers: [],
    protectedPatterns: [],
    invariantCount: 0,
    checkerCount: 0,
  };

  try {
    const configFile = join(projectDir, "stele.config.json");
    context.hasConfig = existsSync(configFile);

    if (context.hasConfig) {
      try {
        const config = JSON.parse(readFileSync(configFile, "utf8"));
        if (config?.protected && Array.isArray(config.protected)) {
          context.protectedPatterns = config.protected;
        } else {
          context.protectedPatterns = [...DEFAULT_PROTECTED_PATTERNS];
        }
      } catch {
        // Ignore parse errors
      }
    }

    context.hasContracts = existsSync(contractDir);

    if (context.hasContracts) {
      const files = listContractFiles(contractDir);

      for (const file of files) {
        try {
          const parsed = await parseContractFromFile(file.path);

          for (const invariant of parsed.invariants) {
            context.invariants.push(invariant);
          }

          context.checkers.push(...parsed.checkers);
        } catch {
          // Skip files that fail to parse
        }
      }
    }

    context.invariantCount = context.invariants.length;
    context.checkerCount = context.checkers.length;
  } catch (err) {
    context.error = err instanceof Error ? err.message : String(err);
  }

  return context;
}

function formatMarkdown(context: Context): string {
  const lines: string[] = [];

  lines.push(`# Stele Contract Context`);
  lines.push(``);
  lines.push(`**Project:** ${context.projectDir}`);
  lines.push(`**Config:** ${context.hasConfig ? "Yes" : "No"}`);
  lines.push(`**Contracts:** ${context.hasContracts ? "Yes" : "No"}`);
  lines.push(`**Invariants:** ${context.invariantCount}`);
  lines.push(`**Checkers:** ${context.checkerCount}`);
  lines.push(``);

  if (context.invariantCount > 0) {
    lines.push(`## Invariants`);
    lines.push(``);

    for (const inv of context.invariants) {
      lines.push(`### ${inv.id}`);
      lines.push(`- **Severity:** ${inv.severity}`);
      lines.push(`- **Description:** ${inv.description}`);
      lines.push(``);
    }
  }

  if (context.checkerCount > 0) {
    lines.push(`## Checkers`);
    lines.push(``);

    for (const checker of context.checkers) {
      lines.push(`### ${checker.id}`);
      lines.push(`- **Description:** ${checker.description}`);
      lines.push(``);
    }
  }

  lines.push(`## Protected Patterns`);
  lines.push(``);

  for (const pattern of context.protectedPatterns) {
    lines.push(`- \`${pattern}\``);
  }

  return lines.join("\n");
}
