import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listRegisteredBackends } from "../backend-registry.js";
import { DEFAULT_CONFIG, INIT_PROTECTED_PATTERNS, STELE_CONFIG_FILE, SteleConfig } from "../config/defaults.js";
import { readOptionalFile, writeIfMissing } from "../utils/shared-utils.js";
import { maybeInstallPreCommit } from "./pre-commit.js";
import {
  buildEnhancedConftest,
  buildExampleCheckerFiles,
  buildGitignoreContent,
  buildGoScaffold,
  buildJavaScaffold,
  buildMinimalConftest,
  buildPythonScaffold,
  buildRustScaffold,
  buildTypeScriptScaffold,
  DEFAULT_CONTRACT_SOURCE,
  getCiTemplate,
  getExampleFixturesContractSource,
  getFrameworkContractSource,
  getNextSteps,
} from "./init-templates.js";

export type InitOptions = {
  language: string;
  dryRun?: boolean;
  preCommit?: boolean;
  ci?: "github-actions" | "gitlab-ci";
  withExampleFixtures?: boolean;
};

export const SUPPORTED_LANGUAGES: readonly string[] = Array.from(
  new Set(listRegisteredBackends().map((entry) => entry.language)),
);

export async function runInit(projectDir: string, options: InitOptions): Promise<void> {
  const supportedLanguageSet = new Set<string>(SUPPORTED_LANGUAGES);

  if (!supportedLanguageSet.has(options.language)) {
    const supported = SUPPORTED_LANGUAGES.join(", ");
    throw new Error(`Unsupported language "${options.language}". Supported languages: ${supported}.`);
  }

  const config = buildConfig(options.language);
  const projectInfo = await detectProject(projectDir);
  const files = buildFilesToCreate(projectDir, config, projectInfo, options.withExampleFixtures);

  if (options.dryRun) {
    printDryRun(files);
    return;
  }

  for (const file of files) {
    await writeIfMissing(file.path, file.content);
  }

  if (options.preCommit) {
    await maybeInstallPreCommit(projectDir);
  }

  if (options.ci) {
    const ciPath = options.ci === "gitlab-ci"
      ? join(projectDir, ".gitlab-ci.yml")
      : join(projectDir, ".github", "workflows", "stele.yml");
    await writeIfMissing(ciPath, getCiTemplate(options.ci));
    const ciRel = options.ci === "gitlab-ci" ? ".gitlab-ci.yml" : ".github/workflows/stele.yml";
    process.stdout.write(`[stele] CI template created: ${ciRel}\n`);
  }

  printInitSummary(projectInfo, config);
}

function buildConfig(language: string): SteleConfig {
  const framework = getFrameworkForLanguage(language);
  const generatedDir = getGeneratedDirForLanguage(language);
  return {
    ...DEFAULT_CONFIG,
    targetLanguage: language,
    testFramework: framework,
    generatedDir: generatedDir,
    // User-project scaffolds get the slim init list (no @stele monorepo
    // internals). Runtime is still defense-in-depth via UNION in loadConfig.
    protected: [...INIT_PROTECTED_PATTERNS],
  };
}

function printDryRun(files: Array<{ path: string; content: string }>): void {
  process.stdout.write("[stele] Dry run — files that would be created:\n\n");
  for (const file of files) {
    const rel = file.path.replace(process.cwd() + "/", "");
    const exists = file.content.length === 0 ? "(empty)" : `${file.content.split("\n").length} lines`;
    process.stdout.write(`  ${rel} — ${exists}\n`);
  }
  process.stdout.write("\n");
}

function getFrameworkForLanguage(language: string): string {
  switch (language) {
    case "typescript": return "vitest";
    case "go": return "testing";
    case "rust": return "cargo-test";
    case "java": return "junit5";
    default: return DEFAULT_CONFIG.testFramework;
  }
}

function getGeneratedDirForLanguage(language: string): string {
  switch (language) {
    case "java": return "src/test/java/contract";
    default: return DEFAULT_CONFIG.generatedDir;
  }
}

function buildFilesToCreate(projectDir: string, config: SteleConfig, projectInfo: DetectedProject, withExampleFixtures?: boolean): Array<{ path: string; content: string }> {
  const language = config.targetLanguage;

  let contractSource: string;
  if (withExampleFixtures && (language === "python" || language === "typescript")) {
    contractSource = getExampleFixturesContractSource();
  } else if (projectInfo.framework !== "unknown") {
    contractSource = getFrameworkContractSource(projectInfo);
  } else {
    contractSource = DEFAULT_CONTRACT_SOURCE;
  }

  const files: Array<{ path: string; content: string }> = [
    { path: join(projectDir, STELE_CONFIG_FILE), content: `${JSON.stringify(config, null, 2)}\n` },
    { path: join(projectDir, "contract", "main.stele"), content: contractSource },
    { path: join(projectDir, "contract", "checker_impls", ".gitkeep"), content: "" },
    ...buildScaffoldFiles(projectDir, language, projectInfo, withExampleFixtures),
    { path: join(projectDir, ".gitignore"), content: buildGitignoreContent() },
  ];

  if (withExampleFixtures && (language === "python" || language === "typescript")) {
    files.push(...buildExampleCheckerFiles(projectDir, language));
  } else if (withExampleFixtures) {
    process.stdout.write(`[stele] Note: --with-example-fixtures is a no-op for language "${language}" (only python and typescript are supported).\n`);
  }

  return files;
}

