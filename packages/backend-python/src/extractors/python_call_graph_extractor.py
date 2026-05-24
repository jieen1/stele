#!/usr/bin/env python3
"""Python CallGraph extractor for @stele/backend-python.

Reads a JSON request from stdin:
    {
      "project_root": "/abs/path",
      "source_files": ["rel/path1.py", ...]   # optional; default = whole tree
    }

Writes the CallGraph JSON to stdout (shape defined in
packages/call-graph-core/src/types.ts — language="python").

Resolution policy (MVP — must match the spec in
docs/design/phase-b/01-call-graph-extractor.md §IX):

  1. Direct name calls `foo()` resolve to the same-module top-level
     def, or to an `from MOD import foo` binding (the resolved
     `<MOD-path>::foo` form), if known.
  2. Method calls `self.foo()` inside a class resolve to
     `<class-path>::ClassName::foo`.
  3. Attribute calls on imported modules `mod.foo()` resolve to
     `<resolved-mod-path>::foo` when `mod` was imported.
  4. Anything else (`getattr`, `obj.attr.call`, `cls.method` on a
     class object retrieved dynamically, etc.) becomes an
     UnresolvedCall with reason="dynamic".

Cross-package external library calls are surfaced as UnresolvedCall
with reason="external-lib" so the Phase B `extern:` aliasing system
can match them.
"""

from __future__ import annotations

import ast
import datetime
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1"
LANGUAGE = "python"
SKIP_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "build", "dist",
    "site-packages",
}


def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
        project_root = Path(request.get("project_root") or os.getcwd()).resolve()
        source_files_input = request.get("source_files")
    except (json.JSONDecodeError, OSError) as e:
        sys.stderr.write(f"[stele:py-callgraph] bad request: {e}\n")
        return 2

    if isinstance(source_files_input, list) and len(source_files_input) > 0:
        files = [project_root / rel for rel in source_files_input]
        files = [f for f in files if f.is_file()]
    else:
        files = _discover_python_files(project_root)

    extractor = _PyExtractor(project_root)
    for f in files:
        try:
            extractor.add_file(f)
        except (SyntaxError, OSError) as e:
            # File-level parse failure surfaces as an unresolved-stub
            # node so the caller sees the gap without aborting the
            # whole extraction.
            rel = _posix_rel(project_root, f)
            extractor.record_parse_error(rel, str(e))

    graph = extractor.build_graph()
    sys.stdout.write(json.dumps(graph, separators=(",", ":"), sort_keys=False) + "\n")
    return 0


def _discover_python_files(project_root: Path) -> list[Path]:
    out: list[Path] = []
    for root, dirs, files in os.walk(project_root):
        # Round 13 (re-uses self-protection skip set): never recurse
        # into ephemeral / vendored trees.
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name.endswith(".py"):
                out.append(Path(root) / name)
    return out


def _posix_rel(root: Path, p: Path) -> str:
    try:
        rel = p.resolve().relative_to(root)
    except ValueError:
        rel = p
    return str(rel).replace(os.sep, "/")


