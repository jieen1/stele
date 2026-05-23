import { describe, expect, it } from "vitest";

import {
  buildExternAliasRegistry,
  resolveExternPattern,
  type ExternAlias,
} from "../src/extern-alias.js";

const STRIPE: ExternAlias = {
  logicalName: "stripe",
  typescript: "stripe",
  python: "stripe",
  rust: "stripe-rust",
  java: "com.stripe:stripe-java",
  go: "github.com/stripe/stripe-go/v74",
};

const DJANGO_DB: ExternAlias = {
  logicalName: "django-db",
  python: "django.db",
};

const GORM: ExternAlias = {
  logicalName: "gorm",
  go: "gorm.io/gorm",
};

describe("buildExternAliasRegistry — lookup", () => {
  it("single alias, single language", () => {
    const r = buildExternAliasRegistry([DJANGO_DB]);
    expect(r.lookup("django-db", "python")).toBe("django.db");
    expect(r.lookup("django-db", "typescript")).toBeNull();
  });

  it("single alias, multiple languages", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(r.lookup("stripe", "typescript")).toBe("stripe");
    expect(r.lookup("stripe", "python")).toBe("stripe");
    expect(r.lookup("stripe", "go")).toBe("github.com/stripe/stripe-go/v74");
    expect(r.lookup("stripe", "java")).toBe("com.stripe:stripe-java");
    expect(r.lookup("stripe", "rust")).toBe("stripe-rust");
  });

  it("multiple aliases coexist", () => {
    const r = buildExternAliasRegistry([STRIPE, DJANGO_DB, GORM]);
    expect(r.lookup("stripe", "typescript")).toBe("stripe");
    expect(r.lookup("django-db", "python")).toBe("django.db");
    expect(r.lookup("gorm", "go")).toBe("gorm.io/gorm");
  });

  it("returns null for unknown logical name", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(r.lookup("paypal", "typescript")).toBeNull();
  });

  it("returns null when a known alias lacks the requested language", () => {
    const r = buildExternAliasRegistry([GORM]);
    expect(r.lookup("gorm", "typescript")).toBeNull();
    expect(r.lookup("gorm", "go")).toBe("gorm.io/gorm");
  });
});

describe("buildExternAliasRegistry — reverseLookup", () => {
  it("finds the logical name from a package name", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(r.reverseLookup("stripe", "typescript")).toBe("stripe");
    expect(r.reverseLookup("com.stripe:stripe-java", "java")).toBe("stripe");
    expect(r.reverseLookup("stripe-rust", "rust")).toBe("stripe");
  });

  it("returns null for unknown package name", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(r.reverseLookup("unknown", "typescript")).toBeNull();
  });

  it("returns null for a language with no entries", () => {
    const r = buildExternAliasRegistry([GORM]);
    expect(r.reverseLookup("gorm.io/gorm", "go")).toBe("gorm");
    expect(r.reverseLookup("gorm", "typescript")).toBeNull();
  });
});

describe("buildExternAliasRegistry — conflict policy", () => {
  it("throws on duplicate logical name", () => {
    expect(() =>
      buildExternAliasRegistry([STRIPE, { ...STRIPE, typescript: "stripe-v2" }]),
    ).toThrow(/duplicate logical-name/);
  });
});

describe("resolveExternPattern", () => {
  it("resolves to per-language form", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(
      resolveExternPattern("extern:stripe::Charges::create(2)", "java", r),
    ).toBe("extern:com.stripe:stripe-java::Charges::create(2)");
    expect(
      resolveExternPattern("extern:stripe::Charges::create(2)", "go", r),
    ).toBe("extern:github.com/stripe/stripe-go/v74::Charges::create(2)");
  });

  it("preserves the tail verbatim", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(
      resolveExternPattern("extern:stripe::*", "typescript", r),
    ).toBe("extern:stripe::*");
    expect(
      resolveExternPattern("extern:stripe::Charges::create(*)", "python", r),
    ).toBe("extern:stripe::Charges::create(*)");
  });

  it("returns null for non-extern pattern", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(
      resolveExternPattern("src/x.ts::C::m(0)", "typescript", r),
    ).toBeNull();
  });

  it("returns null for unknown logical name", () => {
    const r = buildExternAliasRegistry([STRIPE]);
    expect(
      resolveExternPattern("extern:paypal::Charges::create(2)", "typescript", r),
    ).toBeNull();
  });

  it("returns null when language has no mapping for the alias", () => {
    const r = buildExternAliasRegistry([GORM]);
    expect(
      resolveExternPattern("extern:gorm::DB::Where(1)", "typescript", r),
    ).toBeNull();
  });
});
