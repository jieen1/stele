# Java 后端详细设计

> PRD: [prd-phase-2.md](../../prd-phase-2.md) | 估算: 4-6 周 | 类别: 新后端（关键路径）
> 参照: [EP01 TypeScript](../phase-1/01-typescript-backend.md) | [EP10 Go](../phase-2/10-go-backend.md) | [Rust](./rust-backend.md)

## 1. 目标

把 CDL 翻译到 JUnit 5（默认）/ TestNG（可选）测试代码。完整复刻 Python + TypeScript + Go + Rust backend 的语义与 runtime helpers，含 scenario / checker / failure_witness。

## 2. 公开 API

### 2.1 包导出

`packages/backend-java/src/index.ts`：

```typescript
import type { LanguageBackend, GenerationConfig, GeneratedFile, Contract } from "@stele/core";

const backend: LanguageBackend = {
  name: "java",
  framework: "junit5",  // 默认；可被 testFramework: "testng" 覆盖
  fileExtension: ".java",
  version: "0.1.0",
  generate(contract: Contract, config: GenerationConfig): GeneratedFile[] { /* ... */ },
  supportFiles(contract: Contract, config: GenerationConfig): GeneratedFile[] { /* 返回 SteleRuntime.java */ },
};

export default backend;
```

### 2.2 注册到 backend-registry

```typescript
{ language: "java", framework: "junit5", packageName: "@stele/backend-java", displayName: "Java (JUnit 5)" },
// TestNG support is Phase 4 candidate; not shipped in v0.1.
// { language: "java", framework: "testng", packageName: "@stele/backend-java", displayName: "Java (TestNG)" },
```

## 3. 项目结构

Java 标准 Maven/Gradle 项目结构。生成的测试放在 `src/test/java` 下独立 package。

```
src/test/java/contract/
  SteleRuntime.java              -- generator emit (runtime helpers)
  SteleTest_contract.java        -- generator emit (主测试)
  SteleTest_<group>.java         -- generator emit (group 测试)
  SteleConftest.java             -- 用户编写 (context 初始化)
```

**设计决策**：生成文件名以 `SteleTest_` 前缀，避免与用户测试类名冲突。

`stele.config.json`：

```json
{
  "targetLanguage": "java",
  "testFramework": "junit5",
  "generatedDir": "src/test/java/contract",
  "javaPackage": "contract"
}
```

## 4. 文件命名（E0505 合规）

| 文件类型 | 命名 | 说明 |
|---|---|---|
| Runtime helper | `SteleRuntime.java` | E0505 强制（类名 = 文件名） |
| 主测试 | `SteleTest_contract.java` | JUnit `@Test` 注解 |
| group 测试 | `SteleTest_<group>.java` | 每 group 一个类 |
| 用户 setup | `SteleConftest.java` | 用户编写 |

## 5. 类型模型

### 5.1 动态值表示

Java 无 `interface{}` 等价物。用 `Object` 表示动态值，配合类型判断：

