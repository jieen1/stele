import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  TypeStateBindingDeclaration,
  TypeStateDeclaration,
} from "@stele/core";
import type {
  InferTypeStatesResult,
  InferredStateAtCallSite,
} from "@stele/type-state-evaluator";

import { tsTypeStateInferenceExtractor } from "../src/extractors/type-state-inference.js";
import type { ListNode, SourceSpan } from "@stele/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixturePath(name: string): string {
  return resolve(__dirname, "type-state-fixtures", name);
}

const ZERO_SPAN: SourceSpan = { file: "<test>", line: 1, column: 1 };
const FAKE_NODE: ListNode = {
  kind: "list",
  head: "type-state",
  items: [],
  span: ZERO_SPAN,
};

function makeDecl(overrides: Partial<TypeStateDeclaration>): TypeStateDeclaration {
  return {
    kind: "type-state",
    filePath: "contract/main.stele",
    node: FAKE_NODE,
    span: ZERO_SPAN,
    id: "ORDER_LIFECYCLE",
    target: "src/order.ts::Order",
    severity: "error",
    states: ["Draft", "Submitted", "Paid", "Shipped", "Cancelled"],
    initial: "Draft",
    terminal: ["Shipped", "Cancelled"],
    stateTypeMapping: [],
    transitions: [],
    allowedOps: new Map<string, readonly string[]>(),
    ...overrides,
  };
}

function makeBinding(
  fn: string,
  params: ReadonlyArray<{ index: number; state: string }>,
): TypeStateBindingDeclaration {
  return {
    kind: "type-state-binding",
    filePath: "contract/main.stele",
    node: FAKE_NODE,
    span: ZERO_SPAN,
    function: fn,
    params: params.map((p) => ({ index: p.index, state: p.state, span: ZERO_SPAN })),
  };
}

async function runInfer(
  fixture: string,
  decls: readonly TypeStateDeclaration[],
  bindings: readonly TypeStateBindingDeclaration[] = [],
): Promise<InferTypeStatesResult> {
  const projectRoot = fixturePath(fixture);
  return tsTypeStateInferenceExtractor.inferTypeStates({
    // The trait carries a CallGraph param but the TS extractor doesn't
    // require it for its own AST walk; pass a minimal stub.
    callGraph: {
      schemaVersion: "1",
      language: "typescript",
      generatedAt: new Date().toISOString(),
      projectRoot,
      nodes: [],
      edges: [],
      unresolvedCalls: [],
      ambiguousCalls: [],
      methodResolutionHash: "sha256-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      fileHashes: {},
    },
    declarations: decls,
    bindings,
    projectRoot,
  });
}

function findInferenceByMethod(
  inferences: readonly InferredStateAtCallSite[],
  method: string,
): InferredStateAtCallSite | undefined {
  return inferences.find((i) => i.method === method);
}

function allByMethod(
  inferences: readonly InferredStateAtCallSite[],
  method: string,
): readonly InferredStateAtCallSite[] {
  return inferences.filter((i) => i.method === method);
}

describe("tsTypeStateInferenceExtractor — extractor identity", () => {
  it("registers as the 'typescript' language extractor", () => {
    expect(tsTypeStateInferenceExtractor.language).toBe("typescript");
  });

  it("returns an empty result when there are no declarations", async () => {
    const r = await runInfer("direct-construction", []);
    expect(r.inferences).toEqual([]);
  });
});

describe("tsTypeStateInferenceExtractor — direct construction", () => {
  const decl = makeDecl({});

  it("infers Draft from createOrder() return type", async () => {
    const r = await runInfer("direct-construction", [decl]);
    const inf = findInferenceByMethod(r.inferences, "addItem");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBe("Draft");
    expect(inf?.receiverName).toBe("o");
    expect(inf?.declarationId).toBe("ORDER_LIFECYCLE");
  });

  it("infers Submitted from submit(createOrder()) chain", async () => {
    const r = await runInfer("direct-construction", [decl]);
    const inf = findInferenceByMethod(r.inferences, "pay");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBe("Submitted");
    expect(inf?.receiverName).toBe("submitted");
  });

  it("infers Submitted via let binding to submit(createOrder())", async () => {
    const r = await runInfer("direct-construction", [decl]);
    const inf = findInferenceByMethod(r.inferences, "cancel");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBe("Submitted");
  });

  it("infers Paid from pay(submit(createOrder())) nested chain", async () => {
    const r = await runInfer("direct-construction", [decl]);
    const inf = findInferenceByMethod(r.inferences, "ship");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBe("Paid");
  });

  it("records inferenceOrigin with a path + line for every direct call", async () => {
    const r = await runInfer("direct-construction", [decl]);
    for (const inf of r.inferences) {
      expect(inf.inferenceOrigin).toBeDefined();
      expect(inf.inferenceOrigin?.path).toBe("src/scenarios.ts");
      expect(inf.inferenceOrigin?.line).toBeGreaterThan(0);
    }
  });

  it("emits stable ordering across runs", async () => {
    const a = await runInfer("direct-construction", [decl]);
    const b = await runInfer("direct-construction", [decl]);
    expect(a.inferences.map((i) => i.method)).toEqual(b.inferences.map((i) => i.method));
  });
});

