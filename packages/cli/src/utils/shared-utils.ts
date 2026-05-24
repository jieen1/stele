import { execFile } from "node:child_process";
import { readFile, mkdir, open } from "node:fs/promises";
import { dirname, posix, relative, win32 } from "node:path";
import { promisify } from "node:util";
import { stableStringCompare } from "@stele/core";

export { formatAstNode } from "./ast-format.js";

export function compareInvariants(
  left: { filePath: string; span: { line: number; column: number }; id: string },
  right: { filePath: string; span: { line: number; column: number }; id: string },
): number {
  return (
    stableStringCompare(left.filePath, right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    stableStringCompare(left.id, right.id)
  );
}

export function toProjectRelativePath(projectDir: string, filePath: string): string {
  return relative(projectDir, filePath).replaceAll("\\", "/");
}

export function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path, "utf8");
    return;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  await ensureDirectory(path);
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }
}

export function escapeTsvCell(value: string): string {
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 92) {
      result.push("\\", "\\");
    } else if (code === 9) {
      result.push("\\", "t");
    } else if (code === 13) {
      result.push("\\", "r");
    } else if (code === 10) {
      result.push("\\", "n");
    } else {
      result.push(value[i]);
    }
  }
  return result.join("");
}

export function isAbsoluteLikePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:(?![\\/])/.test(value);
}

const execFileAsync = promisify(execFile);

export const PYTHON_CANDIDATES: Array<{ command: string; args: string[] }> = [
  { command: "python", args: [] },
  { command: "py", args: ["-3"] },
  { command: "python3", args: [] },
];

export async function resolvePythonRuntime(): Promise<{ command: string; args: string[] } | undefined> {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      await execFileAsync(candidate.command, [...candidate.args, "--version"], { windowsHide: true });
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}