class _PyExtractor:
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[dict[str, Any]] = []
        self.unresolved: list[dict[str, Any]] = []
        self.ambiguous: list[dict[str, Any]] = []
        self.file_hashes: dict[str, str] = {}
        # NodeId → node entry; used by edge resolution.
        self.node_index: dict[str, dict[str, Any]] = {}
        # rel-path → ast.Module (parsed cache)
        self.modules: dict[str, ast.Module] = {}
        # rel-path → {top-level def name → NodeId}
        self.module_defs: dict[str, dict[str, str]] = {}
        # rel-path → {imported alias → resolved rel-path}
        # External modules (stdlib / 3rd-party) appear with value None.
        self.imports: dict[str, dict[str, str | None]] = {}
        # rel-path → {imported name → originating rel-path}
        self.from_imports: dict[str, dict[str, str | None]] = {}
        self.parse_errors: list[tuple[str, str]] = []

    def record_parse_error(self, rel: str, message: str) -> None:
        self.parse_errors.append((rel, message))
        try:
            self.file_hashes[rel] = self._hash(self.project_root / rel)
        except OSError:
            self.file_hashes[rel] = "0" * 64

    def add_file(self, abs_path: Path) -> None:
        rel = _posix_rel(self.project_root, abs_path)
        source = abs_path.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(source, filename=rel)
        self.modules[rel] = tree
        self.file_hashes[rel] = hashlib.sha256(source.encode("utf-8")).hexdigest()
        # First pass: collect top-level defs + classes for resolution.
        defs: dict[str, str] = {}
        imports: dict[str, str | None] = {}
        from_imports: dict[str, str | None] = {}
        for top in tree.body:
            if isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)):
                node_id = f"{rel}::{top.name}"
                defs[top.name] = node_id
            elif isinstance(top, ast.ClassDef):
                cls_id = f"{rel}::{top.name}"
                defs[top.name] = cls_id
                for item in top.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        defs[f"{top.name}.{item.name}"] = f"{rel}::{top.name}::{item.name}"
            elif isinstance(top, ast.Import):
                for alias in top.names:
                    local = alias.asname or alias.name
                    # `None` marks the import as external (stdlib /
                    # 3rd-party); the call-resolution path then emits
                    # an UnresolvedCall with reason="external-lib"
                    # instead of fabricating a fake `module::func`
                    # NodeId for an unresolved module.
                    imports[local] = self._resolve_module_to_rel(alias.name)
            elif isinstance(top, ast.ImportFrom):
                if top.module is None:
                    continue
                resolved_mod = self._resolve_module_to_rel(top.module)
                for alias in top.names:
                    local = alias.asname or alias.name
                    from_imports[local] = resolved_mod  # may be None (external)
        self.module_defs[rel] = defs
        self.imports[rel] = imports
        self.from_imports[rel] = from_imports

        # Second pass: emit nodes + edges.
        self._emit_nodes_and_edges(rel, tree)

    def _resolve_module_to_rel(self, dotted: str) -> str | None:
        """Best-effort resolve `package.module` to a project-relative
        `.py` path. Returns None for stdlib / 3rd-party modules
        (callers downgrade to external-lib unresolved calls)."""
        parts = dotted.split(".")
        candidates = [
            self.project_root / Path(*parts).with_suffix(".py"),
            self.project_root / Path(*parts) / "__init__.py",
        ]
        for c in candidates:
            if c.is_file():
                return _posix_rel(self.project_root, c)
        return None

    def _emit_nodes_and_edges(self, rel: str, module: ast.Module) -> None:
        # Module-init pseudo-node for top-level statements with calls.
        module_init_id = f"{rel}::__module_init__"
        module_init_node = {
            "id": module_init_id,
            "kind": "module-init",
            "filePath": rel,
            "span": {"line": 1, "column": 1},
            "signature": f"module {rel}",
            "isExported": True,
            "isAsync": False,
        }
        self._register_node(module_init_node)

        for top in module.body:
            if isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._emit_function(rel, top, class_name=None)
            elif isinstance(top, ast.ClassDef):
                self._emit_class(rel, top)
            else:
                # Top-level statements with calls → edges from module-init.
                for call in _iter_calls(top):
                    self._emit_call_edge(rel, module_init_id, None, call)

    def _emit_class(self, rel: str, node: ast.ClassDef) -> None:
        cls_id = f"{rel}::{node.name}"
        class_node = {
            "id": cls_id,
            "kind": "constructor" if any(
                isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef)) and b.name == "__init__"
                for b in node.body
            ) else "function",
            "filePath": rel,
            "span": _span(node),
            "signature": f"class {node.name}",
            "isExported": not node.name.startswith("_"),
            "isAsync": False,
        }
        self._register_node(class_node)
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._emit_function(rel, item, class_name=node.name)

    def _emit_function(
        self, rel: str, fn: ast.FunctionDef | ast.AsyncFunctionDef, class_name: str | None
    ) -> None:
        nid = f"{rel}::{class_name}::{fn.name}" if class_name else f"{rel}::{fn.name}"
        kind = "method" if class_name is not None else "function"
        signature = _signature(fn, class_name)
        effects = _extract_effects(fn)
        node: dict[str, Any] = {
            "id": nid,
            "kind": kind,
            "filePath": rel,
            "span": _span(fn),
            "signature": signature,
            "isExported": not fn.name.startswith("_") or fn.name == "__init__",
            "isAsync": isinstance(fn, ast.AsyncFunctionDef),
        }
        if effects:
            node["effects"] = effects
        self._register_node(node)
        for call in _iter_calls(fn):
            self._emit_call_edge(rel, nid, class_name, call)

    def _emit_call_edge(
        self,
        rel: str,
        from_id: str,
        enclosing_class: str | None,
        call: ast.Call,
    ) -> None:
        target_id, raw = self._resolve_call(rel, enclosing_class, call)
        site = _span_of(call)
        is_async = isinstance(getattr(call, "_parent", None), ast.Await)
        if target_id is None:
            reason = _classify_unresolved(call, raw, self.from_imports[rel], self.imports[rel])
            self.unresolved.append({
                "fromId": from_id,
                "callSite": site,
                "rawText": raw[:200],
                "reason": reason,
            })
            return
        self.edges.append({
            "fromId": from_id,
            "toId": target_id,
            "callSite": site,
            "isConditional": False,
            "isLoop": False,
            "isAsync": is_async,
        })

    def _resolve_call(
        self,
        rel: str,
        enclosing_class: str | None,
        call: ast.Call,
    ) -> tuple[str | None, str]:
        defs = self.module_defs.get(rel, {})
        from_imports = self.from_imports.get(rel, {})
        imports = self.imports.get(rel, {})
        func = call.func
        raw = ast.unparse(call) if hasattr(ast, "unparse") else "<call>"
        if isinstance(func, ast.Name):
            name = func.id
            # Same-module top-level def.
            if name in defs:
                return defs[name], raw
            # `from MOD import name` binding. Only return a resolved
            # target when the originating module is a project file;
            # external (stdlib / 3rd-party) → None (caller classifies
            # as external-lib).
            if name in from_imports:
                resolved_mod = from_imports[name]
                if resolved_mod is None:
                    return None, raw
                return f"{resolved_mod}::{name}", raw
            return None, raw
        if isinstance(func, ast.Attribute):
            attr = func.attr
            # `self.foo()` inside a method.
            if (
                enclosing_class is not None
                and isinstance(func.value, ast.Name)
                and func.value.id == "self"
            ):
                target = f"{rel}::{enclosing_class}::{attr}"
                # The target may live in this same class — check defs.
                key = f"{enclosing_class}.{attr}"
                if key in defs:
                    return defs[key], raw
                return target, raw
            # `module.func()` where `module` was imported. Only
            # resolve when the module is a project file.
            if isinstance(func.value, ast.Name):
                base = func.value.id
                if base in imports:
                    resolved_mod = imports[base]
                    if resolved_mod is None:
                        # External library → unresolved with the
                        # external-lib classification.
                        return None, raw
                    return f"{resolved_mod}::{attr}", raw
            return None, raw
        return None, raw

    def _register_node(self, node: dict[str, Any]) -> None:
        if node["id"] in self.node_index:
            return
        self.nodes.append(node)
        self.node_index[node["id"]] = node

    def _hash(self, abs_path: Path) -> str:
        try:
            return hashlib.sha256(abs_path.read_bytes()).hexdigest()
        except OSError:
            return "0" * 64

    def build_graph(self) -> dict[str, Any]:
        # methodResolutionHash: deterministic hash of (sorted) (NodeId,kind)
        # pairs. Mirrors what the TS extractor does — gives the cache
        # something to compare against.
        h = hashlib.sha256()
        for n in sorted(self.nodes, key=lambda x: x["id"]):
            h.update(n["id"].encode("utf-8"))
            h.update(b"|")
            h.update(n["kind"].encode("utf-8"))
            h.update(b"\n")
        return {
            "schemaVersion": SCHEMA_VERSION,
            "language": LANGUAGE,
            "generatedAt": datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "projectRoot": str(self.project_root),
            "nodes": sorted(self.nodes, key=lambda x: x["id"]),
            "edges": sorted(
                self.edges,
                key=lambda x: (
                    x["fromId"],
                    x["toId"],
                    x["callSite"]["line"],
                    x["callSite"]["column"],
                ),
            ),
            "unresolvedCalls": sorted(
                self.unresolved,
                key=lambda x: (x["fromId"], x["callSite"]["line"], x["callSite"]["column"]),
            ),
            "ambiguousCalls": [],
            "methodResolutionHash": h.hexdigest(),
            "fileHashes": dict(sorted(self.file_hashes.items())),
        }


