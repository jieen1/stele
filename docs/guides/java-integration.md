# Stele Java App Integration

Stele attaches to an existing Java application via JUnit 5. Your application owns runtime state through a `SteleConftest.steleContext()` helper; generated Stele tests read that state directly and never fabricate domain objects.

> **Phase A only.** Java has the Phase A pipeline (CDL → JUnit 5 tests). Phase B forms are supported on TypeScript and Python projects only; Java projects fail loud (Round 4 F-A-02).

## Install and adopt

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele init --language java
```

`stele init --language java` scaffolds **exactly**:

- `stele.config.json` (with `"targetLanguage": "java"`, `"testFramework": "junit5"`, `protected[]`)
- `contract/main.stele` (ships 3 example invariants — see note below)
- `contract/checker_impls/` (custom Java checkers go here)
- `pom.xml`
- `src/test/java/contract/SteleConftest.java` (placeholder — you implement `steleContext()` here)

It does **not** create `SteleContext.java`, `.gitkeep`, or `contract/modules/`.
Your Maven/Gradle build must include `src/test/java/contract/` on the JUnit 5
(`junit-jupiter` 5.9+) test classpath.

> The example invariants in `contract/main.stele` reference data that only exists once
> you wire `SteleConftest.steleContext()` — a fresh project is not green until you
> implement it or delete the examples (the contract still locks + `stele check` passes
> with 0 invariants).

## Contract layout

```
contract/
  main.stele                  # entry (modules/*.stele optional if you split it)
  checker_impls/*.java        # custom Java checker methods
  .manifest.json
src/test/java/contract/
  SteleConftest.java          # user-owned; implements static steleContext()
  _stele_runtime.java         # generated helper — do not edit
  test_contract.java          # generated tests (test_<group>.java per group) — do not edit
```

## The `SteleConftest.steleContext()` helper

Return a `LinkedHashMap<String, Object>` (deterministic iteration order):

```java
// src/test/java/contract/SteleConftest.java
package contract;

import java.util.*;
import myapp.repository.UserRepository;
import myapp.repository.OrderRepository;

public final class SteleConftest {
    public static Map<String, Object> steleContext() {
        var users = UserRepository.loadAll();
        var orders = OrderRepository.loadAll();
        var checkers = new LinkedHashMap<String, java.lang.reflect.Method>();
        try {
            checkers.put("validate-email",
                SteleConftest.class.getMethod("validateEmail", Map.class));
        } catch (NoSuchMethodException e) {
            throw new RuntimeException(e);
        }
        var ctx = new LinkedHashMap<String, Object>();
        ctx.put("user", users.get(0));
        ctx.put("orders", orders);
        ctx.put("_stele_checkers", checkers);
        return ctx;
    }

    public static boolean validateEmail(Map<String, Object> ctx) {
        var user = (Map<String, Object>) ctx.get("user");
        var email = (String) user.get("email");
        return email != null && email.contains("@");
    }
}
```

Generated tests call `SteleConftest.steleContext()` once per test class; contract assertions read the returned map.

### Optional or empty app data

Use `null` (or omit the key) for data your app doesn't have — `(path …)` resolves to `null` and the invariant skips. Use `false` / sentinel value if you want the invariant to actively fail.

## Generate, run, lock

```bash
npx stele generate            # CDL → src/test/java/contract/*.java
mvn -Dtest='contract.*Test' test
# or: ./gradlew test --tests 'contract.*Test'
npx stele lock --reason "initial baseline"
npx stele check               # 0 = clean, 2 = drift, 3 = tamper
```

## Custom checkers

```bash
npx stele add-checker validate-email
```

Scaffolds `contract/checker_impls/ValidateEmail.java`. Wire the method into `_stele_checkers` via `Class.getMethod(...)`.

## Writing contract source

CDL grammar is shared across all backends. See `docs/spec/cdl.md`.

## Generated tests

Generated `*.java` files under `src/test/java/contract/` are deterministic and byte-stable. Do not hand-edit.

## Protected files and AI editing

Same as other backends — the paths in your `stele.config.json` `protected` array are protected by `@stele/claude-code-plugin`.

## CI

```yaml
- name: Verify Stele contracts
  run: |
    npx stele generate
    mvn -B -Dtest='contract.*Test' test
    npx stele check
```

## Controlled contract-change flow

See `docs/guides/python-integration.md` § "Controlled contract-change flow".

## Phase B contracts on Java projects (F-A-02 fail-loud)

`trace-policy` / `type-state` / `effect-policy` fail loud on Java. TypeScript and Python projects use the Phase B evaluator; Java does not:

```text
[error] trace-policy not yet supported for targetLanguage="java".
```

Workarounds:

1. **Remove the Phase B form** and use an `invariant` + Java `checker`.
2. **Wait for the Java Phase B evaluator** (JavaParser-based extractor on roadmap).
3. **Scope Phase B to a TypeScript or Python subproject** if you have one.

## Packed adoption caveat

Pre-publish, install from local tarballs (see `python-integration.md`).