```java
// SteleRuntime.java
package contract;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.lang.reflect.Method;
import java.math.BigDecimal;

public final class SteleRuntime {

    // 不 export——工具方法
    private SteleRuntime() {}

    // --- SteleRuntimeError ---

    /**
     * 运行时异常：路径导航失败、类型转换失败、checker 未注册等。
     * 等价于 Python 的 SteleRuntimeError、TypeScript 的 SteleRuntimeError。
     */
    public static class SteleRuntimeError extends RuntimeException {
        public SteleRuntimeError(String message) {
            super(message);
        }
    }

    // --- 类型判断 ---

    public static boolean isNumber(Object value) {
        return value instanceof Number || (!(value instanceof Boolean) && canParseAsNumber(value));
    }

    private static boolean canParseAsNumber(Object value) {
        if (value == null) return false;
        try {
            Long.parseLong(value.toString());
            return true;
        } catch (NumberFormatException e) {
            // ignore
        }
        try {
            Double.parseDouble(value.toString());
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public static String asString(Object value) {
        if (value == null) return null;
        return value.toString();
    }

    public static long asLong(Object value) {
        if (value instanceof Long) return (Long) value;
        if (value instanceof Integer) return ((Integer) value).longValue();
        if (value instanceof Double) return ((Double) value).longValue();
        if (value instanceof Short) return ((Short) value).longValue();
        if (value instanceof Float) return ((Float) value).longValue();
        if (value instanceof BigDecimal) return ((BigDecimal) value).longValue();
        throw new SteleRuntimeError("expected integer, got " + value.getClass().getName());
    }

    public static double asDouble(Object value) {
        if (value instanceof Double) return (Double) value;
        if (value instanceof Long) return (double) (Long) value;
        if (value instanceof Integer) return (double) (Integer) value;
        if (value instanceof BigDecimal) return ((BigDecimal) value).doubleValue();
        if (value instanceof Float) return ((Float) value).doubleValue();
        throw new SteleRuntimeError("expected number, got " + value.getClass().getName());
    }

    // --- 安全序列化 ---

    private static final Set<String> STELE_REDACTION_PATTERNS = Set.of(
        "password", "token", "secret", "apiKey", "api_key", "accessToken", "access_token"
    );

    /**
     * Registry of scenario functions: name -> Method reference.
     * Populated at test startup via registerScenarioFunction().
     */
    private static final Map<String, Method> STELE_SCENARIO_FUNCTIONS = new ConcurrentHashMap<>();

    /**
     * Register a scenario function by name.
     * Called from SteleConftest or test setup to make functions available to steleRunScenario.
     */
    public static void registerScenarioFunction(String name, Method method) {
        STELE_SCENARIO_FUNCTIONS.put(name, method);
    }

    /**
     * Defensive serialization for failure-witness payloads.
     * Mirrors the TypeScript backend's `safeSerialize` and core `stableStringify`.
     *
     * - Walks the tree up to `maxDepth`; deeper subtrees become "<depth-limit>".
     * - Object keys are sorted for deterministic output (no LinkedHashSet nondeterminism).
     * - Keys matching redaction patterns are replaced with "<redacted>".
     * - Arrays longer than 100 entries are truncated.
     */
    public static String safeSerialize(Object value, int maxDepth) {
        return safeSerializeImpl(value, maxDepth, 0).serialized;
    }

    private static class SerializeResult {
        final String serialized;
        final boolean truncated;
        SerializeResult(String serialized, boolean truncated) {
            this.serialized = serialized;
            this.truncated = truncated;
        }
    }

    private static SerializeResult safeSerializeImpl(Object value, int maxDepth, int depth) {
        if (depth > maxDepth) {
            return new SerializeResult("\"<depth-limit>\"", true);
        }
        if (value == null) {
            return new SerializeResult("null", false);
        }
        if (value instanceof String) {
            return new SerializeResult("\"" + escapeJson((String) value) + "\"", false);
        }
        if (value instanceof Number || value instanceof Boolean) {
            return new SerializeResult(value.toString(), false);
        }
        if (value instanceof List) {
            List<?> list = (List<?>) value;
            boolean truncated = list.size() > 100;
            int limit = Math.min(list.size(), 100);
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < limit; i++) {
                if (i > 0) sb.append(",");
                SerializeResult child = safeSerializeImpl(list.get(i), maxDepth, depth + 1);
                sb.append(child.serialized);
                if (child.truncated) truncated = true;
            }
            sb.append("]");
            return new SerializeResult(sb.toString(), truncated);
        }
        if (value instanceof Map) {
            Map<?, ?> rawMap = (Map<?, ?>) value;
            // Collect (displayKey, value) pairs so non-String keys don't break lookup.
            Map.Entry<String, Object>[] entries = new Map.Entry[rawMap.size()];
            int idx = 0;
            for (Map.Entry<?, ?> e : rawMap.entrySet()) {
                String displayKey = e.getKey() instanceof String
                    ? (String) e.getKey()
                    : String.valueOf(e.getKey());
                entries[idx++] = new AbstractMap.SimpleEntry<>(displayKey, e.getValue());
            }
            Arrays.sort(entries, (a, b) -> a.getKey().compareTo(b.getKey()));
            boolean truncated = false;
            StringBuilder sb = new StringBuilder("{");
            for (int i = 0; i < entries.length; i++) {
                Map.Entry<String, Object> entry = entries[i];
                String key = entry.getKey();
                Object value = entry.getValue();
                if (i > 0) sb.append(",");
                sb.append("\"").append(escapeJson(key)).append("\":");
                if (STELE_REDACTION_PATTERNS.stream().anyMatch(p -> key.toLowerCase().contains(p))) {
                    sb.append("\"<redacted>\"");
                } else {
                    SerializeResult child = safeSerializeImpl(value, maxDepth, depth + 1);
                    sb.append(child.serialized);
                    if (child.truncated) truncated = true;
                }
            }
            sb.append("}");
            return new SerializeResult(sb.toString(), truncated);
        }
        // Fallback for unknown types
        return new SerializeResult("\"" + escapeJson(value.toString()) + "\"", false);
    }

    private static String kebabToCamelCase(String kebab) {
        StringBuilder sb = new StringBuilder();
        boolean nextUpper = false;
        for (int i = 0; i < kebab.length(); i++) {
            char c = kebab.charAt(i);
            if (c == '-') {
                nextUpper = true;
            } else if (nextUpper) {
                sb.append(Character.toUpperCase(c));
                nextUpper = false;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * ReDoS protection: reject patterns with nested quantifiers or excessive repetition.
     * Mirrors the TypeScript backend's defensive regex checks.
     * Not exhaustive; serves as a runtime safety net after validator-side rejection.
     */
    private static boolean hasRedosPattern(String pattern) {
        // Reject patterns with >20 repetitions of a quantified group or character class.
        // Simple heuristic: count consecutive quantifier characters.
        int consecutiveQuantifiers = 0;
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c == '*' || c == '+' || c == '{') {
                consecutiveQuantifiers++;
                if (consecutiveQuantifiers > 3) return true;
            } else {
                consecutiveQuantifiers = 0;
            }
        }
        return false;
    }

    private static String escapeJson(String value) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        // Control characters are escaped as \u00XX per JSON spec.
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                    break;
            }
        }
        return sb.toString();
    }
}
```

