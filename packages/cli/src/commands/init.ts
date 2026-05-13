import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listRegisteredBackends } from "../backend-registry.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE, SteleConfig } from "../config/defaults.js";
import { readOptionalFile, writeIfMissing } from "../utils/shared-utils.js";
import { maybeInstallPreCommit } from "./pre-commit.js";

export type InitOptions = {
  language: string;
  dryRun?: boolean;
  preCommit?: boolean;
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
  const files = buildFilesToCreate(projectDir, config, projectInfo);

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

function buildFilesToCreate(projectDir: string, config: SteleConfig, projectInfo: DetectedProject): Array<{ path: string; content: string }> {
  const language = config.targetLanguage;
  const files: Array<{ path: string; content: string }> = [
    { path: join(projectDir, STELE_CONFIG_FILE), content: `${JSON.stringify(config, null, 2)}\n` },
    { path: join(projectDir, "contract", "main.stele"), content: projectInfo.framework !== "unknown" ? getFrameworkContractSource(projectInfo) : DEFAULT_CONTRACT_SOURCE },
    { path: join(projectDir, "contract", "checker_impls", ".gitkeep"), content: "" },
    ...buildScaffoldFiles(projectDir, language, projectInfo),
    { path: join(projectDir, ".gitignore"), content: buildGitignoreContent() },
  ];

  return files;
}

function buildScaffoldFiles(projectDir: string, language: string, projectInfo: DetectedProject): Array<{ path: string; content: string }> {
  switch (language) {
    case "python":
      return buildPythonScaffold(projectDir, projectInfo);
    case "typescript":
      return buildTypeScriptScaffold(projectDir);
    case "go":
      return buildGoScaffold(projectDir);
    case "rust":
      return buildRustScaffold(projectDir);
    case "java":
      return buildJavaScaffold(projectDir);
    default:
      return buildPythonScaffold(projectDir, projectInfo);
  }
}

// ---------------------------------------------------------------------------
// Language-specific scaffolding
// ---------------------------------------------------------------------------

function buildPythonScaffold(projectDir: string, projectInfo: DetectedProject): Array<{ path: string; content: string }> {
  return [
    { path: join(projectDir, "tests", "contract", "conftest.py"), content: projectInfo.conftestSource },
    { path: join(projectDir, "tests", "contract", "__init__.py"), content: "" },
  ];
}

function buildTypeScriptScaffold(projectDir: string): Array<{ path: string; content: string }> {
  return [
    {
      path: join(projectDir, "tests", "contract", "conftest.ts"),
      content: buildTypeScriptConftest(),
    },
  ];
}

function buildGoScaffold(projectDir: string): Array<{ path: string; content: string }> {
  return [
    { path: join(projectDir, "go.mod"), content: goModTemplate() },
    { path: join(projectDir, "tests", "contract", "setup_test.go"), content: goSetupTestTemplate() },
  ];
}

function buildRustScaffold(projectDir: string): Array<{ path: string; content: string }> {
  return [
    { path: join(projectDir, "Cargo.toml"), content: rustCargoTomlTemplate() },
    { path: join(projectDir, "src", "lib.rs"), content: "// Required by Cargo for compilation.\n" },
    { path: join(projectDir, "tests", "contract", "mod.rs"), content: "// Test module placeholder.\n" },
  ];
}

function buildJavaScaffold(projectDir: string): Array<{ path: string; content: string }> {
  return [
    { path: join(projectDir, "pom.xml"), content: javaPomTemplate() },
    {
      path: join(projectDir, "src", "test", "java", "contract", "SteleConftest.java"),
      content: javaSteleConftestTemplate(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Template builders
// ---------------------------------------------------------------------------

function buildTypeScriptConftest(): string {
  return [
    'import { defineConfig } from "vitest/config";',
    "",
    '// Wire your application data here for contract testing.',
    '// Example:',
    "// export default defineConfig({",
    "//   test: {",
    "//     setupFiles: ['./tests/contract/stele-setup.ts'],",
    "//   },",
    "// });",
    "",
    "export default defineConfig({});",
    "",
  ].join("\n");
}

function goModTemplate(): string {
  return [
    "module stele-contracts",
    "",
    "go 1.21",
    "",
  ].join("\n");
}

function goSetupTestTemplate(): string {
  return [
    "package contract_test",
    "",
    "// SetupSteleContext initializes the SteleContext with your application data.",
    "// Override this function to wire real data from your application.",
    "func SetupSteleContext() *SteleContext {",
    "\tctx := NewContext()",
    "\t// Example: ctx.Data[\"account\"] = map[string]any{\"balance\": 1000}",
    "\treturn ctx",
    "}",
    "",
    "func init() {",
    "\tglobalCtx = SetupSteleContext()",
    "}",
    "",
  ].join("\n");
}

function rustCargoTomlTemplate(): string {
  return [
    "[package]",
    'name = "stele-contracts"',
    "version = \"0.1.0\"",
    "edition = \"2021\"",
    "",
    "[dev-dependencies]",
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'regex = "1"',
    'once_cell = "1"',
    "",
  ].join("\n");
}

function javaPomTemplate(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>com.stele</groupId>
  <artifactId>stele-contracts</artifactId>
  <version>0.1.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.source>1.8</maven.compiler.source>
    <maven.compiler.target>1.8</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <junit.version>5.10.0</junit.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter-api</artifactId>
      <version>\${junit.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter-engine</artifactId>
      <version>\${junit.version}</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.2</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.11.0</version>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

function javaSteleConftestTemplate(): string {
  return [
    "package contract;",
    "",
    "import java.util.LinkedHashMap;",
    "import java.util.Map;",
    "",
    "public class SteleConftest {",
    "    /**",
    "     * Wire your application data here for contract testing.",
    "     * Example: ctx.put(\"account\", createMap(\"balance\", 1000));",
    "     */",
    "    public static Map<String, Object> steleContext() {",
    "        Map<String, Object> ctx = new LinkedHashMap<>();",
    "        // ctx.put(\"account\", createMap(\"balance\", 1000));",
    "        return ctx;",
    "    }",
    "",
    '    @SuppressWarnings("unchecked")',
    "    private static Map<String, Object> createMap(Object... kvs) {",
    "        Map<String, Object> map = new LinkedHashMap<>();",
    "        for (int i = 0; i < kvs.length; i += 2) {",
    "            map.put((String) kvs[i], kvs[i + 1]);",
    "        }",
    "        return map;",
    "    }",
    "}",
    "",
  ].join("\n");
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

function getNextSteps(language: string): string[] {
  switch (language) {
    case "python":
      return ["python -m pytest tests/contract -q", "stele check"];
    case "typescript":
      return ["npx vitest run tests/contract", "stele check"];
    case "go":
      return ["go test ./tests/contract/...", "stele check"];
    case "rust":
      return ["cargo test", "stele check"];
    case "java":
      return ["mvn test", "stele check"];
    default:
      return ["Run your test framework", "stele check"];
  }
}

function getFrameworkContractSource(projectInfo: DetectedProject): string {
  switch (projectInfo.framework) {
    case "fastapi":
      return [
        "(invariant EXAMPLE_RULE",
        "  (severity high)",
        '  (description "Replace this example with your first contract invariant.")',
        "  (assert (eq 1 1))",
        ")",
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
        ")",
        "",
      ].join("\n");

    case "django":
      return [
        "(invariant EXAMPLE_RULE",
        "  (severity high)",
        '  (description "Replace this example with your first contract invariant.")',
        "  (assert (eq 1 1))",
        ")",
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
  ")",
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
