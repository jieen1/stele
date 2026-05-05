import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClassShapeDeclaration, FunctionShapeDeclaration, TypePolicyDeclaration } from "@stele/core";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePythonAdvancedCodeShapes } from "../src/commands/pythonAdvancedCodeShape.js";

const tempDirs: string[] = [];
const CONTRACT_PATH = "contract/main.stele";
const DUMMY_SPAN = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 },
} as const;

describe("python advanced code-shape evaluator", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("reports class-shape field, type, method, and extends violations while recognizing self fields", async () => {
    const projectDir = await createProject({
      "src/models.py": [
        "class ServiceBase:",
        "    pass",
        "",
        "class ContractModel(ServiceBase):",
        "    id: str",
        "",
        "    def __init__(self) -> None:",
        "        self.created_at = 1",
        "",
      ].join("\n"),
    });

    const findings = await evaluatePythonAdvancedCodeShapes({
      projectDir,
      declarations: [
        classShape({
          id: "contract_model_shape",
          target: "src/models.py::ContractModel",
          mustHaveFields: [
            { name: "id", type: "UUID" },
            { name: "created_at" },
            { name: "status" },
          ],
          mustHaveMethods: ["save"],
          mustExtend: ["BaseModel"],
        }),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "contract_model_shape",
          location: expect.objectContaining({
            path: "src/models.py",
          }),
          cause: expect.objectContaining({
            summary: expect.stringContaining('field "status"'),
          }),
        }),
        expect.objectContaining({
          ruleId: "contract_model_shape",
          cause: expect.objectContaining({
            summary: expect.stringContaining('field "id"'),
            detail: expect.stringContaining("str"),
          }),
        }),
        expect.objectContaining({
          ruleId: "contract_model_shape",
          cause: expect.objectContaining({
            summary: expect.stringContaining('method "save"'),
          }),
        }),
        expect.objectContaining({
          ruleId: "contract_model_shape",
          cause: expect.objectContaining({
            summary: expect.stringContaining('extend "BaseModel"'),
          }),
        }),
      ]),
    );
    expect(findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cause: expect.objectContaining({
            summary: expect.stringContaining('field "created_at"'),
          }),
        }),
      ]),
    );
  });

  it("matches fastapi-route selectors and reports missing parameters", async () => {
    const projectDir = await createProject({
      "src/routes.py": [
        "from fastapi import APIRouter",
        "",
        "router = APIRouter()",
        "",
        "@router.post('/contracts')",
        "async def create_contract(payload: dict[str, str]) -> dict[str, str]:",
        "    return payload",
        "",
      ].join("\n"),
    });

    const findings = await evaluatePythonAdvancedCodeShapes({
      projectDir,
      declarations: [
        functionShape({
          id: "route_shape",
          target: "src/routes.py::[fastapi-route]",
          mustHaveParameters: ["request"],
        }),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "route_shape",
          location: expect.objectContaining({
            path: "src/routes.py",
            line: 6,
          }),
          cause: expect.objectContaining({
            summary: expect.stringContaining('parameter "request"'),
          }),
        }),
      ]),
    );
  });

  it("supports dotted and glob call matching on named function selectors", async () => {
    const projectDir = await createProject({
      "src/service.py": [
        "def reconcile_contract(payload: dict[str, str], request: object) -> None:",
        "    db.session.commit()",
        "    audit.emit_event('contracts.reconciled')",
        "",
      ].join("\n"),
    });

    const findings = await evaluatePythonAdvancedCodeShapes({
      projectDir,
      declarations: [
        functionShape({
          id: "reconcile_shape",
          target: "src/service.py::reconcile_contract",
          mustHaveCalls: ["db.session.commit", "audit.*"],
          mustHaveParameters: ["request"],
        }),
      ],
    });

    expect(findings).toEqual([]);
  });

  it("reports deny-type float annotations across file globs", async () => {
    const projectDir = await createProject({
      "src/types.py": "def cast_amount(amount: float) -> float:\n    return amount\n",
    });

    const findings = await evaluatePythonAdvancedCodeShapes({
      projectDir,
      declarations: [
        typePolicy({
          id: "no_float_annotations",
          target: "src/**/*.py",
          denyTypes: ["float"],
        }),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "no_float_annotations",
          location: expect.objectContaining({
            path: "src/types.py",
            line: 1,
          }),
          cause: expect.objectContaining({
            summary: expect.stringContaining('"float"'),
          }),
        }),
      ]),
    );
  });

  it("reports missing required types when no matching annotation exists", async () => {
    const projectDir = await createProject({
      "src/types.py": "def normalize_name(name: str) -> str:\n    return name.strip()\n",
    });

    const findings = await evaluatePythonAdvancedCodeShapes({
      projectDir,
      declarations: [
        typePolicy({
          id: "require_decimal_annotations",
          target: "src/**/*.py",
          requireTypes: ["Decimal"],
        }),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "require_decimal_annotations",
          location: expect.objectContaining({
            path: "src/types.py",
          }),
          cause: expect.objectContaining({
            summary: expect.stringContaining('requires annotation "Decimal"'),
          }),
          scopePaths: expect.arrayContaining([CONTRACT_PATH, "src/types.py"]),
        }),
      ]),
    );
  });

  it("returns execution-style findings for python syntax errors instead of throwing", async () => {
    const projectDir = await createProject({
      "src/bad.py": "def broken(:\n    pass\n",
    });

    await expect(
      evaluatePythonAdvancedCodeShapes({
        projectDir,
        declarations: [
          typePolicy({
            id: "syntax_probe",
            target: "src/**/*.py",
          }),
        ],
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingKind: "execution_error",
          ruleId: "stele.check.execution_error",
          location: expect.objectContaining({
            path: "src/bad.py",
            line: 1,
          }),
          cause: expect.objectContaining({
            summary: expect.stringContaining("Python AST analysis failed"),
          }),
          fix: expect.objectContaining({
            summary: expect.stringContaining("Fix the Python analysis error"),
          }),
        }),
      ]),
    );
  });
});

