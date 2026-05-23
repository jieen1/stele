import { posix } from "node:path";
import { writeFile } from "node:fs/promises";
import type { LanguageBackend } from "@stele/core";
import { getGoRuntimeSource } from "./runtime.js";
import { generateGoTestSource, sanitizeGoIdentifier } from "./translator.js";
import { writeFixtureBootstrap } from "./conformance-bootstrap.js";

const backend: LanguageBackend = {
  name: "go",
  framework: "testing",
  fileExtension: ".go",
  version: "0.1.0",
  generate(contract, config) {
    const generatedDir = config.outputDir ?? "tests/contract";
    const files = [
      {
        path: posix.join(generatedDir, "stele_runtime_test.go"),
        content: getGoRuntimeSource(),
      },
    ];

    const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);

    if (topLevelInvariants.length > 0) {
      files.push({
        path: posix.join(generatedDir, "test_contract_test.go"),
        content: generateGoTestSource({
          ...contract,
          invariants: topLevelInvariants,
        }),
      });
    }

    for (const group of contract.groups) {
      files.push({
        path: posix.join(generatedDir, `test_${sanitizeGoIdentifier(group.id, "group")}_test.go`),
        content: generateGoTestSource({
          ...contract,
          invariants: group.invariants,
        }),
      });
    }

    return files;
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  supportFiles(_contract, _config) {
    return [];
  },
  async writeFixtureBootstrap(fixture, tmpdir) {
    const generatedFile = writeFixtureBootstrap(fixture);
    const outDir = posix.join(tmpdir, "tests", "contract");
    const outputPath = posix.join(outDir, generatedFile.name);
    await writeFile(outputPath, generatedFile.content, "utf8");
  },
};

export { backend };
export default backend;
