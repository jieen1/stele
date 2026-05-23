# 07 — 跨语言适配策略

## 一、Stele 的语言无关定位

> Stele 是"填补宿主语言契约空白"的 AST 静态分析层。

各语言对契约的"原生支持度"差异很大。Stele 的工作：
- **强语言**（Rust）：验证一致性，agent 用原生类型表达，Stele 双重保险
- **中等语言**（TS / Java）：用 phantom types / sealed / annotations，Stele 做检查
- **弱语言**（Go / Python）：宿主语言能力不足，Stele 全权代为校验

## 二、Phase B 三机制 × 5 语言可行性矩阵

| 机制 | TypeScript | Rust | Java | Go | Python |
| --- | --- | --- | --- | --- | --- |
| Trace-Based Policy | ⭐⭐⭐ AST 提取容易 | ⭐⭐⭐ syn crate | ⭐⭐⭐ JavaParser | ⭐⭐⭐ go/ast | ⭐⭐⭐ ast 内置 |
| Type State | ⭐⭐⭐ phantom 自然 | ⭐⭐⭐⭐ 原生 typestate | ⭐⭐ sealed (17+) | ⭐ 多 struct 丑陋 | ⭐⭐⭐ Generic + mypy |
| Effect System | ⭐⭐⭐ JSDoc / phantom | ⭐⭐⭐ marker traits | ⭐⭐⭐ annotation | ⭐⭐ 注释约定 | ⭐⭐⭐ decorator |

图例：⭐⭐⭐⭐ 原生天然 / ⭐⭐⭐ 良好支持 / ⭐⭐ 可行但丑 / ⭐ 困难

## 三、Phase B 实施波次

### 第一波（Phase B 主线交付）

**语言**：TypeScript + Python
**机制**：三机制完整实现 + 5 个 backend 的 CallGraphExtractor 全部实现（基础抽象层不分波次）

**理由**：
- TS + Python 是 Stele 当前主要 case
- 这两个语言的注解 / 类型表达形态最简单（JSDoc / decorator / phantom）
- 验证整套机制能跑通
- CallGraphExtractor 5 语言都要做——基础设施统一时机投资

工程量：~50 天（1.5 月，1 人）。

### 第二波（Phase B 收尾）

**语言**：Go + Java + Rust
**机制**：三机制的语言特定 evaluator 增强

每语言：~10-15 天。

**第二波启动条件**：第一波 stable run 至少 2 周（生产用户反馈无重大问题）。

### 第三波（不在 Phase B 范围）

- Effect System 的预制 effect annotation 包（`@stele/preset-typeorm` 等）
- 语言原生类型层验证（Rust trait + TS phantom 双重校验）

## 四、CallGraphExtractor 5 语言实现摘要

### TypeScript

```typescript
// packages/backend-typescript/src/extractors/calls.ts
import * as ts from "typescript";

export const tsCallGraphExtractor: CallGraphExtractor = {
  language: "typescript",
  async extract(options) {
    const program = ts.createProgram({...});
    const checker = program.getTypeChecker();
    const nodes: CallGraphNode[] = [];
    const edges: CallGraphEdge[] = [];
    
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.fileName.includes("node_modules")) continue;
      
      ts.forEachChild(sourceFile, function visit(node) {
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ...) {
          nodes.push(buildCallGraphNode(node, sourceFile));
        }
        
        if (ts.isCallExpression(node)) {
          const callee = resolveCallee(node, checker);
          const caller = findEnclosingFunction(node);
          if (callee && caller) {
            edges.push(buildCallGraphEdge(caller, callee, node));
          }
        }
        
        ts.forEachChild(node, visit);
      });
    }
    
    return { schemaVersion: "1", language: "typescript", ...buildGraph(nodes, edges) };
  },
  async extractIncremental(options) { /* delta-based */ }
};
```

工程量：3-5 天。

### Python

