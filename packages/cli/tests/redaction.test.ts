import { describe, expect, it } from "vitest";
import { redactPayload } from "../src/events/write-event.js";

// ---------------------------------------------------------------------------
// Top-level secret redaction
// ---------------------------------------------------------------------------

describe("redactPayload — top-level keys", () => {
  it("redacts 'password' key", () => {
    const result = redactPayload({ password: "REDACTED_TEST_PASSWORD_1" });
    expect(result.password).toBe("<redacted>");
  });

  it("redacts 'token' key", () => {
    const result = redactPayload({ token: "REDACTED_TEST_TOKEN_1" });
    expect(result.token).toBe("<redacted>");
  });

  it("redacts 'secret' key", () => {
    const result = redactPayload({ secret: "REDACTED_TEST_SECRET_1" });
    expect(result.secret).toBe("<redacted>");
  });

  it("redacts 'api_key' key", () => {
    const result = redactPayload({ api_key: "REDACTED_TEST_API_KEY_1" });
    expect(result.api_key).toBe("<redacted>");
  });

  it("redacts 'apikey' key", () => {
    const result = redactPayload({ apikey: "REDACTED_TEST_APIKEY_1" });
    expect(result.apikey).toBe("<redacted>");
  });

  it("redacts 'authorization' key", () => {
    const result = redactPayload({ authorization: "REDACTED_TEST_AUTH_1" });
    expect(result.authorization).toBe("<redacted>");
  });

  it("preserves non-secret keys", () => {
    const result = redactPayload({ name: "user", count: 42 });
    expect(result.name).toBe("user");
    expect(result.count).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Nested secret redaction
// ---------------------------------------------------------------------------

describe("redactPayload — nested objects", () => {
  it("redacts secrets in nested objects", () => {
    const result = redactPayload({
      config: {
        password: "REDACTED_NESTED_PASSWORD_1",
        host: "localhost",
      },
    });

    expect((result.config as Record<string, unknown>).password).toBe("<redacted>");
    expect((result.config as Record<string, unknown>).host).toBe("localhost");
  });

  it("redacts secrets in deeply nested structures", () => {
    const result = redactPayload({
      level1: {
        level2: {
          level3: {
            token: "REDACTED_DEEP_TOKEN_1",
            normal: "value",
          },
        },
      },
    });

    const l1 = result.level1 as Record<string, unknown>;
    const l2 = (l1.level2 as Record<string, unknown>);
    const l3 = l2.level3 as Record<string, unknown>;

    expect(l3.token).toBe("<redacted>");
    expect(l3.normal).toBe("value");
  });

  it("redacts secrets at multiple nesting levels", () => {
    const result = redactPayload({
      headers: {
        authorization: "REDACTED_MULTI_AUTH_1",
        host: "example.com",
      },
      password: "REDACTED_MULTI_PASSWORD_1",
    });

    expect((result.headers as Record<string, unknown>).authorization).toBe("<redacted>");
    expect((result.headers as Record<string, unknown>).host).toBe("example.com");
    expect(result.password).toBe("<redacted>");
  });
});

// ---------------------------------------------------------------------------
// Array redaction
// ---------------------------------------------------------------------------

describe("redactPayload — arrays", () => {
  it("redacts secrets in arrays of objects", () => {
    const result = redactPayload({
      items: [
        { name: "item1", secret: "REDACTED_ARRAY_SECRET_1" },
        { name: "item2", token: "REDACTED_ARRAY_TOKEN_1" },
      ],
    });

    const items = result.items as Array<Record<string, unknown>>;
    expect(items[0].secret).toBe("<redacted>");
    expect(items[0].name).toBe("item1");
    expect(items[1].token).toBe("<redacted>");
    expect(items[1].name).toBe("item2");
  });

  it("preserves arrays of primitives", () => {
    const result = redactPayload({
      ids: [1, 2, 3],
      names: ["a", "b", "c"],
    });

    expect(result.ids).toEqual([1, 2, 3]);
    expect(result.names).toEqual(["a", "b", "c"]);
  });

  it("handles empty arrays", () => {
    const result = redactPayload({
      password: "REDACTED_EMPTY_ARR_PASSWORD_1",
      items: [],
    });

    expect(result.password).toBe("<redacted>");
    expect(result.items).toEqual([]);
  });

  it("handles mixed array content", () => {
    const result = redactPayload({
      data: [
        { api_key: "REDACTED_MIXED_API_KEY_1" },
        42,
        "plain",
        { nested: { secret: "REDACTED_MIXED_SECRET_1" } },
      ],
    });

    const data = result.data as Array<unknown>;
    expect((data[0] as Record<string, unknown>).api_key).toBe("<redacted>");
    expect(data[1]).toBe(42);
    expect(data[2]).toBe("plain");

    const nested = (data[3] as Record<string, unknown>).nested as Record<string, unknown>;
    expect(nested.secret).toBe("<redacted>");
  });
});

// ---------------------------------------------------------------------------
// Word boundary — false positive prevention
// ---------------------------------------------------------------------------

describe("redactPayload — word boundaries", () => {
  it("does NOT redact compound keys that contain secret words", () => {
    const result = redactPayload({
      tokenized: "data",
      password_reset_url: "/reset",
      authorization_level: "admin",
      secret_key_length: 32,
      token_bucket: "redis",
      api_keys: ["a", "b"],
    });

    // These should NOT be redacted — the word boundary prevents matching
    expect(result.tokenized).toBe("data");
    expect(result.password_reset_url).toBe("/reset");
    expect(result.authorization_level).toBe("admin");
    expect(result.secret_key_length).toBe(32);
    expect(result.token_bucket).toBe("redis");
    expect(result.api_keys).toEqual(["a", "b"]);
  });

  it("DOES redact exact secret keys", () => {
    const result = redactPayload({
      password: "REDACTED_EXACT_PASSWORD_1",
      token: "REDACTED_EXACT_TOKEN_1",
      secret: "REDACTED_EXACT_SECRET_1",
      api_key: "REDACTED_EXACT_API_KEY_1",
      apikey: "REDACTED_EXACT_APIKEY_1",
      authorization: "REDACTED_EXACT_AUTH_1",
    });

    expect(result.password).toBe("<redacted>");
    expect(result.token).toBe("<redacted>");
    expect(result.secret).toBe("<redacted>");
    expect(result.api_key).toBe("<redacted>");
    expect(result.apikey).toBe("<redacted>");
    expect(result.authorization).toBe("<redacted>");
  });

  it("handles mixed exact and compound keys in same payload", () => {
    const result = redactPayload({
      password: "REDACTED_MIXED_PASSWORD_1",
      password_reset_url: "/reset",
      token: "REDACTED_MIXED_TOKEN_1",
      token_bucket: "redis",
      name: "user",
    });

    expect(result.password).toBe("<redacted>");
    expect(result.password_reset_url).toBe("/reset");
    expect(result.token).toBe("<redacted>");
    expect(result.token_bucket).toBe("redis");
    expect(result.name).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("redactPayload — edge cases", () => {
  it("handles empty payload", () => {
    const result = redactPayload({});
    expect(result).toEqual({});
  });

  it("handles payload with null values", () => {
    const result = redactPayload({
      password: "REDACTED_NULL_PASSWORD_1",
      nullable: null,
      missing: undefined,
    });

    expect(result.password).toBe("<redacted>");
    expect(result.nullable).toBeNull();
    expect(result.missing).toBeUndefined();
  });

  it("handles boolean and number values", () => {
    const result = redactPayload({
      count: 42,
      enabled: true,
      password: "REDACTED_BOOL_PASSWORD_1",
      ratio: 3.14,
    });

    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
    expect(result.password).toBe("<redacted>");
    expect(result.ratio).toBe(3.14);
  });

  it("handles Date-like objects (treated as plain objects)", () => {
    const result = redactPayload({
      created: { iso: "2026-01-01T00:00:00Z" },
      password: "REDACTED_DATE_PASSWORD_1",
    });

    expect((result.created as Record<string, unknown>).iso).toBe("2026-01-01T00:00:00Z");
    expect(result.password).toBe("<redacted>");
  });
});

// ---------------------------------------------------------------------------
// Integration: writeEvent redacts secrets on disk
// ---------------------------------------------------------------------------

describe("writeEvent — redaction on disk", () => {
  it("writes redacted secrets to JSONL", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createEvent, writeEvent } = await import("../src/events/write-event.js");

    const dir = await mkdtemp(join(tmpdir(), "stele-redact-test-"));

    try {
      const event = createEvent("violation-detected", dir, {
        headers: { authorization: "REDACTED_DISK_AUTH_1" },
        password: "REDACTED_DISK_PASSWORD_1",
        safe_key: "safe-value",
        nested: {
          config: {
            api_key: "REDACTED_DISK_API_KEY_1",
            host: "example.com",
          },
        },
      });

      await writeEvent(dir, event);

      const filePath = join(dir, ".stele", "events", `${new Date().toISOString().slice(0, 10)}.jsonl`);
      const content = await readFile(filePath, "utf8");
      const line = JSON.parse(content.split("\n")[0]);

      // Top-level secrets redacted
      expect(line.payload.password).toBe("<redacted>");

      // Nested secrets redacted
      expect((line.payload.headers as Record<string, unknown>).authorization).toBe("<redacted>");
      expect((line.payload.nested as Record<string, unknown>).config)
        .toHaveProperty("api_key", "<redacted>");

      // Non-secret values preserved
      expect(line.payload.safe_key).toBe("safe-value");
      expect((line.payload.nested as Record<string, unknown>).config)
        .toHaveProperty("host", "example.com");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