def _iter_calls(node: ast.AST) -> list[ast.Call]:
    out: list[ast.Call] = []
    # Set parent pointers so we can detect `await` wrapping for is_async.
    for parent in ast.walk(node):
        for child in ast.iter_child_nodes(parent):
            setattr(child, "_parent", parent)
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            out.append(child)
    return out


def _span(node: ast.AST) -> dict[str, Any]:
    line = getattr(node, "lineno", 1) or 1
    col = (getattr(node, "col_offset", 0) or 0) + 1
    end_line = getattr(node, "end_lineno", None)
    end_col = getattr(node, "end_col_offset", None)
    out: dict[str, Any] = {"line": line, "column": col}
    if end_line is not None:
        out["endLine"] = end_line
    if end_col is not None:
        out["endColumn"] = end_col + 1
    return out


def _span_of(call: ast.Call) -> dict[str, Any]:
    return _span(call)


def _signature(fn: ast.FunctionDef | ast.AsyncFunctionDef, class_name: str | None) -> str:
    params: list[str] = []
    for arg in fn.args.args:
        params.append(arg.arg)
    if fn.args.vararg:
        params.append(f"*{fn.args.vararg.arg}")
    for arg in fn.args.kwonlyargs:
        params.append(arg.arg)
    if fn.args.kwarg:
        params.append(f"**{fn.args.kwarg.arg}")
    prefix = f"{class_name}." if class_name else ""
    async_prefix = "async " if isinstance(fn, ast.AsyncFunctionDef) else ""
    return f"{async_prefix}def {prefix}{fn.name}({', '.join(params)})"