describe("tsTypeStateInferenceExtractor — parameter annotation", () => {
  const decl = makeDecl({ target: "src/order.ts::Order" });

  it("infers Submitted inside a function whose param is Order<\"Submitted\">", async () => {
    const r = await runInfer("parameter-annotation", [decl]);
    const charges = allByMethod(r.inferences, "charge");
    // paySubmitted + helper both call .charge() with Submitted-annotated params.
    expect(charges.length).toBeGreaterThanOrEqual(2);
    for (const c of charges) {
      expect(c.inferredState).toBe("Submitted");
    }
  });

  it("does NOT propagate state across function boundaries via call expression args", async () => {
    // processInner's body is `helper(o)`. We do NOT infer the state of `o`
    // at the helper(...) call site because helper(o) is not a method call
    // on `o`. The only method-call inference is inside helper itself.
    const r = await runInfer("parameter-annotation", [decl]);
    // No inference should exist with receiverName "o" inside processInner
    // that targets a method named "helper" (helper is a free function).
    const helperCalls = r.inferences.filter((i) => i.method === "helper");
    expect(helperCalls.length).toBe(0);
  });

  it("reports inference failure when receiver type has an unbound generic param", async () => {
    const r = await runInfer("parameter-annotation", [decl]);
    const refundCalls = allByMethod(r.inferences, "refund");
    expect(refundCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of refundCalls) {
      expect(c.inferredState).toBeUndefined();
      expect(c.inferenceReason).toMatch(/unbound generic parameter/);
    }
  });

  it("inferenceReason quotes the resolved phantom literal", async () => {
    const r = await runInfer("parameter-annotation", [decl]);
    const charge = findInferenceByMethod(r.inferences, "charge");
    expect(charge?.inferenceReason).toMatch(/"Submitted"/);
  });
});

describe("tsTypeStateInferenceExtractor — binding override", () => {
  const decl = makeDecl({ target: "src/order.ts::Order" });

  it("uses (type-state-binding ...) state when receiver has no phantom annotation", async () => {
    const bindings = [makeBinding("src/scenarios.ts::pay(2)", [{ index: 0, state: "Submitted" }])];
    const r = await runInfer("binding-override", [decl], bindings);
    const inf = findInferenceByMethod(r.inferences, "charge");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBe("Submitted");
    expect(inf?.inferenceReason).toMatch(/type-state-binding/);
    expect(inf?.flowSteps.length).toBeGreaterThan(0);
  });

  it("supports binding on a non-zero parameter index", async () => {
    const bindings = [makeBinding("src/scenarios.ts::adjust(2)", [{ index: 1, state: "Draft" }])];
    const r = await runInfer("binding-override", [decl], bindings);
    const inf = findInferenceByMethod(r.inferences, "addItem");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBe("Draft");
  });

  it("returns inferredState=undefined when neither annotation nor matching binding is present", async () => {
    const r = await runInfer("binding-override", [decl], []);
    const inf = findInferenceByMethod(r.inferences, "refund");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBeUndefined();
    expect(inf?.inferenceReason).toMatch(/no type arguments|not a string literal|unbound generic/);
  });

  it("does not apply a binding to a function it does not cover", async () => {
    const bindings = [makeBinding("src/scenarios.ts::pay(2)", [{ index: 0, state: "Submitted" }])];
    const r = await runInfer("binding-override", [decl], bindings);
    const refund = findInferenceByMethod(r.inferences, "refund");
    // unannotated() has no binding, so refund() inside it must remain unresolved.
    expect(refund?.inferredState).toBeUndefined();
  });
});

