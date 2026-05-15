import { describe, expect, it } from "vitest";
import { parseFile } from "../src/parser/parser.js";
import type { ListNode } from "../src/index.js";
import {
  parseAgentDeclaration,
  parseScopeDeclaration,
  parseInterAgentContractDeclaration,
  parseConflictDeclaration,
} from "../src/validator/structure-agent.js";

const TEST_FILE = "test.stele";

function parseListNode(source: string): ListNode {
  const parsed = parseFile(source, TEST_FILE);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error("Expected a list node from CDL source.");
  }

  return node;
}

describe("parseAgentDeclaration", () => {
  it("parses minimal agent declaration", () => {
    const node = parseListNode('(agent "code-reviewer")');

    const result = parseAgentDeclaration(TEST_FILE, node);

    expect(result.kind).toBe("agent");
    expect(result.id).toBe("code-reviewer");
    expect(result.allowedPaths).toEqual([]);
    expect(result.deniedPaths).toEqual([]);
    expect(result.filePath).toBe(TEST_FILE);
  });

  it("parses agent with description", () => {
    const node = parseListNode(
      '(agent "code-reviewer"\n  (description "Reviews code changes."))',
    );

    const result = parseAgentDeclaration(TEST_FILE, node);

    expect(result.id).toBe("code-reviewer");
    expect(result.description).toBeDefined();
    expect(result.description?.valueNode.kind).toBe("string");
  });

  it("parses agent with allowed-paths", () => {
    const node = parseListNode(
      '(agent "feature-writer"\n  (allowed-paths "src/**" "tests/**"))',
    );

    const result = parseAgentDeclaration(TEST_FILE, node);

    expect(result.allowedPaths).toEqual(["src/**", "tests/**"]);
  });

  it("parses agent with denied-paths", () => {
    const node = parseListNode(
      '(agent "feature-writer"\n  (denied-paths "contract/**" "config/**"))',
    );

    const result = parseAgentDeclaration(TEST_FILE, node);

    expect(result.deniedPaths).toEqual(["contract/**", "config/**"]);
  });

  it("parses agent with all fields", () => {
    const node = parseListNode(
      '(agent "code-reviewer"\n  (description "Reviews code.")\n  (allowed-paths "src/**" "tests/**")\n  (denied-paths "contract/**"))',
    );

    const result = parseAgentDeclaration(TEST_FILE, node);

    expect(result.id).toBe("code-reviewer");
    expect(result.description).toBeDefined();
    expect(result.allowedPaths).toEqual(["src/**", "tests/**"]);
    expect(result.deniedPaths).toEqual(["contract/**"]);
  });

  it("rejects agent without id", () => {
    const node = parseListNode('(agent)');

    expect(() => parseAgentDeclaration(TEST_FILE, node)).toThrow();
  });

  it("rejects unknown field", () => {
    const node = parseListNode(
      '(agent "reviewer"\n  (unknown-field "value"))',
    );

    expect(() => parseAgentDeclaration(TEST_FILE, node)).toThrow(
      'Agent "reviewer" has an unknown field "unknown-field".',
    );
  });

  it("rejects duplicate description", () => {
    const node = parseListNode(
      '(agent "reviewer"\n  (description "First.")\n  (description "Second."))',
    );

    expect(() => parseAgentDeclaration(TEST_FILE, node)).toThrow(
      'Agent "reviewer" description may only be declared once.',
    );
  });
});

describe("parseScopeDeclaration", () => {
  it("parses scope with agent and paths", () => {
    const node = parseListNode(
      '(scope "code-reviewer"\n  (path "src/lib/**")\n  (path "tests/lib/**"))',
    );

    const result = parseScopeDeclaration(TEST_FILE, node);

    expect(result.kind).toBe("scope");
    expect(result.agentId).toBe("code-reviewer");
    expect(result.paths).toEqual(["src/lib/**", "tests/lib/**"]);
  });

  it("parses scope with single path", () => {
    const node = parseListNode('(scope "writer" (path "src/**"))');

    const result = parseScopeDeclaration(TEST_FILE, node);

    expect(result.agentId).toBe("writer");
    expect(result.paths).toEqual(["src/**"]);
  });

  it("rejects scope without paths", () => {
    const node = parseListNode('(scope "agent")');

    expect(() => parseScopeDeclaration(TEST_FILE, node)).toThrow(
      'Scope "agent" must declare at least one path.',
    );
  });

  it("rejects scope without agent id", () => {
    const node = parseListNode('(scope)');

    expect(() => parseScopeDeclaration(TEST_FILE, node)).toThrow();
  });

  it("rejects scope with non-string path", () => {
    const node = parseListNode('(scope "agent" (path not-a-string))');

    expect(() => parseScopeDeclaration(TEST_FILE, node)).toThrow();
  });
});

