import { mkdir, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { LanguageBackend } from "@stele/core";
import { getRustRuntimeSource } from "./runtime.js";
import { generateRustSource, sanitizeRustIdentifier } from "./translator.js";
import { writeFixtureBootstrap } from "./conformance-bootstrap.js";

const backend: LanguageBackend = {
    name: "rust",
    framework: "cargo-test",
    fileExtension: ".rs",
    version: "0.1.0",

    generate(contract, config) {
        const generatedDir = config.outputDir ?? "tests/contract";
        const files: Array<{ path: string; content: string }> = [];

        // Runtime helper file
        files.push({
            path: posix.join(generatedDir, "_stele_runtime.rs"),
            content: getRustRuntimeSource(),
        });

        // Top-level invariants (no group)
        const topLevelInvariants = contract.invariants.filter((inv) => inv.groupId === undefined);
        if (topLevelInvariants.length > 0) {
            files.push({
                path: posix.join(generatedDir, "test_contract.rs"),
                content: generateRustSource({
                    ...contract,
                    invariants: topLevelInvariants,
                }),
            });
        }

        // Group invariants
        for (const group of contract.groups) {
            files.push({
                path: posix.join(generatedDir, `test_${sanitizeRustIdentifier(group.id, "group")}.rs`),
                content: generateRustSource({
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
        const json = writeFixtureBootstrap(fixture);
        const outDir = resolve(tmpdir, "tests", "contract");
        const outputPath = resolve(outDir, ".stele_fixture.json");
        await mkdir(outDir, { recursive: true });
        await writeFile(outputPath, json, "utf8");
    },
};

export { backend };
export default backend;
