import { describe, expect, test } from "vitest";
import { translateExpression, sanitizeRustIdentifier, astToSource, generateRustSource } from "../src/translator.js";
import type { AstNode } from "@stele/core";

// ---------------------------------------------------------------------------
// Helper: build minimal AST nodes for testing
// ---------------------------------------------------------------------------

function makeSpan(file = "test.cdl"): import("@stele/core").SourceSpan {
    return { file, line: 1, column: 0 };
}

function num(value: number, raw = `${value}`): AstNode {
    return { kind: "number", value, raw, span: makeSpan() };
}

function str(value: string): AstNode {
    return { kind: "string", value, span: makeSpan() };
}

function ident(value: string): AstNode {
    return { kind: "identifier", value, span: makeSpan() };
}

function keyword(value: string): AstNode {
    return { kind: "keyword", value, span: makeSpan() };
}

function list(head: string, items: AstNode[]): AstNode {
    return { kind: "list", head, items, span: makeSpan() };
}

// ---------------------------------------------------------------------------
// Literal translation tests
// ---------------------------------------------------------------------------

describe("translateExpression — literals", () => {
    test("integer literal", () => {
        expect(translateExpression(num(42))).toBe("SteleValue::Int(42)");
    });

    test("float literal", () => {
        expect(translateExpression(num(3.14, "3.14"))).toBe("SteleValue::Float(SteleFloat(3.14))");
    });

    test("string literal", () => {
        expect(translateExpression(str("hello"))).toBe('SteleValue::Str(String::from("hello"))');
    });

    test("boolean true", () => {
        expect(translateExpression(ident("true"))).toBe("true");
    });

    test("boolean false", () => {
        expect(translateExpression(ident("false"))).toBe("false");
    });

    test("null literal", () => {
        expect(translateExpression(ident("null"))).toBe("SteleValue::Null");
    });

    test("none literal maps to SteleValue::Null", () => {
        expect(translateExpression(ident("none"))).toBe("SteleValue::Null");
    });
});

// ---------------------------------------------------------------------------
// Path operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — path operator", () => {
    test("single segment path", () => {
        const expr = list("path", [ident("accounts")]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_get_path");
        expect(result).toContain("accounts");
    });

    test("multi segment path", () => {
        const expr = list("path", [ident("account"), ident("balance")]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_get_path");
        expect(result).toContain("account");
        expect(result).toContain("balance");
    });

    test("keyword segment path", () => {
        const expr = list("path", [keyword("type"), ident("id")]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_get_path");
    });
});

// ---------------------------------------------------------------------------
// Comparison operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — comparison operators", () => {
    test("eq operator", () => {
        const expr = list("eq", [num(1), num(2)]);
        expect(translateExpression(expr)).toContain("stele_eq");
    });

    test("neq operator", () => {
        const expr = list("neq", [num(1), num(2)]);
        expect(translateExpression(expr)).toContain("stele_neq");
    });

    test("gt operator", () => {
        const expr = list("gt", [num(10), num(5)]);
        expect(translateExpression(expr)).toContain("stele_gt");
    });

    test("lte operator", () => {
        const expr = list("lte", [num(3), num(10)]);
        expect(translateExpression(expr)).toContain("stele_lte");
    });
});

// ---------------------------------------------------------------------------
// Logic operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — logic operators", () => {
    test("and operator joins with &&", () => {
        const expr = list("and", [num(1), num(2)]);
        const result = translateExpression(expr);
        expect(result).toContain("&&");
    });

    test("or operator joins with ||", () => {
        const expr = list("or", [num(1), num(2)]);
        const result = translateExpression(expr);
        expect(result).toContain("||");
    });

    test("not operator wraps with !", () => {
        const expr = list("not", [num(1)]);
        const result = translateExpression(expr);
        expect(result).toMatch(/^!/);
    });
});

