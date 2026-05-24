// Round 14 P1: tests for the TypeScript code-shape analyzer.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeTypeScriptFiles,
  isTypeScriptFilePath,
} from "../src/code-shape/typescript-analyzer.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  tempDirs.length = 0;
});

async function mkProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stele-ts-cs-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

describe("isTypeScriptFilePath", () => {
  it("matches .ts and .tsx", () => {
    expect(isTypeScriptFilePath("src/a.ts")).toBe(true);
    expect(isTypeScriptFilePath("src/b.tsx")).toBe(true);
  });
  // Phase 2 self-dogfooding: the TS analyzer also accepts .js / .mjs / .cjs
  // so `(lang typescript)` code-shape declarations can target ESM hook
  // scripts under packages/claude-code-plugin/scripts/*.js. The TS compiler
  // API parses JS adequately for the shape checks.
  it("accepts .js / .mjs / .cjs as JS source", () => {
    expect(isTypeScriptFilePath("src/a.js")).toBe(true);
    expect(isTypeScriptFilePath("src/a.mjs")).toBe(true);
    expect(isTypeScriptFilePath("src/a.cjs")).toBe(true);
  });
  it("rejects .py and other non-JS extensions", () => {
    expect(isTypeScriptFilePath("src/a.py")).toBe(false);
    expect(isTypeScriptFilePath("src/a.md")).toBe(false);
  });
});

describe("analyzeTypeScriptFiles", () => {
  it("extracts class name, fields, methods, and base classes", async () => {
    const root = await mkProject({
      "src/svc.ts":
        "export class OrderService extends ServiceBase {\n" +
        "  private repository: OrderRepository = null!;\n" +
        "  active: boolean = true;\n" +
        "  constructor() { super(); }\n" +
        "  async place(order: Order): Promise<void> {}\n" +
        "  cancel(): void {}\n" +
        "}\n",
    });
    const r = await analyzeTypeScriptFiles(root, ["src/svc.ts"]);
    expect(r.errors).toEqual([]);
    expect(r.files).toHaveLength(1);
    const file = r.files[0]!;
    expect(file.classes).toHaveLength(1);
    const cls = file.classes[0]!;
    expect(cls.name).toBe("OrderService");
    expect(cls.bases).toEqual(["ServiceBase"]);
    const fieldNames = cls.fields.map((f) => f.name);
    expect(fieldNames).toContain("repository");
    expect(fieldNames).toContain("active");
    const methodNames = cls.methods.map((m) => m.name);
    expect(methodNames).toContain("constructor");
    expect(methodNames).toContain("place");
    expect(methodNames).toContain("cancel");
  });

  it("captures function decorators and parameter names", async () => {
    const root = await mkProject({
      "src/dec.ts":
        "@authorize\nexport class Auth {\n" +
        "  @route(\"/x\")\n" +
        "  handle(id: string): void {}\n" +
        "}\n",
    });
    const r = await analyzeTypeScriptFiles(root, ["src/dec.ts"]);
    const cls = r.files[0]!.classes[0]!;
    const method = cls.methods.find((m) => m.name === "handle")!;
    expect(method.decorators).toContain("route(\"/x\")");
    expect(method.parameters).toEqual(["id"]);
  });

  it("captures imports as DependencyEdge-shaped specifier candidates", async () => {
    const root = await mkProject({
      "src/uses.ts":
        'import { db } from "./db.js";\nimport defaultThing from "external";\n',
    });
    const r = await analyzeTypeScriptFiles(root, ["src/uses.ts"]);
    const imports = r.files[0]!.imports;
    expect(imports.map((i) => i.candidates[0])).toEqual([
      "./db.js",
      "external",
    ]);
  });

  it("captures type annotations on parameters + return + fields with name list", async () => {
    const root = await mkProject({
      "src/types.ts":
        "export function f(x: Promise<string | null>): Map<string, number> {\n" +
        "  return new Map();\n" +
        "}\n",
    });
    const r = await analyzeTypeScriptFiles(root, ["src/types.ts"]);
    const fn = r.files[0]!.functions[0]!;
    const allNames = fn.annotations.flatMap((a) => a.names);
    expect(allNames).toContain("Promise");
    expect(allNames).toContain("string");
    expect(allNames).toContain("null");
    expect(allNames).toContain("Map");
    expect(allNames).toContain("number");
  });

  it("records calls with name + line/column", async () => {
    const root = await mkProject({
      "src/calls.ts":
        "function helper(): number { return 1; }\n" +
        "export function main(): number { return helper() + helper(); }\n",
    });
    const r = await analyzeTypeScriptFiles(root, ["src/calls.ts"]);
    const main = r.files[0]!.functions.find((f) => f.name === "main")!;
    expect(main.calls).toHaveLength(2);
    expect(main.calls[0]!.name).toBe("helper");
    expect(main.calls[0]!.line).toBe(2);
  });

  it("reports a per-file error when a file is unreadable but continues on the rest", async () => {
    const root = await mkProject({
      "src/ok.ts": "export const x = 1;\n",
    });
    const r = await analyzeTypeScriptFiles(root, [
      "src/ok.ts",
      "src/missing.ts",
    ]);
    expect(r.files.map((f) => f.path)).toEqual(["src/ok.ts"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.path).toBe("src/missing.ts");
  });
});
