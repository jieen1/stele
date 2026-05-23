/**
 * Glob-style NodeId pattern matcher.
 *
 * Supported pattern shapes:
 *   src/db/**                              file glob, no symbol restriction
 *   **::Repository::*                      any container Repository, any method
 *   **::Repository::find(*)                Repository.find with any arity
 *   **::Repository::find(2)                Repository.find with arity exactly 2
 *   **::Repository::find(2)#abc12345       exact arity + disambiguator
 *   stripe.*                               sugar for extern:stripe::*
 *   extern:stripe::*                       extern logical-name match
 *   **\/services/*.ts::*                   file glob restricted to TS in services/
 *
 * Brace expansion `{ts,py,go,java,rs}` is delegated to minimatch.
 *
 * When the pattern omits arity (no parens), ANY arity matches.
 * When the pattern uses `(*)`, ANY arity matches.
 * When the pattern uses `(N)`, only that arity matches.
 *
 * When the pattern omits the disambiguator, any disambiguator (or
 * none) matches. When the pattern specifies `#abc12345`, only that
 * exact disambiguator matches (a NodeId with no disambiguator does
 * not match a pattern that specifies one).
 */

import { minimatch } from "minimatch";

import { parseNodeId } from "./node-id.js";

const EXTERN_PREFIX = "extern:";

interface PatternParts {
  /** Glob pattern for filePath (already extern-aware). */
  readonly leftGlob: string;
  /** True when the pattern targets extern: NodeIds. */
  readonly isExtern: boolean;
  /** Container chain segments; each segment is its own glob. */
  readonly containerGlobs: readonly string[];
  /** Symbol-name glob (e.g. "find", "*", "find*"). */
  readonly symbolGlob: string;
  /** undefined → any arity; -1 → `(*)`; otherwise specific. */
  readonly arity: number | "any";
  /** undefined → match any (or absent) disambiguator. */
  readonly disambiguator: string | undefined;
}

export interface CompiledPattern {
  readonly source: string;
  matches(nodeId: string): boolean;
}

const COMPILE_CACHE = new Map<string, CompiledPattern>();

export function matchPattern(nodeId: string, pattern: string): boolean {
  return compilePattern(pattern).matches(nodeId);
}

export function compilePattern(pattern: string): CompiledPattern {
  const cached = COMPILE_CACHE.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = compilePatternImpl(pattern);
  COMPILE_CACHE.set(pattern, compiled);
  return compiled;
}

function compilePatternImpl(rawPattern: string): CompiledPattern {
  const parsed = parsePattern(rawPattern);

  const compiled: CompiledPattern = {
    source: rawPattern,
    matches(nodeId: string): boolean {
      if (parsed === null) {
        return false;
      }
      const node = parseNodeId(nodeId);
      if (node === null) {
        return false;
      }
      return matchAgainst(node, parsed);
    },
  };
  return compiled;
}

function parsePattern(rawPattern: string): PatternParts | null {
  if (typeof rawPattern !== "string" || rawPattern.length === 0) {
    return null;
  }

  let pattern = rawPattern;
  let isExtern = false;

  // Detect extern explicit form `extern:<name>::...`.
  if (pattern.startsWith(EXTERN_PREFIX)) {
    isExtern = true;
  } else if (isExternShorthand(pattern)) {
    // Sugar: `stripe.*` → `extern:stripe::*`. We rewrite, then fall
    // through normal processing.
    const dotIdx = pattern.indexOf(".");
    const logical = pattern.slice(0, dotIdx);
    const tail = pattern.slice(dotIdx + 1);
    pattern = `${EXTERN_PREFIX}${logical}::${tail === "*" ? "*" : tail}`;
    isExtern = true;
  }

  // Split into "left of first ::" + "rest". Left = file glob or
  // `extern:name`. Rest = container::*::symbol(arity)[#d].
  let leftGlob: string;
  let rest: string | undefined;

  const firstSep = pattern.indexOf("::");
  if (firstSep < 0) {
    // No symbol portion at all — pattern is purely a file glob.
    leftGlob = pattern;
    rest = undefined;
  } else {
    leftGlob = pattern.slice(0, firstSep);
    rest = pattern.slice(firstSep + 2);
  }

  // Strip the `extern:` prefix from leftGlob for matching purposes;
  // we'll match the externLogicalName separately.
  if (isExtern && leftGlob.startsWith(EXTERN_PREFIX)) {
    leftGlob = leftGlob.slice(EXTERN_PREFIX.length);
  }

  // Parse the symbol portion.
  let containerGlobs: readonly string[] = [];
  let symbolGlob = "*";
  let arity: number | "any" = "any";
  let disambiguator: string | undefined;

  if (rest !== undefined && rest.length > 0) {
    // Extract disambiguator.
    let working = rest;
    const hashIdx = working.lastIndexOf("#");
    if (hashIdx >= 0) {
      const dCandidate = working.slice(hashIdx + 1);
      if (/^[0-9a-f]{8}$/.test(dCandidate)) {
        disambiguator = dCandidate;
        working = working.slice(0, hashIdx);
      }
    }

    // Extract arity. Match the LAST `(...)` group.
    const arityMatch = /^(.*)\(([^()]*)\)$/.exec(working);
    if (arityMatch) {
      const before = arityMatch[1];
      const inside = arityMatch[2];
      if (before !== undefined && inside !== undefined) {
        working = before;
        if (inside === "*" || inside === "") {
          arity = "any";
        } else if (/^\d+$/.test(inside)) {
          arity = Number(inside);
        } else {
          // Malformed arity → pattern invalid.
          return null;
        }
      }
    }

    // The remaining `working` is `container::*::symbol`. Split by `::`.
    if (working.length === 0) {
      // e.g. pattern "src/x.ts::(1)" — no symbol; treat as match-any-symbol.
      symbolGlob = "*";
      containerGlobs = [];
    } else if (working === "*" || working === "**") {
      // Bare `*` or `**` after the prefix means "anywhere": any
      // container chain (including empty) + any symbol name. This is
      // what `extern:stripe::*` and `**::Repository::*`-style patterns
      // intuitively express.
      symbolGlob = "*";
      containerGlobs = ["**"];
    } else {
      const parts = working.split("::");
      const last = parts.pop();
      if (last === undefined || last.length === 0) {
        // Trailing `::` is invalid.
        return null;
      }
      symbolGlob = last;
      containerGlobs = parts.filter((p) => p.length > 0);
    }
  }

  return {
    leftGlob,
    isExtern,
    containerGlobs,
    symbolGlob,
    arity,
    disambiguator,
  };
}