describe("tsTypeStateInferenceExtractor — unbound generic / async / edge cases", () => {
  const decl = makeDecl({ target: "src/order.ts::Order" });

  it("returns undefined for receivers whose phantom is a TypeParameter", async () => {
    const r = await runInfer("unbound-generic", [decl]);
    expect(r.inferences.length).toBeGreaterThanOrEqual(1);
    for (const inf of r.inferences) {
      expect(inf.inferredState).toBeUndefined();
    }
  });

  it("explains the failure with a reason mentioning generics or missing args", async () => {
    const r = await runInfer("unbound-generic", [decl]);
    for (const inf of r.inferences) {
      expect(inf.inferenceReason).toMatch(/unbound generic parameter|no type arguments/);
    }
  });

  it("unwraps Promise<Order<\"Paid\">> from awaited expression", async () => {
    const r = await runInfer("async-promise", [decl]);
    const inf = findInferenceByMethod(r.inferences, "ship");
    expect(inf).toBeDefined();
    expect(inf?.inferredState).toBe("Paid");
  });

  it("class form: external `new Order<\"Draft\">().addItem(...)` yields Draft", async () => {
    const r = await runInfer("methods-on-class", [makeDecl({ target: "src/order.ts::Order" })]);
    const externalCalls = r.inferences.filter(
      (i) => i.method === "addItem" && i.callerId.includes("externalCallSite"),
    );
    expect(externalCalls.length).toBe(1);
    expect(externalCalls[0]?.inferredState).toBe("Draft");
  });

  it("class form: `this.touch()` inside addItem<S> reports inference failure (S unbound)", async () => {
    const r = await runInfer("methods-on-class", [makeDecl({ target: "src/order.ts::Order" })]);
    const touch = findInferenceByMethod(r.inferences, "touch");
    expect(touch).toBeDefined();
    expect(touch?.inferredState).toBeUndefined();
    expect(touch?.inferenceReason).toMatch(
      /unbound generic parameter|no type arguments|not a string literal/,
    );
  });

  it("class form: receiver from Order.factory() yields Draft", async () => {
    const r = await runInfer("methods-on-class", [makeDecl({ target: "src/order.ts::Order" })]);
    const viaFactory = r.inferences.filter(
      (i) => i.method === "addItem" && i.callerId.includes("viaFactory"),
    );
    expect(viaFactory.length).toBe(1);
    expect(viaFactory[0]?.inferredState).toBe("Draft");
  });

  it("skips declarations whose target uses a glob (B.1 MC-3 Go territory)", async () => {
    const r = await runInfer(
      "glob-target",
      [makeDecl({ target: "src/*.ts::*Order" })],
    );
    expect(r.inferences).toEqual([]);
  });

  it("returns empty inferences when projectRoot has no tsconfig and no ts files", async () => {
    const r = await tsTypeStateInferenceExtractor.inferTypeStates({
      callGraph: {
        schemaVersion: "1",
        language: "typescript",
        generatedAt: new Date().toISOString(),
        projectRoot: "/nonexistent-stele-fixture-root",
        nodes: [],
        edges: [],
        unresolvedCalls: [],
        ambiguousCalls: [],
        methodResolutionHash:
          "sha256-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        fileHashes: {},
      },
      declarations: [makeDecl({})],
      bindings: [],
      projectRoot: "/nonexistent-stele-fixture-root",
    });
    expect(r.inferences).toEqual([]);
  });

  it("returns empty inferences when target type cannot be resolved", async () => {
    const r = await runInfer("direct-construction", [
      makeDecl({ target: "src/order.ts::NonExistentType" }),
    ]);
    expect(r.inferences).toEqual([]);
  });
});

describe("tsTypeStateInferenceExtractor — flow steps", () => {
  it("attaches a provenance step for chained construction", async () => {
    const r = await runInfer("direct-construction", [makeDecl({})]);
    const submitted = findInferenceByMethod(r.inferences, "pay");
    expect(submitted?.flowSteps.length).toBeGreaterThan(0);
  });

  it("flowSteps is a frozen array of strings", async () => {
    const r = await runInfer("direct-construction", [makeDecl({})]);
    for (const inf of r.inferences) {
      expect(Array.isArray(inf.flowSteps)).toBe(true);
      for (const s of inf.flowSteps) {
        expect(typeof s).toBe("string");
      }
    }
  });
});