```python
# packages/backend-python/extractors/calls.py
import ast
from typing import Iterator

def extract_call_graph(project_root: str, source_files: list[str]) -> CallGraph:
    nodes: list[CallGraphNode] = []
    edges: list[CallGraphEdge] = []
    
    for filepath in source_files:
        with open(filepath) as f:
            tree = ast.parse(f.read(), filename=filepath)
        
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                nodes.append(build_node(node, filepath))
            
            if isinstance(node, ast.Call):
                caller = find_enclosing_func(node, tree)
                callee = resolve_callee(node)
                if caller and callee:
                    edges.append(build_edge(caller, callee, node))
    
    return {...}
```

工程量（Round 1 修订）：**7 天**（含 pyright daemon 集成）。

### Python pyright daemon（Round 1 修订 MC-9）

调用解析对 Python 较难（动态语言），引入 pyright 作为辅助。但**冷启动子进程**每次 stele check 重新加载 stdlib + 第三方 stub 要 8-30s，不可接受。

B.2 阶段实现 **pyright daemon 模式**：

1. stele 首次需要 type info 时，启动 `pyright --watch` 长连接子进程
2. 通过 JSON-RPC 与 daemon 通信
3. 子进程生命周期由 stele 管理：
   - 项目首次 check 启动
   - 空闲 5 分钟自动停（节省资源）
   - 项目根目录变更自动重启
4. stele 退出时 graceful shutdown daemon（避免僵尸进程）

daemon 启动一次后，后续 check 通信 < 200ms。

工程量从 3 天调到 7 天（含 daemon 生命周期 + 跨平台子进程管理 + IPC 协议设计 + 优雅退出）。

### Go

```go
// packages/backend-go/extractors/calls.go
package extractors

import (
    "go/ast"
    "go/parser"
    "go/token"
    "go/types"
    "golang.org/x/tools/go/packages"
)

func ExtractCallGraph(projectRoot string) (*CallGraph, error) {
    cfg := &packages.Config{Mode: packages.LoadAllSyntax, Dir: projectRoot}
    pkgs, err := packages.Load(cfg, "./...")
    if err != nil { return nil, err }
    
    var nodes []CallGraphNode
    var edges []CallGraphEdge
    
    for _, pkg := range pkgs {
        for _, file := range pkg.Syntax {
            ast.Inspect(file, func(n ast.Node) bool {
                if funcDecl, ok := n.(*ast.FuncDecl); ok {
                    nodes = append(nodes, buildNode(funcDecl, pkg))
                }
                if call, ok := n.(*ast.CallExpr); ok {
                    if callee := resolveCallee(call, pkg.TypesInfo); callee != nil {
                        edges = append(edges, buildEdge(call, callee, pkg))
                    }
                }
                return true
            })
        }
    }
    
    return &CallGraph{...}, nil
}
```

工程量：4 天。Go 的 type info 在 `pkg.TypesInfo`，比 Python 静态分析更可靠。

### Java

```java
// packages/backend-java/extractors/CallExtractor.java
package io.stele.extractors;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.*;

public class CallExtractor {
    public CallGraph extract(Path projectRoot) {
        TypeSolver typeSolver = new CombinedTypeSolver(
            new ReflectionTypeSolver(),
            new JavaParserTypeSolver(projectRoot.toFile())
        );
        JavaSymbolSolver symbolSolver = new JavaSymbolSolver(typeSolver);
        StaticJavaParser.getConfiguration().setSymbolResolver(symbolSolver);
        
        List<CallGraphNode> nodes = new ArrayList<>();
        List<CallGraphEdge> edges = new ArrayList<>();
        
        for (Path javaFile : findJavaFiles(projectRoot)) {
            CompilationUnit cu = StaticJavaParser.parse(javaFile);
            cu.findAll(MethodDeclaration.class).forEach(m -> nodes.add(buildNode(m)));
            cu.findAll(MethodCallExpr.class).forEach(call -> {
                try {
                    ResolvedMethodDeclaration resolved = call.resolve();
                    edges.add(buildEdge(call, resolved));
                } catch (UnsolvedSymbolException e) {
                    // record unresolved
                }
            });
        }
        
        return new CallGraph(nodes, edges);
    }
}
```

