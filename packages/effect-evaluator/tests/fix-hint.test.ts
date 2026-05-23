import { describe, expect, it } from "vitest";

import {
  defaultDisallowedEffectFixHint,
  defaultForbiddenEffectFixHint,
  defaultUnresolvedCallFixHint,
  proposeExitText,
} from "../src/fix-hint.js";
import { mkEffectPolicy } from "./fixtures/helpers.js";

const POLICY = mkEffectPolicy({
  id: "NO_IO_IN_UI",
  targetScope: ["**/components/**::*"],
  forbid: ["db.read"],
});

describe("defaultForbiddenEffectFixHint", () => {
  const direct = defaultForbiddenEffectFixHint(
    POLICY,
    "src/components/UserCard.tsx::UserCard(0)",
    "db.read",
    true,
    undefined,
    "src/components/UserCard.tsx",
    23,
  );
  const indirect = defaultForbiddenEffectFixHint(
    POLICY,
    "src/components/UserCard.tsx::UserCard(0)",
    "db.read",
    false,
    "src/db/users.ts::getUserFromDb(1)",
    "src/components/UserCard.tsx",
    23,
  );

  it("contains the backtick-quoted offending effect (E0339 actionable)", () => {
    expect(direct).toContain("`db.read`");
  });

  it("references the call site file:line", () => {
    expect(direct).toContain("src/components/UserCard.tsx:23");
  });

  it("FIX_HINT_REQUIRES_ANALYSIS_BRANCH — direct variant contains [A] + [B] + keywords", () => {
    expect(direct).toMatch(/\bcode\s+issue\b/i);
    expect(direct).toMatch(/\bcontract\s+issue\b/i);
    expect(direct).toMatch(/\bpropose\b/i);
    expect(direct).toMatch(/\[A\]/);
    expect(direct).toMatch(/\[B\]/);
  });

  it("FIX_HINT_REQUIRES_ANALYSIS_BRANCH — indirect variant contains [A] + [B] + keywords", () => {
    expect(indirect).toMatch(/\bcode\s+issue\b/i);
    expect(indirect).toMatch(/\bcontract\s+issue\b/i);
    expect(indirect).toMatch(/\bpropose\b/i);
    expect(indirect).toMatch(/\[A\]/);
    expect(indirect).toMatch(/\[B\]/);
  });

  it("does NOT instruct the agent to edit the contract directly", () => {
    expect(direct).not.toMatch(
      /\bedit\s+(the\s+)?contract\s+(file\s+)?directly\b(?!\s*[—-])/i,
    );
    expect(direct).toContain("Do NOT edit the contract directly");
  });

  it("indirect variant mentions the propagation root", () => {
    expect(indirect).toContain("src/db/users.ts::getUserFromDb(1)");
  });

  it("includes proposeExitText verbatim", () => {
    expect(direct).toContain(proposeExitText(POLICY.id));
  });
});

describe("defaultDisallowedEffectFixHint", () => {
  const hint = defaultDisallowedEffectFixHint(
    POLICY,
    "src/lib/pure/util.ts::util(0)",
    "db.read",
    ["log.audit"],
    false,
    "src/db/users.ts::getUserFromDb(1)",
    "src/lib/pure/util.ts",
    11,
  );

  it("FIX_HINT_REQUIRES_ANALYSIS_BRANCH — all required substrings", () => {
    expect(hint).toMatch(/\bcode\s+issue\b/i);
    expect(hint).toMatch(/\bcontract\s+issue\b/i);
    expect(hint).toMatch(/\bpropose\b/i);
    expect(hint).toMatch(/\[A\]/);
    expect(hint).toMatch(/\[B\]/);
  });

  it("contains the backtick-quoted offending effect", () => {
    expect(hint).toContain("`db.read`");
  });

  it("does NOT instruct the agent to edit the contract directly", () => {
    expect(hint).not.toMatch(
      /\bedit\s+(the\s+)?contract\s+(file\s+)?directly\b(?!\s*[—-])/i,
    );
    expect(hint).toContain("Do NOT edit the contract directly");
  });

  it("renders the allow list", () => {
    expect(hint).toContain("[log.audit]");
  });

  it("references the file:line", () => {
    expect(hint).toContain("src/lib/pure/util.ts:11");
  });

  it("empty allow list rendered as `<empty — no effects allowed>`", () => {
    const hint2 = defaultDisallowedEffectFixHint(
      POLICY,
      "src/r/x.ts::x(0)",
      "time.now",
      [],
      true,
      undefined,
      "src/r/x.ts",
      5,
    );
    expect(hint2).toContain("<empty — no effects allowed>");
  });
});

describe("defaultUnresolvedCallFixHint", () => {
  const hint = defaultUnresolvedCallFixHint(
    undefined,
    "src/services/runner.ts::run(1)",
    "src/services/runner.ts",
    42,
  );

  it("FIX_HINT_REQUIRES_ANALYSIS_BRANCH — all required substrings", () => {
    expect(hint).toMatch(/\bcode\s+issue\b/i);
    expect(hint).toMatch(/\bcontract\s+issue\b/i);
    expect(hint).toMatch(/\bpropose\b/i);
    expect(hint).toMatch(/\[A\]/);
    expect(hint).toMatch(/\[B\]/);
  });

  it("explains why static analysis failed (D-CG-5 fail-closed)", () => {
    expect(hint).toContain("unresolved call");
    expect(hint).toMatch(/D-CG-5|fail closed/);
  });

  it("does NOT instruct the agent to edit the contract directly", () => {
    expect(hint).not.toMatch(
      /\bedit\s+(the\s+)?contract\s+(file\s+)?directly\b(?!\s*[—-])/i,
    );
    expect(hint).toContain("Do NOT edit the contract directly");
  });

  it("uses policyId when policy is provided", () => {
    const hint2 = defaultUnresolvedCallFixHint(
      POLICY,
      "src/services/x.ts::x(0)",
      "src/services/x.ts",
      7,
    );
    expect(hint2).toContain("NO_IO_IN_UI");
  });

  it("falls back to <effect-system> when policy is undefined", () => {
    expect(hint).toContain("<effect-system>");
  });
});

describe("proposeExitText", () => {
  it("is parameterised by policy id", () => {
    const a = proposeExitText("POLICY_A");
    const b = proposeExitText("POLICY_B");
    expect(a).toContain("POLICY_A");
    expect(b).toContain("POLICY_B");
    expect(a).not.toContain("POLICY_B");
  });

  it("contains the verbatim 'Do NOT edit the contract directly' clause", () => {
    expect(proposeExitText("X")).toContain("Do NOT edit the contract directly");
  });

  it("references the policy id and proposal flow", () => {
    // Phase B currently exposes only `stele design propose <type>` with
    // built-in types invariant/branded-id/aggregate. Effect-policy-specific
    // propose subcommand is a planned follow-up — fix-hint instructs the
    // agent to write a YAML proposal containing the policy id instead.
    const text = proposeExitText("NO_IO_IN_UI");
    expect(text).toContain("NO_IO_IN_UI");
    expect(text).toContain("stele design propose");
    expect(text).toContain("contract/design/proposals/");
  });

  it("references `stele why <id>` for context", () => {
    expect(proposeExitText("FOO")).toContain("stele why FOO");
  });
});
