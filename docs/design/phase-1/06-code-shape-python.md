# EP06 详细设计：Code Shape Python 后端补全

> PRD: [prd-phase-1.md §7](../../prd-phase-1.md) | 估算: 1-2 周 | 类别: 后端补全

## 1. 目标

5 种 Code Shape 顶层声明（`boundary`、`class-shape`、`function-shape`、`type-policy`、`file-policy`）当前已解析 + 校验，但 Python 后端 emit 仅 placeholder 注释。本 EP 让生成的 pytest 文件**实际执行**这些校验。

## 2. 翻译目标

### 2.1 class-shape

CDL：

```lisp
(class-shape Account
  (location "ledger.account.Account")
  (fields
    (balance Number)
    (currency String))
  (methods deposit withdraw))
```

生成 pytest：

```python
def test_class_shape_account(stele_context):
    cls = stele_resolve_class("ledger.account.Account")
    # Fields
    if not stele_has_field(cls, "balance", expected_type="Number"):
        pytest.fail("class-shape Account: field 'balance' missing or wrong type")
    if not stele_has_field(cls, "currency", expected_type="String"):
        pytest.fail("class-shape Account: field 'currency' missing or wrong type")
    # Methods
    if not stele_has_callable(cls, "deposit"):
        pytest.fail("class-shape Account: method 'deposit' missing or not callable")
    if not stele_has_callable(cls, "withdraw"):
        pytest.fail("class-shape Account: method 'withdraw' missing or not callable")
```

### 2.2 function-shape

CDL：

```lisp
(function-shape calculate_total
  (location "ledger.totals.calculate_total")
  (params (cart Cart) (tax-rate Number))
  (returns Number))
```

生成：

```python
def test_function_shape_calculate_total(stele_context):
    fn = stele_resolve_function("ledger.totals.calculate_total")
    sig = inspect.signature(fn)
    expected_params = ["cart", "tax_rate"]  # kebab→snake
    actual_params = list(sig.parameters.keys())
    if actual_params != expected_params:
        pytest.fail(f"function-shape calculate_total: expected params {expected_params}, got {actual_params}")
    # returns 类型仅当 typing.get_type_hints 可用且不为空时检查
    hints = stele_get_type_hints(fn)
    if "return" in hints:
        if not stele_type_matches(hints["return"], "Number"):
            pytest.fail(f"function-shape calculate_total: return type mismatch")
```

### 2.3 boundary

CDL：

```lisp
(boundary api
  (allowed-imports
    "fastapi"
    "ledger"
    "schemas")
  (forbidden-imports
    "ledger.internal"
    "test_*"))
```

生成：

```python
def test_boundary_api(stele_context):
    api_files = stele_glob("api/**/*.py")
    for filepath in api_files:
        imports = stele_collect_imports(filepath)
        for imp in imports:
            if not stele_import_allowed(imp, allowed=["fastapi", "ledger", "schemas"], forbidden=["ledger.internal", "test_*"]):
                pytest.fail(f"boundary api: file {filepath} imports forbidden {imp}")
```

### 2.4 type-policy

CDL：

```lisp
(type-policy
  (location "models.Account")
  (must-have-fields id created-at)
  (forbidden-types raw-string-money))
```

生成：

```python
def test_type_policy_account(stele_context):
    cls = stele_resolve_class("models.Account")
    fields = stele_get_class_fields(cls)
    for required in ["id", "created_at"]:
        if required not in fields:
            pytest.fail(f"type-policy Account: missing required field {required}")
    for field, ftype in fields.items():
        if stele_type_is(ftype, "raw_string_money"):
            pytest.fail(f"type-policy Account: field {field} uses forbidden type raw-string-money")
```

### 2.5 file-policy

CDL：

```lisp
(file-policy
  (path-pattern "ledger/**/*.py")
  (required-imports "from typing import")
  (forbidden-patterns "TODO" "FIXME"))
```

生成：

```python
def test_file_policy_ledger(stele_context):
    files = stele_glob("ledger/**/*.py")
    for filepath in files:
        text = stele_read_file(filepath)
        if "from typing import" not in text:
            pytest.fail(f"file-policy: {filepath} missing required import 'from typing import'")
        for pattern in ["TODO", "FIXME"]:
            if pattern in text:
                pytest.fail(f"file-policy: {filepath} contains forbidden pattern {pattern}")
```

