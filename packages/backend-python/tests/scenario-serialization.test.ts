import { describe, expect, it } from "vitest";
import {
  serializeScenario,
  serializeScenarioValue,
  renderPythonValue,
} from "../src/scenario-serialization.js";
import { SteleError, type AstNode, type ScenarioDeclaration, type ScenarioOperation } from "@stele/core";

// ---------------------------------------------------------------------------
// renderPythonValue
// ---------------------------------------------------------------------------

describe("renderPythonValue", () => {
  it("renders null as None", () => {
    const lines = renderPythonValue(null, 0);
    expect(lines).toEqual(["None,"]);
  });

  it("renders string as Python string", () => {
    const lines = renderPythonValue("hello", 0);
    expect(lines).toEqual(['"hello",']);
  });

  it("renders number", () => {
    const lines = renderPythonValue(42, 0);
    expect(lines).toEqual(["42,"]);
  });

  it("renders float number", () => {
    const lines = renderPythonValue(3.14, 0);
    expect(lines).toEqual(["3.14,"]);
  });

  it("renders boolean true", () => {
    const lines = renderPythonValue(true, 0);
    expect(lines).toEqual(["True,"]);
  });

  it("renders boolean false", () => {
    const lines = renderPythonValue(false, 0);
    expect(lines).toEqual(["False,"]);
  });

  it("renders empty array as []", () => {
    const lines = renderPythonValue([], 0);
    expect(lines).toEqual(["[],"]);
  });

  it("renders non-empty array with indentation", () => {
    const lines = renderPythonValue([1, 2, 3], 0);
    expect(lines[0]).toBe("[");
    expect(lines).toContainEqual(expect.stringContaining("1,"));
    expect(lines).toContainEqual(expect.stringContaining("]"));
  });

  it("renders empty object as {}", () => {
    const lines = renderPythonValue({}, 0);
    expect(lines).toEqual(["{},"]);
  });

  it("renders object with string values inline", () => {
    const lines = renderPythonValue({ name: "test" }, 0);
    expect(lines.some((l) => l.includes('"name": "test"'))).toBe(true);
  });

  it("renders nested object with indentation", () => {
    const lines = renderPythonValue({ outer: { inner: "val" } }, 0);
    expect(lines[0]).toBe("{");
    expect(lines[lines.length - 1]).toBe("},");
  });

  it("renders list of strings inline", () => {
    const lines = renderPythonValue(["a", "b"], 0);
    expect(lines[0]).toBe("[");
  });

  it("renders complex nested structure", () => {
    const value = {
      id: "fund-123",
      metadata: { name: "fund", tags: ["a", "b"] },
    };
    const lines = renderPythonValue(value, 0);
    expect(lines[0]).toBe("{");
    expect(lines[lines.length - 1]).toBe("},");
  });

  it("renders with custom indent level", () => {
    const lines = renderPythonValue({ a: 1 }, 2);
    expect(lines[0]).toBe("        {");
  });

  it("renders string with special chars", () => {
    const lines = renderPythonValue("he said \"hi\"", 0);
    expect(lines[0]).toContain('he said');
  });
});

// ---------------------------------------------------------------------------
// serializeScenarioValue — with manually built AST nodes
// ---------------------------------------------------------------------------

