import { posix } from "node:path";
import type { LanguageBackend } from "@stele/core";
import { getTypeScriptRuntimeSource, getTypeScriptSetupSource } from "./runtime.js";
import { generateVitestSource, sanitizeTsIdentifier } from "./translator.js";

const backend: LanguageBackend = {
  name: "typescript",
  framework: "vitest",
  fileExtension: ".ts",
  version: "0.1.0",
  generate(contract, config) {
    const generatedDir = config.outputDir ?? "tests/contract";
    const files = [
      {
        path: posix.join(generatedDir, "_stele_runtime.ts"),
        content: getTypeScriptRuntimeSource(),
      },
    ];
    const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);

    if (topLevelInvariants.length > 0) {
      files.push({
        path: posix.join(generatedDir, "test_contract.ts"),
        content: generateVitestSource({
          ...contract,
          invariants: topLevelInvariants,
        }),
      });
    }

    for (const group of contract.groups) {
      files.push({
        path: posix.join(generatedDir, `test_${sanitizeTsIdentifier(group.id, "group")}.ts`),
        content: generateVitestSource({
          ...contract,
          invariants: group.invariants,
        }),
      });
    }

    return files;
  },
  supportFiles(_contract, config) {
    const generatedDir = config.outputDir ?? "tests/contract";
    return [
      {
        // Phase C: vitest setup hook that captures SteleAssertionFailed
        // witnesses for downstream `stele check` integration. Wiring is
        // user-controlled (`setupFiles` in vitest.config.ts); the file is
        // shipped as a support file so it does not interfere with the
        // canonical `_stele_runtime.ts` + `test_*.ts` layout.
        path: posix.join(generatedDir, "_stele_setup.ts"),
        content: getTypeScriptSetupSource(),
      },
    ];
  },
};

export { backend };
export default backend;
