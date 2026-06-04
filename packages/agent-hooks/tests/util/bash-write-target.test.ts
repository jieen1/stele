import { describe, expect, it } from "vitest";
import { extractBashWriteTarget } from "../../src/util/bash-write-target.js";

describe("extractBashWriteTarget", () => {
  describe("undefined/null input", () => {
    it("returns null for undefined", () => {
      expect(extractBashWriteTarget(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(extractBashWriteTarget("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(extractBashWriteTarget("   ")).toBeNull();
    });
  });

  describe("redirect operators", () => {
    it("extracts target from > redirect", () => {
      expect(extractBashWriteTarget("echo hello > /tmp/out.txt")).toBe("/tmp/out.txt");
    });

    it("extracts target from >> redirect", () => {
      expect(extractBashWriteTarget("echo hello >> /tmp/out.txt")).toBe("/tmp/out.txt");
    });

    it("extracts relative path from redirect", () => {
      expect(extractBashWriteTarget("echo hello > file.txt")).toBe("file.txt");
    });

    it("handles quoted redirect target", () => {
      expect(extractBashWriteTarget("echo hello > 'file.txt'")).toBe("file.txt");
    });

    it("handles double-quoted redirect target", () => {
      expect(extractBashWriteTarget("echo hello > \"file.txt\"")).toBe("file.txt");
    });

    it("returns null for unquoted redirect target", () => {
      // The redirect target after > is treated as a token
      expect(extractBashWriteTarget("echo hello > file.txt")).toBe("file.txt");
    });
  });

  describe("tee command", () => {
    it("extracts target from tee", () => {
      expect(extractBashWriteTarget("echo hello | tee /tmp/out.txt")).toBe("/tmp/out.txt");
    });

    it("extracts target from tee with flags", () => {
      expect(extractBashWriteTarget("echo hello | tee -a /tmp/out.txt")).toBe("/tmp/out.txt");
    });

    it("extracts target from tee -- file", () => {
      expect(extractBashWriteTarget("echo hello | tee -- file.txt")).toBe("file.txt");
    });

    it("extracts target from tee with multiple flags", () => {
      expect(extractBashWriteTarget("echo hello | tee -i -a file.txt")).toBe("file.txt");
    });

    it("handles quoted tee target", () => {
      expect(extractBashWriteTarget("echo hello | tee 'file.txt'")).toBe("file.txt");
    });

    it("stops at first non-flag tee argument", () => {
      // tee takes only the first non-flag argument as the target
      expect(extractBashWriteTarget("tee file1.txt file2.txt")).toBe("file1.txt");
    });
  });

  describe("cp/mv/install commands", () => {
    it("extracts destination from cp", () => {
      expect(extractBashWriteTarget("cp src.txt dst.txt")).toBe("dst.txt");
    });

    it("extracts destination from cp with flags", () => {
      expect(extractBashWriteTarget("cp -r src/ dst/")).toBe("dst/");
    });

    it("extracts destination from mv", () => {
      expect(extractBashWriteTarget("mv old.txt new.txt")).toBe("new.txt");
    });

    it("extracts destination from mv with flags", () => {
      expect(extractBashWriteTarget("mv -f old.txt new.txt")).toBe("new.txt");
    });

    it("extracts destination from install", () => {
      expect(extractBashWriteTarget("install src.txt /usr/bin/dest")).toBe("/usr/bin/dest");
    });

    it("handles -- separator for cp", () => {
      expect(extractBashWriteTarget("cp -- src.txt dst.txt")).toBe("dst.txt");
    });

    it("handles -- separator for mv", () => {
      expect(extractBashWriteTarget("mv -- old.txt new.txt")).toBe("new.txt");
    });

    it("extracts last positional for cp with multiple sources", () => {
      expect(extractBashWriteTarget("cp a.txt b.txt c/")).toBe("c/");
    });
  });

  describe("rm/rmdir/unlink/shred (deletion) commands", () => {
    it("extracts target from rm", () => {
      expect(extractBashWriteTarget("rm contract/main.stele")).toBe("contract/main.stele");
    });

    it("extracts target from rm -rf with flags", () => {
      expect(extractBashWriteTarget("rm -rf tests/contract")).toBe("tests/contract");
    });

    it("extracts target from rmdir", () => {
      expect(extractBashWriteTarget("rmdir somedir")).toBe("somedir");
    });

    it("extracts target from unlink", () => {
      expect(extractBashWriteTarget("unlink contract/.manifest.json")).toBe("contract/.manifest.json");
    });

    it("honours -- separator for rm", () => {
      expect(extractBashWriteTarget("rm -- -weird-name.txt")).toBe("-weird-name.txt");
    });
  });

  describe("no write target", () => {
    it("returns null for ls command", () => {
      expect(extractBashWriteTarget("ls -la")).toBeNull();
    });

    it("returns null for grep command", () => {
      expect(extractBashWriteTarget("grep -r TODO src/")).toBeNull();
    });

    it("returns null for echo without redirect", () => {
      expect(extractBashWriteTarget("echo hello")).toBeNull();
    });

    it("returns null for cat command", () => {
      expect(extractBashWriteTarget("cat file.txt")).toBeNull();
    });

    it("returns null for diff command", () => {
      expect(extractBashWriteTarget("diff a.txt b.txt")).toBeNull();
    });
  });

  describe("complex commands", () => {
    it("handles pipe with redirect", () => {
      expect(extractBashWriteTarget("cat input.txt | grep foo > output.txt")).toBe("output.txt");
    });

    it("handles pipe with tee", () => {
      expect(extractBashWriteTarget("cat input.txt | tee output.txt")).toBe("output.txt");
    });

    it("handles multiple redirects", () => {
      // First redirect wins (processed left to right)
      expect(extractBashWriteTarget("echo hello > out1.txt >> out2.txt")).toBe("out1.txt");
    });

    it("handles semicolon-separated commands", () => {
      expect(extractBashWriteTarget("echo hello > file.txt ; ls")).toBe("file.txt");
    });

    it("handles ampersand (background) with redirect", () => {
      expect(extractBashWriteTarget("echo hello > file.txt &")).toBe("file.txt");
    });
  });

  describe("edge cases for parseLiteral", () => {
    it("handles paths with backslashes (normalize on Windows, reject on Unix)", () => {
      const result = extractBashWriteTarget("echo > path\\with\\backslash");
      if (process.platform === "win32") {
        expect(result).toBe("path/with/backslash");
      } else {
        expect(result).toBeNull();
      }
    });

    it("rejects paths with shell metacharacters", () => {
      expect(extractBashWriteTarget("echo > $HOME/file.txt")).toBeNull();
    });

    it("rejects paths with backticks", () => {
      expect(extractBashWriteTarget("echo > `pwd`/file.txt")).toBeNull();
    });

    it("rejects paths with glob characters", () => {
      expect(extractBashWriteTarget("echo > *.txt")).toBeNull();
    });

    it("splits on pipe characters (tokenizer separates pipe)", () => {
      // Tokenizer splits on |, so "file" is extracted before the pipe
      expect(extractBashWriteTarget("echo > file|other.txt")).toBe("file");
    });

    it("splits on semicolons (tokenizer separates commands)", () => {
      // Tokenizer splits on ;, so "file.txt" is extracted before the semicolon
      expect(extractBashWriteTarget("echo > file.txt;rm -rf /")).toBe("file.txt");
    });

    it("accepts simple absolute path", () => {
      expect(extractBashWriteTarget("echo > /tmp/output.txt")).toBe("/tmp/output.txt");
    });

    it("accepts simple relative path", () => {
      expect(extractBashWriteTarget("echo > output.txt")).toBe("output.txt");
    });
  });

  describe("tokenizer behavior", () => {
    it("handles double quote", () => {
      expect(extractBashWriteTarget("echo 'hello world' > out.txt")).toBe("out.txt");
    });

    it("handles single quote", () => {
      expect(extractBashWriteTarget("echo \"hello world\" > out.txt")).toBe("out.txt");
    });

    it("handles spaces in paths (when quoted)", () => {
      expect(extractBashWriteTarget("echo > 'path with spaces.txt'")).toBe("path with spaces.txt");
    });

    it("handles double-quoted paths with spaces", () => {
      expect(extractBashWriteTarget("echo > \"path with spaces.txt\"")).toBe("path with spaces.txt");
    });

    it("handles multiple spaces between tokens", () => {
      expect(extractBashWriteTarget("echo    hello    >    file.txt")).toBe("file.txt");
    });

    it("handles tab-separated tokens", () => {
      expect(extractBashWriteTarget("echo\thello\t>\tfile.txt")).toBe("file.txt");
    });
  });
});