function isExternShorthand(pattern: string): boolean {
  // Shorthand: a single logical-name segment, then `.`, then a glob.
  // Disallow if the pattern already has `::` (then it's a normal form).
  if (pattern.includes("::")) {
    return false;
  }
  if (pattern.includes("/")) {
    // File path: not a shorthand.
    return false;
  }
  const dotIdx = pattern.indexOf(".");
  if (dotIdx <= 0) {
    return false;
  }
  const logical = pattern.slice(0, dotIdx);
  // logical-name: lowercase kebab-case starting with a letter.
  return /^[a-z][a-z0-9-]*$/.test(logical);
}

function matchAgainst(
  node: ReturnType<typeof parseNodeId>,
  pattern: PatternParts,
): boolean {
  if (node === null) {
    return false;
  }

  // Extern-ness must agree.
  if (pattern.isExtern !== node.isExtern) {
    return false;
  }

  // Match the "left" (file path or extern logical name).
  if (node.isExtern) {
    const logical = node.externLogicalName ?? "";
    if (!minimatch(logical, pattern.leftGlob, MINIMATCH_OPTS)) {
      return false;
    }
  } else {
    const filePath = node.filePath ?? "";
    if (!minimatch(filePath, pattern.leftGlob, MINIMATCH_OPTS)) {
      return false;
    }
  }

  // Match container chain.
  if (!matchContainerChain(node.container, pattern.containerGlobs)) {
    return false;
  }

  // Match symbol.
  if (!minimatch(node.symbolName, pattern.symbolGlob, MINIMATCH_OPTS)) {
    return false;
  }

  // Match arity.
  if (pattern.arity !== "any" && node.arity !== pattern.arity) {
    return false;
  }

  // Match disambiguator. Pattern-specified disambiguator requires
  // exact equality; pattern-omitted matches any (including absent).
  if (pattern.disambiguator !== undefined) {
    if (node.disambiguator !== pattern.disambiguator) {
      return false;
    }
  }

  return true;
}

const MINIMATCH_OPTS = {
  // Allow `**` to span directory separators in file globs and to
  // span container chain (we feed container segments individually but
  // also use `**` to absorb whole-chain wildcards).
  dot: true,
  nocomment: true,
  noext: false,
};

/**
 * Container chain matching with `**` support.
 *
 * - `**` in `containerGlobs` matches zero or more container segments.
 * - Each non-`**` glob matches exactly one container segment.
 */
function matchContainerChain(
  nodeContainer: readonly string[],
  patternGlobs: readonly string[],
): boolean {
  return walkContainer(nodeContainer, 0, patternGlobs, 0);
}

function walkContainer(
  nodeC: readonly string[],
  ni: number,
  patternG: readonly string[],
  pi: number,
): boolean {
  // Reached end of pattern: only valid if we consumed all node segments.
  if (pi >= patternG.length) {
    return ni >= nodeC.length;
  }

  const cur = patternG[pi];

  if (cur === "**") {
    // Try matching zero or more segments.
    // Skip the `**`:
    if (walkContainer(nodeC, ni, patternG, pi + 1)) {
      return true;
    }
    // Consume one segment and stay on `**`:
    if (ni < nodeC.length && walkContainer(nodeC, ni + 1, patternG, pi)) {
      return true;
    }
    return false;
  }

  if (ni >= nodeC.length) {
    return false;
  }

  if (cur === undefined) {
    return false;
  }

  const seg = nodeC[ni];
  if (seg === undefined) {
    return false;
  }

  if (!minimatch(seg, cur, MINIMATCH_OPTS)) {
    return false;
  }
  return walkContainer(nodeC, ni + 1, patternG, pi + 1);
}