工程量：4 天。

### Rust

```rust
// packages/backend-rust/extractors/calls.rs
use syn::{visit::Visit, ItemFn, ExprCall};
use std::collections::HashMap;

pub fn extract_call_graph(project_root: &Path) -> Result<CallGraph> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    
    for rust_file in find_rust_files(project_root)? {
        let source = std::fs::read_to_string(&rust_file)?;
        let syntax_tree = syn::parse_file(&source)?;
        
        let mut visitor = CallVisitor {
            current_fn: None,
            nodes: &mut nodes,
            edges: &mut edges,
            file_path: rust_file.clone(),
        };
        visitor.visit_file(&syntax_tree);
    }
    
    Ok(CallGraph { nodes, edges, ... })
}

struct CallVisitor<'a> { /* ... */ }
impl<'a, 'ast> Visit<'ast> for CallVisitor<'a> {
    fn visit_item_fn(&mut self, item: &'ast ItemFn) { /* push node */ }
    fn visit_expr_call(&mut self, call: &'ast ExprCall) { /* push edge */ }
}
```

工程量：4 天。Rust 的 type resolution 在 macro 展开后会丢，可选用 `rust-analyzer` 辅助但增加复杂度。

## 五、Effect 注解解析的语言特定差异

每个 backend 还要实现 EffectAnnotationExtractor：

### TypeScript

读取 JSDoc：

```typescript
// 提取 /** @stele:effects db.read,db.write */
function parseTsEffectsFromJsDoc(node: ts.Node): string[] | null {
  const jsDoc = ts.getJSDocTags(node);
  for (const tag of jsDoc) {
    if (tag.tagName.text === "stele:effects") {
      return tag.comment?.split(",").map(s => s.trim()) ?? [];
    }
  }
  return null;
}
```

phantom type 解析为可选：
```typescript
// 提取 function foo(): Effect<"db.read", T>
function parseEffectsFromPhantomType(node: ts.FunctionDeclaration, checker: ts.TypeChecker): string[] | null {
  const returnType = checker.getTypeAtLocation(node.type);
  // 检查是否是 Effect<E, T>
  if (isEffectType(returnType)) return extractEffectTags(returnType);
  return null;
}
```

### Python

```python
# 提取 @stele.effects("db.read", "db.write")
def parse_effects_from_decorator(func_def: ast.FunctionDef) -> list[str] | None:
    for decorator in func_def.decorator_list:
        if isinstance(decorator, ast.Call) and is_stele_effects(decorator.func):
            return [arg.value for arg in decorator.args if isinstance(arg, ast.Constant)]
    return None
```

### Go

```go
// 提取 // stele:effects db.read,db.write
func parseEffectsFromComment(funcDecl *ast.FuncDecl) []string {
    if funcDecl.Doc == nil { return nil }
    for _, comment := range funcDecl.Doc.List {
        if strings.HasPrefix(comment.Text, "// stele:effects ") {
            return strings.Split(strings.TrimPrefix(comment.Text, "// stele:effects "), ",")
        }
    }
    return nil
}
```

### Java

```java
// 提取 @Effects({"db.read", "db.write"})
public List<String> parseEffectsFromAnnotation(MethodDeclaration method) {
    return method.getAnnotationByName("Effects")
        .filter(a -> a.isSingleMemberAnnotationExpr())
        .map(a -> ((SingleMemberAnnotationExpr) a).getMemberValue())
        .filter(v -> v.isArrayInitializerExpr())
        .map(v -> ((ArrayInitializerExpr) v).getValues().stream()
            .map(e -> e.asStringLiteralExpr().asString())
            .toList())
        .orElse(Collections.emptyList());
}
```

需要项目里有 `@stele.Effects` annotation 定义（要么用户自己定义、要么 `@stele/preset-java` 提供）。

### Rust

