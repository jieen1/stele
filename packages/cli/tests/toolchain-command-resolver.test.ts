import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseShellCommand } from "../src/toolchain/command-resolver.js";

// vi.mock is hoisted, so it runs before the module is imported.
vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  platform: vi.fn(),
}));

import * as fs from "node:fs";
import * as os from "node:os";

// Re-import after mocks are in place
import {
  resolveCommand,
  findLocalExecutable,
} from "../src/toolchain/command-resolver.js";

// ---------------------------------------------------------------------------
// parseShellCommand (no mocking needed — pure function)
// ---------------------------------------------------------------------------

describe("parseShellCommand", () => {
  it("splits command and simple args", () => {
    const result = parseShellCommand("tsc --noEmit --pretty false");
    expect(result.command).toBe("tsc");
    expect(result.args).toEqual(["--noEmit", "--pretty", "false"]);
  });

  it("splits command with no args", () => {
    const result = parseShellCommand("eslint");
    expect(result.command).toBe("eslint");
    expect(result.args).toEqual([]);
  });

  it("preserves double-quoted arguments", () => {
    const result = parseShellCommand('eslint "src/**/*.ts" --format json');
    expect(result.command).toBe("eslint");
    expect(result.args).toEqual(["src/**/*.ts", "--format", "json"]);
  });

  it("preserves single-quoted arguments", () => {
    const result = parseShellCommand("tsc 'src/index.ts'");
    expect(result.command).toBe("tsc");
    expect(result.args).toEqual(["src/index.ts"]);
  });

  it("handles spaces inside quoted arguments", () => {
    const result = parseShellCommand('cmd "arg with spaces"');
    expect(result.command).toBe("cmd");
    expect(result.args).toEqual(["arg with spaces"]);
  });

  it("handles escaped characters", () => {
    const result = parseShellCommand('cmd arg\\ with\\ spaces');
    expect(result.command).toBe("cmd");
    expect(result.args).toEqual(["arg with spaces"]);
  });

  it("handles multiple spaces between args", () => {
    const result = parseShellCommand("cmd  arg1   arg2");
    expect(result.command).toBe("cmd");
    expect(result.args).toEqual(["arg1", "arg2"]);
  });
});

// ---------------------------------------------------------------------------
// findLocalExecutable
// ---------------------------------------------------------------------------

describe("findLocalExecutable", () => {
  const reset = () => {
    (fs.accessSync as any).mockReset();
    (os.platform as any).mockReset();
  };

  beforeEach(reset);

  it("finds tsc in node_modules/.bin on Unix", () => {
    (os.platform as any).mockReturnValue("linux");
    (fs.accessSync as any).mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized.includes("node_modules/.bin/tsc")) return;
      throw new Error("ENOENT");
    });

    const result = findLocalExecutable("tsc", "/project");
    expect(result).toBeDefined();
    expect(result!.replace(/\\/g, "/")).toMatch(/node_modules\/\.bin\/tsc$/);
  });

  it("finds eslint in node_modules/.bin on Unix", () => {
    (os.platform as any).mockReturnValue("linux");
    (fs.accessSync as any).mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized.includes("node_modules/.bin/eslint")) return;
      throw new Error("ENOENT");
    });

    const result = findLocalExecutable("eslint", "/project");
    expect(result).toBeDefined();
    expect(result!.replace(/\\/g, "/")).toMatch(/node_modules\/\.bin\/eslint$/);
  });

  it("finds .cmd suffix on Windows", () => {
    (os.platform as any).mockReturnValue("win32");
    (fs.accessSync as any).mockImplementation((path: string) => {
      if (path.includes("node_modules") && path.includes("tsc.cmd")) return;
      throw new Error("ENOENT");
    });

    const result = findLocalExecutable("tsc", "C:\\project");
    expect(result).toMatch(/node_modules[\\/]\.bin[\\/]tsc\.cmd$/);
  });

  it("returns undefined when executable not found", () => {
    (os.platform as any).mockReturnValue("linux");
    (fs.accessSync as any).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = findLocalExecutable("nonexistent", "/project");
    expect(result).toBeUndefined();
  });

  it("walks up directories to find node_modules (monorepo)", () => {
    (os.platform as any).mockReturnValue("linux");
    // The walk-up visits /project/packages/cli, /project/packages, /project, /
    // We want to match the tsc found at the root level's node_modules/.bin/tsc.
    // On Windows, path.join produces backslashes, so we normalize.
    (fs.accessSync as any).mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, "/");
      // Match any node_modules/.bin/tsc at a root-ish level (not deep in project/packages)
      if (/\/node_modules\/\.bin\/tsc$/.test(normalized) && !normalized.includes("packages/cli") && !normalized.includes("packages/")) {
        return;
      }
      throw new Error("ENOENT");
    });

    const result = findLocalExecutable("tsc", "/project/packages/cli");
    expect(result).toBeDefined();
  });

  it("finds .bat suffix on Windows", () => {
    (os.platform as any).mockReturnValue("win32");
    (fs.accessSync as any).mockImplementation((path: string) => {
      if (path.includes("eslint.bat")) return;
      throw new Error("ENOENT");
    });

    const result = findLocalExecutable("eslint", "C:\\project");
    expect(result).toMatch(/node_modules[\\/]\.bin[\\/]eslint\.bat$/);
  });
});