function buildScaffoldFiles(projectDir: string, language: string, projectInfo: DetectedProject, withExampleFixtures?: boolean): Array<{ path: string; content: string }> {
  switch (language) {
    case "python":
      return buildPythonScaffold(projectDir, projectInfo, withExampleFixtures);
    case "typescript":
      return buildTypeScriptScaffold(projectDir, withExampleFixtures);
    case "go":
      return buildGoScaffold(projectDir);
    case "rust":
      return buildRustScaffold(projectDir);
    case "java":
      return buildJavaScaffold(projectDir);
    default:
      return buildPythonScaffold(projectDir, projectInfo, withExampleFixtures);
  }
}

function printInitSummary(projectInfo: DetectedProject, config: SteleConfig): void {
  const nextSteps = getNextSteps(config.targetLanguage);
  process.stdout.write(`[stele] Initialized Stele in "${projectInfo.root}." (language: ${config.targetLanguage}, framework: ${config.testFramework})\n`);

  if (projectInfo.framework !== "unknown") {
    process.stdout.write(`[stele] Detected framework: ${projectInfo.framework}\n`);
  }

  if (projectInfo.modelFiles.length > 0) {
    process.stdout.write(`[stele] Found model directories: ${projectInfo.modelFiles.join(", ")}\n`);
  }

  process.stdout.write(`[stele] Next steps:\n`);
  process.stdout.write(`  1. Edit contract/main.stele with your invariants\n`);
  process.stdout.write(`  2. stele generate\n`);
  let num = 3;
  for (const cmd of nextSteps) {
    process.stdout.write(`  ${num}. ${cmd}\n`);
    num++;
  }
}

export interface BaseProjectInfo {
  conftestSource: string;
  hasPyproject: boolean;
  hasSetupPy: boolean;
  hasRequirements: boolean;
  srcDirs: string[];
  modelFiles: string[];
  root: string;
}

export interface FrameworkDetection {
  framework: "fastapi" | "flask" | "django" | "unknown";
  endpoints: string[];
}

export type DetectedProject = BaseProjectInfo & FrameworkDetection;

async function detectProject(projectDir: string): Promise<DetectedProject> {
  const hasPyproject = await fileExists(join(projectDir, "pyproject.toml"));
  const hasSetupPy = await fileExists(join(projectDir, "setup.py"));
  const hasRequirements = await fileExists(join(projectDir, "requirements.txt"));
  const srcDirs = await findSourceDirs(projectDir);
  const modelFiles = await findModelFiles(projectDir, srcDirs);

  const frameworkInfo = await detectFramework(projectDir);
  const conftestSource = modelFiles.length > 0 ? buildEnhancedConftest(modelFiles, frameworkInfo) : buildMinimalConftest();

  return {
    conftestSource,
    hasPyproject,
    hasSetupPy,
    hasRequirements,
    srcDirs,
    modelFiles,
    root: projectDir,
    ...frameworkInfo,
  };
}

async function detectFramework(projectDir: string): Promise<FrameworkDetection> {
  const requirements = await readOptionalFile(join(projectDir, "requirements.txt"));
  const pyproject = await readOptionalFile(join(projectDir, "pyproject.toml"));
  const deps = `${requirements ?? ""}${pyproject ?? ""}`.toLowerCase();

  let framework: "fastapi" | "flask" | "django" | "unknown" = "unknown";
  let endpoints: string[] = [];

  if (deps.includes("fastapi")) {
    framework = "fastapi";
    endpoints = await findFastApiEndpoints(projectDir);
  } else if (deps.includes("flask")) {
    framework = "flask";
  } else if (deps.includes("django")) {
    framework = "django";
  }

  return { framework, endpoints };
}

async function findFastApiEndpoints(projectDir: string): Promise<string[]> {
  const srcDirs = await findSourceDirs(projectDir);
  const endpoints: string[] = [];

  for (const srcDir of srcDirs) {
    await collectFastApiEndpoints(srcDir, projectDir, endpoints);
  }

  return endpoints;
}

async function collectFastApiEndpoints(directory: string, projectDir: string, results: string[]): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith("_")) {
        await collectFastApiEndpoints(join(directory, entry.name), projectDir, results);
      }

      if (entry.isFile() && entry.name.endsWith(".py") && !entry.name.startsWith("_")) {
        const content = await readOptionalFile(join(directory, entry.name));
        if (content?.includes("APIRouter") || content?.includes("@app.route") || content?.includes("@router.")) {
          const relativePath = join(directory, entry.name).replace(projectDir + "/", "");
          results.push(relativePath);
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

async function findSourceDirs(projectDir: string): Promise<string[]> {
  const dirs: string[] = [];
  const commonNames = ["src", "app", "lib"];

  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && commonNames.includes(entry.name)) {
        dirs.push(join(projectDir, entry.name));
      }
    }
  } catch {
    // Ignore if root cannot be read
  }

  if (dirs.length === 0) {
    dirs.push(projectDir);
  }

  return dirs;
}

async function findModelFiles(projectDir: string, srcDirs: string[]): Promise<string[]> {
  const models: string[] = [];

  for (const srcDir of srcDirs) {
    try {
      const entries = await readdir(srcDir);
      for (const entry of entries) {
        const path = join(srcDir, entry);
        const st = await stat(path);

        if (st.isDirectory()) {
          const lower = entry.toLowerCase();
          if (lower === "models" || lower === "schemas") {
            models.push(path);
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return models;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