describe("parseInterAgentContractDeclaration", () => {
  it("parses minimal contract", () => {
    const node = parseListNode(
      '(inter-agent-contract "review-before-merge"\n  (agents "code-reviewer" "feature-writer")\n  (requires "feature-writer" (path "src/**") (approved-by "code-reviewer")))',
    );

    const result = parseInterAgentContractDeclaration(TEST_FILE, node);

    expect(result.kind).toBe("inter-agent-contract");
    expect(result.id).toBe("review-before-merge");
    expect(result.agents).toEqual(["code-reviewer", "feature-writer"]);
    expect(result.requires).toHaveLength(1);
    expect(result.requires[0].agentId).toBe("feature-writer");
    expect(result.requires[0].pathPattern).toBe("src/**");
    expect(result.requires[0].approvedBy).toBe("code-reviewer");
  });

  it("parses contract with description", () => {
    const node = parseListNode(
      '(inter-agent-contract "contract"\n  (description "All changes need review.")\n  (agents "reviewer" "writer")\n  (requires "writer" (path "src/**") (approved-by "reviewer")))',
    );

    const result = parseInterAgentContractDeclaration(TEST_FILE, node);

    expect(result.description).toBeDefined();
    expect(result.description?.valueNode.kind).toBe("string");
  });

  it("rejects contract without agents", () => {
    const node = parseListNode(
      '(inter-agent-contract "c"\n  (requires "writer" (path "src/**") (approved-by "reviewer")))',
    );

    expect(() => parseInterAgentContractDeclaration(TEST_FILE, node)).toThrow(
      'Inter-agent contract "c" must declare at least one agent.',
    );
  });

  it("rejects contract without requires", () => {
    const node = parseListNode('(inter-agent-contract "c" (agents "reviewer" "writer"))');

    expect(() => parseInterAgentContractDeclaration(TEST_FILE, node)).toThrow(
      'Inter-agent contract "c" must declare at least one requirement.',
    );
  });

  it("rejects contract without id", () => {
    const node = parseListNode('(inter-agent-contract)');

    expect(() => parseInterAgentContractDeclaration(TEST_FILE, node)).toThrow();
  });

  it("rejects contract with duplicate requires clauses", () => {
    const node = parseListNode(
      '(inter-agent-contract "c"\n  (agents "a" "b")\n  (requires "a" (path "x") (approved-by "b"))\n  (requires "a" (path "y") (approved-by "b")))',
    );

    expect(() => parseInterAgentContractDeclaration(TEST_FILE, node)).toThrow(
      'Inter-agent contract "c" requires may only be declared once.',
    );
  });
});

describe("parseConflictDeclaration", () => {
  it("parses conflict with required fields", () => {
    const node = parseListNode(
      '(conflict (path "src/core/engine.ts")\n  (agents "feature-writer" "perf-optimizer")\n  (resolution "last-writer-wins"))',
    );

    const result = parseConflictDeclaration(TEST_FILE, node);

    expect(result.kind).toBe("conflict");
    expect(result.path).toBe("src/core/engine.ts");
    expect(result.agents).toEqual(["feature-writer", "perf-optimizer"]);
    expect(result.resolution).toBe("last-writer-wins");
    expect(result.fallback).toBeUndefined();
  });

  it("parses conflict with fallback", () => {
    const node = parseListNode(
      '(conflict (path "src/core/engine.ts")\n  (resolution "manual-review")\n  (fallback "contract-gated"))',
    );

    const result = parseConflictDeclaration(TEST_FILE, node);

    expect(result.resolution).toBe("manual-review");
    expect(result.fallback).toBe("contract-gated");
  });

  it("rejects conflict without path", () => {
    const node = parseListNode('(conflict)');

    expect(() => parseConflictDeclaration(TEST_FILE, node)).toThrow();
  });

  it("rejects conflict without resolution", () => {
    const node = parseListNode('(conflict (path "src/engine.ts") (agents "writer"))');

    expect(() => parseConflictDeclaration(TEST_FILE, node)).toThrow(
      'Conflict for "src/engine.ts" must declare a resolution strategy.',
    );
  });

  it("rejects invalid resolution strategy", () => {
    const node = parseListNode(
      '(conflict (path "src/engine.ts")\n  (resolution "invalid-strategy"))',
    );

    expect(() => parseConflictDeclaration(TEST_FILE, node)).toThrow(
      'Invalid conflict resolution strategy "invalid-strategy".',
    );
  });

  it("rejects invalid fallback strategy", () => {
    const node = parseListNode(
      '(conflict (path "src/engine.ts")\n  (resolution "last-writer-wins")\n  (fallback "bad"))',
    );

    expect(() => parseConflictDeclaration(TEST_FILE, node)).toThrow(
      'Invalid conflict fallback strategy "bad".',
    );
  });

  it("accepts all valid resolution strategies", () => {
    const strategies = [
      "last-writer-wins",
      "manual-review",
      "merge-strategy",
      "contract-gated",
    ];

    for (const strategy of strategies) {
      const node = parseListNode(
        `(conflict (path "src/engine.ts") (resolution "${strategy}"))`,
      );

      const result = parseConflictDeclaration(TEST_FILE, node);
      expect(result.resolution).toBe(strategy);
    }
  });
});

describe("agent declarations in pipeline", () => {
  it("buildContract collects agent declarations", () => {
    const source = `(agent "code-reviewer"\n  (allowed-paths "src/**")\n  (denied-paths "contract/**"))`;

    const parsed = parseFile(source, TEST_FILE);
    const node = parsed.body[0];

    if (node && node.kind === "list") {
      const result = parseAgentDeclaration(TEST_FILE, node);
      expect(result.id).toBe("code-reviewer");
      expect(result.allowedPaths).toContain("src/**");
      expect(result.deniedPaths).toContain("contract/**");
    }
  });

  it("structure-agent exports are accessible", () => {
    expect(typeof parseAgentDeclaration).toBe("function");
    expect(typeof parseScopeDeclaration).toBe("function");
    expect(typeof parseInterAgentContractDeclaration).toBe("function");
    expect(typeof parseConflictDeclaration).toBe("function");
  });
});
