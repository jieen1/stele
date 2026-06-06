import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const STATIC_IMPORT = /from\s+["']z3-solver["']/;
const DYNAMIC_IMPORT = /import\(\s*["']z3-solver["']\s*\)/;

describe("z3-solver lazy-import contract", () => {
  it("only analyze.ts references z3-solver, and only via dynamic import", async () => {
    const surfaces = [
      "index.ts",
      "commands/list.ts",
      "commands/check.ts",
      "commands/lint.ts",
      "lint/translate.ts",
    ];
    for (const rel of surfaces) {
      const source = await readFile(join(srcDir, rel), "utf8");
      expect(STATIC_IMPORT.test(source), `${rel} must not statically import z3-solver`).toBe(false);
      expect(DYNAMIC_IMPORT.test(source), `${rel} must not dynamically import z3-solver`).toBe(false);
    }

    const analyzeSource = await readFile(join(srcDir, "lint", "analyze.ts"), "utf8");
    expect(STATIC_IMPORT.test(analyzeSource), "analyze.ts must not statically import z3-solver").toBe(false);
    expect(DYNAMIC_IMPORT.test(analyzeSource), "analyze.ts must dynamically import z3-solver").toBe(true);
  });

  it("never initializes z3 for `list` or for a checker-only `lint`", async () => {
    const factory = vi.fn(() => {
      throw new Error("z3-solver must not be imported here");
    });
    vi.doMock("z3-solver", factory);

    const dir = await mkdtemp(join(tmpdir(), "stele-cli-lazy-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "contract"), { recursive: true });
    await writeFile(
      join(dir, "stele.config.json"),
      JSON.stringify({
        version: "0.1.0",
        entry: "contract/main.stele",
        contractDir: "contract",
        targetLanguage: "python",
        testFramework: "pytest",
      }),
      "utf8",
    );
    await writeFile(
      join(dir, "contract", "main.stele"),
      `
(checker check_active (description "active"))
(invariant ACCT_ACTIVE (severity high) (description "d") (uses-checker check_active))
`,
      "utf8",
    );

    const { runList } = await import("../src/commands/list.js");
    const { runLint } = await import("../src/commands/lint.js");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runList(dir, { format: "json" });
      const checkerOnly = await runLint(dir, {});
      expect(checkerOnly.report.coverage.translated).toBe(0);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      vi.doUnmock("z3-solver");
    }
  });
});
