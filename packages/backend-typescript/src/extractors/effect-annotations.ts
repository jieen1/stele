/**
 * TypeScript implementation of the cross-language
 * `EffectAnnotationExtractor` trait from `@stele/effect-evaluator`.
 *
 * The trait answers one question for the evaluator:
 *
 *   "Which effect names did the author annotate on this function-like
 *    declaration in source code?"
 *
 * In TypeScript the annotation lives in a JSDoc tag:
 *
 *   /** @stele:effects db.read,db.write *\/
 *   function getUser(id: string): User { ... }
 *
 * Multi-line, multi-tag, and class-method forms are also supported.
 *
 * The colon in `@stele:effects` is NOT preserved by TypeScript's JSDoc
 * lexer — it splits the tag name on whitespace, leaving `tag.tagName.text
 * === "stele"` and the comment starting with `:effects ...`. We accept
 * both `tagName === "stele:effects"` (future-proof) and the current
 * `tagName === "stele" + comment-startswith-:effects` shape.
 *
 * Phantom-type annotations (`type Effect<E, T> = T & { __effect: E }`)
 * are NOT implemented in B.1 — only JSDoc. See §六 of
 * docs/design/phase-b/04-effect-system.md.
 *
 * Line/inline `// @stele:effects ...` comments are NOT recognized —
 * only block-form JSDoc. This is consistent with how all other
 * language-native annotation channels work (decorators, attribute
 * macros) and avoids false positives from non-doc commentary.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import * as ts from "typescript";

import type { EffectAnnotationExtractor } from "@stele/effect-evaluator";

import { buildNodeIdForDeclaration } from "./node-id-builder.js";
import type { ExtractorContext } from "./types.js";

/** Strict effect-name pattern — mirrors core's E0350 validator. */
const EFFECT_NAME_RE = /^[a-z][a-z0-9._-]*$/;
/** Glob-permissive variant — mirrors core's effect-reference pattern. */
const EFFECT_GLOB_RE = /^[a-z][a-z0-9._*-]*$/;

/**
 * Parse the value portion of a `@stele:effects` tag.
 *
 * Accepts comma-separated names. Names containing characters outside the
 * grammar are silently dropped — the evaluator is the authority on what
 * to do with bad input. Duplicate names within the same tag are
 * deduplicated (preserving first-seen order).
 *
 * Returns an in-order, deduplicated list of valid effect names.
 */