### 5.2 数值提升策略

与 Python/TS/Go/Rust 一致：整数比较用 `long`，浮点比较用 `double` 容忍度 `1e-9`。

```java
/**
 * 数值比较：两个操作数中任一方为浮点则提升到 double。
 * 浮点比较容忍度 1e-9。
 */
public static int numericCompare(Object a, Object b) {
    boolean aIsDouble = a instanceof Double || a instanceof Float || a instanceof BigDecimal;
    boolean bIsDouble = b instanceof Double || b instanceof Float || b instanceof BigDecimal;

    if (!aIsDouble && !bIsDouble) {
        long ai = asLong(a);
        long bi = asLong(b);
        return Long.compare(ai, bi);
    }
    double af = asDouble(a);
    double bf = asDouble(b);
    double diff = af - bf;
    if (Math.abs(diff) < 1e-9) return 0;
    return diff < 0 ? -1 : 1;
}
```

### 5.3 类型映射表

| CDL 类型 | Java runtime | 用户 context 期望 |
|---|---|---|
| `Number` (整数) | `Long` | `Integer`, `Long`, `Short` |
| `Number` (浮点) | `Double` | `Double`, `Float`, `BigDecimal` |
| `String` | `String` | `String` |
| `Boolean` | `Boolean` | `Boolean` |
| `Collection` | `List<Object>` | `List<Object>`, `Collection<?>` |
| `Path` | `String...` | — |

### 5.4 不支持的类型

- `BigInteger`：超出 `Long` 范围。Phase 3 候选。
- `BigDecimal`：金融场景。v0.2 部分支持（`numericCompare` 可转换，但 `SteleValue` 不原生持有 `BigDecimal`）。
- `LocalDateTime`：用 ISO 字符串或 epoch millis。

## 6. 路径访问

Java 用 `Map<String, Object>` 表示上下文：

```java
/**
 * 路径导航：逐段从 Map 中查找。
 * 找不到时尝试 kebab -> camelCase fallback（与 TypeScript 一致）。
 */
@SuppressWarnings("unchecked")
public static Object getAtPath(Object root, String... segments) {
    Object current = root;
    for (String seg : segments) {
        if (current == null) {
            throw new SteleRuntimeError("path navigation hit null at segment: " + seg);
        }
        if (current instanceof Map) {
            Map<String, Object> map = (Map<String, Object>) current;
            if (map.containsKey(seg)) {
                current = map.get(seg);
                continue;
            }
            // kebab -> camelCase fallback (Java convention)
            String camel = kebabToCamelCase(seg);
            if (map.containsKey(camel)) {
                current = map.get(camel);
                continue;
            }
            throw new SteleRuntimeError("path not found: segment " + seg
                + " on map with keys " + map.keySet());
        }
        throw new SteleRuntimeError("path navigation hit non-Map at segment: " + seg
            + " (got " + current.getClass().getSimpleName() + ")");
    }
    return current;
}
```