async function createProject(files: Record<string, string>): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "stele-python-advanced-shape-"));
  tempDirs.push(projectDir);

  for (const [relativePath, content] of Object.entries(files)) {
    await writeProjectFile(projectDir, relativePath, content);
  }

  return projectDir;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function classShape(options: {
  id: string;
  target: string;
  mustHaveFields?: Array<{ name: string; type?: string }>;
  mustHaveMethods?: string[];
  mustExtend?: string[];
}): ClassShapeDeclaration {
  return {
    kind: "class-shape",
    filePath: CONTRACT_PATH,
    node: {} as never,
    span: DUMMY_SPAN as never,
    id: options.id,
    lang: "python",
    target: options.target,
    mustHaveFields: (options.mustHaveFields ?? []).map((field) => ({
      ...field,
      span: DUMMY_SPAN as never,
    })),
    mustHaveMethods: options.mustHaveMethods ?? [],
    mustExtend: options.mustExtend ?? [],
  };
}

function functionShape(options: {
  id: string;
  target: string;
  mustHaveCalls?: string[];
  mustHaveDecorators?: string[];
  mustHaveParameters?: string[];
}): FunctionShapeDeclaration {
  return {
    kind: "function-shape",
    filePath: CONTRACT_PATH,
    node: {} as never,
    span: DUMMY_SPAN as never,
    id: options.id,
    lang: "python",
    target: options.target,
    mustHaveCalls: options.mustHaveCalls ?? [],
    mustHaveDecorators: options.mustHaveDecorators ?? [],
    mustHaveParameters: options.mustHaveParameters ?? [],
  };
}

function typePolicy(options: {
  id: string;
  target: string;
  denyTypes?: string[];
  requireTypes?: string[];
}): TypePolicyDeclaration {
  return {
    kind: "type-policy",
    filePath: CONTRACT_PATH,
    node: {} as never,
    span: DUMMY_SPAN as never,
    id: options.id,
    lang: "python",
    target: options.target,
    denyTypes: options.denyTypes ?? [],
    requireTypes: options.requireTypes ?? [],
  };
}