// ---------------------------------------------------------------------------
// Arithmetic operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — arithmetic operators", () => {
    test("add operator", () => {
        const expr = list("add", [num(1), num(2)]);
        expect(translateExpression(expr)).toContain("stele_add");
    });

    test("sub operator", () => {
        const expr = list("sub", [num(10), num(3)]);
        expect(translateExpression(expr)).toContain("stele_sub");
    });

    test("mul operator", () => {
        const expr = list("mul", [num(2), num(3)]);
        expect(translateExpression(expr)).toContain("stele_mul");
    });

    test("neg operator", () => {
        const expr = list("neg", [num(5)]);
        expect(translateExpression(expr)).toContain("stele_neg");
    });

    test("abs operator", () => {
        const expr = list("abs", [num(-5)]);
        expect(translateExpression(expr)).toContain("stele_abs");
    });

    test("mod operator", () => {
        const expr = list("mod", [num(10), num(3)]);
        expect(translateExpression(expr)).toContain("stele_mod");
    });
});

// ---------------------------------------------------------------------------
// Aggregate operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — aggregate operators", () => {
    test("count operator", () => {
        const expr = list("count", [list("path", [ident("items")])]);
        expect(translateExpression(expr)).toContain("stele_count");
    });

    test("is-empty operator", () => {
        const expr = list("is-empty", [list("path", [ident("items")])]);
        expect(translateExpression(expr)).toContain("stele_is_empty");
    });

    test("sum with projection", () => {
        const expr = list("sum", [list("path", [ident("items")]), list("path", [ident("amount")])]);
        expect(translateExpression(expr)).toContain("stele_sum");
    });
});

// ---------------------------------------------------------------------------
// String operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — string operators", () => {
    test("contains operator", () => {
        const expr = list("contains", [str("hello world"), str("world")]);
        expect(translateExpression(expr)).toContain("stele_contains");
    });

    test("starts-with operator", () => {
        const expr = list("starts-with", [str("hello"), str("he")]);
        expect(translateExpression(expr)).toContain("stele_starts_with");
    });

    test("trim operator", () => {
        const expr = list("trim", [str(" hello ")]);
        expect(translateExpression(expr)).toContain("stele_trim");
    });
});

// ---------------------------------------------------------------------------
// Quantifier operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — quantifier operators", () => {
    test("forall operator includes binding", () => {
        const expr = list("forall", [
            ident("item"),
            list("path", [ident("items")]),
            list("gt", [list("path", [ident("value")]), num(0)]),
        ]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_forall");
    });

    test("exists operator includes binding", () => {
        const expr = list("exists", [
            ident("x"),
            list("path", [ident("items")]),
            list("eq", [list("path", [ident("x")]), num(1)]),
        ]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_exists");
    });
});

// ---------------------------------------------------------------------------
// Identifier sanitization tests
// ---------------------------------------------------------------------------

describe("sanitizeRustIdentifier", () => {
    test("kebab-case converts to snake_case", () => {
        expect(sanitizeRustIdentifier("my-invariant")).toBe("my_invariant");
    });

    test("simple identifier passes through", () => {
        expect(sanitizeRustIdentifier("balance")).toBe("balance");
    });

    test("empty string uses fallback", () => {
        expect(sanitizeRustIdentifier("")).toBe("value");
    });

    test("special characters replaced", () => {
        expect(sanitizeRustIdentifier("foo-bar.baz")).toBe("foo_bar_baz");
    });

    test("leading digit prefixed", () => {
        expect(sanitizeRustIdentifier("123abc")).toBe("value_123abc");
    });
});

// ---------------------------------------------------------------------------
// astToSource tests
// ---------------------------------------------------------------------------

describe("astToSource", () => {
    test("number node", () => {
        expect(astToSource(num(42))).toBe("42");
    });

    test("string node", () => {
        expect(astToSource(str("hello"))).toBe('"hello"');
    });

    test("list node", () => {
        const node = list("eq", [num(1), num(2)]);
        expect(astToSource(node)).toBe("(eq 1 2)");
    });

    test("nested list node", () => {
        const node = list("and", [
            list("eq", [num(1), num(2)]),
            list("gt", [num(3), num(4)]),
        ]);
        expect(astToSource(node)).toBe("(and (eq 1 2) (gt 3 4))");
    });
});

