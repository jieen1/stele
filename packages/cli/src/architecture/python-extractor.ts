// Round 14 P2: Python import extractor for `architecture` evaluation.
//
// Mirrors the `extractImports(file, source) -> DependencyEdge[]` shape
// of the TypeScript extractor, but uses a regex-based scan of the
// source. We do not invoke Python here; the imports we care about
// (top-level `import` / `from … import …`) are syntactically simple
// enough that regex is reliable, and we keep architecture-runtime
// synchronous + fast.
//
// Resolution policy (mirrors `python_call_graph_extractor.py`):
//   - `import foo.bar.baz`     → resolved file = project/foo/bar/baz.py
//                                or  project/foo/bar/baz/__init__.py
//   - `from foo.bar import x`  → resolved file = project/foo/bar.py
//                                or  project/foo/bar/__init__.py
//   - relative imports (`from .helpers import x`) → resolve against
//                                the importing file's package dir
//   - unresolvable specifiers (3rd-party libs, stdlib) → toFile undefined,
//                                edge still emitted so the architecture
//                                evaluator can decide whether to treat
//                                them as cross-architecture / external.

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { DependencyEdge } from "@stele/architecture-core";

export interface PyExtractor {
  extractImports(absolutePath: string, source: string): DependencyEdge[];
}

export interface PyExtractorOptions {
  projectDir: string;
}

const _IMPORT_LINE_RE =
  /^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import[ \t]+([\w*,\s()]+)|import[ \t]+([\w.,\s]+))/gm;

export function createPyExtractor(options: PyExtractorOptions): PyExtractor {
  const projectDir = resolve(options.projectDir);

  function resolveDotted(dotted: string, baseDirAbs: string): string | null {
    if (dotted.startsWith(".")) {
      // Relative import: collapse leading dots into parent-dir hops.
      let levelsUp = 0;
      while (levelsUp < dotted.length && dotted[levelsUp] === ".") {
        levelsUp += 1;
      }
      // `from . import x` → 1 dot = current package; 2 dots = parent; …
      // After consuming the dots, `levelsUp - 1` is the number of
      // dirname() hops we need from the importing file's directory.
      let base = baseDirAbs;
      for (let i = 0; i < levelsUp - 1; i += 1) {
        base = dirname(base);
      }
      const rest = dotted.slice(levelsUp);
      const restPath = rest.length > 0 ? rest.replace(/\./g, sep) : "";
      const candidates = [
        restPath.length > 0 ? join(base, `${restPath}.py`) : null,
        restPath.length > 0
          ? join(base, restPath, "__init__.py")
          : join(base, "__init__.py"),
      ].filter((p): p is string => p !== null);
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return null;
    }
    // Absolute import: try resolving from projectDir.
    const parts = dotted.split(".");
    const candidates = [
      resolve(projectDir, ...parts) + ".py",
      resolve(projectDir, ...parts, "__init__.py"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  return {
    extractImports(absolutePath: string, source: string): DependencyEdge[] {
      const edges: DependencyEdge[] = [];
      const fromFile = absolutePath;
      const baseDir = dirname(absolutePath);
      // Walk every line; the regex is multiline-anchored so we get
      // line numbers via the match index.
      _IMPORT_LINE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = _IMPORT_LINE_RE.exec(source)) !== null) {
        const [, fromModule, fromNames, importNames] = match;
        const line = lineOf(source, match.index);
        const column = columnOf(source, match.index);
        if (fromModule !== undefined && fromNames !== undefined) {
          // `from X import a, b, c`
          const resolved = resolveDotted(fromModule, baseDir);
          edges.push({
            fromModule: "",
            toModule: "",
            fromFile,
            toFile: resolved ?? undefined,
            specifier: fromModule,
            importKind: "static-import",
            line,
            column,
          });
        } else if (importNames !== undefined) {
          // `import a, b.c, d`
          for (const part of importNames.split(",")) {
            const dotted = part.trim().split(/\s+as\s+/u)[0]!;
            if (dotted.length === 0) continue;
            const resolved = resolveDotted(dotted, baseDir);
            edges.push({
              fromModule: "",
              toModule: "",
              fromFile,
              toFile: resolved ?? undefined,
              specifier: dotted,
              importKind: "static-import",
              line,
              column,
            });
          }
        }
      }
      return edges;
    },
  };
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function columnOf(source: string, index: number): number {
  let last = source.lastIndexOf("\n", index - 1);
  return index - last;
}
