import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tsEffectAnnotationExtractor } from "../src/extractors/effect-annotations.js";
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

describe("effect inference — checker-backed body inference", () => {
  it("infers `network` for an un-annotated `await fetch(x)`", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doFetch(1)")).toEqual(["network"]);
  });

  it("infers `fs.write` for `writeFileSync` (named import)", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doWrite(0)")).toEqual(["fs.write"]);
  });

  it("infers `fs.read` for `readFileSync` (named import)", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doRead(0)")).toEqual(["fs.read"]);
  });

  it("infers `child-process` for `execSync`", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doExec(0)")).toEqual(["child-process"]);
  });

  it("infers `random` for `Math.random()`", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doRandom(0)")).toEqual(["random"]);
  });

  it("infers `time` for `Date.now()`", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doTime(0)")).toEqual(["time"]);
  });

  it("infers `env` for `process.env.X`", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doEnv(0)")).toEqual(["env"]);
  });

  it("infers `process` for `process.cwd()`", async () => {
    const m = await runExtract("inference");
    expect(m.get("src/index.ts::doProcess(0)")).toEqual(["process"]);
  });

  it("does NOT false-positive on a user method named writeFileSync", async () => {
    const m = await runExtract("inference");
    // The class method itself performs no effect.
    expect(m.has("src/index.ts::FakeFs::writeFileSync(0)")).toBe(false);
    // The caller `this.writeFileSync()` must NOT be attributed fs.write.
    expect(m.has("src/index.ts::FakeFs::use(0)")).toBe(false);
  });

  it("does NOT false-positive RegExp.prototype.exec as child-process", async () => {
    const m = await runExtract("inference");
    expect(m.has("src/index.ts::regexExec(1)")).toBe(false);
  });

  it("does NOT false-positive a user `read` method as fs.read", async () => {
    const m = await runExtract("inference");
    expect(m.has("src/index.ts::arrayLikeRead(1)")).toBe(false);
  });

  it("does NOT record a genuinely pure function", async () => {
    const m = await runExtract("inference");
    expect(m.has("src/index.ts::pure(2)")).toBe(false);
  });
});
