import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseEffectsTagValue,
  tsEffectAnnotationExtractor,
} from "../src/extractors/effect-annotations.js";
import { tsCallGraphExtractor } from "../src/extractors/call-graph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixturePath(name: string): string {
  return resolve(__dirname, "effect-annotation-fixtures", name);
}

async function runExtract(name: string): Promise<ReadonlyMap<string, readonly string[]>> {
  const projectRoot = fixturePath(name);
  const callGraph = await tsCallGraphExtractor.extract({ projectRoot });
  const { annotationsByNode } = await tsEffectAnnotationExtractor.extractAnnotations({
    callGraph,
    projectRoot,
  });
  return annotationsByNode;
}

async function runExtractFull(name: string): ReturnType<
  typeof tsEffectAnnotationExtractor.extractAnnotations
> {
  const projectRoot = fixturePath(name);
  const callGraph = await tsCallGraphExtractor.extract({ projectRoot });
  return tsEffectAnnotationExtractor.extractAnnotations({ callGraph, projectRoot });
}

describe("tsEffectAnnotationExtractor — extractor identity", () => {
  it("registers as the 'typescript' language extractor", () => {
    expect(tsEffectAnnotationExtractor.language).toBe("typescript");
  });

  it("exposes an extractAnnotations method", () => {
    expect(typeof tsEffectAnnotationExtractor.extractAnnotations).toBe("function");
  });
});