## 7. 测试生成模板

### 7.1 JUnit 5 测试类

```java
// SteleTest_contract.java (generator emit)
package contract;

import org.junit.jupiter.api.Test;
import static contract.SteleRuntime.*;
import static contract.SteleRuntime.CheckerFunction;
import static contract.SteleRuntime.CheckerResult;
import static org.junit.jupiter.api.Assertions.*;
import java.util.*;

public class SteleTest_contract {

    private final Map<String, Object> ctx = SteleConftest.steleContext();

    @Test
    void test_ACCT_BALANCE_POSITIVE() {
        List<Object> accounts = (List<Object>) getAtPath(ctx, "accounts");
        for (int i = 0; i < accounts.size(); i++) {
            Object balance = getAtPath(accounts.get(i), "balance");
            assertTrue(numericCompare(balance, 0L) > 0,
                "ACCT_BALANCE_POSITIVE: accounts[" + i + "].balance > 0");
        }
    }
}
```

### 7.2 forall/exists 量词

```java
/**
 * forall: 所有元素满足谓词。
 * 失败时 emit witness 到文件通道。
 */
public static <T> void steleForall(List<T> items, java.util.function.Predicate<T> pred, String predSource) {
    for (int i = 0; i < items.size(); i++) {
        T item = items.get(i);
        if (!pred.test(item)) {
            FailureWitness witness = new FailureWitness(
                "forall", items.size(), i, safeSerialize(item, 2), predSource
            );
            emitWitness(witness);
            throw new SteleRuntimeError("forall failed at index " + i + ": " + predSource);
        }
    }
}

public static <T> boolean steleExists(List<T> items, java.util.function.Predicate<T> pred, String predSource) {
    for (T item : items) {
        if (pred.test(item)) return true;
    }
    throw new SteleRuntimeError("exists: no item satisfies predicate: " + predSource);
}
```

## 8. Context 接口

### 8.1 用户 SteleConftest.java

```java
// SteleConftest.java (用户编写)
package contract;

import java.lang.reflect.Method;
import java.util.*;

public class SteleConftest {

    /**
     * Register scenario functions at class load time.
     * SteleRuntime.registerScenarioFunction() makes them available to steleRunScenario().
     */
    static {
        try {
            // Example: register a user-defined scenario function.
            // The method must accept Object... args and return Object (or a compatible type).
            Method withdrawMethod = SteleConftest.class.getMethod("withdraw", Map.class, Long.class);
            SteleRuntime.registerScenarioFunction("withdraw", withdrawMethod);
        } catch (NoSuchMethodException e) {
            throw new RuntimeException("failed to register scenario function", e);
        }
    }

    // User-defined scenario function called via steleRunScenario steps.
    public static Object withdraw(Map<String, Object> account, Long amount) {
        long balance = (long) account.get("balance");
        account.put("balance", balance - amount);
        return null;
    }

    public static Map<String, Object> steleContext() {
        Map<String, Object> ctx = new LinkedHashMap<>();

        Map<String, Object> account = new LinkedHashMap<>();
        account.put("balance", 100L);
        account.put("name", "Alice");
        ctx.put("account", account);

        List<Object> accounts = new ArrayList<>();
        Map<String, Object> a1 = new LinkedHashMap<>();
        a1.put("balance", 100L);
        accounts.add(a1);
        Map<String, Object> a2 = new LinkedHashMap<>();
        a2.put("balance", 50L);
        accounts.add(a2);
        ctx.put("accounts", accounts);

        return ctx;
    }
}
```

### 8.2 Checker

Checker types are defined as nested static members of `SteleRuntime`. Note: `import static contract.SteleRuntime.*` does NOT import nested types. Generated tests must include explicit imports for `CheckerFunction` and `CheckerResult`.

