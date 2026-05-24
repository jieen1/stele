// Round 14 P2: tests for the Python architecture extractor.
//
// Uses a small Python project + a minimal architecture declaration to
// verify the regex-based import extractor detects layer-violating
// imports (deny-dependency) and resolves both `from X import Y` and
// `import X.Y` shapes.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateArchitectureRuntime } from "../src/architecture-runtime.js";

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
  const root = await mkdtemp(join(tmpdir(), "stele-py-arch-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

describe("evaluateArchitectureRuntime (lang: python)", () => {
  it("flags an absolute `from infra import X` from a domain module as a dependency violation", async () => {
    const root = await mkProject({
      "src/domain/order.py":
        "from src.infra.db import save  # forbidden: domain → infra\n\ndef place_order(order):\n    save(order)\n",
      "src/infra/db.py": "def save(order): pass\n",
    });
    const result = await evaluateArchitectureRuntime({
      projectRoot: root,
      architecture: {
        id: "ddd-py",
        lang: "python",
        modules: [
          { id: "domain", paths: ["src/domain/**"] },
          { id: "infra", paths: ["src/infra/**"] },
        ],
        // domain is NOT allowed to depend on infra in this profile.
        allowDependencies: [{ from: "infra", to: ["domain"] }],
        denyCycles: false,
      },
    });
    expect(result.dependencyViolations.length).toBeGreaterThan(0);
    const v = result.dependencyViolations[0]!;
    expect(v.fromModule).toBe("domain");
    expect(v.toModule).toBe("infra");
  });

  it("does NOT flag the import when the direction is allowed", async () => {
    const root = await mkProject({
      "src/infra/db.py":
        "from src.domain.order import Order\n\ndef save(o: Order): pass\n",
      "src/domain/order.py": "class Order: pass\n",
    });
    const result = await evaluateArchitectureRuntime({
      projectRoot: root,
      architecture: {
        id: "ddd-py",
        lang: "python",
        modules: [
          { id: "domain", paths: ["src/domain/**"] },
          { id: "infra", paths: ["src/infra/**"] },
        ],
        // infra → domain is explicitly allowed.
        allowDependencies: [{ from: "infra", to: ["domain"] }],
        denyCycles: false,
      },
    });
    expect(result.dependencyViolations).toEqual([]);
  });

  it("resolves `import a.b.c` (dotted) to a project-relative path", async () => {
    const root = await mkProject({
      "src/domain/order.py":
        "import src.infra.db  # forbidden\n\ndef place(o):\n    pass\n",
      "src/infra/db.py": "def save(order): pass\n",
    });
    const result = await evaluateArchitectureRuntime({
      projectRoot: root,
      architecture: {
        id: "ddd-py",
        lang: "python",
        modules: [
          { id: "domain", paths: ["src/domain/**"] },
          { id: "infra", paths: ["src/infra/**"] },
        ],
        allowDependencies: [{ from: "infra", to: ["domain"] }],
        denyCycles: false,
      },
    });
    expect(result.dependencyViolations.length).toBeGreaterThan(0);
  });

  it("ignores unresolved (3rd-party) imports such as `import requests`", async () => {
    const root = await mkProject({
      "src/domain/order.py":
        "import requests  # external, not part of any module\n\ndef place(o):\n    requests.get('http://x')\n",
    });
    const result = await evaluateArchitectureRuntime({
      projectRoot: root,
      architecture: {
        id: "ddd-py",
        lang: "python",
        modules: [{ id: "domain", paths: ["src/domain/**"] }],
        allowDependencies: [],
        denyCycles: false,
      },
    });
    expect(result.dependencyViolations).toEqual([]);
  });
});