// ---------------------------------------------------------------------------
// Temporal operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — temporal operators", () => {
    test("modified operator", () => {
        const expr = list("modified", [list("path", [ident("account"), ident("balance")])]);
        expect(translateExpression(expr)).toContain("stele_is_modified");
    });

    test("state-before operator", () => {
        const expr = list("state-before", []);
        expect(translateExpression(expr)).toContain("stele_state_before");
    });

    test("state-after operator", () => {
        const expr = list("state-after", []);
        expect(translateExpression(expr)).toContain("stele_state_after");
    });

    test("within operator", () => {
        const expr = list("within", [num(1700000000, "1700000000"), num(30)]);
        expect(translateExpression(expr)).toContain("stele_within");
    });

    test("before operator", () => {
        const expr = list("before", [num(100), num(200)]);
        expect(translateExpression(expr)).toContain("stele_before");
    });

    test("after operator", () => {
        const expr = list("after", [num(200), num(100)]);
        expect(translateExpression(expr)).toContain("stele_after");
    });
});

// ---------------------------------------------------------------------------
// Logic operator tests (extended: when, if, implies, iff)
// ---------------------------------------------------------------------------

describe("translateExpression — logic operators (extended)", () => {
    test("when operator renders as !cond || body", () => {
        const expr = list("when", [num(1), num(2)]);
        const result = translateExpression(expr);
        expect(result).toContain("||");
    });

    test("if operator", () => {
        const expr = list("if", [num(1), num(2), num(3)]);
        const result = translateExpression(expr);
        expect(result).toContain("if");
    });

    test("implies operator renders as !a || b", () => {
        const expr = list("implies", [num(1), num(2)]);
        const result = translateExpression(expr);
        expect(result).toContain("||");
    });

    test("iff operator renders as a == b", () => {
        const expr = list("iff", [num(1), num(2)]);
        const result = translateExpression(expr);
        expect(result).toContain("==");
    });
});

// ---------------------------------------------------------------------------
// Collection operator tests (EP04)
// ---------------------------------------------------------------------------

describe("translateExpression — collection operators (EP04)", () => {
    test("length operator", () => {
        const expr = list("length", [list("path", [ident("items")])]);
        expect(translateExpression(expr)).toContain("stele_length");
    });

    test("concat operator", () => {
        const expr = list("concat", [list("path", [ident("a")]), list("path", [ident("b")])]);
        expect(translateExpression(expr)).toContain("stele_concat");
    });

    test("sort-by operator", () => {
        const expr = list("sort-by", [list("path", [ident("items")]), list("path", [ident("price")])]);
        expect(translateExpression(expr)).toContain("stele_sort_by(");
    });

    test("sort-by-desc operator", () => {
        const expr = list("sort-by-desc", [list("path", [ident("items")]), list("path", [ident("price")])]);
        expect(translateExpression(expr)).toContain("stele_sort_by_desc");
    });

    test("map operator", () => {
        const expr = list("map", [list("path", [ident("items")]), list("path", [ident("name")])]);
        expect(translateExpression(expr)).toContain("stele_map");
    });

    test("first operator", () => {
        const expr = list("first", [list("path", [ident("items")])]);
        expect(translateExpression(expr)).toContain("stele_first");
    });

    test("last operator", () => {
        const expr = list("last", [list("path", [ident("items")])]);
        expect(translateExpression(expr)).toContain("stele_last");
    });

    test("has-length operator", () => {
        const expr = list("has-length", [list("path", [ident("items")]), num(3)]);
        expect(translateExpression(expr)).toContain("stele_has_length");
    });

    test("exists-in operator", () => {
        const expr = list("exists-in", [num(5), list("path", [ident("ids")])]);
        expect(translateExpression(expr)).toContain("stele_exists_in");
    });

    test("unique operator", () => {
        const expr = list("unique", [list("path", [ident("items")]), list("path", [ident("id")])]);
        expect(translateExpression(expr)).toContain("stele_unique");
    });

    test("avg operator", () => {
        const expr = list("avg", [list("path", [ident("items")]), list("path", [ident("score")])]);
        expect(translateExpression(expr)).toContain("stele_avg");
    });

    test("min operator", () => {
        const expr = list("min", [list("path", [ident("items")]), list("path", [ident("score")])]);
        expect(translateExpression(expr)).toContain("stele_min");
    });

    test("max operator", () => {
        const expr = list("max", [list("path", [ident("items")]), list("path", [ident("score")])]);
        expect(translateExpression(expr)).toContain("stele_max");
    });

    test("distinct operator", () => {
        const expr = list("distinct", [list("path", [ident("items")]), list("path", [ident("tag")])]);
        expect(translateExpression(expr)).toContain("stele_distinct");
    });
});