```java
// Inside SteleRuntime.java (nested types)
@FunctionalInterface
public interface CheckerFunction {
    CheckerResult apply(List<Object> args, Map<String, Object> ctx);
}

public static class CheckerResult {
    public final boolean ok;
    public final String message;
    public final Object details;

    public CheckerResult(boolean ok, String message, Object details) {
        this.ok = ok;
        this.message = message;
        this.details = details;
    }
}

public static CheckerResult steleCallChecker(
    Map<String, CheckerFunction> checkers, String name, List<Object> args, Map<String, Object> ctx
) {
    CheckerFunction fn = checkers.get(name);
    if (fn == null) {
        throw new SteleRuntimeError("checker " + name + " not registered");
    }
    return fn.apply(args, ctx);
}
```

### 8.3 writeFixtureBootstrap（Conformance Fixture Bootstrap）

与 Python/TypeScript/Go/Rust backend 一致，Java backend 实现 `writeFixtureBootstrap` 方法，在 conformance 测试运行前为每个 fixture 生成 `SteleConftest.java` 文件。

该方法从 `ConformanceFixture.appState`（解析后的 app-state.json）生成 fixture 专属的 `SteleConftest.java`，将其写入临时目录的 `src/test/java/contract/` 下。

```java
// packages/backend-java/src/backend.ts（TypeScript 侧的 backend 实现）
import type { LanguageBackend } from "@stele/core";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const backend: LanguageBackend = {
  // ... other fields ...
  async writeFixtureBootstrap(fixture, tmpdir) {
    const outDir = join(tmpdir, "src", "test", "java", "contract");
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "SteleConftest.java"),
      renderSteleConftest(fixture.appState),
      "utf8",
    );
  },
};
```

`renderSteleConftest` 函数将 `appState`（JSON object）渲染为 `SteleConftest.java` 源码，将 JSON 数据嵌入为 `LinkedHashMap` 字面量。与 Python 的 `renderConftest` 和 TypeScript 的 `renderConftest` 一致，输出必须是确定性的（排序 key、稳定缩进）。

```typescript
// packages/backend-java/src/translator.ts（新增）
function renderSteleConftest(appState: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("package contract;");
  lines.push("");
  lines.push("import java.util.*;");
  lines.push("");
  lines.push("public class SteleConftest {");
  lines.push("    public static Map<String, Object> steleContext() {");
  lines.push("        Map<String, Object> ctx = new LinkedHashMap<>();");

  // Sort keys for deterministic output
  const sortedKeys = Object.keys(appState).sort();
  for (const key of sortedKeys) {
    lines.push(`        ctx.put("${escapeJavaString(key)}", ${jsonToJavaLiteral(appState[key])});`);
  }

  lines.push("        return ctx;");
  lines.push("    }");
  lines.push("");
  lines.push("    @SuppressWarnings(\"unchecked\")");
  lines.push("    private static Map<String, Object> createMap(Object... kvs) {");
  lines.push("        Map<String, Object> map = new LinkedHashMap<>();");
  lines.push("        for (int i = 0; i < kvs.length; i += 2) {");
  lines.push("            map.put((String) kvs[i], kvs[i + 1]);");
  lines.push("        }");
  lines.push("        return map;");
  lines.push("    }");
  lines.push("}");
  return lines.join("\n");
}

// jsonToJavaLiteral: recursively converts JSON values to Java literals.
// - null -> null
// - boolean -> true/false
// - number (integer) -> N L (e.g., 100L)
// - number (float) -> N.0
// - string -> "escaped"
// - array -> Arrays.asList(...)
// - object -> createMap("k1", v1, "k2", v2)
// Implementation mirrors Go's toGoLiteral and Python's emitFixtureBootstrap.
```

生成的 `SteleConftest.java` 示例：

```java
package contract;

import java.util.*;

public class SteleConftest {
    public static Map<String, Object> steleContext() {
        Map<String, Object> ctx = new LinkedHashMap<>();
        ctx.put("accounts", Arrays.asList(
            createMap("balance", 100L, "name", "Alice"),
            createMap("balance", 50L, "name", "Bob")
        ));
        ctx.put("_stele_checkers", new LinkedHashMap<>());
        return ctx;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> createMap(Object... kvs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kvs.length; i += 2) {
            map.put((String) kvs[i], kvs[i + 1]);
        }
        return map;
    }
}
```

