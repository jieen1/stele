// Round 14 P0: tests for the Python CallGraph extractor.
//
// Each test writes a tiny Python project to a temp dir, runs the
// extractor, and asserts on the produced CallGraph shape.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pyCallGraphExtractor } from "../src/extractors/call-graph.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  tempDirs.length = 0;
});

async function mkProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stele-py-cg-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

describe("pyCallGraphExtractor", () => {
  it("produces a schema-versioned graph with python language tag", async () => {
    const root = await mkProject({
      "main.py": "def main():\n    pass\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    expect(graph.schemaVersion).toBe("1");
    expect(graph.language).toBe("python");
    expect(graph.projectRoot).toBe(root);
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it("emits a node for every top-level function with the expected NodeId shape", async () => {
    const root = await mkProject({
      "service.py": "def helper(x):\n    return x + 1\n\ndef other():\n    return helper(1)\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain("service.py::helper");
    expect(ids).toContain("service.py::other");
  });

  it("emits class + method nodes with `ClassName::method` ids", async () => {
    const root = await mkProject({
      "svc.py":
        "class Service:\n" +
        "    def __init__(self):\n" +
        "        self.state = 0\n" +
        "    def run(self, n):\n" +
        "        return self.tick()\n" +
        "    def tick(self):\n" +
        "        return 1\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toContain("svc.py::Service");
    expect(ids).toContain("svc.py::Service::__init__");
    expect(ids).toContain("svc.py::Service::run");
    expect(ids).toContain("svc.py::Service::tick");
  });

  it("resolves self.<method>() calls to the enclosing class method", async () => {
    const root = await mkProject({
      "svc.py":
        "class Service:\n" +
        "    def run(self):\n" +
        "        return self.tick()\n" +
        "    def tick(self):\n" +
        "        return 1\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const runId = "svc.py::Service::run";
    const tickId = "svc.py::Service::tick";
    const edge = graph.edges.find((e) => e.fromId === runId && e.toId === tickId);
    expect(edge).toBeDefined();
  });

  it("resolves same-module direct name calls to module-level defs", async () => {
    const root = await mkProject({
      "a.py": "def helper():\n    return 1\n\ndef main():\n    return helper()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const edge = graph.edges.find(
      (e) => e.fromId === "a.py::main" && e.toId === "a.py::helper",
    );
    expect(edge).toBeDefined();
  });

  it("classifies external library calls as unresolved with reason=external-lib", async () => {
    const root = await mkProject({
      "uses_os.py":
        "import os\n\ndef pid_str():\n    return os.getpid()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const unresolved = graph.unresolvedCalls.find(
      (u) => u.fromId === "uses_os.py::pid_str" && u.rawText === "os.getpid()",
    );
    expect(unresolved).toBeDefined();
    expect(unresolved!.reason).toBe("external-lib");
    // external-lib is a statically VISIBLE name → not a hidden bypass.
    expect(unresolved!.nameHidden).toBe(false);
  });

  // P0 regression guard: every unresolved call MUST carry a boolean nameHidden.
  // The trace-policy fail-closed gate fires only on nameHidden===true; if the
  // extractor omitted the field, `!undefined` skipped EVERY unresolved Python
  // call and silently disabled fail-closed on Python projects.
  it("emits a boolean nameHidden on every unresolved call", async () => {
    const root = await mkProject({
      "mixed.py":
        "import os\n" +
        "def f(predicate, table, name, o):\n" +
        "    os.getpid()\n" +
        "    predicate()\n" +
        "    table[name]()\n" +
        "    getattr(o, name)()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    expect(graph.unresolvedCalls.length).toBeGreaterThan(0);
    for (const u of graph.unresolvedCalls) {
      expect(typeof u.nameHidden).toBe("boolean");
    }
  });

  it("marks computed-member dispatch obj[expr]() as nameHidden=true", async () => {
    const root = await mkProject({
      "dispatch.py":
        "def route(table, name):\n    return table[name]()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const hidden = graph.unresolvedCalls.find(
      (u) => u.fromId === "dispatch.py::route" && u.rawText === "table[name]()",
    );
    expect(hidden).toBeDefined();
    expect(hidden!.nameHidden).toBe(true);
  });

  it("marks reflection getattr(o, name)() dispatch as nameHidden=true", async () => {
    const root = await mkProject({
      "reflect.py":
        "def call(o, name):\n    return getattr(o, name)()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const hidden = graph.unresolvedCalls.filter(
      (u) => u.fromId === "reflect.py::call" && u.nameHidden === true,
    );
    // Both the outer `(...)()` invocation of a call-result AND the inner
    // getattr(...) reflection call are name-hidden — at least one fires.
    expect(hidden.length).toBeGreaterThan(0);
  });

  it("resolves a single-hop local alias of an imported target to a REAL edge (no false-green)", async () => {
    // Regression for the review's HIGH finding: `w = delete_all; w()` must
    // resolve to a real edge to the project target (so a trace deny-policy
    // fires directly), not a silently-dropped unresolved call.
    const root = await mkProject({
      "db.py": "def delete_all():\n    pass\n",
      "handler.py":
        "from db import delete_all\n\ndef handler():\n    w = delete_all\n    w()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const edge = graph.edges.find(
      (e) => e.fromId === "handler.py::handler" && e.toId === "db.py::delete_all",
    );
    expect(edge).toBeDefined();
    // No leftover unresolved `w()` (which would have been the false-green).
    expect(graph.unresolvedCalls.find((u) => u.rawText === "w()")).toBeUndefined();
  });

  it("does not leak a sibling function's alias (per-scope aliasing)", async () => {
    // `a` aliases delete_all; `b` only calls `w()` with no alias of its own.
    // b's `w()` must NOT resolve to delete_all — aliases are scoped per function.
    const root = await mkProject({
      "db.py": "def delete_all():\n    pass\n",
      "two.py":
        "from db import delete_all\n\n" +
        "def a():\n    w = delete_all\n    w()\n\n" +
        "def b():\n    w()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    // a's w() resolves to a real edge.
    expect(
      graph.edges.find((e) => e.fromId === "two.py::a" && e.toId === "db.py::delete_all"),
    ).toBeDefined();
    // b's w() does NOT (no alias in b's scope) — no leak.
    expect(
      graph.edges.find((e) => e.fromId === "two.py::b" && e.toId === "db.py::delete_all"),
    ).toBeUndefined();
  });

  it("marks a visible-name callback predicate() as nameHidden=false (no over-block)", async () => {
    const root = await mkProject({
      "cb.py":
        "def run(predicate):\n    return predicate()\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const visible = graph.unresolvedCalls.find(
      (u) => u.fromId === "cb.py::run" && u.rawText === "predicate()",
    );
    expect(visible).toBeDefined();
    expect(visible!.nameHidden).toBe(false);
  });

  it("extracts effects from @stele.effects([...]) decorator", async () => {
    const root = await mkProject({
      "with_effects.py":
        "import stele\n\n@stele.effects([\"payment.charge\", \"db.read\"])\ndef charge():\n    pass\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const node = graph.nodes.find((n) => n.id === "with_effects.py::charge");
    expect(node).toBeDefined();
    expect(node!.effects).toEqual(["payment.charge", "db.read"]);
  });

  it("extracts effects from `@stele:effects` docstring line", async () => {
    const root = await mkProject({
      "doc_effects.py":
        'def charge():\n    """Charge a payment.\n\n    @stele:effects payment.charge db.read\n    """\n    pass\n',
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    const node = graph.nodes.find((n) => n.id === "doc_effects.py::charge");
    expect(node!.effects).toEqual(["payment.charge", "db.read"]);
  });

  it("produces deterministic methodResolutionHash for the same input", async () => {
    const root = await mkProject({
      "a.py": "def foo(): pass\n",
      "b.py": "def bar(): pass\n",
    });
    const g1 = await pyCallGraphExtractor.extract({ projectRoot: root });
    const g2 = await pyCallGraphExtractor.extract({ projectRoot: root });
    expect(g1.methodResolutionHash).toBe(g2.methodResolutionHash);
  });

  it("populates fileHashes with sha256 per file", async () => {
    const root = await mkProject({
      "a.py": "def foo(): pass\n",
    });
    const graph = await pyCallGraphExtractor.extract({ projectRoot: root });
    expect(graph.fileHashes["a.py"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
