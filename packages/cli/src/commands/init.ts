import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listRegisteredBackends } from "../backend-registry.js";
import { DEFAULT_CONFIG, INIT_PROTECTED_PATTERNS, STELE_CONFIG_FILE, SteleConfig } from "../config/defaults.js";
import { readOptionalFile, writeIfMissing } from "../utils/shared-utils.js";
import { maybeInstallPreCommit } from "./pre-commit.js";

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

// ---------------------------------------------------------------------------
// Language-specific scaffolding
// ---------------------------------------------------------------------------

function buildPythonScaffold(projectDir: string, projectInfo: DetectedProject, withExampleFixtures?: boolean): Array<{ path: string; content: string }> {
  const conftestContent = withExampleFixtures ? buildRichPythonConftest() : projectInfo.conftestSource;
  return [
    { path: join(projectDir, "tests", "contract", "conftest.py"), content: conftestContent },
    { path: join(projectDir, "tests", "contract", "__init__.py"), content: "" },
  ];
}

function buildTypeScriptScaffold(projectDir: string, withExampleFixtures?: boolean): Array<{ path: string; content: string }> {
  return [
    {
      path: join(projectDir, "tests", "contract", "stele_context.ts"),
      content: withExampleFixtures ? buildRichTypeScriptContext() : buildTypeScriptConftest(),
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

function buildRichPythonConftest(): string {
  return [
    "import pytest",
    "from decimal import Decimal",
    "from importlib.util import module_from_spec, spec_from_file_location",
    "from pathlib import Path",
    "",
    "",
    "def _load_checker(name):",
    '    """Load a checker module from contract/checker_impls/<name>.py."""',
    "    project_root = Path(__file__).resolve().parents[2]",
    "    path = project_root / 'contract' / 'checker_impls' / f'{name}.py'",
    "    spec = spec_from_file_location(name, path)",
    "    mod = module_from_spec(spec)",
    "    spec.loader.exec_module(mod)",
    "    return mod.check",
    "",
    "",
    "# ---------------------------------------------------------------------------",
    "# This conftest.py wires a realistic e-commerce fixture into Stele contracts.",
    "#",
    "# The keys below map directly to (path …) expressions in contract/main.stele.",
    "# Replace the stub values with real data from your application or test DB.",
    "# ---------------------------------------------------------------------------",
    "",
    "",
    "@pytest.fixture",
    "def stele_context():",
    "    user = {",
    '        "id": "usr-001",',
    '        "email": "alice@example.com",',
    '        "status": "active",',
    "    }",
    "    account = {",
    '        "id": "acct-001",',
    '        "balance": Decimal("250.00"),',
    '        "currency": "USD",',
    "    }",
    "    orders = [",
    "        {",
    '            "id": "ord-001",',
    '            "total": Decimal("49.99"),',
    "        },",
    "        {",
    '            "id": "ord-002",',
    '            "total": Decimal("14.50"),',
    "        },",
    "    ]",
    "    # Flat items collection — referenced by the SKU_FORMAT invariant.",
    "    items = [",
    '        {"sku": "WIDGET-A1", "price": Decimal("29.99"), "qty": 1},',
    '        {"sku": "WIDGET-B2", "price": Decimal("20.00"), "qty": 1},',
    '        {"sku": "GADGET-C3", "price": Decimal("14.50"), "qty": 1},',
    "    ]",
    "    return {",
    '        "user": user,',
    '        "account": account,',
    '        "orders": orders,',
    '        "items": items,',
    "        # _stele_checkers maps checker IDs (as declared in contract/main.stele)",
    "        # to Python callables. Each callable receives (stele_context, **kwargs).",
    '        "_stele_checkers": {',
    '            "validate-sku": _load_checker("validate_sku"),',
    '            "validate-email": _load_checker("validate_email"),',
    "        },",
    "    }",
    "",
    "",
    "@pytest.fixture",
    "def stele_sandbox():",
    '    """Scenario sandbox. Only needed if you use (scenario …) contracts."""',
    "    return None",
    "",
  ].join("\n");
}

function buildRichTypeScriptContext(): string {
  return [
    'import type { SteleContext } from "../contract/_stele_runtime.js";',
    "",
    "// ---------------------------------------------------------------------------",
    "// Wire your application data here for contract testing.",
    "// The keys below map directly to (path …) expressions in contract/main.stele.",
    "// ---------------------------------------------------------------------------",
    "",
    "export const steleContext: SteleContext = {",
    "  user: {",
    '    id: "usr-001",',
    '    email: "alice@example.com",',
    '    status: "active",',
    "  },",
    "  account: {",
    '    id: "acct-001",',
    "    balance: 250.0,",
    '    currency: "USD",',
    "  },",
    "  orders: [",
    "    { id: 'ord-001', total: 49.99 },",
    "    { id: 'ord-002', total: 14.5 },",
    "  ],",
    "  // Flat items collection — referenced by the SKU_FORMAT invariant.",
    "  items: [",
    '    { sku: "WIDGET-A1", price: 29.99, qty: 1 },',
    '    { sku: "WIDGET-B2", price: 20.0, qty: 1 },',
    '    { sku: "GADGET-C3", price: 14.5, qty: 1 },',
    "  ],",
    "  _stele_checkers: {},",
    "};",
    "",
  ].join("\n");
}

function getExampleFixturesContractSource(): string {
  return [
    "; ============================================================================",
    "; Example fixtures contract — generated by stele init --with-example-fixtures",
    ";",
    "; Five realistic e-commerce invariants covering a fake order domain.",
    "; Companion context is in tests/contract/conftest.py (Python) or",
    "; tests/contract/stele_context.ts (TypeScript).",
    "; ============================================================================",
    "",
    "(metadata",
    '  (stele-version "0.1")',
    '  (project "my-app"))',
    "",
    "; --- 1. Order totals must be positive ---",
    "",
    "(invariant ORDER_TOTAL_POSITIVE",
    "  (severity error)",
    '  (description "Every order total must be greater than zero.")',
    "  (assert (forall order (collection orders)",
    "                  (gt (path order total) 0))))",
    "",
    "; --- 2. All orders have non-null IDs ----------------------------------------",
    "",
    "(invariant ORDER_ID_PRESENT",
    "  (severity error)",
    '  (description "Every order must have a non-null ID.")',
    "  (assert (forall order (collection orders)",
    "                  (not-null (path order id)))))",
    "",
    "; --- 3. User status must be an allowed enum value ---",
    "",
    "(invariant USER_STATUS_ENUM",
    "  (severity error)",
    '  (description "User status must be active, suspended, or deleted.")',
    '  (assert (or (eq (path user status) "active")',
    '              (eq (path user status) "suspended")',
    '              (eq (path user status) "deleted"))))',
    "",
    "; --- 4. SKU format (custom checker) ---",
    ";",
    "; validate-sku is implemented in contract/checker_impls/validate_sku.py",
    "; (Python) or validate-sku.ts (TypeScript).",
    "; The checker receives stele_context and validates all SKUs in items.",
    "",
    "(checker validate-sku",
    '  (description "SKU must match ^[A-Z]+-[A-Z0-9]+$ format."))',
    "",
    "(invariant SKU_FORMAT",
    "  (severity warning)",
    '  (description "All item SKUs must match the expected format.")',
    "  (uses-checker validate-sku))",
    "",
    "; --- 5. Email format (custom checker) ---",
    ";",
    "; validate-email is implemented in contract/checker_impls/validate_email.py",
    "; (Python) or validate-email.ts (TypeScript).",
    "",
    "(checker validate-email",
    '  (description "Email must be RFC-shaped (user@domain.tld)."))',
    "",
    "(invariant EMAIL_FORMAT",
    "  (severity warning)",
    '  (description "User email must be RFC-shaped.")',
    "  (uses-checker validate-email))",
    "",
  ].join("\n");
}

function buildExampleCheckerFiles(projectDir: string, language: string): Array<{ path: string; content: string }> {
  if (language === "python") {
    return [
      {
        path: join(projectDir, "contract", "checker_impls", "validate_sku.py"),
        content: buildPythonSkuChecker(),
      },
      {
        path: join(projectDir, "contract", "checker_impls", "validate_email.py"),
        content: buildPythonEmailChecker(),
      },
    ];
  }
  if (language === "typescript") {
    return [
      {
        path: join(projectDir, "contract", "checker_impls", "validate-sku.ts"),
        content: buildTypeScriptSkuChecker(),
      },
      {
        path: join(projectDir, "contract", "checker_impls", "validate-email.ts"),
        content: buildTypeScriptEmailChecker(),
      },
    ];
  }
  return [];
}

function buildPythonSkuChecker(): string {
  return [
    "import re",
    "",
    "# SKU format: UPPERCASE-ALPHANUMERIC e.g. WIDGET-A1, GADGET-123",
    "SKU_PATTERN = re.compile(r'^[A-Z]+-[A-Z0-9]+$')",
    "",
    "",
    "def check(stele_context, **_kwargs):",
    "    \"\"\"",
    "    Custom checker: validates all SKUs in stele_context['items'].",
    "    Returns {passed: bool, message: str}.",
    "    \"\"\"",
    "    items = stele_context.get('items', [])",
    "    for item in items:",
    "        sku = item.get('sku', '') if isinstance(item, dict) else getattr(item, 'sku', '')",
    "        if not SKU_PATTERN.match(str(sku)):",
    "            return {",
    "                'passed': False,",
    "                'message': f'SKU {sku!r} does not match ^[A-Z]+-[A-Z0-9]+$',",
    "            }",
    "    return {'passed': True, 'message': None}",
    "",
  ].join("\n");
}

function buildPythonEmailChecker(): string {
  return [
    "import re",
    "",
    "# Minimal RFC-shaped email pattern: local@domain.tld",
    "EMAIL_PATTERN = re.compile(r'^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')",
    "",
    "",
    "def check(stele_context, **_kwargs):",
    "    \"\"\"",
    "    Custom checker: validates user.email from stele_context.",
    "    Returns {passed: bool, message: str}.",
    "    \"\"\"",
    "    user = stele_context.get('user', {})",
    "    email = user.get('email', '') if isinstance(user, dict) else getattr(user, 'email', '')",
    "    if EMAIL_PATTERN.match(str(email)):",
    "        return {'passed': True, 'message': None}",
    "    return {",
    "        'passed': False,",
    "        'message': f'Email {email!r} is not RFC-shaped (expected user@domain.tld)',",
    "    }",
    "",
  ].join("\n");
}

function buildTypeScriptSkuChecker(): string {
  return [
    "// SKU format: UPPERCASE-ALPHANUMERIC e.g. WIDGET-A1, GADGET-123",
    "const SKU_PATTERN = /^[A-Z]+-[A-Z0-9]+$/;",
    "",
    "export function check(",
    "  steleContext: Record<string, unknown>,",
    "  _kwargs: Record<string, unknown>,",
    "): { passed: boolean; message: string | null } {",
    "  const items = Array.isArray(steleContext['items']) ? steleContext['items'] as Record<string, unknown>[] : [];",
    "  for (const item of items) {",
    "    const sku = String(item['sku'] ?? '');",
    "    if (!SKU_PATTERN.test(sku)) {",
    "      return {",
    "        passed: false,",
    "        message: `SKU ${JSON.stringify(sku)} does not match ^[A-Z]+-[A-Z0-9]+$`,",
    "      };",
    "    }",
    "  }",
    "  return { passed: true, message: null };",
    "}",
    "",
  ].join("\n");
}

function buildTypeScriptEmailChecker(): string {
  return [
    "// Minimal RFC-shaped email pattern: local@domain.tld",
    "const EMAIL_PATTERN = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;",
    "",
    "export function check(",
    "  steleContext: Record<string, unknown>,",
    "  _kwargs: Record<string, unknown>,",
    "): { passed: boolean; message: string | null } {",
    "  const user = (steleContext['user'] ?? {}) as Record<string, unknown>;",
    "  const email = String(user['email'] ?? '');",
    "  if (EMAIL_PATTERN.test(email)) {",
    "    return { passed: true, message: null };",
    "  }",
    "  return {",
    "    passed: false,",
    "    message: `Email ${JSON.stringify(email)} is not RFC-shaped (expected user@domain.tld)`,",
    "  };",
    "}",
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
  "; ============================================================================",
  "; Welcome to Stele! This file is your contract.",
  ";",
  "; Each (invariant ...) form below declares a rule the agent CANNOT silently",
  "; break — `stele generate` turns it into a test, `stele check` proves it",
  "; still passes, and the Claude Code plugin blocks edits to this file.",
  ";",
  "; Edit / delete / add rules below. Then run:",
  ";",
  ";   stele generate                 # rules -> generated tests",
  ";   python -m pytest tests/contract  # run the tests",
  ";   stele lock --reason \"baseline\"   # snapshot SHA-256 of protected files",
  ";   stele check                    # exit 0 = clean",
  ";",
  "; Full grammar reference: docs/spec/cdl.md",
  "; 70+ operators available: eq / gt / gte / lt / lte / in / matches / forall / exists / where / sum / avg / and / or / not / implies / ...",
  "; ============================================================================",
  "",
  "(metadata",
  "  (stele-version \"0.1\")",
  "  (project \"your-app\"))",
  "",
  "; --- Example 1: simple non-negative balance --------------------------------",
  "; Replace `account.balance` with a real path into your `stele_context` fixture",
  "; (see tests/contract/conftest.py).",
  "",
  "(invariant ACCOUNT_BALANCE_NON_NEGATIVE",
  "  (severity error)",
  "  (description \"Account balance must never go below zero.\")",
  "  (assert (gte (path account balance) 0)))",
  "",
  "; --- Example 2: forall over a collection ----------------------------------",
  "; Asserts every order in the orders collection has a positive total.",
  "; In your conftest.py, return `{\"orders\": [<order objects>], ...}`",
  "; from `stele_context` for this to bind.",
  "",
  "(invariant ALL_ORDERS_POSITIVE_TOTAL",
  "  (severity warning)",
  "  (description \"Every order's total must be > 0.\")",
  "  (assert (forall item (collection orders)",
  "                  (gt (path item total) 0))))",
  "",
  "; --- Example 3: enum check (use `or` since CDL has no literal list) ------",
  "",
  "(invariant USER_STATUS_ENUM",
  "  (severity error)",
  "  (description \"User status must be one of the defined states.\")",
  "  (assert (or (eq (path user status) \"active\")",
  "              (eq (path user status) \"suspended\")",
  "              (eq (path user status) \"deleted\"))))",
  "",
  "; Delete examples above and add your own. Each invariant becomes one test.",
  "",
].join("\n");

function buildGitignoreContent(): string {
  return [
    "# Stele",
    "contract/.manifest.json",
    "contract/.baseline.json",
    "contract/.unlock-log.jsonl",
    "contract/.last-check-report.json",
    "contract/proposals/",
    "",
    "# Generated tests",
    "tests/contract/",
    "",
    "# Local events",
    ".stele/events/",
    "",
  ].join("\n");
}

function getCiTemplate(ci: "github-actions" | "gitlab-ci"): string {
  if (ci === "gitlab-ci") {
    return `stele-contracts:
  stage: test
  image: python:3.12-slim
  before_script:
    - pip install pytest
  script:
    - npx stele generate
    - npx stele check
    - python -m pytest tests/contract -q
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == "main"
`;
  }
  return `name: Stele Contracts

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  stele:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pnpm install --frozen-lockfile
      - run: python -m pip install pytest
      - run: npx stele generate
      - run: npx stele check
      - run: python -m pytest tests/contract -q
`;
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
    "# ===========================================================================",
    "# This is your bridge between Stele contracts and your application.",
    "#",
    "# Stele reads whatever `stele_context` returns. The keys must match the",
    "# `(path …)` expressions in contract/main.stele.",
    "#",
    "# The default contract/main.stele references:",
    "#   - account.balance       (number)",
    "#   - user.status           (string)",
    "#   - orders                (collection of objects with .total)",
    "#",
    "# Replace the placeholder values below with real data from your app.",
    "# ===========================================================================",
    "",
    "",
    "@pytest.fixture",
    "def stele_context():",
    "    return {",
    "        # TODO: replace with real values from your application/database/fixtures.",
    "        \"account\": {\"balance\": 100},",
    "        \"user\": {\"status\": \"active\"},",
    "        \"orders\": [",
    "            {\"id\": \"ord-1\", \"total\": 50},",
    "        ],",
    "        # Internal: custom-checker registry (leave empty unless you add",
    "        # (uses-checker …) rules with Python implementations under",
    "        # contract/checker_impls/).",
    "        \"_stele_checkers\": {},",
    "    }",
    "",
    "",
    "@pytest.fixture",
    "def stele_sandbox():",
    "    \"\"\"Scenario sandbox. Only needed if you use (scenario …) contracts.\"\"\"",
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