**设计要点**：
- `appState` 中的 `_checkers` key 不直接放入 context，而是单独处理（checker 实现在 conformance 测试中由 runner 注入）。
- 输出的 Java 代码必须确定性：map 的 key 按字母序排序，相同输入产生相同字节输出。
- 生成的文件是 `SteleConftest.java`（用户编写的 conftest 也在此位置），conformance runner 会覆盖它。

## 9. Failure Witness

### 9.1 文件通道协议

与 Go/Rust 一致：

```java
private static final AtomicInteger WITNESS_COUNTER = new AtomicInteger(0);

public static class FailureWitness {
    public final String operator;
    public final int collectionSize;
    public final int failedAtIndex;
    public final String failedItem;
    public final String predicateSource;

    public FailureWitness(String operator, int collectionSize, int failedAtIndex,
                          String failedItem, String predicateSource) {
        this.operator = operator;
        this.collectionSize = collectionSize;
        this.failedAtIndex = failedAtIndex;
        this.failedItem = failedItem;
        this.predicateSource = predicateSource;
    }
}

private static void emitWitness(FailureWitness witness) {
    String dir = System.getenv("STELE_WITNESS_DIR");
    if (dir == null || dir.isEmpty()) return;

    // Deterministic naming: counter-based to avoid collisions within a single test run.
    // System.nanoTime() is non-deterministic across runs and breaks conformance comparison.
    String filename = "witness-" + WITNESS_COUNTER.getAndIncrement() + ".json";
    String path = dir + System.fileSeparator + filename;

    // 使用 StringBuilder 构建 JSON（不引入外部依赖）
    String json = "{" +
        "\"operator\":\"" + escapeJson(witness.operator) + "\"," +
        "\"collectionSize\":" + witness.collectionSize + "," +
        "\"failedAtIndex\":" + witness.failedAtIndex + "," +
        "\"failedItem\":" + witness.failedItem + "," +
        "\"predicateSource\":\"" + escapeJson(witness.predicateSource) + "\"" +
    "}";

    try {
        java.nio.file.Files.write(
            java.nio.file.Paths.get(path),
            json.getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );
    } catch (Exception e) {
        // best-effort: ignore
    }
}
```

### 9.2 stele check 收集

CLI 侧：创建临时目录、设置 `STELE_WITNESS_DIR`、运行 `mvn test` 或 `gradle test`、收集 JSON 文件。

```typescript
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnAsync } from "../utils/spawn.js";  // wrapper around node:child_process.spawn + Promise

async function runJavaTestRunner(projectRoot: string): Promise<{ exitCode: number; witnesses: Witness[] }> {
  const witnessDir = join(tmpdir(), `stele-witness-${process.pid}-${Date.now()}`);
  await mkdir(witnessDir, { recursive: true });

  // 检测构建工具
  const buildTool = existsSync(join(projectRoot, "pom.xml")) ? "mvn" : "gradle";
  const args = buildTool === "mvn"
    ? ["test", "-Dtest=contract.SteleTest*"]
    : ["test", "--tests", "contract.SteleTest_*"];

  const result = await spawnAsync(buildTool, args, {
    cwd: projectRoot,
    env: { ...process.env, STELE_WITNESS_DIR: witnessDir },
  });

  const witnesses = await collectWitnessFiles(witnessDir);
  await rm(witnessDir, { recursive: true, force: true });

  return { exitCode: result.status, witnesses };
}
```

## 10. 操作符翻译

### 10.1 算术运算符

```java
public static Object steleAdd(Object a, Object b) {
    if (a instanceof Long && b instanceof Long) {
        return (Long) a + (Long) b;  // 保持整数
    }
    return asDouble(a) + asDouble(b);
}

public static Object steleMod(Object a, Object b) {
    double af = asDouble(a);
    double bf = asDouble(b);
    // sign-of-divisor（Java % 默认 sign-of-dividend）
    return ((af % bf) + bf) % bf;
}
```

### 10.2 集合运算符

