import { readFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE, type SteleConfig } from "./defaults.js";

type PartialConfig = Partial<Omit<SteleConfig, "protected">> & {
  protected?: unknown;
};

export async function loadConfig(projectDir: string): Promise<SteleConfig> {
  const normalizedProjectDir = resolve(projectDir);
  const configFile = await readFile(resolve(projectDir, STELE_CONFIG_FILE), "utf8");
  const parsed = JSON.parse(configFile) as PartialConfig;

  return {
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
    protected: Array.isArray(parsed.protected)
      ? parsed.protected.filter((value): value is string => typeof value === "string")
      : [...DEFAULT_CONFIG.protected],
  };
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

function isAbsoluteLikePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:(?![\\/])/.test(value);
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
