import { readFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE, type SteleConfig } from "./defaults.js";

type PartialConfig = Partial<Omit<SteleConfig, "protected">> & {
  protected?: unknown;
};

export async function loadConfig(projectDir: string): Promise<SteleConfig> {
  const configFile = await readFile(resolve(projectDir, STELE_CONFIG_FILE), "utf8");
  const parsed = JSON.parse(configFile) as PartialConfig;

  return {
    version: readString(parsed.version, DEFAULT_CONFIG.version),
    contractDir: normalizeRelativePath(readString(parsed.contractDir, DEFAULT_CONFIG.contractDir)),
    entry: normalizeRelativePath(readString(parsed.entry, DEFAULT_CONFIG.entry)),
    generatedDir: normalizeRelativePath(readString(parsed.generatedDir, DEFAULT_CONFIG.generatedDir)),
    checkerImplDir: normalizeRelativePath(readString(parsed.checkerImplDir, DEFAULT_CONFIG.checkerImplDir)),
    manifestPath: normalizeRelativePath(readString(parsed.manifestPath, DEFAULT_CONFIG.manifestPath)),
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

function normalizeRelativePath(value: string): string {
  const normalized = win32
    .normalize(value)
    .split(win32.sep)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .reduce<string>((current, segment) => (current.length === 0 ? segment : posix.join(current, segment)), "");

  return normalized.length === 0 ? "." : normalized;
}
