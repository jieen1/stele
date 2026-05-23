import type { LanguageBackend } from "@stele/core";
import { SteleError } from "@stele/core";

/** Registry entry mapping language + framework to a backend npm package. */
export interface RegisteredBackend {
  /** Value of stele.config.json `targetLanguage`. */
  language: string;
  /** Value of stele.config.json `testFramework`; undefined matches any framework. */
  framework?: string;
  /** Dynamically imported npm package name. */
  packageName: string;
  /** CLI display name for error/help output. */
  displayName: string;
}

/** Built-in registered backends. New backends append a row here. */
export const REGISTERED_BACKENDS: readonly RegisteredBackend[] = Object.freeze([
  {
    language: "python",
    framework: "pytest",
    packageName: "@stele/backend-python",
    displayName: "Python (pytest)",
  },
  {
    language: "typescript",
    framework: "vitest",
    packageName: "@stele/backend-typescript",
    displayName: "TypeScript (vitest)",
  },
  {
    language: "rust",
    framework: "cargo-test",
    packageName: "@stele/backend-rust",
    displayName: "Rust (cargo test)",
  },
  {
    language: "go",
    framework: "testing",
    packageName: "@stele/backend-go",
    displayName: "Go (testing)",
  },
  {
    language: "java",
    framework: "junit5",
    packageName: "@stele/backend-java",
    displayName: "Java (JUnit 5)",
  },
] as RegisteredBackend[]);

interface BackendModule {
  default?: LanguageBackend;
  backend?: LanguageBackend;
}

/** Load the LanguageBackend for the given language + framework. */
export async function loadBackend(language: string, framework: string | undefined): Promise<LanguageBackend> {
  let candidates = REGISTERED_BACKENDS.filter(
    (entry) => entry.language === language && (framework === undefined || entry.framework === framework),
  );

  if (candidates.length === 0 && framework === undefined) {
    candidates = REGISTERED_BACKENDS.filter((entry) => entry.language === language);
  }

  if (candidates.length === 0) {
    const supported = REGISTERED_BACKENDS.map((entry) => entry.displayName).join(", ");
    throw new SteleError(
      "E_UNSUPPORTED_BACKEND",
      "BackendError",
      `Unsupported backend: ${language}/${framework ?? "*"}. Supported: ${supported}.`,
      undefined,
      undefined,
      `If this language is planned, run 'npm install @stele/backend-${language}'.`,
    );
  }

  const entry = candidates[0]!;
  let mod: BackendModule;

  try {
    mod = (await import(entry.packageName)) as BackendModule;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SteleError(
      "E_BACKEND_LOAD_FAILED",
      "BackendError",
      `Failed to import ${entry.packageName}: ${message}`,
      undefined,
      undefined,
      `Run 'npm install ${entry.packageName}' if not yet installed.`,
    );
  }

  const backend = mod.default ?? mod.backend;

  if (!backend) {
    throw new SteleError(
      "E_BACKEND_LOAD_FAILED",
      "BackendError",
      `Backend package ${entry.packageName} did not export a default backend.`,
    );
  }

  if (typeof backend.generate !== "function") {
    throw new SteleError(
      "E_BACKEND_LOAD_FAILED",
      "BackendError",
      `Backend ${entry.packageName} does not implement LanguageBackend.generate.`,
    );
  }

  return backend;
}

/** List all registered backends (used for --language validation and error messages). */
export function listRegisteredBackends(): readonly RegisteredBackend[] {
  return REGISTERED_BACKENDS;
}
