/**
 * Extern-alias resolution: logical name (e.g. "stripe") ↔ per-language
 * package name (e.g. npm "stripe", pip "stripe", crate "stripe-rust",
 * maven "com.stripe:stripe-java", go module
 * "github.com/stripe/stripe-go/v74").
 *
 * The CDL form `(extern-alias <logical-name> (typescript "<pkg>") ...)`
 * is parsed elsewhere (in `@stele/core`); this module owns the runtime
 * registry and the `extern:<logical-name>::` pattern resolver.
 */

import type { SupportedLanguage } from "./types.js";

/** Single alias declaration from CDL `(extern-alias ...)` form. */
export interface ExternAlias {
  readonly logicalName: string;
  readonly typescript?: string;
  readonly python?: string;
  readonly go?: string;
  readonly java?: string;
  readonly rust?: string;
}

export interface ExternAliasRegistry {
  /** Look up the per-language package name for a logical alias. */
  lookup(logicalName: string, language: SupportedLanguage): string | null;
  /**
   * Reverse lookup: given an extern package name in a specific
   * language, find the logical name (if any).
   */
  reverseLookup(packageName: string, language: SupportedLanguage): string | null;
}

/**
 * Build a registry from a list of aliases. Conflict policy: when two
 * aliases share the same `logicalName`, this function THROWS — we
 * surface duplicate-key errors at construction time so the CDL
 * validator can report E0363 at parse time. (Callers that need a
 * silent-merge policy can deduplicate before calling.)
 */
export function buildExternAliasRegistry(
  aliases: readonly ExternAlias[],
): ExternAliasRegistry {
  const byLogical = new Map<string, ExternAlias>();
  for (const a of aliases) {
    if (byLogical.has(a.logicalName)) {
      throw new Error(
        `buildExternAliasRegistry: duplicate logical-name '${a.logicalName}'`,
      );
    }
    byLogical.set(a.logicalName, a);
  }

  // Build reverse index per language.
  const reverse = new Map<SupportedLanguage, Map<string, string>>();
  for (const a of aliases) {
    addReverse(reverse, "typescript", a.typescript, a.logicalName);
    addReverse(reverse, "python", a.python, a.logicalName);
    addReverse(reverse, "go", a.go, a.logicalName);
    addReverse(reverse, "java", a.java, a.logicalName);
    addReverse(reverse, "rust", a.rust, a.logicalName);
  }

  return {
    lookup(logicalName, language) {
      const a = byLogical.get(logicalName);
      if (a === undefined) {
        return null;
      }
      const pkg = a[language];
      return pkg ?? null;
    },
    reverseLookup(packageName, language) {
      const map = reverse.get(language);
      if (map === undefined) {
        return null;
      }
      return map.get(packageName) ?? null;
    },
  };
}

function addReverse(
  reverse: Map<SupportedLanguage, Map<string, string>>,
  lang: SupportedLanguage,
  pkg: string | undefined,
  logical: string,
): void {
  if (pkg === undefined) {
    return;
  }
  let map = reverse.get(lang);
  if (map === undefined) {
    map = new Map();
    reverse.set(lang, map);
  }
  // Last-wins on conflicting reverse mapping. The forward map already
  // refused duplicates by `logicalName`, so this only triggers when
  // two distinct aliases map to the same package in the same language.
  map.set(pkg, logical);
}

const EXTERN_PREFIX = "extern:";

/**
 * Resolve `extern:<logical-name>::...` to the current-language form
 * `extern:<resolved-package>::...` by consulting the registry.
 *
 * Returns null when:
 *  - the input is not an `extern:` pattern, or
 *  - the logical name is not registered, or
 *  - the registry has no mapping for the target language.
 *
 * The function preserves the part after the first `::` verbatim. The
 * caller is responsible for downstream pattern matching.
 */
export function resolveExternPattern(
  externPattern: string,
  language: SupportedLanguage,
  registry: ExternAliasRegistry,
): string | null {
  if (!externPattern.startsWith(EXTERN_PREFIX)) {
    return null;
  }
  const afterPrefix = externPattern.slice(EXTERN_PREFIX.length);
  const sepIdx = afterPrefix.indexOf("::");

  let logicalName: string;
  let tail: string;
  if (sepIdx < 0) {
    // e.g. `extern:stripe` with no symbol portion.
    logicalName = afterPrefix;
    tail = "";
  } else {
    logicalName = afterPrefix.slice(0, sepIdx);
    tail = afterPrefix.slice(sepIdx);
  }

  if (logicalName.length === 0) {
    return null;
  }

  const resolved = registry.lookup(logicalName, language);
  if (resolved === null) {
    return null;
  }
  return `${EXTERN_PREFIX}${resolved}${tail}`;
}