```java
@SuppressWarnings("unchecked")
public static Object steleSum(List<Object> items, String... path) {
    long longTotal = 0;
    double doubleTotal = 0.0;
    boolean hasFloat = false;
    for (Object item : items) {
        Object val = getAtPath(item, path);
        if (val instanceof Long) {
            longTotal += (Long) val;
        } else if (val instanceof Integer) {
            longTotal += (Integer) val;
        } else if (val instanceof Short) {
            longTotal += ((Short) val).longValue();
        } else if (val instanceof Double) {
            hasFloat = true;
            doubleTotal += (Double) val;
        } else if (val instanceof Float) {
            hasFloat = true;
            doubleTotal += ((Float) val).doubleValue();
        } else if (val instanceof BigDecimal) {
            hasFloat = true;
            doubleTotal += ((BigDecimal) val).doubleValue();
        } else {
            hasFloat = true;
            doubleTotal += asDouble(val);
        }
    }
    // Return double only when floats are present; otherwise return long to preserve integer precision.
    if (hasFloat) {
        return (double) longTotal + doubleTotal;
    }
    return longTotal;
}

@SuppressWarnings("unchecked")
public static boolean steleUnique(List<Object> items, String... path) {
    // TreeSet ensures sorted, deterministic ordering regardless of iteration order.
    Set<String> seen = new TreeSet<>();
    for (Object item : items) {
        Object val = getAtPath(item, path);
        String key = safeSerialize(val, 1);
        if (!seen.add(key)) return false;
    }
    return true;
}
```

### 10.3 字符串运算符

```java
public static boolean steleStartsWith(Object value, Object prefix) {
    String s = asString(value);
    String p = asString(prefix);
    return s.startsWith(p);
}

public static boolean steleMatches(Object value, Object pattern) {
    String s = asString(value);
    String p = asString(pattern);
    // ReDoS protection
    if (hasRedosPattern(p)) {
        throw new SteleRuntimeError("potentially dangerous regex pattern: " + p);
    }
    try {
        return java.util.regex.Pattern.compile(p).matcher(s).find();
    } catch (java.util.regex.PatternSyntaxException e) {
        throw new SteleRuntimeError("invalid regex pattern: " + e.getMessage());
    }
}
```

## 11. Scenario / Checker

### 11.1 Scenario 执行

```java
public static Map<String, Object> steleRunScenario(
    List<Map<String, Object>> steps, Map<String, Object> ctx
) {
    for (Map<String, Object> step : steps) {
        String type = (String) step.get("type");
        switch (type) {
            case "execute": {
                String funcName = (String) step.get("function");
                List<Object> args = (List<Object>) step.getOrDefault("args", List.of());
                Object fn = STELE_SCENARIO_FUNCTIONS.get(funcName);
                if (fn == null) {
                    throw new SteleRuntimeError("scenario function " + funcName + " not registered");
                }
                // Reflection-based invocation: fn is already a java.lang.reflect.Method.
                try {
                    Object result = fn.invoke(null, args.toArray());
                    if (step.containsKey("assign")) {
                        String assignPath = (String) step.get("assign");
                        // Store result into ctx at the given path.
                        ctx.put(assignPath, result);
                    }
                } catch (java.lang.reflect.InvocationTargetException e) {
                    throw new SteleRuntimeError("scenario function " + funcName + " threw: "
                        + e.getCause().getMessage());
                } catch (Exception e) {
                    throw new SteleRuntimeError("failed to invoke scenario function " + funcName
                        + ": " + e.getMessage());
                }
                break;
            }
            case "capture-state": {
                String label = (String) step.getOrDefault("label", "");
                // Snapshot the current context into stateBefore / stateAfter fields on the step.
                // Shallow clone via new HashMap to avoid mutating the live context.
                Map<String, Object> snapshot = new HashMap<>(ctx);
                if ("before".equals(label) || label.isEmpty()) {
                    step.put("stateBefore", snapshot);
                } else {
                    step.put("stateAfter", snapshot);
                }
                break;
            }
            case "import":
                String module = (String) step.get("module");
                assertImportAllowed(module);
                break;
            default:
                throw new SteleRuntimeError("unknown scenario step type: " + type);
        }
    }
    return ctx;
}
```

### 11.2 Import 安全