// ---------------------------------------------------------------------------
// Arithmetic operator tests (extended: div, pow, round, ceil, floor)
// ---------------------------------------------------------------------------

describe("translateExpression — arithmetic operators (extended)", () => {
    test("div operator", () => {
        const expr = list("div", [num(10), num(2)]);
        expect(translateExpression(expr)).toContain("stele_div");
    });

    test("pow operator", () => {
        const expr = list("pow", [num(2), num(3)]);
        expect(translateExpression(expr)).toContain("stele_pow");
    });

    test("round operator", () => {
        const expr = list("round", [num(3.7, "3.7")]);
        expect(translateExpression(expr)).toContain("stele_round");
    });

    test("ceil operator", () => {
        const expr = list("ceil", [num(3.2, "3.2")]);
        expect(translateExpression(expr)).toContain("stele_ceil");
    });

    test("floor operator", () => {
        const expr = list("floor", [num(3.9, "3.9")]);
        expect(translateExpression(expr)).toContain("stele_floor");
    });
});

// ---------------------------------------------------------------------------
// String operator tests (extended: ends-with, lower, upper, split, join)
// ---------------------------------------------------------------------------

describe("translateExpression — string operators (extended)", () => {
    test("ends-with operator", () => {
        const expr = list("ends-with", [str("hello"), str("lo")]);
        expect(translateExpression(expr)).toContain("stele_ends_with");
    });

    test("lower operator", () => {
        const expr = list("lower", [str("HELLO")]);
        expect(translateExpression(expr)).toContain("stele_lower");
    });

    test("upper operator", () => {
        const expr = list("upper", [str("hello")]);
        expect(translateExpression(expr)).toContain("stele_upper");
    });

    test("split operator", () => {
        const expr = list("split", [str("a,b,c"), str(",")]);
        expect(translateExpression(expr)).toContain("stele_split");
    });

    test("join operator", () => {
        const expr = list("join", [list("path", [ident("parts")]), str(",")]);
        expect(translateExpression(expr)).toContain("stele_join");
    });
});

// ---------------------------------------------------------------------------
// Quantifier operator tests (extended: none)
// ---------------------------------------------------------------------------

