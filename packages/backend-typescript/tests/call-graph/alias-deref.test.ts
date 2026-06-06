import { describe, expect, it } from "vitest";

import { extractFixture } from "./_helpers.js";

describe("tsCallGraphExtractor — single-identifier alias deref (HIGH #1 part 3)", () => {
  const ALIASED = "src/index.ts::aliased(0)";
  const DIRECT = "src/index.ts::direct(0)";
  const SINK = "src/index.ts::sink(0)";

  it("`const w = sink; w()` resolves to a real edge aliased -> sink", async () => {
    const g = await extractFixture("alias-deref");
    const edge = g.edges.find((e) => e.fromId === ALIASED && e.toId === SINK);
    expect(edge).toBeDefined();
  });

  it("the aliased call is NOT recorded as unresolved", async () => {
    const g = await extractFixture("alias-deref");
    const u = g.unresolvedCalls.find((u) => u.fromId === ALIASED);
    expect(u).toBeUndefined();
  });

  it("the aliased edge matches the direct call edge (same target)", async () => {
    const g = await extractFixture("alias-deref");
    const aliasedTargets = g.edges
      .filter((e) => e.fromId === ALIASED)
      .map((e) => e.toId)
      .sort();
    const directTargets = g.edges
      .filter((e) => e.fromId === DIRECT)
      .map((e) => e.toId)
      .sort();
    expect(aliasedTargets).toEqual(directTargets);
  });
});
