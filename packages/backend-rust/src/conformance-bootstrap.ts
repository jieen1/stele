import type { ConformanceFixture } from "@stele/core";

/**
 * Generate a fixture JSON file for Rust conformance testing.
 *
 * The Rust runtime's `stele_context()` checks for a `.stele_fixture.json`
 * file in the test directory. If present, it deserializes the fixture
 * data at test time. This avoids the compile-time module shadowing issue
 * where a separate fixture file can't override `stele_context()`.
 */
export function writeFixtureBootstrap(fixture: ConformanceFixture): string {
    return JSON.stringify(fixture.appState, null, 2);
}

/** Alias for backend.test.ts and backend.ts import compatibility. */
export { writeFixtureBootstrap as generateFixtureBootstrapContent };