describe("translateExpression — quantifier operators (extended)", () => {
    test("none operator includes binding", () => {
        const expr = list("none", [
            ident("item"),
            list("path", [ident("items")]),
            list("eq", [list("path", [ident("item")]), num(0)]),
        ]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_none");
    });
});

// ---------------------------------------------------------------------------
// Control operator tests (not-null, between, approx-eq, type-of)
// ---------------------------------------------------------------------------

describe("translateExpression — control operators", () => {
    test("not-null operator", () => {
        const expr = list("not-null", [list("path", [ident("name")])]);
        expect(translateExpression(expr)).toContain("stele_not_null");
    });

    test("between operator", () => {
        const expr = list("between", [num(5), num(0), num(10)]);
        expect(translateExpression(expr)).toContain("stele_between");
    });

    test("approx-eq operator", () => {
        const expr = list("approx-eq", [num(3.14, "3.14"), num(3.141, "3.141"), num(0.01, "0.01")]);
        expect(translateExpression(expr)).toContain("stele_approx_eq");
    });

    test("type-of operator", () => {
        const expr = list("type-of", [list("path", [ident("value")])]);
        expect(translateExpression(expr)).toContain("stele_type_of");
    });
});

// ---------------------------------------------------------------------------
// translateExpression: field operator
// ---------------------------------------------------------------------------

describe("translateExpression — field operator", () => {
    test("extends a single-segment path", () => {
        const pathNode = list("path", [ident("account")]);
        const expr = list("field", [pathNode, ident("cash")]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_get_path");
        expect(result).toContain("account");
        expect(result).toContain("cash");
    });

    test("extends a multi-segment path", () => {
        const pathNode = list("path", [ident("account"), ident("details")]);
        const expr = list("field", [pathNode, ident("balance")]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_get_path");
        expect(result).toContain("account");
        expect(result).toContain("details");
        expect(result).toContain("balance");
    });

    // @tcb-negative @stele/backend-rust
    test("throws when first argument is not a path", () => {
        const expr = list("field", [ident("account"), ident("cash")]);
        expect(() => translateExpression(expr)).toThrow('Operator "field" expects its first argument to be a path expression.');
    });

    test("throws when wrong number of operands", () => {
        const expr = list("field", [list("path", [ident("account")])]);
        expect(() => translateExpression(expr)).toThrow('Operator "field" expects a path and a field name.');
    });
});

// ---------------------------------------------------------------------------
// translateExpression: in operator
// ---------------------------------------------------------------------------

describe("translateExpression — in operator", () => {
    test("translates in as membership check", () => {
        const expr = list("in", [num(5), list("path", [ident("ids")])]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_exists_in");
    });

    test("translates in with path value and path collection", () => {
        const expr = list("in", [list("path", [ident("name")]), list("path", [ident("names")])]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_exists_in");
        expect(result).toContain("name");
        expect(result).toContain("names");
    });

    test("throws when wrong number of operands", () => {
        const expr = list("in", [num(5)]);
        expect(() => translateExpression(expr)).toThrow('Operator "in" expects two operands');
    });
});

// ---------------------------------------------------------------------------
// json-path operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — json-path operator", () => {
    test("translates json-path as stele_json_path call", () => {
        const expr = list("json-path", [list("path", [ident("data")]), str("accounts.balance")]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_json_path");
        expect(result).toContain("accounts.balance");
    });
});

// ---------------------------------------------------------------------------
// decimal-eq operator tests
// ---------------------------------------------------------------------------

describe("translateExpression — decimal-eq operator", () => {
    test("translates decimal-eq as stele_decimal_eq call", () => {
        const expr = list("decimal-eq", [list("path", [ident("amount")]), num(1234.56)]);
        const result = translateExpression(expr);
        expect(result).toContain("stele_decimal_eq");
    });
});

// ---------------------------------------------------------------------------
// generateRustSource integration
// ---------------------------------------------------------------------------

describe("generateRustSource", () => {
    function makeContract(
        invariants: import("@stele/core").InvariantDeclaration[],
    ): import("@stele/core").Contract {
        return {
            rootPath: "/test",
            files: [],
            metadata: [],
            imports: [],
            operators: [],
            checkers: [],
            scenarios: [],
            groups: [],
            invariants,
            codeShapes: [],
            architectures: [],
            coreNodes: [],
            brandedIds: [],
            tracePolicies: [],
            typeStates: [],
            typeStateBindings: [],
            effectDeclarations: [],
            effectAnnotations: [],
            effectPolicies: [],
            effectSuppressions: [],
          externAliases: [],

        };
    }

    test("emits #[path] header for runtime", () => {
        const invariant = {
            kind: "invariant" as const,
            filePath: "test.cdl",
            node: list("invariant", []) as any,
            span: makeSpan(),
            id: "test-inv",
            severity: "error",
            description: "test",
            assertExpression: list("eq", [num(1), num(1)]),
            dependsOn: [],
        };
        const source = generateRustSource(makeContract([invariant]));
        expect(source).toContain('#[path = "_stele_runtime.rs"]');
        expect(source).toContain("mod _stele_runtime;");
    });

    test("emits #[test] fn for each invariant", () => {
        const invariant = {
            kind: "invariant" as const,
            filePath: "test.cdl",
            node: list("invariant", []) as any,
            span: makeSpan(),
            id: "balance-positive",
            severity: "error",
            description: "balance must be positive",
            assertExpression: list("gt", [list("path", [ident("balance")]), num(0)]),
            dependsOn: [],
        };
        const source = generateRustSource(makeContract([invariant]));
        expect(source).toContain("#[test]");
        expect(source).toContain("fn test_");
    });
});