describe("serializeScenarioValue", () => {
  it("serializes number node", () => {
    const node: AstNode = { kind: "number", value: 42, raw: "42", span: { file: "", line: 1, column: 1 } };
    expect(serializeScenarioValue(node)).toBe(42);
  });

  it("serializes string node", () => {
    const node: AstNode = { kind: "string", value: "hello", span: { file: "", line: 1, column: 1 } };
    expect(serializeScenarioValue(node)).toBe("hello");
  });

  it("serializes keyword node with colon prefix", () => {
    const node: AstNode = { kind: "keyword", value: "sym", span: { file: "", line: 1, column: 1 } };
    expect(serializeScenarioValue(node)).toBe(":sym");
  });

  it("serializes true identifier", () => {
    const node: AstNode = { kind: "identifier", value: "true", span: { file: "", line: 1, column: 1 } };
    expect(serializeScenarioValue(node)).toBe(true);
  });

  it("serializes false identifier", () => {
    const node: AstNode = { kind: "identifier", value: "false", span: { file: "", line: 1, column: 1 } };
    expect(serializeScenarioValue(node)).toBe(false);
  });

  it("serializes null identifier", () => {
    const node: AstNode = { kind: "identifier", value: "null", span: { file: "", line: 1, column: 1 } };
    expect(serializeScenarioValue(node)).toBe(null);
  });

  it("serializes none identifier", () => {
    const node: AstNode = { kind: "identifier", value: "none", span: { file: "", line: 1, column: 1 } };
    expect(serializeScenarioValue(node)).toBe(null);
  });

  it("throws for unsupported bare identifier", () => {
    const node: AstNode = { kind: "identifier", value: "unknownThing", span: { file: "", line: 1, column: 1 } };
    expect(() => serializeScenarioValue(node)).toThrow(SteleError);
  });

  it("serializes object form", () => {
    const nameId: AstNode = { kind: "identifier", value: "id", span: { file: "", line: 1, column: 1 } };
    const nameVal: AstNode = { kind: "string", value: "123", span: { file: "", line: 1, column: 1 } };
    const fieldNode: AstNode = {
      kind: "list",
      head: "name",
      items: [nameVal],
      span: { file: "", line: 1, column: 1 },
    };
    const objNode: AstNode = {
      kind: "list",
      head: "object",
      items: [fieldNode],
      span: { file: "", line: 1, column: 1 },
    };
    const result = serializeScenarioValue(objNode);
    expect(result).toEqual({ name: "123" });
  });

  it("serializes ref form", () => {
    const fundId: AstNode = { kind: "identifier", value: "fund", span: { file: "", line: 1, column: 1 } };
    const idPart: AstNode = { kind: "identifier", value: "id", span: { file: "", line: 1, column: 1 } };
    const refNode: AstNode = {
      kind: "list",
      head: "ref",
      items: [fundId, idPart],
      span: { file: "", line: 1, column: 1 },
    };
    const result = serializeScenarioValue(refNode);
    expect(result).toEqual({ $ref: ["fund", "id"] });
  });

  it("serializes gen unique-name form", () => {
    const uniqueId: AstNode = { kind: "identifier", value: "unique-name", span: { file: "", line: 1, column: 1 } };
    const prefixStr: AstNode = { kind: "string", value: "fund", span: { file: "", line: 1, column: 1 } };
    const genNode: AstNode = {
      kind: "list",
      head: "gen",
      items: [uniqueId, prefixStr],
      span: { file: "", line: 1, column: 1 },
    };
    const result = serializeScenarioValue(genNode);
    expect(result).toEqual({ $gen: { kind: "unique-name", prefix: "fund" } });
  });

  it("serializes ref with keyword path segment", () => {
    const capId: AstNode = { kind: "identifier", value: "cap", span: { file: "", line: 1, column: 1 } };
    const kwPart: AstNode = { kind: "keyword", value: "id", span: { file: "", line: 1, column: 1 } };
    const refNode: AstNode = {
      kind: "list",
      head: "ref",
      items: [capId, kwPart],
      span: { file: "", line: 1, column: 1 },
    };
    const result = serializeScenarioValue(refNode);
    expect(result).toEqual({ $ref: ["cap", ":id"] });
  });

  it("throws for unsupported operator", () => {
    const node: AstNode = {
      kind: "list",
      head: "unsupported-op",
      items: [],
      span: { file: "", line: 1, column: 1 },
    };
    expect(() => serializeScenarioValue(node)).toThrow(SteleError);
  });
});

// ---------------------------------------------------------------------------
// serializeScenario — full scenario serialization
// ---------------------------------------------------------------------------

describe("serializeScenario", () => {
  it("serializes minimal scenario", () => {
    const scenario = {
      id: "sc1",
      filePath: "test.stele",
      span: { file: "test.stele", line: 1, column: 1 },
      executor: "python-import",
      sandbox: "transactional",
      steps: [],
    } as unknown as ScenarioDeclaration;
    const result = serializeScenario(scenario);
    expect(result.id).toBe("sc1");
    expect(result.executor).toBe("python-import");
    expect(result.steps).toEqual([]);
  });

  it("serializes scenario with step", () => {
    const callTarget = "tests.scenarios:create_fund";
    const scenario = {
      id: "sc1",
      filePath: "test.stele",
      span: { file: "test.stele", line: 1, column: 1 },
      executor: "python-import",
      sandbox: "transactional",
      steps: [
        {
          kind: "step",
          id: "setup",
          capture: "fund",
          call: { target: callTarget, body: undefined },
        },
      ],
    } as unknown as ScenarioDeclaration;
    const result = serializeScenario(scenario);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.kind).toBe("step");
    expect(result.steps[0]?.capture).toBe("fund");
  });

  it("serializes scenario with capture-state", () => {
    const scenario = {
      id: "sc1",
      filePath: "test.stele",
      span: { file: "test.stele", line: 1, column: 1 },
      executor: "python-import",
      sandbox: "transactional",
      steps: [
        {
          kind: "capture-state",
          capture: "state-before",
          call: { target: "tests.scenarios:get_state" },
        },
      ],
    } as unknown as ScenarioDeclaration;
    const result = serializeScenario(scenario);
    expect(result.steps[0]?.kind).toBe("capture-state");
    expect(result.steps[0]?.capture).toBe("state-before");
  });
});

// ---------------------------------------------------------------------------
// Integration: render scenario as Python
// ---------------------------------------------------------------------------

describe("renderPythonValue integration", () => {
  it("renders serialized scenario as valid Python", () => {
    const value = {
      id: "fund-flow",
      executor: "python-import",
      sandbox: { kind: "transactional" },
      steps: [
        {
          kind: "step",
          id: "create",
          capture: "fund",
          call: {
            target: "tests.scenarios:create",
            body: { name: "Fund A" },
          },
        },
      ],
    };
    const lines = renderPythonValue(value, 0);
    const source = lines.join("\n");
    // Should produce valid-looking Python dict literal
    expect(source).toContain('"id": "fund-flow"');
    expect(source).toContain('"steps"');
  });
});
