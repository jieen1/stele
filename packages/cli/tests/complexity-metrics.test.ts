import { describe, expect, it } from "vitest";
import {
  countSLOC,
  countPublicMethods,
  computeMaxCyclomaticComplexity,
  findClassByName,
} from "../src/complexity/typescript-metrics.js";
import * as ts from "typescript";

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "test.ts",
    source,
    ts.ScriptTarget.ES2022,
  );
}

function findClass(source: string, name: string): ts.ClassDeclaration {
  const sf = parseSource(source);
  const cls = findClassByName(sf, name);
  if (cls === undefined) throw new Error(`Class ${name} not found`);
  return cls;
}

// ----------------------------------------------------------------
// SLOC tests
// ----------------------------------------------------------------

describe("countSLOC", () => {
  it("counts non-blank, non-comment lines in a class body", () => {
    const source = `class Service {
  public foo(): void {}
  public bar(): void {}
  // this is a comment
  public baz(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countSLOC(source, cls)).toBe(3);
  });

  it("ignores blank lines", () => {
    const source = `class Service {
  public foo(): void {}

  public bar(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countSLOC(source, cls)).toBe(2);
  });

  it("ignores multi-line block comments", () => {
    const source = `class Service {
  /* comment block */
  public foo(): void {}
  /*
   * multi-line
   */
  public bar(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countSLOC(source, cls)).toBe(2);
  });

  it("ignores JSDoc comments", () => {
    const source = `class Service {
  /**
   * JSDoc comment
   */
  public foo(): void {}
}
`;
    const cls = findClass(source, "Service");
    const result = countSLOC(source, cls);
    expect(result).toBe(1);
  });

  it("handles a class with only comments", () => {
    const source = `class Service {
  // only comments
  /* also comments */
}
`;
    const cls = findClass(source, "Service");
    expect(countSLOC(source, cls)).toBe(0);
  });

  it("counts an empty class as 0", () => {
    const source = `class Empty {}`;
    const cls = findClass(source, "Empty");
    expect(countSLOC(source, cls)).toBe(0);
  });

  it("counts code on same line as closing brace of a block comment", () => {
    const source = `class Service {
  /* comment */ const x = 1;
}
`;
    const cls = findClass(source, "Service");
    expect(countSLOC(source, cls)).toBe(1);
  });
});

// ----------------------------------------------------------------
// Public Method Count tests
// ----------------------------------------------------------------

describe("countPublicMethods", () => {
  it("counts public methods only", () => {
    const source = `class Service {
  public foo(): void {}
  private bar(): void {}
  protected baz(): void {}
  public qux(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countPublicMethods(cls)).toBe(2);
  });

  it("counts methods without modifier as public", () => {
    const source = `class Service {
  foo(): void {}
  bar(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countPublicMethods(cls)).toBe(2);
  });

  it("includes getters and setters", () => {
    const source = `class Service {
  get value(): string { return "x"; }
  set value(v: string) {}
  public foo(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countPublicMethods(cls)).toBe(3);
  });

  it("excludes private getters", () => {
    const source = `class Service {
  private get internal(): string { return "x"; }
  public foo(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countPublicMethods(cls)).toBe(1);
  });

  it("returns 0 for a class with only private methods", () => {
    const source = `class Service {
  private only(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(countPublicMethods(cls)).toBe(0);
  });

  it("returns 0 for an empty class", () => {
    const source = `class Empty {}`;
    const cls = findClass(source, "Empty");
    expect(countPublicMethods(cls)).toBe(0);
  });
});

// ----------------------------------------------------------------
// Max Cyclomatic Complexity tests
// ----------------------------------------------------------------

describe("computeMaxCyclomaticComplexity", () => {
  it("returns 1 for a method with no branches", () => {
    const source = `class Service {
  public simple(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(1);
  });

  it("counts if as a decision point", () => {
    const source = `class Service {
  public method(x: boolean): void {
    if (x) {}
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(2);
  });

  it("counts if/else-if chains", () => {
    const source = `class Service {
  public method(x: number): string {
    if (x === 1) {
      return "one";
    } else if (x === 2) {
      return "two";
    } else if (x === 3) {
      return "three";
    }
    return "other";
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(4);
  });

  it("counts for loops", () => {
    const source = `class Service {
  public method(items: number[]): void {
    for (const item of items) {}
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(2);
  });

  it("counts while loops", () => {
    const source = `class Service {
  public method(n: number): void {
    while (n > 0) { n--; }
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(2);
  });

  it("counts catch clauses", () => {
    const source = `class Service {
  public method(): void {
    try {
      throw new Error();
    } catch (e) {}
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(2);
  });

  it("counts ternary operators", () => {
    const source = `class Service {
  public method(x: boolean): string {
    return x ? "yes" : "no";
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(2);
  });

  it("counts logical AND/OR operators", () => {
    const source = `class Service {
  public method(a: boolean, b: boolean): boolean {
    return a && b;
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(2);
  });

  it("counts multiple logical operators", () => {
    const source = `class Service {
  public method(a: boolean, b: boolean, c: boolean): boolean {
    return a || b && c;
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(3);
  });

  it("counts switch case clauses", () => {
    const source = `class Service {
  public method(x: number): string {
    switch (x) {
      case 1: return "one";
      case 2: return "two";
      default: return "other";
    }
  }
}
`;
    const cls = findClass(source, "Service");
    // 1 base + 2 case clauses = 3
    expect(computeMaxCyclomaticComplexity(cls)).toBe(3);
  });

  it("returns 0 for a class with no public methods", () => {
    const source = `class Service {
  private only(): void {}
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(0);
  });

  it("picks the max complexity across all public methods", () => {
    const source = `class Service {
  public simple(): void {}
  public complex(x: boolean, y: number): string {
    if (x) {
      if (y > 0) {
        return "both";
      } else {
        return "x only";
      }
    }
    return "none";
  }
}
`;
    const cls = findClass(source, "Service");
    // simple = 1, complex = 1 + 2 (two ifs) = 3
    expect(computeMaxCyclomaticComplexity(cls)).toBe(3);
  });

  it("counts do-while loops", () => {
    const source = `class Service {
  public method(n: number): void {
    do { n--; } while (n > 0);
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(2);
  });

  it("handles nested for/while loops", () => {
    const source = `class Service {
  public method(n: number): void {
    for (let i = 0; i < n; i++) {
      while (i > 0) { i--; }
    }
  }
}
`;
    const cls = findClass(source, "Service");
    expect(computeMaxCyclomaticComplexity(cls)).toBe(3);
  });
});

// ----------------------------------------------------------------
// findClassByName tests
// ----------------------------------------------------------------

describe("findClassByName", () => {
  it("finds a class by name", () => {
    const source = "export class PaymentService {}";
    const sf = parseSource(source);
    expect(findClassByName(sf, "PaymentService")).toBeDefined();
  });

  it("returns undefined for a non-existent class", () => {
    const source = "export class PaymentService {}";
    const sf = parseSource(source);
    expect(findClassByName(sf, "NonExistent")).toBeUndefined();
  });

  it("finds a class in nested scope", () => {
    const source = `
namespace Api {
  export class Service {}
}
`;
    const sf = parseSource(source);
    expect(findClassByName(sf, "Service")).toBeDefined();
  });
});
