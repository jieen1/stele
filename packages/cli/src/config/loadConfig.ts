import { readFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import { isAbsoluteLikePath } from "../utils/shared-utils.js";
import {
  DEFAULT_CONFIG,
  STELE_CONFIG_FILE,
  type PhaseLanguages,
  type PhaseSupportedLanguage,
  type SteleConfig,
} from "./defaults.js";

type PartialConfig = Partial<Omit<SteleConfig, "protected">> & {
  protected?: unknown;
};

const VALID_PHASE_LANGUAGE_KEYS: ReadonlySet<keyof PhaseLanguages> = new Set([
  "trace",
  "type-state",
  "effect",
  "code-shape",
  "architecture",
]);

const VALID_PHASE_LANGUAGE_VALUES: ReadonlySet<PhaseSupportedLanguage> = new Set([
  "typescript",
  "python",
  "go",
  "java",
  "rust",
]);

export async function loadConfig(projectDir: string): Promise<SteleConfig> {
  const normalizedProjectDir = resolve(projectDir);
  const configFile = await readFile(resolve(projectDir, STELE_CONFIG_FILE), "utf8");
  const parsed = JSON.parse(configFile) as PartialConfig;

  const config: SteleConfig = {
    version: readString(parsed.version, DEFAULT_CONFIG.version),
    contractDir: validateProjectRelativePath(normalizedProjectDir, readString(parsed.contractDir, DEFAULT_CONFIG.contractDir), "contractDir", "directory"),
    entry: validateProjectRelativePath(normalizedProjectDir, readString(parsed.entry, DEFAULT_CONFIG.entry), "entry", "file"),
    generatedDir: validateProjectRelativePath(
      normalizedProjectDir,
      readString(parsed.generatedDir, DEFAULT_CONFIG.generatedDir),
      "generatedDir",
      "directory",
    ),
    checkerImplDir: validateProjectRelativePath(
      normalizedProjectDir,
      readString(parsed.checkerImplDir, DEFAULT_CONFIG.checkerImplDir),
      "checkerImplDir",
      "directory",
    ),
    manifestPath: validateProjectRelativePath(
      normalizedProjectDir,
      readString(parsed.manifestPath, DEFAULT_CONFIG.manifestPath),
      "manifestPath",
      "file",
    ),
    targetLanguage: readString(parsed.targetLanguage, DEFAULT_CONFIG.targetLanguage),
    testFramework: readString(parsed.testFramework, DEFAULT_CONFIG.testFramework),
    pathMode: readString(parsed.pathMode, DEFAULT_CONFIG.pathMode),
    // Round 4 D-01 (Round 3 P0-3 follow-up): UNION default + user patterns
    // instead of REPLACE. The hook-side `pre-tool-protect.js` was already
    // changed in P0-3, but the CLI side still trusted a narrowed user
    // config — meaning manifest verification / generation could silently
    // skip hook scripts if the user's `stele.config.json` happened to
    // forget them. Defense-in-depth requires that the CLI honours the
    // same UNION semantics so the protected glob can only grow, never
    // shrink, via user config.
    protected: mergeProtected(parsed),
  };

  const phaseLanguages = readPhaseLanguages(parsed.phaseLanguages);
  if (phaseLanguages !== undefined) {
    config.phaseLanguages = phaseLanguages;
  }
  if (parsed.tsconfig !== undefined) {
    if (typeof parsed.tsconfig !== "string" || parsed.tsconfig.length === 0) {
      throw new Error('Config field "tsconfig" must be a non-empty string when present.');
    }
    config.tsconfig = parsed.tsconfig;
  }
  // Phase 4 self-dogfooding: optional `effectStrictMode` controls
  // whether unresolved-call sites in the call graph are treated as
  // error (default true, Round 2 D-CG-1) or as advisory notices
  // (false — needed for projects with dynamic dispatch the static
  // extractor can't model).
  if (parsed.effectStrictMode !== undefined) {
    if (typeof parsed.effectStrictMode !== "boolean") {
      throw new Error('Config field "effectStrictMode" must be a boolean when present.');
    }
    config.effectStrictMode = parsed.effectStrictMode;
  }

  return config;
}

function readPhaseLanguages(value: unknown): PhaseLanguages | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Config field "phaseLanguages" must be an object.');
  }
  const result: PhaseLanguages = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!VALID_PHASE_LANGUAGE_KEYS.has(key as keyof PhaseLanguages)) {
      throw new Error(
        `Config field "phaseLanguages.${key}" is not a recognized phase. Use one of ${[...VALID_PHASE_LANGUAGE_KEYS].sort().join(", ")}.`,
      );
    }
    if (typeof raw !== "string" || !VALID_PHASE_LANGUAGE_VALUES.has(raw as PhaseSupportedLanguage)) {
      throw new Error(
        `Config field "phaseLanguages.${key}" must be one of ${[...VALID_PHASE_LANGUAGE_VALUES].sort().join(", ")}.`,
      );
    }
    result[key as keyof PhaseLanguages] = raw as PhaseSupportedLanguage;
  }
  return result;
}