export function parseEffectsTagValue(raw: string): readonly string[] {
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of tokens) {
    if (!EFFECT_GLOB_RE.test(tok) && !EFFECT_NAME_RE.test(tok)) continue;
    // Disallow whitespace in the middle of a token (shouldn't occur post-trim,
    // but defensively reject any embedded space).
    if (/\s/.test(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return Object.freeze(out);
}

/**
 * Read the `comment` slot of a JSDocTag as a plain string. TypeScript
 * may return a string, an array of inline comment nodes, or undefined.
 */
function tagCommentToString(tag: ts.JSDocTag): string {
  const c = tag.comment;
  if (c === undefined) return "";
  if (typeof c === "string") return c;
  // NodeArray<JSDocComment> — concatenate the `.text` of each part.
  let out = "";
  for (const part of c) {
    if (typeof part === "string") {
      out += part;
    } else if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
      out += (part as { text: string }).text;
    }
  }
  return out;
}

/**
 * Return the effect tokens declared by a single `@stele:effects` JSDoc
 * tag, or null if this tag is not a `stele:effects` tag.
 *
 * Two shapes are accepted:
 *
 *  1. `tag.tagName.text === "stele:effects"` — direct match. Some TS
 *     versions / configurations preserve the colon in the tag name.
 *  2. `tag.tagName.text === "stele"` AND the comment begins with
 *     `:effects` (optionally followed by whitespace). This is what
 *     current TS (≥5.0) actually produces in practice.
 */
function readSteleEffectsTag(tag: ts.JSDocTag): readonly string[] | null {
  const tagName = tag.tagName.text;
  const comment = tagCommentToString(tag);

  if (tagName === "stele:effects") {
    return parseEffectsTagValue(comment);
  }
  if (tagName === "stele") {
    // Strip a leading `:effects` (possibly followed by whitespace) from
    // the comment. Anything else means this is not our tag.
    const m = /^:effects(?:\s+(.*))?$/s.exec(comment.trim());
    if (m === null) return null;
    const rest = m[1] ?? "";
    return parseEffectsTagValue(rest);
  }
  return null;
}

/**
 * Collect every `@stele:effects` annotation on `decl`. Multiple tags on
 * the same declaration are unioned, with first-seen order preserved.
 */
function annotationsForDeclaration(decl: ts.Node): readonly string[] {
  const tags = ts.getJSDocTags(decl);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const effects = readSteleEffectsTag(tag);
    if (effects === null) continue;
    for (const e of effects) {
      if (seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
  }
  return Object.freeze(out);
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function shouldVisit(sourceFile: ts.SourceFile, projectRoot: string): boolean {
  if (sourceFile.isDeclarationFile) return false;
  if (sourceFile.fileName.includes("/node_modules/")) return false;
  return sourceFile.fileName.startsWith(projectRoot);
}

function toPosixCollect(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === "dist" || ent.name === ".git") continue;
      const full = `${dir}${sep}${ent.name}`;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        if ((ent.name.endsWith(".ts") || ent.name.endsWith(".tsx")) && !ent.name.endsWith(".d.ts")) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

function createProgram(projectRoot: string, tsconfigPath: string | undefined): ts.Program | null {
  const configPath = tsconfigPath ?? resolve(projectRoot, "tsconfig.json");

  let rootNames: string[] = [];
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    esModuleInterop: true,
  };

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = ts.parseConfigFileTextToJson(configPath, raw);
    if (parsed.error === undefined && parsed.config !== undefined) {
      const conf = ts.parseJsonConfigFileContent(
        parsed.config,
        ts.sys,
        projectRoot,
        compilerOptions,
        configPath,
      );
      rootNames = conf.fileNames;
      compilerOptions = { ...conf.options, noEmit: true };
    }
  }

  if (rootNames.length === 0) {
    rootNames = toPosixCollect(projectRoot);
  }

  if (rootNames.length === 0) return null;
  return ts.createProgram({ rootNames, options: compilerOptions });
}

function visitSourceFile(
  sourceFile: ts.SourceFile,
  ctx: ExtractorContext,
  out: Map<string, string[]>,
): void {
  const visit = (node: ts.Node): void => {
    if (isFunctionLikeDeclaration(node)) {
      const decl = node;
      // NOTE: We do NOT skip overload signatures without bodies. The
      // call-graph extractor skips them because they would double-emit
      // identical nodes, but here we WANT to collect annotations from
      // both the overload signatures and the implementation — they all
      // share the same NodeId (per node-id-builder.ts), so the union
      // logic below merges them onto a single entry.
      const effects = annotationsForDeclaration(decl);
      if (effects.length > 0) {
        let nodeId: string;
        try {
          nodeId = buildNodeIdForDeclaration(decl, ctx);
        } catch {
          // Anonymous lambdas with no usable name — skip silently.
          ts.forEachChild(node, visit);
          return;
        }
        const existing = out.get(nodeId);
        if (existing === undefined) {
          out.set(nodeId, [...effects]);
        } else {
          // Union, preserving first-seen order, deduplicated.
          const seen = new Set(existing);
          for (const e of effects) {
            if (!seen.has(e)) {
              seen.add(e);
              existing.push(e);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export const tsEffectAnnotationExtractor: EffectAnnotationExtractor = {
  language: "typescript",

  async extractAnnotations(options) {
    const projectRoot = isAbsolute(options.projectRoot)
      ? options.projectRoot
      : resolve(options.projectRoot);

    const program = createProgram(projectRoot, options.tsconfigPath);
    if (program === null) {
      return { annotationsByNode: new Map() };
    }
    const checker = program.getTypeChecker();
    const ctx: ExtractorContext = {
      program,
      checker,
      projectRoot,
      sourceFiles: new Set<string>(),
    };

    const collected = new Map<string, string[]>();
    for (const sourceFile of program.getSourceFiles()) {
      if (!shouldVisit(sourceFile, projectRoot)) continue;
      visitSourceFile(sourceFile, ctx, collected);
    }

    // Freeze each entry list so the contract's `readonly string[]` is
    // structurally honoured.
    const frozen = new Map<string, readonly string[]>();
    const keys = [...collected.keys()].sort();
    for (const k of keys) {
      const v = collected.get(k);
      if (v !== undefined) frozen.set(k, Object.freeze(v.slice()));
    }
    return { annotationsByNode: frozen };
  },
};