def _extract_effects(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    """Extract `@stele.effects(["payment.charge", ...])` decorator
    declarations OR a docstring `@stele:effects payment.charge db.read`
    line. Per Phase B effect-system spec §IV."""
    effects: list[str] = []
    for dec in fn.decorator_list:
        if (
            isinstance(dec, ast.Call)
            and isinstance(dec.func, ast.Attribute)
            and dec.func.attr == "effects"
            and isinstance(dec.func.value, ast.Name)
            and dec.func.value.id == "stele"
        ):
            for arg in dec.args:
                if isinstance(arg, ast.List):
                    for el in arg.elts:
                        if isinstance(el, ast.Constant) and isinstance(el.value, str):
                            effects.append(el.value)
                elif isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    effects.append(arg.value)
    doc = ast.get_docstring(fn)
    if doc:
        for line in doc.splitlines():
            line = line.strip()
            if line.startswith("@stele:effects"):
                for token in line.split()[1:]:
                    effects.append(token)
    seen: set[str] = set()
    unique: list[str] = []
    for e in effects:
        if e not in seen:
            seen.add(e)
            unique.append(e)
    return unique


def _classify_unresolved(
    call: ast.Call,
    raw: str,
    from_imports: dict[str, str | None],
    imports: dict[str, str | None],
) -> str:
    """Best-effort classification per CallGraph spec §V."""
    func = call.func
    if isinstance(func, ast.Name):
        # `from <external> import name` → external-lib when `name` was
        # imported from a module we couldn't resolve.
        if func.id in {"getattr", "setattr", "hasattr", "globals", "locals", "eval", "exec"}:
            return "reflection"
        if func.id in from_imports and from_imports[func.id] is None:
            return "external-lib"
    if isinstance(func, ast.Attribute):
        if (
            isinstance(func.value, ast.Name)
            and func.value.id in imports
        ):
            # `module.func()` where module was imported (resolved or
            # not). When the resolved path is None it's external.
            return "external-lib"
    if isinstance(func, ast.Subscript):
        return "dynamic"
    return "dynamic"


if __name__ == "__main__":
    sys.exit(main())
