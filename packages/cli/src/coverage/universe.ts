import { minimatch } from "minimatch";
import { stableStringCompare } from "@stele/core";
import { walkRoot } from "../code-shape/evaluate.js";
import { isTypeScriptFilePath } from "../code-shape/typescript-analyzer.js";
import { normalizeRelativePath } from "../code-shape/code-shape-common.js";

/**
 * The "countable universe" is the set of product source files that *could*
 * be protected by a contract — the denominator of the coverage ratio.
 *
 * Coverage is purely static: we enumerate these files once, then ask each
 * contract mechanism which of them it binds. No tests run, no instrumentation.
 */

export interface UniverseFile {
  /** Project-relative POSIX path. */
  readonly path: string;
  /** Owning workspace package (`packages/<name>`), or "" when not under packages/. */
  readonly pkg: string;
  readonly lang: "typescript" | "python";
}

/**
 * Default source-root globs. Derived from the workspace package layout. These
 * are the fallback when `stele.config.json` carries no explicit source roots
 * (it has none today — the field is reserved for a future extension).
 */
export const DEFAULT_UNIVERSE_ROOTS: readonly string[] = Object.freeze([
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
  "packages/backend-python/runtime/**/*.py",
  // NOTE: contract/checker_impls/**/*.py is deliberately NOT a coverage root.
  // Those files are the contract's OWN implementation (the checkers — the
  // guards), not application/product code a spatial contract guards. They
  // cannot carry a class-shape/effect/trace target (they ARE the mechanism)
  // and are protected from tampering by the manifest, not a spatial contract.
  // Counting them flagged the self-protection infra (self_protection.py,
  // test_negative.py) as "uncovered" — a category error.
]);

/**
 * Paths that are NOT product source and must never count toward coverage:
 * tests, build output, fixtures/examples, generated contracts, declaration
 * files, and the usual ignore dirs.
 */
export const COUNTABLE_EXCLUDES: readonly string[] = Object.freeze([
  "**/tests/**",
  "**/*.test.*",
  "**/dist/**",
  "**/build/**",
  "fixtures/**",
  "examples/**",
  "contract/generated/**",
  "tests/contract/**",
  "**/*.d.ts",
  "**/node_modules/**",
  "**/.git/**",
  "**/.stele/**",
  "**/coverage/**",
]);

function isPythonFilePath(path: string): boolean {
  return normalizeRelativePath(path).endsWith(".py");
}

function owningPackage(path: string): string {
  const match = /^packages\/([^/]+)\//.exec(path);
  return match ? `packages/${match[1]}` : "";
}

function isExcluded(path: string): boolean {
  for (const pattern of COUNTABLE_EXCLUDES) {
    if (minimatch(path, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Enumerate the countable universe under `projectDir`. Deterministic: walks
 * each root with the same `../`-guard + symlink-skip the code-shape stage uses,
 * minimatch-filters by the root globs, drops excludes, sorts, and dedupes.
 */
export async function enumerateUniverse(
  projectDir: string,
  roots: readonly string[] = DEFAULT_UNIVERSE_ROOTS,
): Promise<UniverseFile[]> {
  const seen = new Set<string>();
  const out: UniverseFile[] = [];

  // Walk each distinct top-level directory once, then filter by every root
  // glob. We derive the walk directory from the literal prefix of each glob.
  const walkDirs = new Map<string, string[]>();
  for (const root of roots) {
    const top = root.split("/")[0] ?? ".";
    const existing = walkDirs.get(top);
    if (existing === undefined) {
      walkDirs.set(top, [root]);
    } else {
      existing.push(root);
    }
  }

  const { resolve } = await import("node:path");
  for (const [top, rootGlobs] of walkDirs) {
    const walkDir = top === "." ? resolve(projectDir) : resolve(projectDir, top);
    const files = await walkRoot(walkDir, resolve(projectDir));
    for (const file of files) {
      if (seen.has(file)) continue;
      if (!rootGlobs.some((glob) => minimatch(file, glob))) continue;
      if (isExcluded(file)) continue;
      const lang = isTypeScriptFilePath(file)
        ? "typescript"
        : isPythonFilePath(file)
          ? "python"
          : undefined;
      if (lang === undefined) continue;
      seen.add(file);
      out.push({ path: file, pkg: owningPackage(file), lang });
    }
  }

  out.sort((a, b) => stableStringCompare(a.path, b.path));
  return out;
}
