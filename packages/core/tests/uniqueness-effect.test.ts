import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("effect-declarations uniqueness", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects two (effect-declarations ...) blocks in the same file (E0351)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "db.read"))',
        '(effect-declarations (effect "db.write"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0351",
      messageIncludes: "more than once",
    });
  });

  it("rejects an effect declared in two different blocks across files (E0352)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "./other.stele")',
        '(effect-declarations (effect "db.read"))',
      ].join("\n"),
      "other.stele": '(effect-declarations (effect "db.read"))',
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0352",
      messageIncludes: 'Effect "db.read" is declared in multiple',
    });
  });

  it("rejects two effect-policy declarations with the same id (E0359)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "db.read") (effect "db.write"))',
        '(effect-policy DUP (target-scope "**/a/**") (forbid "db.read"))',
        '(effect-policy DUP (target-scope "**/b/**") (forbid "db.write"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0359",
      messageIncludes: 'Effect-policy id "DUP" is already defined',
    });
  });

  it("accepts a single block declaring multiple effects (happy path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(effect-declarations",
        '  (effect "db.read")',
        '  (effect "db.write")',
        '  (effect "http.outgoing"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.effectDeclarations).toHaveLength(1);
    expect(contract.effectDeclarations[0]?.effects).toHaveLength(3);
  });

  it("accepts disjoint effect declarations spread across multiple files (happy path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "./other.stele")',
        '(effect-declarations (effect "db.read"))',
      ].join("\n"),
      "other.stele": '(effect-declarations (effect "http.outgoing"))',
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.effectDeclarations).toHaveLength(2);
  });

  it("accepts multiple effect-policy declarations with distinct ids (happy path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "db.read") (effect "time.now"))',
        '(effect-policy NO_IO_IN_UI (target-scope "**/views/**") (forbid "db.read"))',
        '(effect-policy PURE_LIB (target-scope "**/lib/pure/**") (allow-only "time.now"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.effectPolicies).toHaveLength(2);
    expect(contract.effectPolicies.map((p: { id: string }) => p.id)).toEqual([
      "NO_IO_IN_UI",
      "PURE_LIB",
    ]);
  });

  it("accepts multiple effect-suppression declarations (no id uniqueness on suppression)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "db.read") (effect "db.write"))',
        '(effect-suppression (target "src/a.ts::wrap(1)") (suppresses "db.read") (reason "Wrapper around getUser."))',
        '(effect-suppression (target "src/b.ts::wrap(1)") (suppresses "db.write") (reason "Wrapper around setUser."))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.effectSuppressions).toHaveLength(2);
  });
});

describe("effect-name reference resolution (E0350)", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects a misspelled effect name in (forbid ...) (E0350)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "network"))',
        '(effect-policy NO_NET (target-scope "**/lib/**") (forbid "netork"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0350",
      messageIncludes: 'Unknown effect name "netork"',
    });
  });

  it("rejects a misspelled effect name in (allow-only ...) (E0350)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "time.now"))',
        '(effect-policy PURE (target-scope "**/pure/**") (allow-only "tim.now"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0350",
      messageIncludes: 'Unknown effect name "tim.now"',
    });
  });

  it("rejects an undeclared effect in (suppresses ...) (E0350)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "db.read"))',
        '(effect-suppression (target "src/a.ts::wrap(1)") (suppresses "db.rad") (reason "Wrapper."))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0350",
      messageIncludes: 'Unknown effect name "db.rad"',
    });
  });

  it("rejects an undeclared effect in (annotates ...) (E0350)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "fs.read"))',
        '(effect-annotation (target "src/a.ts::*") (annotates "fs.raed"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0350",
      messageIncludes: 'Unknown effect name "fs.raed"',
    });
  });

  it("rejects a glob that matches no declared effect (E0350)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "db.read"))',
        '(effect-policy NO_PAY (target-scope "**/lib/**") (forbid "payment.*"))',
      ].join("\n"),
    });

    await expectSteleError(getLoadContract()(project.rootPath), {
      code: "E0350",
      messageIncludes: 'Effect glob "payment.*" matches no declared effect',
    });
  });

  it("accepts a glob that matches at least one declared effect (happy path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(effect-declarations (effect "payment.charge") (effect "payment.refund"))',
        '(effect-policy NO_PAY (target-scope "**/lib/**") (forbid "payment.*"))',
      ].join("\n"),
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.effectPolicies).toHaveLength(1);
  });

  it("resolves references against declarations in an imported file (happy path)", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "./effects.stele")',
        '(effect-policy NO_NET (target-scope "**/lib/**") (forbid "network"))',
      ].join("\n"),
      "effects.stele": '(effect-declarations (effect "network"))',
    });

    const contract = await getLoadContract()(project.rootPath);
    expect(contract.effectPolicies).toHaveLength(1);
  });
});

// --- helpers ---------------------------------------------------------------

async function expectSteleError(
  promise: Promise<unknown>,
  expectation: { code: string; messageIncludes: string },
): Promise<void> {
  await expect(promise).rejects.toThrowError(SteleError);

  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SteleError);
    expect(err).toMatchObject({ code: expectation.code });
    expect((err as SteleError).message).toContain(expectation.messageIncludes);
  }
}

async function createTempProject(
  files: Record<string, string>,
): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-fx-uniq-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return {
    directory,
    rootPath: join(directory, "main.stele"),
  };
}

function getLoadContract(): (rootPath: string) => Promise<{
  effectDeclarations: { effects: unknown[] }[];
  effectAnnotations: { target: unknown[] }[];
  effectPolicies: { id: string }[];
  effectSuppressions: { target: string }[];
}> {
  const loadContract = (stele as Record<string, unknown>).loadContract;
  expect(loadContract).toBeTypeOf("function");
  return loadContract as (rootPath: string) => Promise<{
    effectDeclarations: { effects: unknown[] }[];
    effectAnnotations: { target: unknown[] }[];
    effectPolicies: { id: string }[];
    effectSuppressions: { target: string }[];
  }>;
}