```java
/**
 * Import allowlist: only explicitly allowed packages may be imported.
 * Everything else is rejected. This is the core security boundary — Stele
 * exists to protect against agent damage, so a blocklist is insufficient
 * (new dangerous packages could always be added).
 */
private static final List<String> STELE_ALLOWED_IMPORTS = List.of(
    "java.util", "java.util.*",
    "java.lang", "java.lang.*",
    "java.math", "java.math.*",
    "java.nio.file", "java.nio.file.*",
    "java.nio.charset", "java.nio.charset.*",
    "java.io", "java.io.*",
    "stele", "stele.*",
    "org.junit", "org.junit.*"
);
// Note: java.nio.file and java.nio.charset are required by the generated runtime
// (emitWitness uses Files.write and StandardCharsets.UTF_8). java.io is allowed for
// general IO operations in user conftest code.

private static void assertImportAllowed(String module) {
    boolean allowed = STELE_ALLOWED_IMPORTS.stream()
        .anyMatch(pattern -> {
            if (!pattern.endsWith("*")) {
                return pattern.equals(module);
            }
            String prefix = pattern.substring(0, pattern.length() - 1);
            return module.startsWith(prefix);
        });
    if (!allowed) {
        throw new SteleRuntimeError("Module " + module + " is not in the Stele allowlist");
    }
}
```

## 12. Maven/Gradle 依赖

生成的代码需要：

| dependency | 用途 | 何时需要 |
|---|---|---|
| `junit-jupiter` | `@Test`, `assertThat` | `testFramework: "junit5"` |
| (TestNG) | `@Test`, `assertEquals` | 未实现；Phase 4 候选 |
| 无外部 runtime 依赖 | `_stele_runtime` 纯 stdlib | 始终 |

**重要**：`SteleRuntime.java` 不引入外部依赖。仅用 `java.util.*` + `java.nio.file.*`。

`stele init --language java` 生成 `pom.xml`：

```xml
<dependencies>
  <dependency>
    <groupId>org.junit.jupiter</groupId>
    <artifactId>junit-jupiter</artifactId>
    <version>5.10.0</version>
    <scope>test</scope>
  </dependency>
</dependencies>
```

或 `build.gradle`：

```groovy
dependencies {
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
}
```

## 13. 测试策略

### 13.1 TS 端测试

- `packages/backend-java/tests/translator.test.ts`：每操作符翻译测试
- `packages/backend-java/tests/integration.test.ts`：端到端 `stele generate` + `mvn test`

### 13.2 Java runtime 测试

- `packages/backend-java/runtime/src/test/java/contract/SteleRuntimeTest.java`：runtime helpers 单测

### 13.3 Conformance

- `tests/conformance/` runner 加 `STELE_CONFORMANCE_BACKENDS=...,java`
- 全部 fixture 跑 Java backend
- 跨 backend 字节等价验证

### 13.4 Code Shape 跳过

`06-code-shape` fixture 仅 Python backend 支持，Java skip。

## 14. 估算分解

| 工作 | 估算 |
|---|---|
| 包 scaffold + LanguageBackend 注册 | 1 天 |
| 数值提升策略 + 类型系统 | 1.5 天 |
| 51 baseline 操作符翻译 + runtime | 8 天 |
| Path access (kebab->camelCase) | 0.5 天 |
| 18 EP04 + 5 EP13 操作符 | 4 天 |
| Scenario / checker runtime | 4 天 |
| Witness file channel + CLI 集成 | 2 天 |
| Maven/Gradle 模板 + init | 1 天 |
| Conformance fixture + 修 bug | 5 天 |
| examples/java-project + 文档 | 2 天 |
| **合计** | **30 天 ≈ 6 周（1 FTE）/ 3-3.5 周（2 FTE）** |

## 15. 验收标准

- [ ] `stele init --language java` 生成正确的 project structure + pom.xml
- [ ] `stele generate` 生成的 Java 代码通过 `mvn compile -DskipTests`
- [ ] `mvn test -Dtest=contract.SteleTest*` 运行通过
- [ ] `tests/conformance/` 全部 fixture 在 Java backend 通过
- [ ] 跨 backend 一致性：Python + TS + Go + Rust + Java violation report 字节等价
- [ ] `SteleRuntime.java` 不引入外部依赖（纯 stdlib）
- [ ] `examples/java-project/` 演示完整流程
- [ ] `docs/guides/java-integration.md` 完整