describe("parseEffectsTagValue — token grammar", () => {
  it("parses a single name", () => {
    expect(parseEffectsTagValue("db.read")).toEqual(["db.read"]);
  });

  it("parses comma-separated names with surrounding whitespace", () => {
    expect(parseEffectsTagValue("db.read, db.write")).toEqual(["db.read", "db.write"]);
  });

  it("tolerates extra whitespace and trailing whitespace", () => {
    expect(parseEffectsTagValue("   db.read  ,   payment.charge   "))
      .toEqual(["db.read", "payment.charge"]);
  });

  it("accepts glob-style names", () => {
    expect(parseEffectsTagValue("db.*")).toEqual(["db.*"]);
    expect(parseEffectsTagValue("payment.*, http.outgoing"))
      .toEqual(["payment.*", "http.outgoing"]);
  });

  it("rejects uppercase names", () => {
    expect(parseEffectsTagValue("DB.read")).toEqual([]);
    expect(parseEffectsTagValue("Db.read")).toEqual([]);
  });

  it("rejects names starting with a digit", () => {
    expect(parseEffectsTagValue("1bad")).toEqual([]);
  });

  it("rejects tokens containing whitespace mid-token", () => {
    // After splitting on comma we trim, but an interior space (no comma)
    // means a single bad token — the whole token is rejected.
    expect(parseEffectsTagValue("has space")).toEqual([]);
  });

  it("drops bad tokens but keeps valid ones from the same tag", () => {
    expect(parseEffectsTagValue("DB.read, 1bad, ok.one"))
      .toEqual(["ok.one"]);
  });

  it("deduplicates within a single tag preserving first-seen order", () => {
    expect(parseEffectsTagValue("db.read, db.read, http.outgoing"))
      .toEqual(["db.read", "http.outgoing"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(parseEffectsTagValue("")).toEqual([]);
    expect(parseEffectsTagValue("   ")).toEqual([]);
  });

  it("returns a frozen list", () => {
    const result = parseEffectsTagValue("db.read");
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("tsEffectAnnotationExtractor — basic JSDoc reading", () => {
  it("reads a single effect annotation on a top-level function", async () => {
    const m = await runExtract("single-effect");
    expect(m.get("src/index.ts::getUser(1)")).toEqual(["db.read"]);
  });

  it("does NOT record functions without an annotation", async () => {
    const m = await runExtract("single-effect");
    expect(m.has("src/index.ts::plain(0)")).toBe(false);
  });

  it("reads multiple effects from a single tag", async () => {
    const m = await runExtract("multi-effect");
    expect(m.get("src/index.ts::writeUser(1)")).toEqual(["db.read", "db.write"]);
  });

  it("reads a JSDoc with description followed by tag", async () => {
    const m = await runExtract("multi-effect");
    expect(m.get("src/index.ts::fetchUser(1)")).toEqual(["http.outgoing", "db.read"]);
  });

  it("tolerates whitespace inside the tag value", async () => {
    const m = await runExtract("multi-effect");
    expect(m.get("src/index.ts::chargeAndLog(1)")).toEqual(["payment.charge", "log.write"]);
  });
});

describe("tsEffectAnnotationExtractor — class methods", () => {
  it("reads a method JSDoc annotation", async () => {
    const m = await runExtract("class-method");
    expect(m.get("src/index.ts::Order::load(0)")).toEqual(["db.read"]);
  });

  it("reads a method with multiple effects", async () => {
    const m = await runExtract("class-method");
    expect(m.get("src/index.ts::Order::save(0)")).toEqual(["db.write", "log.write"]);
  });

  it("reads a static method", async () => {
    const m = await runExtract("class-method");
    expect(m.get("src/index.ts::Order::now(0)")).toEqual(["time.now"]);
  });

  it("reads a constructor annotation", async () => {
    const m = await runExtract("class-method");
    expect(m.get("src/index.ts::Order::<constructor>(1)")).toEqual(["db.write"]);
  });

  it("does NOT add an entry for unannotated methods", async () => {
    const m = await runExtract("class-method");
    expect(m.has("src/index.ts::Order::helper(0)")).toBe(false);
  });
});

describe("tsEffectAnnotationExtractor — merging multiple tags", () => {
  it("unions effects from two @stele:effects tags on the same decl", async () => {
    const m = await runExtract("merged-tags");
    expect(m.get("src/index.ts::twoTags(0)")).toEqual(["db.read", "http.outgoing"]);
  });

  it("deduplicates effects repeated within one tag", async () => {
    const m = await runExtract("merged-tags");
    expect(m.get("src/index.ts::duplicateInOneTag(0)")).toEqual(["db.read", "http.outgoing"]);
  });

  it("deduplicates effects repeated across tags", async () => {
    const m = await runExtract("merged-tags");
    expect(m.get("src/index.ts::sameTagTwice(0)")).toEqual(["db.read"]);
  });
});

describe("tsEffectAnnotationExtractor — unannotated and edge cases", () => {
  it("produces a map containing only the empty-annotation entry; unannotated functions are absent", async () => {
    // Closeout 1 Category B (2026-05-25): an `@stele:effects` tag with
    // no effect names IS a deliberate author declaration of zero effects.
    // The extractor records it so the evaluator's closed-world override
    // can find it. Unannotated functions remain absent.
    const m = await runExtract("unannotated");
    expect([...m.keys()]).toEqual(["src/index.ts::emptyAnnotation(0)"]);
    expect(m.get("src/index.ts::emptyAnnotation(0)")).toEqual([]);
  });

  it("does NOT read line-comment forms `// @stele:effects ...`", async () => {
    const m = await runExtract("unannotated");
    expect(m.has("src/index.ts::lineCommented(0)")).toBe(false);
  });

  it("ignores regular (non-stele) JSDoc tags", async () => {
    const m = await runExtract("unannotated");
    expect(m.has("src/index.ts::regularJsdoc(1)")).toBe(false);
  });

  it("records an empty `@stele:effects` tag as an entry with an empty effect list (closed-world declaration)", async () => {
    // Closeout 1 Category B (2026-05-25): an empty annotation is no
    // longer dropped. It is recorded so the evaluator can treat the
    // node as closed-world (the author has attested to zero effects),
    // which overrides the unresolved-call fail-closed widening.
    const m = await runExtract("unannotated");
    expect(m.has("src/index.ts::emptyAnnotation(0)")).toBe(true);
    expect(m.get("src/index.ts::emptyAnnotation(0)")).toEqual([]);
  });
});

describe("tsEffectAnnotationExtractor — glob and invalid name handling", () => {
  it("accepts glob-style effect names", async () => {
    const m = await runExtract("glob-and-invalid");
    expect(m.get("src/index.ts::readAny(0)")).toEqual(["db.*"]);
  });

  it("accepts a mix of glob and concrete names", async () => {
    const m = await runExtract("glob-and-invalid");
    expect(m.get("src/index.ts::payAndCall(0)")).toEqual(["payment.*", "http.outgoing"]);
  });

  it("silently drops invalid names but keeps valid ones from the same tag", async () => {
    const m = await runExtract("glob-and-invalid");
    expect(m.get("src/index.ts::mixedValidity(0)")).toEqual(["ok.one"]);
  });

  it("annotates a generic function correctly", async () => {
    const m = await runExtract("glob-and-invalid");
    expect(m.get("src/index.ts::generic(1)")).toEqual(["generic"]);
  });
});

describe("tsEffectAnnotationExtractor — NodeId stability vs call-graph", () => {
  it("every annotated NodeId matches a call-graph NodeId from the same fixture", async () => {
    const projectRoot = fixturePath("class-method");
    const cg = await tsCallGraphExtractor.extract({ projectRoot });
    const { annotationsByNode } = await tsEffectAnnotationExtractor.extractAnnotations({
      callGraph: cg,
      projectRoot,
    });
    const cgIds = new Set(cg.nodes.map((n) => n.id));
    for (const id of annotationsByNode.keys()) {
      expect(cgIds.has(id)).toBe(true);
    }
  });

  it("overload signature JSDoc unions onto the impl's NodeId", async () => {
    const m = await runExtract("overloaded");
    // All three find decls share NodeId `src/index.ts::Repo::find(1)`.
    // Annotations from both signatures + the impl should be unioned.
    expect(m.get("src/index.ts::Repo::find(1)")).toEqual([
      "db.read",
      "log.write",
      "metrics.emit",
    ]);
  });

  it("annotates each sibling method independently", async () => {
    const m = await runExtract("overloaded");
    expect(m.get("src/index.ts::Repo::count(0)")).toEqual(["db.read"]);
    expect(m.get("src/index.ts::Repo::countBy(1)")).toEqual(["db.read", "log.write"]);
  });
});

describe("tsEffectAnnotationExtractor — result shape", () => {
  it("returns frozen per-node lists", async () => {
    const m = await runExtract("single-effect");
    const list = m.get("src/index.ts::getUser(1)");
    expect(list).toBeDefined();
    expect(Object.isFrozen(list)).toBe(true);
  });

  it("emits deterministic key order across runs", async () => {
    const a = await runExtract("multi-effect");
    const b = await runExtract("multi-effect");
    expect([...a.keys()]).toEqual([...b.keys()]);
  });

  it("returns a map sized to the count of explicitly-annotated nodes", async () => {
    // Closeout 1 Category B (2026-05-25): the `unannotated` fixture has
    // one function with an empty `@stele:effects` tag (a deliberate
    // zero-effects declaration). The map records that one entry; all
    // truly-unannotated functions remain absent.
    const m = await runExtract("unannotated");
    expect(m.size).toBe(1);
  });
});

describe("tsEffectAnnotationExtractor — Fix #4 line-comment annotation detection", () => {
  it("detects a `//`-form @stele:effects and surfaces it as ignoredAnnotations", async () => {
    const result = await runExtractFull("line-comment");
    const ignored = result.ignoredAnnotations ?? [];
    expect(ignored).toHaveLength(1);
    expect(ignored[0]?.raw).toContain("@stele:effects network");
    expect(ignored[0]?.filePath).toContain("line-comment");
    expect(ignored[0]?.line).toBe(1);
    expect(ignored[0]?.reason).toContain("line-comment");
  });

  it("does NOT treat the line comment as a real effect declaration", async () => {
    // The block-JSDoc function gets `fs.read`; the line-commented function
    // contributes nothing to annotationsByNode (it is ignored, not honoured).
    const result = await runExtractFull("line-comment");
    const declaredNames = [...result.annotationsByNode.values()].flat();
    expect(declaredNames).not.toContain("network");
    expect(declaredNames).toContain("fs.read");
  });
});
