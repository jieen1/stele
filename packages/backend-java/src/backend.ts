import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { LanguageBackend } from "@stele/core";
import { getJavaRuntimeSource } from "./runtime.js";
import { generateJUnitSource, sanitizeJavaIdentifier } from "./translator.js";
import { renderSteleConftest } from "./conformance-bootstrap.js";

const backend: LanguageBackend = {
  name: "java",
  framework: "junit5",
  fileExtension: ".java",
  version: "0.1.0",
  generate(contract, config) {
    const generatedDir = config.outputDir ?? "src/test/java/contract";
    const files: Array<{ path: string; content: string }> = [
      {
        path: posix.join(generatedDir, "_stele_runtime.java"),
        content: getJavaRuntimeSource(),
      },
    ];

    const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);

    if (topLevelInvariants.length > 0) {
      files.push({
        path: posix.join(generatedDir, "test_contract.java"),
        content: generateJUnitSource(
          {
            ...contract,
            invariants: topLevelInvariants,
          },
          "Test_contract",
        ),
      });
    }

    for (const group of contract.groups) {
      const groupName = sanitizeJavaIdentifier(group.id, "group");
      files.push({
        path: posix.join(generatedDir, `test_${groupName}.java`),
        content: generateJUnitSource(
          {
            ...contract,
            invariants: group.invariants,
          },
          `Test_${groupName}`,
          group.id,
        ),
      });
    }

    return files;
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  supportFiles(_contract, _config) {
    return [];
  },
  async writeFixtureBootstrap(fixture, tmpdir) {
    const outDir = join(tmpdir, "src", "test", "java", "contract");
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "SteleConftest.java"),
      renderSteleConftest(fixture.appState),
      "utf8",
    );
  },
};

export { backend };
export default backend;
