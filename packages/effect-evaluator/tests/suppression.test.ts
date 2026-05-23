import { describe, expect, it } from "vitest";

import { applySuppressions } from "../src/suppression.js";
import { mkEffectSuppression } from "./fixtures/helpers.js";

const DECLARED = new Set([
  "db.read",
  "db.write",
  "http.outgoing",
  "log.audit",
]);

const NODES = new Set([
  "src/cache/cached-get.ts::cachedGet(1)",
  "src/services/other.ts::other(0)",
]);

function initMap(
  entries: ReadonlyArray<readonly [string, readonly string[]]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [id, eff] of entries) {
    out.set(id, new Set(eff));
  }
  return out;
}

describe("applySuppressions", () => {
  it("removes the suppressed effect from the target initial set", () => {
    const initial = initMap([
      ["src/cache/cached-get.ts::cachedGet(1)", ["db.read", "log.audit"]],
    ]);
    const r = applySuppressions({
      initialEffectsByNode: initial,
      suppressions: [
        mkEffectSuppression({
          target: "src/cache/cached-get.ts::cachedGet(1)",
          suppresses: ["db.read"],
          reason: "Cache wrapper around getUser",
        }),
      ],
      declaredEffects: DECLARED,
      callGraphNodeIds: NODES,
    });
    const after = r.initialEffectsByNode.get(
      "src/cache/cached-get.ts::cachedGet(1)",
    );
    expect([...(after ?? [])]).toEqual(["log.audit"]);
    expect(r.activeCount).toBe(1);
  });

  it("supports multiple effects in one suppression", () => {
    const initial = initMap([
      [
        "src/cache/cached-get.ts::cachedGet(1)",
        ["db.read", "db.write", "log.audit"],
      ],
    ]);
    const r = applySuppressions({
      initialEffectsByNode: initial,
      suppressions: [
        mkEffectSuppression({
          target: "src/cache/cached-get.ts::cachedGet(1)",
          suppresses: ["db.read", "db.write"],
          reason: "Wraps multiple DB ops",
        }),
      ],
      declaredEffects: DECLARED,
      callGraphNodeIds: NODES,
    });
    const after = r.initialEffectsByNode.get(
      "src/cache/cached-get.ts::cachedGet(1)",
    );
    expect([...(after ?? [])]).toEqual(["log.audit"]);
  });

  it("emits a 'dormant' notice when target node missing from call graph", () => {
    const r = applySuppressions({
      initialEffectsByNode: initMap([]),
      suppressions: [
        mkEffectSuppression({
          target: "src/missing.ts::missing(0)",
          suppresses: ["db.read"],
          reason: "Intentional",
        }),
      ],
      declaredEffects: DECLARED,
      callGraphNodeIds: NODES,
    });
    expect(r.activeCount).toBe(0);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]?.rule_id).toBe("effect.suppression_dormant");
    expect(r.notices[0]?.cause.summary).toContain("not found");
  });

  it("active suppression notice severity follows declaration severity", () => {
    const r = applySuppressions({
      initialEffectsByNode: initMap([
        ["src/cache/cached-get.ts::cachedGet(1)", ["db.read"]],
      ]),
      suppressions: [
        mkEffectSuppression({
          target: "src/cache/cached-get.ts::cachedGet(1)",
          suppresses: ["db.read"],
          reason: "x",
          severity: "error",
        }),
      ],
      declaredEffects: DECLARED,
      callGraphNodeIds: NODES,
    });
    expect(r.notices[0]?.rule_id).toBe("effect.suppression_active");
    expect(r.notices[0]?.severity).toBe("error");
  });

  it("captures reason and target NodeId in the notice detail", () => {
    const r = applySuppressions({
      initialEffectsByNode: initMap([
        ["src/cache/cached-get.ts::cachedGet(1)", ["db.read"]],
      ]),
      suppressions: [
        mkEffectSuppression({
          target: "src/cache/cached-get.ts::cachedGet(1)",
          suppresses: ["db.read"],
          reason: "Caching wrapper deliberate",
        }),
      ],
      declaredEffects: DECLARED,
      callGraphNodeIds: NODES,
    });
    expect(r.notices[0]?.cause.detail).toContain("reason: Caching wrapper deliberate");
    expect(r.notices[0]?.cause.detail).toContain("target: src/cache/cached-get.ts::cachedGet(1)");
  });

  it("input map is not mutated by application (returns new map)", () => {
    const initial = initMap([
      ["src/cache/cached-get.ts::cachedGet(1)", ["db.read", "log.audit"]],
    ]);
    applySuppressions({
      initialEffectsByNode: initial,
      suppressions: [
        mkEffectSuppression({
          target: "src/cache/cached-get.ts::cachedGet(1)",
          suppresses: ["db.read"],
          reason: "x",
        }),
      ],
      declaredEffects: DECLARED,
      callGraphNodeIds: NODES,
    });
    const original = initial.get("src/cache/cached-get.ts::cachedGet(1)");
    // Original map untouched.
    expect([...(original ?? [])].sort()).toEqual(["db.read", "log.audit"]);
  });
});
