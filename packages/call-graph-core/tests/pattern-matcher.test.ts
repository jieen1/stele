import { describe, expect, it } from "vitest";

import {
  compilePattern,
  matchPattern,
} from "../src/pattern-matcher.js";

describe("matchPattern — exact and basic globs", () => {
  it("matches identical NodeId and pattern", () => {
    expect(
      matchPattern(
        "src/db/users.ts::Users::find(1)",
        "src/db/users.ts::Users::find(1)",
      ),
    ).toBe(true);
  });

  it("file glob matches deep paths", () => {
    expect(
      matchPattern("src/db/users.ts::Users::find(1)", "src/db/**::**::*"),
    ).toBe(true);
  });

  it("file glob does not match unrelated directories", () => {
    expect(
      matchPattern("src/services/x.ts::X::find(1)", "src/db/**::**::*"),
    ).toBe(false);
  });

  it("`**` left + container wildcard matches across files", () => {
    expect(
      matchPattern("src/x.ts::Repository::find(1)", "**::Repository::*"),
    ).toBe(true);
    expect(
      matchPattern("src/sub/dir/y.ts::Repository::find(1)", "**::Repository::*"),
    ).toBe(true);
  });

  it("rejects wrong container", () => {
    expect(
      matchPattern("src/x.ts::OtherClass::find(1)", "**::Repository::*"),
    ).toBe(false);
  });
});

describe("matchPattern — arity semantics", () => {
  it("arity (*) matches any arity", () => {
    expect(
      matchPattern("src/x.ts::Repository::find(1)", "**::Repository::find(*)"),
    ).toBe(true);
    expect(
      matchPattern("src/x.ts::Repository::find(2)", "**::Repository::find(*)"),
    ).toBe(true);
    expect(
      matchPattern("src/x.ts::Repository::find(0)", "**::Repository::find(*)"),
    ).toBe(true);
  });

  it("arity (2) matches only arity 2", () => {
    expect(
      matchPattern("src/x.ts::Repository::find(2)", "**::Repository::find(2)"),
    ).toBe(true);
    expect(
      matchPattern("src/x.ts::Repository::find(1)", "**::Repository::find(2)"),
    ).toBe(false);
    expect(
      matchPattern("src/x.ts::Repository::find(3)", "**::Repository::find(2)"),
    ).toBe(false);
  });

  it("omitting arity entirely matches any arity", () => {
    expect(
      matchPattern("src/x.ts::Repository::find(1)", "**::Repository::find"),
    ).toBe(true);
    expect(
      matchPattern("src/x.ts::Repository::find(5)", "**::Repository::find"),
    ).toBe(true);
  });
});

describe("matchPattern — disambiguator semantics", () => {
  it("pattern without disambiguator matches NodeId with one", () => {
    expect(
      matchPattern(
        "src/wallet.java::Wallet::debit(1)#a3f5b7c2",
        "**::Wallet::debit(1)",
      ),
    ).toBe(true);
  });

  it("pattern without disambiguator matches NodeId without one", () => {
    expect(
      matchPattern("src/wallet.java::Wallet::debit(1)", "**::Wallet::debit(1)"),
    ).toBe(true);
  });

  it("exact disambiguator matches that one only", () => {
    expect(
      matchPattern(
        "src/wallet.java::Wallet::debit(1)#a3f5b7c2",
        "**::Wallet::debit(1)#a3f5b7c2",
      ),
    ).toBe(true);
    expect(
      matchPattern(
        "src/wallet.java::Wallet::debit(1)#e2d8a4f9",
        "**::Wallet::debit(1)#a3f5b7c2",
      ),
    ).toBe(false);
  });

  it("pattern-specified disambiguator requires presence on NodeId", () => {
    expect(
      matchPattern(
        "src/wallet.java::Wallet::debit(1)",
        "**::Wallet::debit(1)#a3f5b7c2",
      ),
    ).toBe(false);
  });
});

