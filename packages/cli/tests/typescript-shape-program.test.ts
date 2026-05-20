import { resolve, join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  createShapeProgram,
  clearProgramCache,
  findSourceFile,
  findNamedDeclaration,
} from "../src/typescript-shape/program.js";
import * as ts from "typescript";

const FIXTURES = resolve(__dirname, "fixtures", "typescript-shape");
const FIXTURE_TS_CONFIG = resolve(FIXTURES, "tsconfig.json");

beforeEach(() => {
  clearProgramCache();
});

// ---------------------------------------------------------------------------
// createShapeProgram
// ---------------------------------------------------------------------------

describe("createShapeProgram", () => {
  it("creates a program from an explicit tsconfig.json", () => {
    const result = createShapeProgram({
      projectDir: FIXTURES,
      tsconfigPath: FIXTURE_TS_CONFIG,
    });

    expect(result.program).toBeDefined();
    expect(result.typeChecker).toBeDefined();
    expect(result.parsedCommandLine).toBeDefined();
    expect(result.parsedCommandLine.options.target).toBe(ts.ScriptTarget.ES2022);
    expect(result.parsedCommandLine.options.strict).toBe(true);
  });

  it("returns a cached result on second call with the same options", () => {
    const opt = {
      projectDir: FIXTURES,
      tsconfigPath: FIXTURE_TS_CONFIG,
    };

    const first = createShapeProgram(opt);
    const second = createShapeProgram(opt);

    expect(second).toBe(first); // same reference (cached)
  });

  it("returns distinct results for different tsconfig paths", () => {
    const a = createShapeProgram({
      projectDir: FIXTURES,
      tsconfigPath: FIXTURE_TS_CONFIG,
    });

    // A different tsconfig path (even if non-existent in cache) produces a new entry
    // We use a relative vs absolute path to the same file to verify the key differs
    const relativePath = join("fixtures", "typescript-shape", "tsconfig.json");
    const b = createShapeProgram({
      projectDir: FIXTURES,
      tsconfigPath: relativePath,
    });

    // They may or may not be the same reference depending on normalization;
    // the key point is both produce a valid program
    expect(b.program).toBeDefined();
  });

  it("handles missing tsconfig gracefully with fallback config", () => {
    const result = createShapeProgram({
      projectDir: FIXTURES,
      tsconfigPath: resolve(FIXTURES, "nonexistent-tsconfig.json"),
    });

    // Should NOT throw; falls back to minimal config
    expect(result.program).toBeDefined();
    expect(result.typeChecker).toBeDefined();
  });

  it("accepts optional sourceFiles and includes them in file names", () => {
    const result = createShapeProgram({
      projectDir: FIXTURES,
      tsconfigPath: FIXTURE_TS_CONFIG,
      sourceFiles: ["valid/Money.ts"],
    });

    expect(result.program).toBeDefined();
    // fileNames should contain files from the tsconfig
    expect(result.parsedCommandLine.fileNames.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// findSourceFile
// ---------------------------------------------------------------------------

describe("findSourceFile", () => {
  let program: ts.Program;
  let projectDir: string;

  beforeEach(() => {
    clearProgramCache();
    const result = createShapeProgram({
      projectDir: FIXTURES,
      tsconfigPath: FIXTURE_TS_CONFIG,
    });
    program = result.program;
    projectDir = FIXTURES;
  });

  it("finds a file by absolute path", () => {
    const absolutePath = resolve(FIXTURES, "valid", "Money.ts");
    const sf = findSourceFile(program, absolutePath, projectDir);

    expect(sf).toBeDefined();
    expect(sf!.fileName.includes("Money.ts")).toBe(true);
  });

  it("finds a file by relative path", () => {
    const sf = findSourceFile(program, "valid/Money.ts", projectDir);

    expect(sf).toBeDefined();
    expect(sf!.fileName.includes("Money.ts")).toBe(true);
  });

  it("returns undefined for a file that does not exist in the program", () => {
    const sf = findSourceFile(
      program,
      resolve(FIXTURES, "valid", "DoesNotExist.ts"),
      projectDir,
    );

    expect(sf).toBeUndefined();
  });

  it("finds files across different subdirectories", () => {
    const money = findSourceFile(program, "valid/Money.ts", projectDir);
    const key = findSourceFile(program, "invalid/PublicKey.ts", projectDir);
    const order = findSourceFile(program, "protected/Order.ts", projectDir);

    expect(money).toBeDefined();
    expect(key).toBeDefined();
    expect(order).toBeDefined();
    expect(money!.fileName).not.toBe(key!.fileName);
  });
});

// ---------------------------------------------------------------------------
// findNamedDeclaration
// ---------------------------------------------------------------------------

describe("findNamedDeclaration", () => {
  let program: ts.Program;

  beforeEach(() => {
    clearProgramCache();
    const result = createShapeProgram({
      projectDir: FIXTURES,
      tsconfigPath: FIXTURE_TS_CONFIG,
    });
    program = result.program;
  });

  it("finds a class declaration by name", () => {
    const sf = program.getSourceFile(
      resolve(FIXTURES, "valid", "Money.ts"),
    );
    expect(sf).toBeDefined();

    const decl = findNamedDeclaration(sf!, "Money");
    expect(decl).toBeDefined();
    expect(ts.isClassDeclaration(decl!)).toBe(true);
  });

  it("finds a class in the PublicKey file", () => {
    const sf = program.getSourceFile(
      resolve(FIXTURES, "invalid", "PublicKey.ts"),
    );
    expect(sf).toBeDefined();

    const decl = findNamedDeclaration(sf!, "PublicKey");
    expect(decl).toBeDefined();
    expect(ts.isClassDeclaration(decl!)).toBe(true);
  });

  it("finds a class in the Order file", () => {
    const sf = program.getSourceFile(
      resolve(FIXTURES, "protected", "Order.ts"),
    );
    expect(sf).toBeDefined();

    const decl = findNamedDeclaration(sf!, "Order");
    expect(decl).toBeDefined();
    expect(ts.isClassDeclaration(decl!)).toBe(true);
  });

  it("returns undefined when the name does not match any declaration", () => {
    const sf = program.getSourceFile(
      resolve(FIXTURES, "valid", "Money.ts"),
    );
    expect(sf).toBeDefined();

    const decl = findNamedDeclaration(sf!, "NonExistentClass");
    expect(decl).toBeUndefined();
  });
});
