import { posix } from "node:path";
import { stableStringCompare } from "../util/array.js";
import type { Contract } from "../validator/structure.js";
import type { GeneratedFile, LanguageBackend } from "./types.js";
import { normalizeFileExtension, normalizeRelativeFilePath, assertPathWithinOutputDirectory, sanitizeGeneratedPathSegment } from "./path-safety.js";
import { generationError } from "./errors.js";

export function buildCanonicalGeneratedPaths(
  contract: Contract,
  backend: LanguageBackend,
  outputDir: string,
): string[] {
  const expectedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const seenCaseFoldedPaths = new Map<string, string>();
  const fileExtension = normalizeFileExtension(backend.fileExtension);
  const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);
  const testFileExtension = backend.name === "go" ? "_test.go" : fileExtension;
  const groupPaths = contract.groups.map((group) =>
    posix.join(outputDir, `test_${sanitizeGeneratedPathSegment(group.id, "group")}${testFileExtension}`),
  );

  const runtimePath =
    backend.name === "go"
      ? posix.join(outputDir, "stele_runtime_test.go")
      : posix.join(outputDir, `_stele_runtime${fileExtension}`);

  registerGeneratedPath(runtimePath, seenPaths, seenCaseFoldedPaths, "canonical generated file path", (path) => expectedPaths.push(path));

  if (topLevelInvariants.length > 0) {
    registerGeneratedPath(
      posix.join(outputDir, `test_contract${testFileExtension}`),
      seenPaths,
      seenCaseFoldedPaths,
      "canonical generated file path",
      (path) => expectedPaths.push(path),
    );
  }

  for (const groupPath of groupPaths) {
    registerGeneratedPath(groupPath, seenPaths, seenCaseFoldedPaths, "canonical generated file path", (path) => expectedPaths.push(path));
  }

  if (backend.name === "python" && contract.codeShapes.some((d) => d.lang === "python")) {
    registerGeneratedPath(
      posix.join(outputDir, `test_code_shape${fileExtension}`),
      seenPaths,
      seenCaseFoldedPaths,
      "canonical generated file path",
      (path) => expectedPaths.push(path),
    );
  }

  expectedPaths.sort((left, right) => stableStringCompare(left, right));
  return expectedPaths;
}

export function mergeExpectedGeneratedPaths(canonicalPaths: string[], supportPaths: string[]): string[] {
  const expectedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const seenCaseFoldedPaths = new Map<string, string>();

  for (const path of [...canonicalPaths, ...supportPaths]) {
    registerGeneratedPath(path, seenPaths, seenCaseFoldedPaths, "expected generated file path", (value) => expectedPaths.push(value));
  }

  expectedPaths.sort((left, right) => stableStringCompare(left, right));
  return expectedPaths;
}

export function normalizeGeneratedFiles(files: GeneratedFile[], outputDir: string): GeneratedFile[] {
  const normalizedFiles: GeneratedFile[] = [];
  const seenPaths = new Set<string>();
  const seenCaseFoldedPaths = new Map<string, string>();

  for (const file of files) {
    if (!isGeneratedFile(file)) {
      throw generationError(
        "E0501",
        "Backend returned an invalid generated file entry.",
        "Each generated file must include string path and content fields.",
        "Return only objects shaped like { path, content } from backend.generate().",
      );
    }

    const normalizedPath = normalizeRelativeFilePath(file.path, "generated file path");
    assertPathWithinOutputDirectory(normalizedPath, outputDir);
    registerGeneratedPath(
      normalizedPath,
      seenPaths,
      seenCaseFoldedPaths,
      "generated file path",
      (path) => normalizedFiles.push({ path, content: file.content }),
    );
  }

  normalizedFiles.sort((left, right) => stableStringCompare(left.path, right.path) || stableStringCompare(left.content, right.content));
  return normalizedFiles;
}

export function assertGeneratedFilesMatchExpectedLayout(
  actualFiles: GeneratedFile[],
  expectedPaths: string[],
  backendName: string,
): void {
  const actualPaths = actualFiles.map((file) => file.path);
  const actualPathSet = new Set(actualPaths);
  const expectedPathSet = new Set(expectedPaths);
  const missing = expectedPaths.filter((path) => !actualPathSet.has(path));
  const unexpected = actualPaths.filter((path) => !expectedPathSet.has(path));

  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const detailLines = [
    `expected: ${expectedPaths.join(", ") || "<none>"}`,
    `missing: ${missing.join(", ") || "<none>"}`,
    `unexpected: ${unexpected.join(", ") || "<none>"}`,
  ];

  throw generationError(
    "E0505",
    `Backend "${backendName}" did not emit the canonical generated layout.`,
    detailLines.join("\n"),
    "Emit exactly the runtime helper plus the canonical top-level and group test files required by core.",
  );
}

/**
 * Pure helper: validate that `normalizedPath` is unique (and that no
 * case-insensitive collision exists) before invoking the `register`
 * callback to record it. The `register` callback is a function-typed
 * parameter — every production caller binds it to a pure in-memory
 * `Set.add` / `Map.set` update; none performs IO. The closed-world
 * declaration tells the effect-evaluator that the unresolved
 * `register(...)` callee is accounted for and contributes no effects.
 *
 * @stele:effects
 */
function registerGeneratedPath(
  normalizedPath: string,
  seenPaths: Set<string>,
  seenCaseFoldedPaths: Map<string, string>,
  label: string,
  register: (path: string) => void,
): void {
  if (seenPaths.has(normalizedPath)) {
    throw generationError(
      "E0503",
      `Duplicate ${label} "${normalizedPath}".`,
      "Generated file paths must be unique after normalization.",
      "Ensure each project-relative generated file path appears exactly once.",
    );
  }

  const caseFoldedPath = normalizedPath.toLowerCase();
  const collidingPath = seenCaseFoldedPaths.get(caseFoldedPath);

  if (collidingPath !== undefined && collidingPath !== normalizedPath) {
    throw generationError(
      "E0503",
      `Case-insensitive ${label} collision between "${collidingPath}" and "${normalizedPath}".`,
      "Common Windows filesystems treat those generated paths as the same file.",
      "Rename the source ids or emitted files so their normalized paths stay distinct ignoring case.",
    );
  }

  seenPaths.add(normalizedPath);
  seenCaseFoldedPaths.set(caseFoldedPath, normalizedPath);
  register(normalizedPath);
}

function isGeneratedFile(value: unknown): value is GeneratedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    "content" in value &&
    typeof value.path === "string" &&
    typeof value.content === "string"
  );
}