describe("matchPattern — extern", () => {
  it("extern explicit form matches", () => {
    expect(
      matchPattern("extern:stripe::Charges::create(2)", "extern:stripe::*"),
    ).toBe(true);
  });

  it("extern shorthand matches", () => {
    expect(
      matchPattern("extern:stripe::Charges::create(2)", "stripe.*"),
    ).toBe(true);
  });

  it("extern shorthand requires extern NodeId", () => {
    expect(
      matchPattern("src/x.ts::Stripe::create(2)", "stripe.*"),
    ).toBe(false);
  });

  it("extern pattern does not match non-extern NodeId", () => {
    expect(
      matchPattern("src/charges.ts::Charges::create(2)", "extern:stripe::*"),
    ).toBe(false);
  });

  it("non-extern pattern does not match extern NodeId", () => {
    expect(
      matchPattern("extern:stripe::Charges::create(2)", "**::Charges::create(2)"),
    ).toBe(false);
  });

  it("extern wrong logical name rejected", () => {
    expect(
      matchPattern("extern:paypal::Charges::create(2)", "extern:stripe::*"),
    ).toBe(false);
  });

  it("extern with explicit container::symbol match", () => {
    expect(
      matchPattern(
        "extern:stripe::Charges::create(2)",
        "extern:stripe::Charges::create(2)",
      ),
    ).toBe(true);
    expect(
      matchPattern(
        "extern:stripe::Charges::list(0)",
        "extern:stripe::Charges::create(2)",
      ),
    ).toBe(false);
  });
});

describe("matchPattern — brace expansion (minimatch)", () => {
  it("matches multiple file extensions", () => {
    expect(matchPattern("src/x.ts::X::f(0)", "**/*.{ts,py}::**::*")).toBe(true);
    expect(matchPattern("src/x.py::X::f(0)", "**/*.{ts,py}::**::*")).toBe(true);
    expect(matchPattern("src/x.go::X::f(0)", "**/*.{ts,py}::**::*")).toBe(false);
  });

  it("restricts to services directory by glob", () => {
    expect(
      matchPattern("src/services/foo.ts::Service::f(0)", "**/services/*.ts::*::*"),
    ).toBe(true);
    expect(
      matchPattern("src/services/sub/foo.ts::Service::f(0)", "**/services/*.ts::*::*"),
    ).toBe(false);
  });
});

describe("matchPattern — container chain matching", () => {
  it("matches single-level container with literal name", () => {
    expect(
      matchPattern("src/x.ts::Repository::find(1)", "src/x.ts::Repository::find(1)"),
    ).toBe(true);
  });

  it("`**` in container chain absorbs nested containers", () => {
    expect(
      matchPattern(
        "src/x.ts::Outer::Inner::method(2)",
        "src/x.ts::**::Inner::method(2)",
      ),
    ).toBe(true);
    expect(
      matchPattern(
        "src/x.ts::Inner::method(2)",
        "src/x.ts::**::Inner::method(2)",
      ),
    ).toBe(true);
  });

  it("container glob `*` matches a single segment only", () => {
    expect(
      matchPattern(
        "src/x.ts::Outer::Inner::method(2)",
        "src/x.ts::*::Inner::method(2)",
      ),
    ).toBe(true);
    expect(
      matchPattern(
        "src/x.ts::Inner::method(2)",
        "src/x.ts::*::Inner::method(2)",
      ),
    ).toBe(false);
  });

  it("symbol glob matches by prefix", () => {
    expect(
      matchPattern("src/x.ts::Repository::findAll(0)", "**::Repository::find*"),
    ).toBe(true);
    expect(
      matchPattern("src/x.ts::Repository::insert(1)", "**::Repository::find*"),
    ).toBe(false);
  });
});

describe("matchPattern — negative cases", () => {
  it("rejects different file path", () => {
    expect(
      matchPattern("src/a.ts::C::m(0)", "src/b.ts::C::m(0)"),
    ).toBe(false);
  });

  it("rejects different symbol", () => {
    expect(matchPattern("src/x.ts::C::m(0)", "src/x.ts::C::n(0)")).toBe(false);
  });

  it("empty pattern does not match", () => {
    expect(matchPattern("src/x.ts::C::m(0)", "")).toBe(false);
  });

  it("malformed pattern does not match", () => {
    expect(matchPattern("src/x.ts::C::m(0)", "src/x.ts::C::m(notanumber)")).toBe(
      false,
    );
  });

  it("malformed NodeId does not match anything", () => {
    expect(matchPattern("garbage", "**::*::*")).toBe(false);
  });
});

describe("compilePattern", () => {
  it("returns a CompiledPattern that exposes source", () => {
    const c = compilePattern("**::Repository::find(2)");
    expect(c.source).toBe("**::Repository::find(2)");
    expect(c.matches("src/x.ts::Repository::find(2)")).toBe(true);
    expect(c.matches("src/x.ts::Repository::find(1)")).toBe(false);
  });

  it("caches identical patterns (referential equality)", () => {
    const a = compilePattern("**::X::y(0)");
    const b = compilePattern("**::X::y(0)");
    expect(a).toBe(b);
  });
});
