// Go CallGraph extractor tests. Runs the real `go run` extractor, so they are
// gated on a reachable Go toolchain (STELE_GO env, else `go` on PATH).

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { goCallGraphExtractor } from "../src/extractors/call-graph.js";

function goReachable(): boolean {
  const candidate = process.env.STELE_GO && process.env.STELE_GO.trim().length > 0 ? process.env.STELE_GO.trim() : "go";
  try {
    execFileSync(candidate, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeGo = goReachable() ? describe : describe.skip;

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs.length = 0;
});

async function mkProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stele-go-cg-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

describeGo("goCallGraphExtractor", () => {
  it("emits a schema-versioned go graph with function + method nodes", async () => {
    const root = await mkProject({
      "svc/svc.go":
        "package svc\n" +
        "type Svc struct{}\n" +
        "func (s *Svc) Run() { s.help() }\n" +
        "func (s *Svc) help() {}\n" +
        "func Free() { Helper() }\n" +
        "func Helper() {}\n",
    });
    const g = await goCallGraphExtractor.extract({ projectRoot: root });
    expect(g.schemaVersion).toBe("1");
    expect(g.language).toBe("go");
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("svc/svc.go::Svc::Run");
    expect(ids).toContain("svc/svc.go::Svc::help");
    expect(ids).toContain("svc/svc.go::Free");
    expect(ids).toContain("svc/svc.go::Helper");
  });

  it("resolves same-package func calls and receiver-method dispatch to edges", async () => {
    const root = await mkProject({
      "svc/svc.go":
        "package svc\n" +
        "type Svc struct{}\n" +
        "func (s *Svc) Run() { s.help() }\n" +
        "func (s *Svc) help() {}\n" +
        "func Free() { Helper() }\n" +
        "func Helper() {}\n",
    });
    const g = await goCallGraphExtractor.extract({ projectRoot: root });
    expect(g.edges.some((e) => e.fromId === "svc/svc.go::Free" && e.toId === "svc/svc.go::Helper")).toBe(true);
    expect(
      g.edges.some((e) => e.fromId === "svc/svc.go::Svc::Run" && e.toId === "svc/svc.go::Svc::help"),
    ).toBe(true);
  });

  it("classifies pkg.Func() as external-lib (nameHidden=false) and a computed call as nameHidden=true", async () => {
    const root = await mkProject({
      "m/m.go":
        "package m\n" +
        'import "fmt"\n' +
        "func Run(name string, handlers map[string]func()) {\n" +
        "	fmt.Println(name)\n" +
        "	handlers[name]()\n" +
        "}\n",
    });
    const g = await goCallGraphExtractor.extract({ projectRoot: root });
    const ext = g.unresolvedCalls.find((u) => u.rawText.includes("fmt.Println"));
    expect(ext).toBeDefined();
    expect(ext!.reason).toBe("external-lib");
    expect(ext!.nameHidden).toBe(false);
    const computed = g.unresolvedCalls.find((u) => u.nameHidden === true);
    expect(computed).toBeDefined();
    // every unresolved call carries a boolean nameHidden (the soundness field)
    for (const u of g.unresolvedCalls) {
      expect(typeof u.nameHidden).toBe("boolean");
    }
  });

  it("extracts // stele:effects annotations onto the node", async () => {
    const root = await mkProject({
      "db/db.go":
        "package db\n" +
        "// stele:effects db.write payment.charge\n" +
        "func DeleteAll() {}\n",
    });
    const g = await goCallGraphExtractor.extract({ projectRoot: root });
    const n = g.nodes.find((x) => x.id === "db/db.go::DeleteAll");
    expect(n).toBeDefined();
    expect(n!.effects).toEqual(["db.write", "payment.charge"]);
  });

  it("produces a deterministic methodResolutionHash for the same input", async () => {
    const root = await mkProject({ "a/a.go": "package a\nfunc F() { G() }\nfunc G() {}\n" });
    const g1 = await goCallGraphExtractor.extract({ projectRoot: root });
    const g2 = await goCallGraphExtractor.extract({ projectRoot: root });
    expect(g1.methodResolutionHash).toBe(g2.methodResolutionHash);
  });
});
