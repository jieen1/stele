import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../config/defaults.js";

export type InitOptions = {
  language: string;
};

export const SUPPORTED_LANGUAGES = ["python"] as const;
const supportedLanguageSet = new Set<string>(SUPPORTED_LANGUAGES);

export async function runInit(projectDir: string, options: InitOptions): Promise<void> {
  if (!supportedLanguageSet.has(options.language)) {
    throw new Error(`Unsupported language "${options.language}". Supported languages: python.`);
  }

  const config = {
    ...DEFAULT_CONFIG,
    targetLanguage: options.language,
  };

  await writeIfMissing(join(projectDir, STELE_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  await writeIfMissing(join(projectDir, "contract", "main.stele"), DEFAULT_CONTRACT_SOURCE);
  await writeIfMissing(join(projectDir, "contract", "checker_impls", ".gitkeep"), "");

  const projectInfo = await detectProject(projectDir);

  if (projectInfo.framework !== "unknown") {
    const frameworkContract = getFrameworkContractSource(projectInfo);
    await writeIfMissing(join(projectDir, "contract", "main.stele"), frameworkContract);
  }

  await writeIfMissing(join(projectDir, "tests", "contract", "conftest.py"), projectInfo.conftestSource);
  await writeIfMissing(join(projectDir, "tests", "contract", "__init__.py"), "");
  await writeIfMissing(join(projectDir, ".gitignore"), buildGitignoreContent());

  printInitSummary(projectInfo);
}

function printInitSummary(projectInfo: DetectedProject): void {
  process.stdout.write(`[stele] Initialized Stele in "${projectInfo.root}."\n`);

  if (projectInfo.framework !== "unknown") {
    process.stdout.write(`[stele] Detected framework: ${projectInfo.framework}\n`);
  }

  if (projectInfo.modelFiles.length > 0) {
    process.stdout.write(`[stele] Found model directories: ${projectInfo.modelFiles.join(", ")}\n`);
  }

  process.stdout.write(`[stele] Next steps:\n`);
  process.stdout.write(`  1. Edit contract/main.stele with your invariants\n`);
  process.stdout.write(`  2. stele generate\n`);
  process.stdout.write(`  3. python -m pytest tests/contract -q\n`);
  process.stdout.write(`  4. stele check\n`);
}

function getFrameworkContractSource(projectInfo: DetectedProject): string {
  switch (projectInfo.framework) {
    case "fastapi":
      return [
        "(invariant EXAMPLE_RULE",
        "  (severity high)",
        '  (description "Replace this example with your first contract invariant.")',
        "  (assert (eq 1 1))",
        "",
        ...(projectInfo.endpoints.length > 0
          ? [
              "; Example: enforce request validation on all endpoints",
              "; (invariant API_REQUEST_VALIDATION",
              ";   (severity error)",
              ";   (description \"All API endpoints must validate request bodies.\")",
              ";   (assert (forall endpoint (collection endpoints) (not-null endpoint.schema))))",
            ]
          : []),
        "",
      ].join("\n");

    case "flask":
      return [
        "(invariant EXAMPLE_RULE",
        "  (severity high)",
        '  (description "Replace this example with your first contract invariant.")',
        "  (assert (eq 1 1))",
        "",
      ].join("\n");

    case "django":
      return [
        "(invariant EXAMPLE_RULE",
        "  (severity high)",
        '  (description "Replace this example with your first contract invariant.")',
        "  (assert (eq 1 1))",
        "",
      ].join("\n");

    default:
      return DEFAULT_CONTRACT_SOURCE;
  }
}

const DEFAULT_CONTRACT_SOURCE = [
  "(invariant EXAMPLE_RULE",
  "  (severity high)",
  '  (description "Replace this example rule with your first contract invariant.")',
  "  (assert (eq 1 1))",
  "",
].join("\n");

function buildGitignoreContent(): string {
  return [
    "# Stele",
    "contract/manifest.json",
    "contract/baseline.json",
    "contract/.unlock-log.jsonl",
    "contract/proposals/",
    "",
    "# Generated tests",
    "tests/contract/",
    "",
  ].join("\n");
}

interface BaseProjectInfo {
  conftestSource: string;
  hasPyproject: boolean;
  hasSetupPy: boolean;
  hasRequirements: boolean;
  srcDirs: string[];
  modelFiles: string[];
  root: string;
}

interface FrameworkDetection {
  framework: "fastapi" | "flask" | "django" | "unknown";
  endpoints: string[];
}

type DetectedProject = BaseProjectInfo & FrameworkDetection;

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

function buildMinimalConftest(): string {
  return [
    "import pytest",
    "",
    "",
    "@pytest.fixture",
    "def stele_context():",
    "    return {}",
    "",
    "",
    "@pytest.fixture",
    "def stele_sandbox():",
    "    return None",
    "",
  ].join("\n");
}

function buildEnhancedConftest(modelFiles: string[], frameworkInfo: FrameworkDetection): string {
  const lines = [
    "import pytest",
    "",
    "# Auto-detected model directories: " + modelFiles.join(", "),
    `# Detected framework: ${frameworkInfo.framework}`,
    "# Wire these to your real application state for contract testing.",
    "",
    "",
    "@pytest.fixture",
    "def stele_context():",
    "    # TODO: Replace with real data from your application",
    '    # Example: "return {',
    '    #     "account": fetch_account(),',
    '    #     "positions": fetch_positions(),',
    "    #     '_stele_checkers': {},",
    "    # }",
    "    return {",
    "        '_stele_checkers': {},",
    "    }",
    "",
    "",
    "@pytest.fixture",
    "def stele_sandbox():",
    "    return None",
    "",
  ];

  return lines.join("\n");
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path, "utf8");
    return;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");

  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
