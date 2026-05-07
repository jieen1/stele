import { readFile, mkdir, open } from "node:fs/promises";
import { dirname, relative } from "node:path";

export { formatAstNode } from "./ast-format.js";

export function compareInvariants(
  left: { filePath: string; span: { line: number; column: number }; id: string },
  right: { filePath: string; span: { line: number; column: number }; id: string },
): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

export function compareBySource(
  left: { filePath: string; span: { line: number; column: number }; id: string },
  right: { filePath: string; span: { line: number; column: number }; id: string },
): number {
  return compareInvariants(left, right);
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
  const result: string[] = []
  const PUSH_BACKSLASH = String.fromCharCode(92)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 92) {
      result.push(PUSH_BACKSLASH, PUSH_BACKSLASH)
    } else if (code === 9) {
      result.push(PUSH_BACKSLASH, "t")
    } else if (code === 13) {
      result.push(PUSH_BACKSLASH, "r")
    } else if (code === 10) {
      result.push(PUSH_BACKSLASH, "n")
    } else {
      result.push(value[i])
    }
  }
  return result.join("")
}


