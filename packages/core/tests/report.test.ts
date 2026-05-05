import { describe, expect, it } from "vitest";
import { createViolation } from "../src/index";

describe("violation reporting", () => {
  it("creates a stable fingerprint from deterministic violation content", () => {
    const base = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "generated",
      },
      location: {
        path: "tests/contract/test_contract.py",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        changed: ["tests/contract/test_contract.py"],
        missing: [],
        extra: [],
      },
      scope_paths: ["tests/contract/test_contract.py", "contract/main.stele"],
      fix: {
        summary: "Re-run stele generate --force to replace generated files.",
        command: "stele generate --force",
      },
    });
    const reordered = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        command: "check",
        kind: "generated",
        tool: "stele",
      },
      location: {
        path: "tests/contract/test_contract.py",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        extra: [],
        changed: ["tests/contract/test_contract.py"],
        missing: [],
      },
      scope_paths: ["contract/main.stele", "tests/contract/test_contract.py"],
      fix: {
        command: "stele generate --force",
        summary: "Re-run stele generate --force to replace generated files.",
      },
    });
    const changed = createViolation({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      severity: "error",
      source: {
        tool: "stele",
        command: "check",
        kind: "generated",
      },
      location: {
        path: "tests/contract/_stele_runtime.py",
      },
      cause: {
        summary: "Generated files do not match the contract.",
        changed: ["tests/contract/_stele_runtime.py"],
        missing: [],
        extra: [],
      },
      scope_paths: ["tests/contract/_stele_runtime.py", "contract/main.stele"],
      fix: {
        summary: "Re-run stele generate --force to replace generated files.",
        command: "stele generate --force",
      },
    });

    expect(base.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.fingerprint).toBe(base.fingerprint);
    expect(changed.fingerprint).not.toBe(base.fingerprint);
  });
});
