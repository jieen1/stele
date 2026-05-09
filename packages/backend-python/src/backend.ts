import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { LanguageBackend } from "@stele/core";
import { getPythonRuntimeSource } from "./runtime.js";
import {
  generatePytestCodeShapeSource,
  generatePytestSource,
  sanitizePythonIdentifier,
} from "./translator.js";
import { renderConftest } from "./conformance-bootstrap.js";

const backend: LanguageBackend = {
  name: "python",
  framework: "pytest",
  fileExtension: ".py",
  version: "0.1.0",
  generate(contract, config) {
    const generatedDir = config.outputDir ?? "tests/contract";
    const files = [
      {
        path: posix.join(generatedDir, "_stele_runtime.py"),
        content: getPythonRuntimeSource(),
      },
    ];
    const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);

    if (topLevelInvariants.length > 0) {
      files.push({
        path: posix.join(generatedDir, "test_contract.py"),
        content: generatePytestSource({
          ...contract,
          invariants: topLevelInvariants,
        }),
      });
    }

    for (const group of contract.groups) {
      files.push({
        path: posix.join(generatedDir, `test_${sanitizePythonIdentifier(group.id, "group")}.py`),
        content: generatePytestSource({
          ...contract,
          invariants: group.invariants,
        }),
      });
    }

    if (contract.codeShapes.length > 0) {
      files.push({
        path: posix.join(generatedDir, "test_code_shape.py"),
        content: generatePytestCodeShapeSource(contract),
      });
    }

    return files;
  },
  supportFiles(_contract, config) {
    const generatedDir = config.outputDir ?? "tests/contract";
    return [
      {
        path: posix.join(generatedDir, "__init__.py"),
        content: "",
      },
    ];
  },
  async writeFixtureBootstrap(fixture, tmpdir) {
    const conftestPath = join(tmpdir, "tests", "contract", "conftest.py");
    await mkdir(dirname(conftestPath), { recursive: true });
    await writeFile(conftestPath, renderConftest(fixture.appState), "utf8");
  },
};

export { backend };
export default backend;