## 3. Runtime helpers (新增至 `_stele_runtime.py`)

```python
import importlib
import inspect
import re
from glob import glob

# Module 解析（受 _STELE_ALLOWED_MODULES 白名单约束）
def stele_resolve_class(qualified_name):
    """importlib + getattr 分两步；失败抛 SteleRuntimeError"""
    module_name, class_name = qualified_name.rsplit(".", 1)
    if not _stele_module_allowed(module_name):
        raise SteleRuntimeError(f"class resolution blocked by allowlist: {module_name}")
    try:
        mod = importlib.import_module(module_name)
        return getattr(mod, class_name)
    except (ImportError, AttributeError) as e:
        raise SteleRuntimeError(f"failed to resolve class {qualified_name}: {e}")

def stele_resolve_function(qualified_name):
    """同 resolve_class 但要求 callable"""
    obj = stele_resolve_class(qualified_name)
    if not callable(obj):
        raise SteleRuntimeError(f"{qualified_name} is not callable")
    return obj

# 字段 / 方法 / 类型查询
def stele_has_field(cls, field_name, expected_type=None):
    if not hasattr(cls, field_name):
        # 也尝试 dataclass / pydantic field
        if not _stele_has_dataclass_field(cls, field_name):
            return False
    if expected_type is not None:
        hints = stele_get_type_hints(cls)
        actual = hints.get(field_name)
        if not stele_type_matches(actual, expected_type):
            return False
    return True

def stele_has_callable(cls, method_name):
    return callable(getattr(cls, method_name, None))

def stele_get_class_fields(cls):
    """返回 dict[name, type]，含 dataclass / pydantic field"""
    hints = stele_get_type_hints(cls)
    return hints

def stele_get_type_hints(obj):
    try:
        import typing
        return typing.get_type_hints(obj)
    except Exception:
        return {}

def stele_type_matches(actual_type, expected_name):
    """expected_name 是 CDL 类型名（'Number', 'String', 'Boolean', 自定义）"""
    if expected_name == "Number":
        # bool 是 int 子类；明确排除（用户写 Number 不期望 Boolean 被接受）
        if actual_type is bool:
            return False
        if actual_type in (int, float):
            return True
        # 加入 Decimal 支持（金融场景）
        try:
            from decimal import Decimal
            if actual_type is Decimal:
                return True
        except ImportError:
            pass
        return False
    if expected_name == "String":
        return actual_type is str
    if expected_name == "Boolean":
        return actual_type is bool
    # 自定义类型 → 名称比对
    return getattr(actual_type, "__name__", None) == expected_name

# 文件 / import 检查
def stele_glob(pattern):
    return sorted(glob(pattern, recursive=True))

def stele_read_file(filepath):
    # 安全：拒绝 symlink 引用项目外文件（防 boundary check 读 /etc/passwd）
    project_root = os.path.realpath(os.getcwd())
    real = os.path.realpath(filepath)
    if not real.startswith(project_root + os.sep) and real != project_root:
        raise SteleRuntimeError(f"refusing to read outside project: {filepath} → {real}")
    with open(real, "r", encoding="utf-8") as f:
        return f.read()

def stele_collect_imports(filepath):
    """返回 set of imported module names"""
    import ast
    text = stele_read_file(filepath)
    tree = ast.parse(text, filepath)
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.add(node.module)
    return imports

def stele_import_allowed(imp, allowed, forbidden):
    """imp 满足 forbidden 任一 → false；不满足 allowed 任一 → false"""
    for pattern in forbidden:
        if _stele_match(imp, pattern):
            return False
    if not allowed:
        return True
    return any(_stele_match(imp, pattern) for pattern in allowed)

def _stele_match(s, pattern):
    """支持 * 通配（不是完整 regex）"""
    re_pattern = "^" + re.escape(pattern).replace("\\*", ".*") + "$"
    return re.match(re_pattern, s) is not None
```

## 4. 模块 allowlist 拆分（v0.2 修正）

⚠️ 早期草稿提议把 `importlib`、`inspect`、`ast`、`glob`、`typing`、`re` 加到现有 `_STELE_ALLOWED_MODULES`。但该 allowlist 当前是**用户代码可见**的（用户契约 scenario step 中可 `import` 的模块 prefix）。把 `importlib` 加进去 = 让用户代码可以再次 import 任意模块，绕过 allowlist 整个机制。