// ---------------------------------------------------------------------------
// resolveCommand
// ---------------------------------------------------------------------------

describe("resolveCommand", () => {
  const reset = () => {
    (fs.accessSync as any).mockReset();
    (fs.existsSync as any).mockReset();
    (os.platform as any).mockReset();
  };

  beforeEach(() => {
    reset();
    // Default: no lockfiles, no PATH commands available
    (fs.existsSync as any).mockReturnValue(false);
    (fs.accessSync as any).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  it("resolves 'tsc --noEmit' to local tsc when found", () => {
    (os.platform as any).mockReturnValue("linux");
    (fs.accessSync as any).mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized.includes("node_modules/.bin/tsc")) return;
      throw new Error("ENOENT");
    });

    const result = resolveCommand("tsc --noEmit --pretty false", "/project");
    expect(result.command.replace(/\\/g, "/")).toMatch(/node_modules\/\.bin\/tsc$/);
    expect(result.args).toEqual(["--noEmit", "--pretty", "false"]);
  });

  it("resolves 'eslint' to local eslint when found", () => {
    (os.platform as any).mockReturnValue("linux");
    (fs.accessSync as any).mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized.includes("node_modules/.bin/eslint")) return;
      throw new Error("ENOENT");
    });

    const result = resolveCommand("eslint", "/project");
    expect(result.command.replace(/\\/g, "/")).toMatch(/node_modules\/\.bin\/eslint$/);
    expect(result.args).toEqual([]);
  });

  it("falls back to original command when not found locally or via package manager", () => {
    (os.platform as any).mockReturnValue("linux");
    // No local exe, no lockfile, no PATH commands
    (fs.accessSync as any).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    (fs.existsSync as any).mockReturnValue(false);

    const result = resolveCommand("tsc --noEmit", "/project");
    expect(result.command).toBe("tsc");
    expect(result.args).toEqual(["--noEmit"]);
  });

  it("uses pnpm exec when lockfile matches and local exe not found", () => {
    (os.platform as any).mockReturnValue("linux");
    // No local executable, but pnpm is on PATH
    (fs.accessSync as any).mockImplementation((path: string) => {
      if (path.includes("pnpm")) return;
      throw new Error("ENOENT");
    });
    // pnpm-lock.yaml exists
    (fs.existsSync as any).mockImplementation((path: string) => {
      return path.includes("pnpm-lock.yaml");
    });

    const result = resolveCommand("tsc --noEmit", "/project");
    expect(result.command).toBe("pnpm");
    expect(result.args).toContain("exec");
    expect(result.args).toContain("tsc");
  });

  it("uses npm exec when package-lock.json exists", () => {
    (os.platform as any).mockReturnValue("linux");
    // No local executable, but npm is on PATH
    (fs.accessSync as any).mockImplementation((path: string) => {
      if (path.includes("npm")) return;
      throw new Error("ENOENT");
    });
    // package-lock.json exists, but NOT pnpm-lock.yaml
    (fs.existsSync as any).mockImplementation((path: string) => {
      return path.includes("package-lock.json");
    });

    const result = resolveCommand("eslint --fix", "/project");
    expect(result.command).toBe("npm");
    expect(result.args).toContain("exec");
    expect(result.args).toContain("eslint");
  });

  it("preserves quoted arguments through resolveCommand", () => {
    (os.platform as any).mockReturnValue("linux");
    // No local executable, no fallback
    (fs.accessSync as any).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    (fs.existsSync as any).mockReturnValue(false);

    const result = resolveCommand('eslint "src/**/*.ts" --format json', "/project");
    expect(result.command).toBe("eslint");
    expect(result.args).toEqual(["src/**/*.ts", "--format", "json"]);
  });

  it("handles Windows .cmd resolution with resolveCommand", () => {
    (os.platform as any).mockReturnValue("win32");
    (fs.accessSync as any).mockImplementation((path: string) => {
      if (path.includes("node_modules") && path.includes("tsc.cmd")) return;
      throw new Error("ENOENT");
    });
    (fs.existsSync as any).mockReturnValue(false);

    const result = resolveCommand("tsc --noEmit", "C:\\project");
    expect(result.command.replace(/\\/g, "/")).toMatch(/node_modules\/\.bin\/tsc\.cmd$/);
    expect(result.args).toEqual(["--noEmit"]);
  });
});
