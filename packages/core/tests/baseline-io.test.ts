import { mkdtemp, rm, readFile, writeFile, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readViolationBaseline, tryReadViolationBaseline, writeViolationBaseline } from "../src/baseline/io.js";
import type { ViolationBaseline } from "../src/baseline/types.js";

function makeValidBaseline(): ViolationBaseline {
  return {
    version: "1",
    generated_at: "2026-05-07T00:00:00.000Z",
    reason: "initial",
    violations: {
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
        rule_id: "ledger.balance_mismatch",
        rule_kind: "rule_violation",
        first_seen: "2026-05-07T00:00:00.000Z",
        source: { tool: "ledger-checker", command: "check", kind: "rule" },
        location: { path: "src/payments.ts" },
        scope_paths: ["src/payments.ts"],
      },
    },
  };
}

describe("writeViolationBaseline", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "baseline-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON with trailing newline", async () => {
    const path = join(tmpDir, "write-basic.json");
    const baseline = makeValidBaseline();
    await writeViolationBaseline(path, baseline);

    const content = await readFile(path, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("creates parent directories", async () => {
    const path = join(tmpDir, "deep", "nested", "dir", "baseline.json");
    const baseline = makeValidBaseline();
    await writeViolationBaseline(path, baseline);

    const stats = await fsStat(path);
    expect(stats.isFile()).toBe(true);
  });

  it("writes baseline with empty violations", async () => {
    const path = join(tmpDir, "empty-violations.json");
    const baseline: ViolationBaseline = {
      version: "1",
      generated_at: "2026-05-07T00:00:00.000Z",
      reason: "no violations",
      violations: {},
    };
    await writeViolationBaseline(path, baseline);

    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.violations).toEqual({});
  });
});

describe("readViolationBaseline", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "baseline-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads and parses correctly", async () => {
    const path = join(tmpDir, "valid.json");
    const baseline = makeValidBaseline();
    await writeViolationBaseline(path, baseline);

    const result = await readViolationBaseline(path);
    expect(result.version).toBe("1");
    expect(result.generated_at).toBe("2026-05-07T00:00:00.000Z");
    expect(result.reason).toBe("initial");
    expect(Object.keys(result.violations)).toHaveLength(1);
  });

  it("throws on invalid JSON", async () => {
    const path = join(tmpDir, "invalid.json");
    await writeFile(path, "not json{{{}", "utf8");

    await expect(readViolationBaseline(path)).rejects.toThrow("is not valid JSON");
  });

  it("throws on invalid shape - wrong version", async () => {
    const path = join(tmpDir, "wrong-version.json");
    const content = {
      version: "2",
      generated_at: "2026-05-07T00:00:00.000Z",
      reason: "test",
      violations: {},
    };
    await writeFile(path, JSON.stringify(content), "utf8");

    await expect(readViolationBaseline(path)).rejects.toThrow("invalid shape");
  });

  it("throws on invalid shape - missing fields", async () => {
    const path = join(tmpDir, "missing-fields.json");
    const content = {
      version: "1",
      generated_at: "2026-05-07T00:00:00.000Z",
    };
    await writeFile(path, JSON.stringify(content), "utf8");

    await expect(readViolationBaseline(path)).rejects.toThrow("invalid shape");
  });
});

describe("tryReadViolationBaseline", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "baseline-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined for missing file", async () => {
    const path = join(tmpDir, "does-not-exist.json");
    const result = await tryReadViolationBaseline(path);
    expect(result).toBeUndefined();
  });

  it("re-throws non-missing-file errors", async () => {
    const path = join(tmpDir, "invalid.json");
    await writeFile(path, "bad{{{" , "utf8");

    await expect(tryReadViolationBaseline(path)).rejects.toThrow();
  });
});

describe("read-write round trip", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "baseline-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves data through write-then-read", async () => {
    const path = join(tmpDir, "roundtrip.json");
    const original = makeValidBaseline();
    await writeViolationBaseline(path, original);

    const result = await readViolationBaseline(path);
    expect(result).toEqual(original);
  });
});

describe("fingerprint validation", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "baseline-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts short fingerprints (architecture violations use descriptive IDs)", async () => {
    const path = join(tmpDir, "short-fp.json");
    const content = {
      version: "1",
      generated_at: "2026-05-07T00:00:00.000Z",
      reason: "test",
      violations: {
        aaaaaaaaaaa: {
          rule_id: "ledger.balance_mismatch",
          rule_kind: "rule_violation",
          first_seen: "2026-05-07T00:00:00.000Z",
          source: { tool: "ledger-checker", command: "check", kind: "rule" },
          location: { path: "src/payments.ts" },
          scope_paths: ["src/payments.ts"],
        },
      },
    };
    await writeFile(path, JSON.stringify(content), "utf8");

    // Short fingerprints are accepted for architecture violations
    const result = await readViolationBaseline(path);
    expect(result.violations["aaaaaaaaaaa"]).toBeDefined();
  });

  it("accepts non-hex fingerprints (architecture violations use descriptive IDs)", async () => {
    const path = join(tmpDir, "non-hex-fp.json");
    const validBaseline = makeValidBaseline();
    const [originalFp] = Object.keys(validBaseline.violations);
    const validViolation = validBaseline.violations[originalFp];

    const nonHexFp = "core-domain-services->core-domain-primitives:src/path.ts:123";
    const nonHexBaseline = {
      ...validBaseline,
      violations: {
        [nonHexFp]: validViolation,
      },
    };
    await writeViolationBaseline(path, nonHexBaseline);

    const result = await readViolationBaseline(path);
    expect(result.violations[nonHexFp]).toBeDefined();
  });

  it("accepts valid 64-char hex fingerprints", async () => {
    const path = join(tmpDir, "valid-fp.json");
    const baseline = makeValidBaseline();
    await writeViolationBaseline(path, baseline);

    const result = await readViolationBaseline(path);
    expect(result).toEqual(baseline);
  });
});