function mergeProtected(parsed: PartialConfig): string[] {
  const userPatterns = Object.prototype.hasOwnProperty.call(parsed, "protected")
    ? readProtectedConfig(parsed.protected)
    : [];
  return [...new Set([...DEFAULT_CONFIG.protected, ...userPatterns])];
}

function readProtectedConfig(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Config field "protected" must be an array of non-empty project-relative glob strings.');
  }

  for (const pattern of value) {
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      throw new Error('Config field "protected" must be an array of non-empty project-relative glob strings.');
    }

    if (isAbsoluteLikePath(pattern)) {
      throw new Error(`Config field "protected" must contain only project-relative glob strings. Invalid pattern: ${pattern}`);
    }

    if (containsParentTraversal(pattern)) {
      throw new Error(`Config field "protected" must not escape the project root. Invalid pattern: ${pattern}`);
    }

    if (pattern.includes("[") || pattern.includes("]")) {
      throw new Error(`Config field "protected" does not support bracket glob syntax. Invalid pattern: ${pattern}`);
    }
  }

  return [...value];
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function validateProjectRelativePath(
  projectDir: string,
  value: string,
  label: string,
  kind: "file" | "directory",
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Config field "${label}" must be a non-empty project-relative path.`);
  }

  if (isAbsoluteLikePath(value)) {
    throw new Error(`Config field "${label}" must be a project-relative path inside the project root.`);
  }

  const normalized = win32
    .normalize(value)
    .split(win32.sep)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .reduce<string>((current, segment) => (current.length === 0 ? segment : posix.join(current, segment)), "");

  const normalizedPath = normalized.length === 0 ? "." : normalized;

  if (normalizedPath.split("/").includes("..")) {
    throw new Error(`Config field "${label}" must stay inside the project root.`);
  }

  if (kind === "file" && normalizedPath === ".") {
    throw new Error(`Config field "${label}" must identify a file inside the project root.`);
  }

  if (!isWithinProject(projectDir, resolve(projectDir, normalizedPath))) {
    throw new Error(`Config field "${label}" must resolve inside the project root.`);
  }

  if (label === "manifestPath") {
    validateManifestPath(normalizedPath);
  }

  return normalizedPath;
}

function normalizeGlobPattern(value: string): string {
  const normalized = win32
    .normalize(value)
    .split(win32.sep)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .reduce<string>((current, segment) => (current.length === 0 ? segment : posix.join(current, segment)), "");

  return normalized.length === 0 ? "." : normalized;
}

function containsParentTraversal(value: string): boolean {
  return normalizeGlobPattern(value)
    .split("/")
    .some((segment) => segment === "..") || toPosixPattern(value).split("/").some((segment) => segment === "..");
}

function toPosixPattern(value: string): string {
  return value.replaceAll("\\", "/");
}

function isWithinProject(projectDir: string, candidatePath: string): boolean {
  const relativePath = win32.relative(projectDir, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !win32.isAbsolute(relativePath));
}

function validateManifestPath(path: string): void {
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 2) {
    throw new Error('Config field "manifestPath" must live in a first-level project directory so manifest paths stay project-relative.');
  }
}