```rust
// 提取 #[stele::effects(db::read, db::write)]
fn parse_effects_from_attribute(attrs: &[Attribute]) -> Option<Vec<String>> {
    for attr in attrs {
        if attr.path.is_ident("stele::effects") {
            return Some(extract_meta_list(&attr.tokens));
        }
    }
    None
}
```

需要 `stele-rust` crate 提供 attribute macro 定义（用户依赖）。

## 六、Type State 推断的语言特定差异

### TypeScript / Rust

phantom type 直接读类型参数：

```typescript
const order: Order<"Draft"> = createOrder();
// tsc TypeChecker.getTypeAtLocation(order).aliasTypeArguments → ["Draft"]
```

### Python

mypy / pyright 子进程：

```python
# subprocess: pyright --outputjson <file>
# 解析输出找 "type": "Order[Draft]"
```

注意：mypy 的 dataclass 泛型支持不完美，phantom 模式可能要用 `typing.cast`。

### Go（Round 1 修订：不再声称语义等价）

Go 没有 phantom types，必须用 separate struct types：

```go
type DraftOrder struct { /* ... */ }
type SubmittedOrder struct { /* ... */ }

func (o DraftOrder) Submit() SubmittedOrder { /* ... */ }
```

Stele CDL：

```cdl
(type-state ORDER_LIFECYCLE
  (target "src/order/order.go::*Order")    ; glob
  (states Draft Submitted Paid)
  (state-type-mapping
    Draft     "src/order/order.go::DraftOrder"
    Submitted "src/order/order.go::SubmittedOrder"
    Paid      "src/order/order.go::PaidOrder")
  ...)
```

**致命局限（Round 1 reviewer A 反例 CE4）**：Go 的 separate struct 是**完全独立的类型**，共享方法需要 interface，但 interface **抹掉状态**：

```go
func PrintOrder(o interface{ Id() string }) { /* o 是 interface，状态信息丢失 */ }
PrintOrder(draftOrder)      // 合法
PrintOrder(submittedOrder)  // 合法
```

PrintOrder 是地道 Go 代码，但 type-state evaluator 看不见状态。state-type-mapping 在此**完全失效**。

**Stele 在 Go 上的诚实立场**：

1. **type-state mode 默认 `off`**（profile.yaml 里 `type_driven.type_state.mode: off`）
2. 仅在显式 opt-in 目录启用（`type_driven.type_state.enabled_paths: ["src/order/strict/**"]`）
3. Go 项目主要靠 **trace-policy + effect-policy** 表达"什么操作不能做什么"
4. **不假装 separate-types ≡ TS phantom**
5. type-state 在 Go 是 **B.3 second-class** 功能

### Java

Java 17+ 用 sealed types 自动识别（first-class 支持）：

```java
sealed interface Order permits DraftOrder, SubmittedOrder, PaidOrder {}
```

Stele 自动识别 sealed types 推断状态映射（无需 state-type-mapping）。

Java < 17 项目：type-state mode default off，与 Go 同样处理。

## 七、Phase B 推荐落地路径（一句话）

> **先在 TypeScript + Python 上把三个机制（trace / typestate / effect）完整跑通，建立 5 语言 CallGraphExtractor 基础，Go/Java/Rust 的 evaluator 细节作为第二波。**

这样：
- 第一波（~50 天）：5 语言基础设施 + 2 语言完整体验
- 用户可以在 TS / Python 项目立即用上完整 Phase B 能力
- Go / Java / Rust 用户可以用 trace-policy（语言无关），等第二波获得 typestate / effect 完整支持
- 基础设施（CallGraph 抽象）一次到位，第二波只是 evaluator 增强

## 八、对未来语言的扩展性

新增语言（如 Kotlin, Swift, C#）只需：

1. 实现 `CallGraphExtractor` trait
2. 实现 `EffectAnnotationExtractor` trait（可选）
3. 实现 `TypeStateInferenceExtractor` trait（可选）

三个 evaluator 完全不动。这是 Phase B 跨语言架构最有价值的产物。
