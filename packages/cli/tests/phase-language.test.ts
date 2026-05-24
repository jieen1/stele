import { describe, expect, it } from "vitest";
import { pickPhaseLanguage } from "../src/config/phase-language.js";
import type { SteleConfig } from "../src/config/defaults.js";

function makeConfig(overrides: Partial<SteleConfig>): SteleConfig {
  return {
    version: "0.1",
    contractDir: "contract",
    entry: "contract/main.stele",
    generatedDir: "tests/contract",
    checkerImplDir: "contract/checker_impls",
    manifestPath: "contract/.manifest.json",
    targetLanguage: "python",
    testFramework: "pytest",
    pathMode: "auto",
    protected: [],
    ...overrides,
  };
}

describe("pickPhaseLanguage", () => {
  it("returns per-phase override when set", () => {
    const config = makeConfig({ phaseLanguages: { trace: "typescript" } });
    expect(pickPhaseLanguage(config, "trace")).toBe("typescript");
  });

  it("falls back to targetLanguage when phaseLanguages absent", () => {
    const config = makeConfig({});
    expect(pickPhaseLanguage(config, "trace")).toBe("python");
  });

  it("falls back to targetLanguage when phase-specific override absent", () => {
    const config = makeConfig({
      phaseLanguages: { trace: "typescript" },
    });
    expect(pickPhaseLanguage(config, "effect")).toBe("python");
  });

  it("supports kebab-case phase keys (type-state, code-shape)", () => {
    const config = makeConfig({
      phaseLanguages: {
        "type-state": "typescript",
        "code-shape": "typescript",
      },
    });
    expect(pickPhaseLanguage(config, "type-state")).toBe("typescript");
    expect(pickPhaseLanguage(config, "code-shape")).toBe("typescript");
  });

  it("returns architecture override when set", () => {
    const config = makeConfig({
      phaseLanguages: { architecture: "typescript" },
    });
    expect(pickPhaseLanguage(config, "architecture")).toBe("typescript");
  });
});