**v0.2 修正**：拆为两个独立 allowlist：

```python
# packages/backend-python/src/runtime/_stele_runtime.py

# 用户面：scenario step / checker 可 import 的模块 prefix
_STELE_USER_ALLOWED_MODULES = frozenset({
    "tests.contract_scenarios",
    "tests.contract",
    "app",
    # 不含 importlib / inspect / ast / glob 等（保持现状）
})

# Stele runtime 内部：仅 Stele 自己的代码可用；用户代码触不到
_STELE_INTERNAL_ALLOWED_MODULES = frozenset({
    "importlib",
    "inspect",
    "ast",
    "glob",
    "typing",
    "re",
})

# 检查函数分两个：
def _stele_user_module_allowed(module_name: str) -> bool:
    return any(
        module_name == prefix or module_name.startswith(prefix + ".")
        for prefix in _STELE_USER_ALLOWED_MODULES
    )

# Stele 内部使用 importlib 直接（不查 allowlist；这是 trusted code）
```

`stele_resolve_class` 是 Stele runtime 内部函数；用 `importlib.import_module` 但只接受用户传的 `qualified_name`，**且**对 `qualified_name` 应用 `_stele_user_module_allowed` 检查（不是 internal allowlist）：

```python
def stele_resolve_class(qualified_name):
    module_name, _, class_name = qualified_name.rpartition(".")
    if not _stele_user_module_allowed(module_name):
        raise SteleRuntimeError(f"class resolution blocked: {module_name} not in user allowlist")
    mod = importlib.import_module(module_name)  # Stele 自己用 importlib，trusted
    return getattr(mod, class_name)
```

**风险消除**：用户的 scenario step 仍**不能** import `importlib`、`os`、`subprocess` 等；Code Shape 校验通过 Stele 内部 importlib 调用，**不**经用户代码路径。

## 5. 翻译器修改

`packages/backend-python/src/translator.ts` 新增 5 个 emitters：

```typescript
function emitClassShape(decl: ClassShapeDeclaration, ctx: TranslateContext): string {
  const fnName = `test_class_shape_${snakeCase(decl.name)}`;
  return [
    `def ${fnName}(stele_context):`,
    `    cls = stele_resolve_class(${quote(decl.location)})`,
    ...decl.fields.map((f) => emitFieldCheck(decl.name, f)),
    ...decl.methods.map((m) => emitMethodCheck(decl.name, m)),
  ].join("\n");
}

function emitFunctionShape(...): string { /* ... */ }
function emitBoundary(...): string { /* ... */ }
function emitTypePolicy(...): string { /* ... */ }
function emitFilePolicy(...): string { /* ... */ }
```

## 6. 测试

`packages/backend-python/tests/translator.test.ts` 新增 5 个 describe 块（每 shape 一个）。

`tests/conformance/fixtures/06-code-shape/`：

- `app/account.py` 含 `Account` 类的两版本（合规 + 不合规）
- `contract/main.stele` 定义 1 个 class-shape + 1 个 function-shape
- 两版本各产生 expected-violations.json

## 7. examples 更新

`examples/finance-guard/contract/main.stele` 加 1 个 class-shape 演示：

```lisp
(class-shape Account
  (location "app.models.Account")
  (fields
    (id String)
    (balance Number)
    (currency String))
  (methods deposit withdraw))
```

## 8. TypeScript backend 等价（v0.2 不在范围）

EP01 (TS backend) Phase 1 不补 Code Shape；Code Shape v0.2 仅 Python。TS backend 的 Code Shape 是 v0.5 候选。如果 conformance fixture 06 仅在 Python backend 运行，runner 需 skip：

```typescript
// runner.ts
if (fixture.id === "06-code-shape" && backend !== "python") {
  test.skip(`${fixture.id} on ${backend}: not yet supported`);
  return;
}
```

## 9. 验收标准（来自 PRD §7.1）

- [ ] 5 种 shape 在 Python backend 上生成可执行的 pytest assertion
- [ ] runtime helpers 通过 Python pytest 单测
- [ ] conformance fixture 06 在 Python backend 通过
- [ ] `_STELE_ALLOWED_MODULES` 扩展不破坏现有 fixtures（fixture 01-05 仍通过）
- [ ] `examples/finance-guard/` 添加 class-shape 演示
