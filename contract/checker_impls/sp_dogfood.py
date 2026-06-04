"""Round 4/7+ CLAUDE.md dogfood self-protection checkers."""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
from typing import Any

from sp_shared import *  # noqa: F401,F403

__all__ = [
    "_ESM_RELATIVE_IMPORT_RE",
    "_ESM_SIDE_EFFECT_IMPORT_RE",
    "esm_relative_imports_keep_js",
    "_HOOK_SCRIPTS_DOGFOOD",
    "_extract_catch_bodies",
    "hook_entrypoints_fail_closed",
    "_STELE_PACKAGE_PREFIX_RE",
    "_CORE_ALLOWED_DEPS",
    "core_has_no_stele_deps",
    "_CJS_REQUIRE_RE",
    "_VERSION_TS_ALLOWLIST",
    "no_cjs_require_in_ts_source",
    "tsconfig_base_strict_mode",
    "_SHIM_MARKER_RE",
    "no_backward_compat_shims",
    "_CORE_PURITY_FORBIDDEN",
    "_CORE_PURITY_IMPORT_GATES",
    "_CORE_PURITY_ALLOWLIST",
    "core_engine_purity",
    "_CLI_FS_WRITE_RE",
    "_CLI_PATH_SAFETY_ALLOWLIST",
    "_CLI_PATH_SAFETY_SCAN_DIRS",
    "_PATH_IMPORT_NAMESPACE_RE",
    "_PATH_IMPORT_DEFAULT_RE",
    "_PATH_IMPORT_NAMED_RE",
    "_KNOWN_PATH_HELPERS",
    "_path_module_bindings",
    "cli_io_through_path_utils",
    "_LOCALECOMPARE_RE",
    "_LOCALECOMPARE_ALLOWLIST",
    "no_bare_locale_compare",
    "_BASH_EXTRACTOR_NAMES",
    "_BASH_EXTRACTOR_CONSUMERS",
    "_BASH_EXTRACTOR_MODULE",
    "bash_extractors_shared",
    "inline_version_sync",
]




# ---------------------------------------------------------------------------
# Round 4 Phase 3 — Stele dogfood checkers
#
# CLAUDE.md / spec rules that previously had zero mechanical enforcement now
# get a checker apiece. Each one is language-independent (regex on file
# content) so it works regardless of the project's targetLanguage — that
# lets Stele dogfood Phase B-shape rules even before per-language extractors
# land for Python/Go/Rust/Java.
# ---------------------------------------------------------------------------


# Round 5 K-01: match BOTH single-line `import { … } from "./x"` and the
# multi-line idiom used heavily in this codebase:
#     import {
#       foo,
#       bar,
#     } from "./x.js";
# The legacy regex used `[^\n]*?` which stopped at the first newline and
# missed every multi-line case (~30 files in packages/cli/src alone).
# Also covers bare side-effect imports `import "./x.js";` (no `from`).
_ESM_RELATIVE_IMPORT_RE = re.compile(
    r"""
    (?:import|export)               # import / export keyword
    \b                              # word boundary
    [^;]*?                          # arbitrary content (could span newlines)
    \bfrom\s+                       # "from "
    ["'](\.[^"']+)["']              # captured relative specifier (group 1)
    """,
    re.MULTILINE | re.VERBOSE | re.DOTALL,
)


# Side-effect import: `import "./x.js";` (no `from`). Captured separately
# so the simpler form isn't confused by the [^;]*? consuming too much.
_ESM_SIDE_EFFECT_IMPORT_RE = re.compile(
    r'^\s*import\s+["\'](\.[^"\']+)["\']',
    re.MULTILINE,
)




def esm_relative_imports_keep_js(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 E-02: CLAUDE.md says "ESM only — TypeScript files use `.js`
    extensions in relative imports". Without enforcement an agent can
    drop the `.js` suffix and the npm consumer's runtime resolution
    fails (Node ESM does not infer extensions).

    Scan every `packages/*/src/**/*.ts` file. For each relative import
    (`./foo` or `../foo`) assert the specifier ends in `.js`. We allow
    a few well-known directory-shaped specifiers (e.g. `./foo/index`
    is not idiomatic in this repo but harmless if present).
    """
    violations: list[dict[str, Any]] = []
    for pkg_dir in sorted(_PACKAGES_DIR.glob("*")):
        if not pkg_dir.is_dir():
            continue
        src_dir = pkg_dir / "src"
        if not src_dir.is_dir():
            continue
        for ts_file in src_dir.rglob("*.ts"):
            if "node_modules" in ts_file.parts or "dist" in ts_file.parts:
                continue
            if str(ts_file).endswith(".d.ts"):
                continue
            try:
                content = ts_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for re_pattern in (_ESM_RELATIVE_IMPORT_RE, _ESM_SIDE_EFFECT_IMPORT_RE):
                for m in re_pattern.finditer(content):
                    specifier = m.group(1)
                    if specifier.endswith(
                        (".json", ".css", ".svg", ".png", ".jpg", ".node", ".js"),
                    ):
                        continue
                    line_no = content.count("\n", 0, m.start()) + 1
                    violations.append({
                        "file": str(ts_file.relative_to(_REPO_ROOT)),
                        "line": line_no,
                        "column": None,
                        "message": (
                            f"relative import \"{specifier}\" must end in `.js` "
                            f"so the file resolves under native ESM (CLAUDE.md)"
                        ),
                    })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} relative TS import(s) missing `.js` suffix: "
                + "; ".join(
                    f"{v['file']}:{v['line']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




# Permission-gate hooks: must fail closed (deny on uncaught error).
# Observation / context hooks (observation-hook.js, lifecycle-context.js)
# are intentionally fail-OPEN by design — a logging or context-injection
# error must NOT block the agent's tool call. CLAUDE.md "Hooks fail closed"
# applies to the permission-gating subset only.
_HOOK_SCRIPTS_DOGFOOD = [
    "packages/claude-code-plugin/scripts/pre-tool-protect.js",
    "packages/claude-code-plugin/scripts/stop-validate.js",
]




def _extract_catch_bodies(source: str) -> list[str]:
    """Round 5 K-02 + Round 7 L-03: extract every `catch (...) { ... }`
    block body via QUOTE-AWARE brace counting. L-03 noted that the
    pre-Round-7 helper treated every `{`/`}` literally, so a catch
    body whose first statement was `const msg = "}";` would terminate
    at the brace inside the string and the trailing `failClosed(...)`
    would fall outside the extracted body. Now skips past `"..."`,
    `'...'`, and `` `...` `` segments while counting braces.
    """
    bodies: list[str] = []
    catch_re = re.compile(r"\}\s*catch\s*(?:\([^)]*\))?\s*\{")
    for match in catch_re.finditer(source):
        lb = match.end() - 1  # the `{`
        depth = 1
        i = lb + 1
        in_string: str | None = None  # quote char or None
        n = len(source)
        while i < n and depth > 0:
            ch = source[i]
            if in_string is not None:
                if ch == "\\":
                    # Escape — skip next char.
                    i += 2
                    continue
                if ch == in_string:
                    in_string = None
                i += 1
                continue
            if ch == '"' or ch == "'" or ch == "`":
                in_string = ch
                i += 1
                continue
            if ch == "/" and i + 1 < n and source[i + 1] == "/":
                # Line comment — skip to newline.
                nl = source.find("\n", i)
                i = n if nl == -1 else nl
                continue
            if ch == "/" and i + 1 < n and source[i + 1] == "*":
                end = source.find("*/", i + 2)
                i = n if end == -1 else end + 2
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    bodies.append(source[lb + 1:i])
                    break
            i += 1
    return bodies




def hook_entrypoints_fail_closed(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 E-04: CLAUDE.md "Hooks fail closed." Generalises the
    legacy `hooks_fail_closed` checker — which only inspected
    `pre-tool-protect.js` — to all four hook entrypoint scripts. Each
    must contain an outer `try { ... } catch (...) { ... process.exit(non-zero) }`
    pattern so an uncaught error in the hook becomes a deny instead of a
    silent allow.
    """
    violations: list[dict[str, Any]] = []
    for rel_path in _HOOK_SCRIPTS_DOGFOOD:
        abs_path = _REPO_ROOT / rel_path
        if not abs_path.is_file():
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "hook script missing",
            })
            continue
        content = abs_path.read_text(encoding="utf-8", errors="replace")
        # Heuristic but strict: require a top-level `try {` followed (within
        # the file) by `catch` and a `process.exit(` with a non-zero arg.
        # The legacy `hooks_fail_closed` checker uses the same pattern; we
        # extend it to the other three scripts.
        # Round 5 K-02: pre-K-02 the check accepted any file-scope
        # `try {` + `catch (...)` + non-zero exit / failClosed combination,
        # whether those tokens sat in the same control-flow scope or not.
        # An adversary could swallow the real catch and have an unrelated
        # success-path `process.exit(BLOCK_EXIT_CODE)` elsewhere in the
        # file and still pass.
        #
        # The new check extracts each catch-block body via brace-counting
        # and asserts at least ONE catch body itself ends with a
        # `process.exit(<non-zero>)` / `process.exit(<NAMED>)` /
        # `failClosed(...)`. The file-scope OR'd check is replaced by a
        # body-scoped AND.
        if "try {" not in content and "try{" not in content:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "no top-level `try` block — hook will not fail closed on errors",
            })
            continue
        catch_bodies = _extract_catch_bodies(content)
        if not catch_bodies:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "no catch handler whose body could be extracted",
            })
            continue
        # Accept any of:
        #   - process.exit(<non-zero-literal>)
        #   - process.exit(<NAMED_CONSTANT>)
        #   - failClosed(...)           (pre-tool-protect's helper)
        #   - blockStop(...)            (stop-validate's helper, calls
        #                                process.exit(STOP_BLOCK_EXIT_CODE))
        body_pattern_re = re.compile(
            r"process\.exit\(\s*(?:[1-9][0-9]*|[A-Z][A-Z0-9_]*)\s*\)|"
            r"failClosed\(|blockStop\(",
        )
        any_catch_fails_closed = any(
            body_pattern_re.search(body) is not None
            for body in catch_bodies
        )
        if not any_catch_fails_closed:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": (
                    "no catch-block body ends with `process.exit(<non-zero>)` or "
                    "`failClosed(...)` — hook may exit silently on a thrown error"
                ),
            })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} hook entrypoint(s) do not fail closed: "
                + "; ".join(
                    f"{v['file']}: {v['message']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




# Round 5 K-03: also catch dynamic `import("@stele/X")` and bare
# side-effect `import "@stele/X"` (no `from` keyword).
_STELE_PACKAGE_PREFIX_RE = re.compile(
    r"""
    (?:
      \bfrom\s+ ["'] @stele/ ([a-z][\w\-]*) ["']     # import ... from "@stele/X"
      |
      \bimport \s* \( \s* ["'] @stele/ ([a-z][\w\-]*) ["']  # await import("@stele/X")
      |
      ^ \s* import \s+ ["'] @stele/ ([a-z][\w\-]*) ["']  # bare side-effect
    )
    """,
    re.VERBOSE | re.MULTILINE,
)


# Round 5 K-03: ALLOW-list, not deny-list. The pre-Round-5 deny-list
# would silently allow imports from a NEW workspace package the
# implementer hadn't anticipated. Inverting to "only @stele/call-graph-core
# is allowed" closes that vector: any new dep must be ADDED here
# explicitly, with a code review, before it can be imported from
# @stele/core.
_CORE_ALLOWED_DEPS = {
    # call-graph-core: the validator uses NodeId helpers from this package
    # at parse time for `extern:` patterns. It's a leaf-level package with
    # no further @stele/* deps, so the layering still holds.
    "call-graph-core",
}




def core_has_no_stele_deps(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 E-08: README/CLAUDE.md describe @stele/core as the leaf of
    the dependency direction (`core ← backend-* ← cli`). Without
    mechanical enforcement, an agent can `import {…} from "@stele/cli"`
    inside `packages/core/src/...` and the package layering silently
    inverts.

    Scan every `packages/core/src/**/*.ts` for `@stele/<x>` imports;
    each one must NOT match `_CORE_FORBIDDEN_DEPS`.
    """
    core_src = _PACKAGES_DIR / "core" / "src"
    if not core_src.is_dir():
        return {"passed": True, "message": "no @stele/core/src", "violations": []}
    violations: list[dict[str, Any]] = []
    for ts_file in core_src.rglob("*.ts"):
        if not ts_file.is_file():
            continue
        try:
            content = ts_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # Round 7 L-07: strip comments + string literals before scanning
        # so `// import { x } from "@stele/cli"` (a comment) and string
        # references like JSDoc `` `@stele/cli` `` don't false-positive.
        scanned = _strip_ts_comments(content)
        for m in _STELE_PACKAGE_PREFIX_RE.finditer(scanned):
            # The regex has three alternation groups; exactly one matches.
            pkg = m.group(1) or m.group(2) or m.group(3)
            if pkg is None or pkg in _CORE_ALLOWED_DEPS:
                continue
            line_no = scanned.count("\n", 0, m.start()) + 1
            violations.append({
                "file": str(ts_file.relative_to(_REPO_ROOT)),
                "line": line_no,
                "column": None,
                "message": (
                    f"forbidden import `@stele/{pkg}` — @stele/core must be a leaf "
                    f"package; only @stele/call-graph-core is allow-listed"
                ),
            })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} forbidden cross-package import(s) inside @stele/core: "
                + "; ".join(
                    f"{v['file']}:{v['line']} ({v['message']})" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




_CJS_REQUIRE_RE = re.compile(r"\brequire\s*\(\s*[\"'][^\"']+[\"']\s*\)")


_VERSION_TS_ALLOWLIST = {
    "packages/cli/src/version.ts",
}




def no_cjs_require_in_ts_source(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 7 (Round 5 deferred dogfood #1): CLAUDE.md 'ESM only'.
    Refuse CJS `require()` calls in TS source. The single allowed site
    (`packages/cli/src/version.ts`) reads `package.json` via
    `createRequire(import.meta.url)` and is explicitly allow-listed."""
    violations: list[dict[str, Any]] = []
    for pkg_dir in sorted(_PACKAGES_DIR.glob("*")):
        if not pkg_dir.is_dir():
            continue
        src_dir = pkg_dir / "src"
        if not src_dir.is_dir():
            continue
        for ts_file in src_dir.rglob("*.ts"):
            if "node_modules" in ts_file.parts or "dist" in ts_file.parts:
                continue
            if str(ts_file).endswith(".d.ts"):
                continue
            rel = str(ts_file.relative_to(_REPO_ROOT))
            if rel in _VERSION_TS_ALLOWLIST:
                continue
            try:
                content = ts_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            # Round 8 N-02: blank string-literal contents too — otherwise a
            # `const msg = "use require(...)"` string would false-positive.
            stripped = _strip_ts_comments_and_strings(content)
            for m in _CJS_REQUIRE_RE.finditer(stripped):
                line_no = stripped.count("\n", 0, m.start()) + 1
                violations.append({
                    "file": rel,
                    "line": line_no,
                    "column": None,
                    "message": (
                        f"`{m.group(0)}` — CJS require() in TS source "
                        f"(CLAUDE.md 'ESM only')."
                    ),
                })
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} CJS require() call(s) in TS source: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




def tsconfig_base_strict_mode(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 7 (Round 5 deferred dogfood #2): tsconfig.base.json
    compilerOptions.strict must be true; per-option strict flags must
    not be individually disabled."""
    tsconfig = _REPO_ROOT / "tsconfig.base.json"
    if not tsconfig.is_file():
        return {"passed": False, "message": "tsconfig.base.json missing"}
    try:
        raw = tsconfig.read_text(encoding="utf-8", errors="replace")
        cleaned = re.sub(r"//[^\n]*", "", raw)
        cleaned = re.sub(r"/\*[\s\S]*?\*/", "", cleaned)
        data = json.loads(cleaned)
    except (OSError, json.JSONDecodeError) as e:
        return {"passed": False, "message": f"tsconfig.base.json parse failed: {e}"}
    compiler = data.get("compilerOptions") or {}
    if compiler.get("strict") is not True:
        return {
            "passed": False,
            "message": (
                "tsconfig.base.json compilerOptions.strict must be `true`; "
                "found " + repr(compiler.get("strict"))
            ),
        }
    forbidden_overrides = {
        "noImplicitAny": False,
        "strictNullChecks": False,
        "strictFunctionTypes": False,
        "strictBindCallApply": False,
        "alwaysStrict": False,
    }
    violations: list[str] = []
    for opt, forbidden_val in forbidden_overrides.items():
        if compiler.get(opt) is forbidden_val:
            violations.append(f"{opt}={forbidden_val}")
    if violations:
        return {
            "passed": False,
            "message": (
                "tsconfig.base.json weakens strict mode via per-option override: "
                + ", ".join(violations)
            ),
        }
    return {"passed": True, "message": None, "violations": []}




_SHIM_MARKER_RE = re.compile(
    # Round 8 N-04: anchor on EITHER comment opener (`//` line comment
    # or `/*` block comment opener); accept optional whitespace before
    # the punctuation after `removed`; allow `-` as a third punctuation
    # variant; accept `compatibility` as a synonym of `compat`; require
    # punctuation after `removed` so the diff.ts section header
    # `// Removed contexts` still does NOT match.
    r"(?://|/\*)\s*(?:"
    r"removed\s*[:—-]|"                       # `// removed:`, `// removed —`, `// removed -`
    r"TODO\(compat(?:ibility)?\)|"
    r"for\s+backwards?[\s-]+compat(?:ibility)?\b|"
    r"@deprecated\s+temporary\b|"
    r"legacy\s+shim\b|"
    r"compat(?:ibility)?\s+shim\b"
    r")",
    re.IGNORECASE,
)




def no_backward_compat_shims(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 7 (Round 5 deferred dogfood #3): CLAUDE.md 'Don't add
    backward-compat shims, dead-flag toggles, or `// removed:` markers.'

    Round 8 N-02 follow-up: this checker MUST keep comments visible
    (the markers ARE comments — stripping them would defeat the check).
    But it must also resist a string-literal smuggling attempt where
    the marker is embedded in a string. Use `_blank_string_interiors`
    which is length-preserving and keeps comments untouched, so the
    regex sees real comment text only and reported line numbers stay
    accurate.
    """
    violations: list[dict[str, Any]] = []
    for pkg_dir in sorted(_PACKAGES_DIR.glob("*")):
        if not pkg_dir.is_dir():
            continue
        src_dir = pkg_dir / "src"
        if not src_dir.is_dir():
            continue
        for ts_file in src_dir.rglob("*.ts"):
            if "node_modules" in ts_file.parts or "dist" in ts_file.parts:
                continue
            if str(ts_file).endswith(".d.ts"):
                continue
            try:
                content = ts_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            search_form = _blank_string_interiors(content)
            for m in _SHIM_MARKER_RE.finditer(search_form):
                line_no = search_form.count("\n", 0, m.start()) + 1
                line = content.splitlines()[line_no - 1] if line_no - 1 < len(content.splitlines()) else ""
                violations.append({
                    "file": str(ts_file.relative_to(_REPO_ROOT)),
                    "line": line_no,
                    "column": None,
                    "message": f"backward-compat marker: {line.strip()[:120]}",
                })
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} backward-compat shim marker(s) in TS source: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




_CORE_PURITY_FORBIDDEN = [
    # Dotted forms — the obvious surface.
    ("Date.now()", r"\bDate\.now\s*\("),
    ("Math.random()", r"\bMath\.random\s*\("),
    ("process.env access", r"\bprocess\.env\b"),
    ("process.hrtime()", r"\bprocess\.hrtime\b"),
    ("crypto.randomBytes()", r"\bcrypto\.randomBytes\s*\("),
    ("crypto.randomUUID()", r"\bcrypto\.randomUUID\s*\("),
    # Round 8 N-01: bare imported-name forms (`import { randomBytes }
    # from "node:crypto"`). The original checker only saw the dotted
    # form and was therefore silently allowing the most concise way to
    # introduce nondeterminism. We now also flag the bare callees.
    # Gating on the matching import is intentional: a parameter named
    # `randomBytes` doesn't get flagged unless the file actually
    # imports `randomBytes` from a crypto-like module.
    ("randomBytes (bare)", r"\brandomBytes\s*\(", "import_crypto"),
    ("randomUUID (bare)",  r"\brandomUUID\s*\(",  "import_crypto"),
    ("randomInt (bare)",   r"\brandomInt\s*\(",   "import_crypto"),
]


_CORE_PURITY_IMPORT_GATES = {
    # Round 9 O-02 + Round 10 Q-02: anchor on start-of-line + `import`
    # keyword + the `from "...crypto"` clause. Run against the
    # strings-preserved-comments-stripped form so a string literal
    # mention of `from "node:crypto"` cannot trigger the gate (the
    # `import` prefix would be absent), AND tolerate multi-line
    # imports — `import {\n  randomBytes\n} from "node:crypto"` is
    # common and must still match. The `[\s\S]*?` instead of
    # `[^;\n]*` covers the newline case; the `(?m)^\s*` start anchor
    # still requires the `import` keyword at statement position.
    "import_crypto": re.compile(
        r'(?m)^\s*import\b[\s\S]*?\bfrom\s+["\'](?:node:)?crypto["\']',
    ),
}


_CORE_PURITY_ALLOWLIST = {
    # hash-manifest.ts uses Date.now() + process.pid + randomBytes(8)
    # to build a unique temp-file name during atomic rename. That is
    # the ONLY non-pure call site allowed in the core engine.
    "packages/core/src/manifest/hash-manifest.ts": {
        "Date.now()",
        "randomBytes (bare)",
    },
}




def core_engine_purity(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 7 (Round 5 deferred dogfood #4): CLAUDE.md 'Core engine is
    pure. Same input must produce the same output.' Scan
    `packages/core/src` for nondeterminism sources.

    Round 8 N-01: also flags the bare imported-name forms
    (`randomBytes` from `node:crypto`) — not just the `crypto.X()`
    dotted form. Round 8 N-02: blanks string-literal interiors before
    scanning so a `const msg = "Date.now()"` does not false-positive.
    """
    core_src = _PACKAGES_DIR / "core" / "src"
    if not core_src.is_dir():
        return {"passed": True, "message": "no @stele/core/src present", "violations": []}
    violations: list[dict[str, Any]] = []
    for ts_file in core_src.rglob("*.ts"):
        if not ts_file.is_file() or str(ts_file).endswith(".d.ts"):
            continue
        rel = str(ts_file.relative_to(_REPO_ROOT))
        allow = _CORE_PURITY_ALLOWLIST.get(rel, set())
        try:
            content = ts_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # Use the strings-blanked form for FORBIDDEN-CALL detection
        # (so a `"Date.now()"` string literal doesn't false-positive)
        # but use the strings-preserved form for IMPORT GATE detection
        # (so `from "node:crypto"` is still visible — blanking would
        # erase the package name inside the string literal).
        stripped = _strip_ts_comments_and_strings(content)
        comments_only_stripped = _strip_ts_comments(content)
        for entry in _CORE_PURITY_FORBIDDEN:
            label, pattern = entry[0], entry[1]
            gate_key = entry[2] if len(entry) > 2 else None
            if label in allow:
                continue
            if gate_key is not None:
                gate = _CORE_PURITY_IMPORT_GATES[gate_key]
                if gate.search(comments_only_stripped) is None:
                    continue
            for m in re.finditer(pattern, stripped):
                line_no = stripped.count("\n", 0, m.start()) + 1
                violations.append({
                    "file": rel,
                    "line": line_no,
                    "column": None,
                    "message": f"`{label}` violates @stele/core purity",
                })
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} non-pure call(s) in @stele/core: "
                + "; ".join(
                    f"{v['file']}:{v['line']} ({v['message'][:50]})"
                    for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




_CLI_FS_WRITE_RE = re.compile(
    r"\b(?:writeFile|writeFileSync|appendFile|appendFileSync|"
    r"mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|"
    r"createWriteStream|copyFile|copyFileSync|rename|renameSync)\s*\(",
)


# Round 8 N-06: the original scope was `cli/src/commands/` only, which
# left the allowlist (`utils/output-path.ts`, `last-report.ts`) as dead
# code and contradicted the invariant description ("any new file IO in
# packages/cli or packages/claude-code-plugin/scripts/"). The scope now
# matches the description; the allowlist becomes meaningful and pins
# the two files that legitimately own raw-path IO inside the CLI.
_CLI_PATH_SAFETY_ALLOWLIST = {
    # Round 9 O-07: only files that actually own raw-path IO today
    # appear here. version.ts has no fs write and was removed from the
    # list — keep it dead-config-free.
    "packages/cli/src/utils/output-path.ts",
    "packages/cli/src/last-report.ts",
}


_CLI_PATH_SAFETY_SCAN_DIRS = (
    ("cli", "src"),
    ("claude-code-plugin", "scripts"),
)



# Round 10 Q-01 + Round 11 R-02/R-03: parse imports FROM `node:path` /
# `path`. The parser must:
#   1. handle the four ES-module import shapes:
#        import path from "node:path"                    (default)
#        import * as path from "node:path"               (namespace)
#        import { resolve, join } from "node:path"       (named)
#        import path, { resolve } from "node:path"       (mixed)
#   2. honour `as` aliases (`{ resolve as r }` → local binding `r`,
#      original `resolve`)
#   3. be statement-anchored (R-02): only `import` keywords at the
#      start of a line. Template-literal text that mentions the import
#      shape must NOT inject fake bindings.
#   4. distinguish original-name (used to validate it's a real path
#      helper) from local-binding-name (used to recognise call sites
#      via `local(` notation).
#
# Each regex is anchored on `(?m)^\s*import\b`. The `from "..."`
# specifier is required to be exactly `"path"` or `"node:path"` (the
# quotes are matched). Multi-line imports are supported via `[\s\S]*?`.

_PATH_IMPORT_NAMESPACE_RE = re.compile(
    r'(?m)^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["\'](?:node:)?path["\']',
)


_PATH_IMPORT_DEFAULT_RE = re.compile(
    # `import path from "node:path"` — bare identifier with no braces
    # OR a default + named combo where we record the default identifier
    # and let the named-import regex catch the rest of the destructure.
    # Round 12 S-01: the optional `, { ... }` destructure capture must
    # NOT contain `;`, `{`, or `}` — otherwise an `import x, { y } from
    # "node:url"` line above an `import { z } from "node:path"` line
    # spans across statements and falsely registers `x` as a path
    # namespace. Same class of bug Round 11 R-03 fixed in
    # `_PATH_IMPORT_NAMED_RE`; the companion DEFAULT regex was missed.
    r'(?m)^\s*import\s+([A-Za-z_$][\w$]*)(?:\s*,\s*\{[^;{}]*?\})?\s+from\s+["\'](?:node:)?path["\']',
)


_PATH_IMPORT_NAMED_RE = re.compile(
    # `import { ... } from "node:path"` OR `import id, { ... } from ...`
    # The named destructure block can span multiple lines but cannot
    # contain `;` (statement separator) or another `{`/`}` (Round 11
    # follow-up: the original `[\s\S]*?` was too permissive — when an
    # earlier import line for a different module ended with `}`, the
    # non-greedy match spanned across statements and the captured
    # content was malformed).
    r'(?m)^\s*import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^;{}]*?)\}\s+from\s+["\'](?:node:)?path["\']',
)



_KNOWN_PATH_HELPERS = frozenset(
    {"resolve", "join", "dirname", "normalize", "relative", "basename"}
)




def _path_module_bindings(comments_only_source: str, blanked_source: str) -> dict[str, set[str]]:
    """Round 10 Q-01 + Round 11 R-02/R-03: return the local bindings
    introduced by any `import ... from "(node:)?path"` statements.

    R-02 anti-smuggle: the import regex must scan the
    comments-only-stripped form (string literals preserved — required
    so the `"path"` module specifier is visible), BUT each candidate
    match's start offset is double-checked against the strings-AND-
    comments-blanked form. If the offset there is BLANK (= the match
    sat inside a string / template literal), we reject it. That way:
    - real top-of-file imports survive both checks (their offset in
      the blanked form is `i` for `import`),
    - template-literal smuggled fake imports are rejected (their
      offset in the blanked form is whitespace).

    R-03: handles default (`import x from`), namespace (`import * as
    p from`), named (`import { x }`), default + named (`import x, { y
    } from`), and aliased destructures (`{ resolve as r }`).
    """
    namespaces: set[str] = set()
    names: set[str] = set()

    def _is_real_statement(match_start: int) -> bool:
        # Reject the candidate if the blanked-source has whitespace at
        # the match start — that means the match position was inside a
        # string / template literal in the original source.
        if match_start >= len(blanked_source):
            return False
        return not blanked_source[match_start].isspace()

    for m in _PATH_IMPORT_NAMESPACE_RE.finditer(comments_only_source):
        if not _is_real_statement(m.start()):
            continue
        namespaces.add(m.group(1))
    for m in _PATH_IMPORT_DEFAULT_RE.finditer(comments_only_source):
        if not _is_real_statement(m.start()):
            continue
        namespaces.add(m.group(1))
    for m in _PATH_IMPORT_NAMED_RE.finditer(comments_only_source):
        if not _is_real_statement(m.start()):
            continue
        for tok in m.group(1).split(","):
            tok = tok.strip()
            if not tok:
                continue
            parts = re.split(r"\s+as\s+", tok)
            original = re.split(r"\W+", parts[0].strip(), maxsplit=1)[0]
            local = re.split(r"\W+", parts[-1].strip(), maxsplit=1)[0]
            if not original or not local:
                continue
            if original in _KNOWN_PATH_HELPERS:
                names.add(local)
    return {"namespaces": namespaces, "names": names}




def cli_io_through_path_utils(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 7 (Round 5 deferred dogfood #5): CLAUDE.md 'Path safety is
    the hot path.' Every file in `packages/cli/src` and
    `packages/claude-code-plugin/scripts` that calls a node:fs write
    function must also reference one of the path-safety primitives in
    the same file.

    Round 8 N-02/N-06: scope now covers the full `cli/src/**` tree and
    the plugin scripts (matching the invariant description, not just
    the `commands/` subdir). String-literal interiors are blanked
    before the safety-helper substring check, so an agent can no
    longer satisfy the rule by mentioning the helper inside a string.
    """
    violations: list[dict[str, Any]] = []
    scanned = 0
    for parts in _CLI_PATH_SAFETY_SCAN_DIRS:
        scan_root = _PACKAGES_DIR
        for part in parts:
            scan_root = scan_root / part
        if not scan_root.is_dir():
            continue
        # Scan .ts AND .js (the plugin scripts are ESM JS).
        for pattern in ("*.ts", "*.js", "*.mjs", "*.cjs"):
            for src_file in scan_root.rglob(pattern):
                if not src_file.is_file() or str(src_file).endswith(".d.ts"):
                    continue
                rel = str(src_file.relative_to(_REPO_ROOT))
                if rel in _CLI_PATH_SAFETY_ALLOWLIST:
                    continue
                try:
                    content = src_file.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                scanned += 1
                # Round 11 R-02: use the strings-blanked form for the
                # forbidden-call scan AND pass BOTH forms to the
                # import-binding parser so the parser can see the
                # module specifier (in comments-only form) AND verify
                # the import is not template-literal smuggled (in
                # blanked form).
                stripped = _strip_ts_comments_and_strings(content)
                comments_only = _strip_ts_comments(content)
                if not _CLI_FS_WRITE_RE.search(stripped):
                    continue
                # Always-accepted explicit helpers (the project's own
                # path-safety surface — never depend on local import
                # bindings):
                always_accepted = (
                    "validateOutputPath(",
                    "collectProtectedPaths(",
                    "normalizeProjectRelativePath(",
                    "isWithinProject(",
                    "matchProtectedPath(",
                )
                has_path_safety = any(marker in stripped for marker in always_accepted)
                if not has_path_safety:
                    bindings = _path_module_bindings(comments_only, stripped)
                    # Namespace / default import bind the whole `path`
                    # module — accept `<binding>.resolve(` /
                    # `<binding>.join(` style calls.
                    for ns in bindings["namespaces"]:
                        if any(
                            f"{ns}.{helper}(" in stripped
                            for helper in _KNOWN_PATH_HELPERS
                        ):
                            has_path_safety = True
                            break
                    # Destructure import (possibly aliased) — accept
                    # the local binding as a bare call. The parser
                    # already filtered to bindings whose original
                    # symbol is in _KNOWN_PATH_HELPERS, so any LOCAL
                    # name here is a legitimate path helper.
                    if not has_path_safety:
                        for name in bindings["names"]:
                            if f"{name}(" in stripped:
                                has_path_safety = True
                                break
                if not has_path_safety:
                    violations.append({
                        "file": rel,
                        "line": None,
                        "column": None,
                        "message": (
                            "fs-write call site has no path-safety helper reference"
                        ),
                    })
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} file(s) write to fs without going through path-safety helpers "
                f"(scanned {scanned}): "
                + "; ".join(v['file'] for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




_LOCALECOMPARE_RE = re.compile(r"\.localeCompare\s*\(")


_LOCALECOMPARE_ALLOWLIST = {
    # Round 9 P-01: the single source of truth for the wrapper.
    # `stableStringCompare` mentions localeCompare only in its comment;
    # the helper itself uses pure code-point comparison. We allow this
    # file because the dogfood ban is about ENFORCING the helper's
    # existence + use, not its definition.
    "packages/core/src/util/array.ts",
}




def no_bare_locale_compare(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 9 P-01 + Round 10 Q-03: `String.prototype.localeCompare()`
    reads ICU/host locale and produces different orderings across
    machines (LANG=de_DE vs LANG=sv_SE sort `ä` differently). That
    cracks determinism in the generator output AND the manifest hash
    — same input → different bytes → spurious tamper-detection alerts
    on CI vs. dev laptop.

    CORE_ENGINE_PURITY covers Date.now / Math.random / process.env /
    crypto.random*; locale dependence is just as much "the same input
    must produce the same output." Use `stableStringCompare(left, right)`
    from `@stele/core` everywhere instead.

    Scope (Round 10 Q-03): all `.ts` source files under `packages/*/src`
    AND `packages/*/tests/` — tests are also at risk of locale-flake
    if they sort by string compare. Excludes `.d.ts` and the canonical
    `util/array.ts` allow-listed above.
    """
    violations: list[dict[str, Any]] = []
    for pkg_dir in sorted(_PACKAGES_DIR.glob("*")):
        if not pkg_dir.is_dir():
            continue
        for sub in ("src", "tests"):
            scan_dir = pkg_dir / sub
            if not scan_dir.is_dir():
                continue
            for ts_file in scan_dir.rglob("*.ts"):
                if "node_modules" in ts_file.parts or "dist" in ts_file.parts:
                    continue
                if str(ts_file).endswith(".d.ts"):
                    continue
                rel = str(ts_file.relative_to(_REPO_ROOT))
                if rel in _LOCALECOMPARE_ALLOWLIST:
                    continue
                try:
                    content = ts_file.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                stripped = _strip_ts_comments_and_strings(content)
                for m in _LOCALECOMPARE_RE.finditer(stripped):
                    line_no = stripped.count("\n", 0, m.start()) + 1
                    violations.append({
                        "file": rel,
                        "line": line_no,
                        "column": None,
                        "message": (
                            "`.localeCompare(` is locale-dependent — use "
                            "`stableStringCompare(left, right)` from @stele/core"
                        ),
                    })
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} `.localeCompare(` call(s) — locale-dependent ordering "
                f"leaks into manifest hash + generated output: "
                + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




# Round 13 L-05/P-04: extractor function names that MUST come from the
# shared `bash-extractors.js` module. If either consumer re-defines
# any of these locally, the two hook scripts can drift again.
_BASH_EXTRACTOR_NAMES = (
    "extractBashWriteTargets",
    "extractWriteTargetsFromLine",
    "extractRedirectTargets",
    "extractTeeTargets",
    "extractFileOperationTargets",
    "extractDdTargets",
    "extractGitCheckoutTargets",
    "extractInterpreterScriptTargets",
    "extractHeredocDelimiters",
    "_firstRealCommandIndex",
)


_BASH_EXTRACTOR_CONSUMERS = (
    "packages/claude-code-plugin/scripts/pre-tool-protect.js",
    "packages/claude-code-plugin/scripts/observation-hook.js",
)


_BASH_EXTRACTOR_MODULE = "packages/claude-code-plugin/scripts/bash-extractors.js"




def bash_extractors_shared(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 13 L-05/P-04: assert that both hook scripts use the SHARED
    `bash-extractors.js` module — not their own copies. Earlier rounds
    found that `observation-hook.js` had a weaker extractor set than
    `pre-tool-protect.js` (missing git-checkout, interpreter `-c`,
    wrapper-flag peeling, `ln`, and 4 file-op commands — 8 vectors),
    which meant the audit log was blind to writes the deny gate was
    actively blocking. This checker enforces three rules:

      1. The shared `bash-extractors.js` module exists.
      2. Both consumers `import` from it.
      3. Neither consumer re-defines any of the canonical extractor
         function names (`function extractRedirectTargets(...)` etc.).

    Together these prevent the two scripts from drifting again.
    """
    module_path = _REPO_ROOT / _BASH_EXTRACTOR_MODULE
    if not module_path.is_file():
        return {
            "passed": False,
            "message": f"Shared bash-extractors module missing: {_BASH_EXTRACTOR_MODULE}",
        }
    module_src = module_path.read_text(encoding="utf-8")
    # The module itself must EXPORT the canonical names.
    for name in _BASH_EXTRACTOR_NAMES:
        # `export function X(` or `export { X, ...` shape.
        if (
            f"export function {name}(" not in module_src
            and f"export const {name}" not in module_src
        ):
            return {
                "passed": False,
                "message": (
                    f"`{name}` missing from {_BASH_EXTRACTOR_MODULE} — the "
                    "shared module must export every canonical extractor "
                    "name so consumers can not re-implement them locally."
                ),
            }
    violations: list[dict[str, Any]] = []
    import_re = re.compile(
        r'import\s*\{[^}]*\bextractBashWriteTargets\b[^}]*\}\s*from\s*["\']\./bash-extractors\.js["\']'
    )
    for rel in _BASH_EXTRACTOR_CONSUMERS:
        consumer_path = _REPO_ROOT / rel
        if not consumer_path.is_file():
            violations.append({
                "file": rel, "line": None, "column": None,
                "message": "consumer file missing",
            })
            continue
        src = consumer_path.read_text(encoding="utf-8")
        if not import_re.search(src):
            violations.append({
                "file": rel, "line": None, "column": None,
                "message": (
                    "does not import `extractBashWriteTargets` from "
                    "`./bash-extractors.js` — the shared module is the "
                    "single source of truth."
                ),
            })
            continue
        # Re-implementing any canonical extractor locally is forbidden.
        for name in _BASH_EXTRACTOR_NAMES:
            local_def_re = re.compile(rf"^function\s+{re.escape(name)}\s*\(", re.MULTILINE)
            if local_def_re.search(src):
                violations.append({
                    "file": rel, "line": None, "column": None,
                    "message": (
                        f"locally re-defines `function {name}(...)` — "
                        "delete the local copy and import from the shared "
                        "module instead."
                    ),
                })
    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} bash-extractor sharing violation(s): "
                + "; ".join(f"{v['file']}: {v['message']}" for v in violations[:5])
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




def inline_version_sync(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify inline version strings match package.json versions."""
    # Get version from packages/cli/package.json
    cli_pkg = _PACKAGES_DIR / "cli" / "package.json"
    core_pkg = _PACKAGES_DIR / "core" / "package.json"

    versions: dict[str, str] = {}
    for pkg_path in [cli_pkg, core_pkg]:
        if pkg_path.exists():
            try:
                data = json.loads(pkg_path.read_text(encoding="utf-8"))
                ver = data.get("version")
                if ver:
                    versions[pkg_path.parent.name] = ver
            except (json.JSONDecodeError, OSError):
                continue

    if not versions:
        return {"passed": False, "message": "No package.json versions found"}

    # Check manifest.ts for STELE_VERSION matching
    manifest_ts = _PACKAGES_DIR / "core" / "src" / "manifest" / "manifest.ts"
    if manifest_ts.exists():
        content = manifest_ts.read_text(encoding="utf-8")
        stele_ver_match = re.search(r'STELE_VERSION\s*=\s*"([^"]+)"', content)
        if stele_ver_match:
            inline_ver = stele_ver_match.group(1)
            core_ver = versions.get("core", "")
            # Normalize: "0.1.0" matches "0.1"
            if inline_ver != core_ver:
                # Allow "0.1.0" when package.json has "0.1"
                if not (_normalize_version(inline_ver)[:2] == _normalize_version(core_ver)[:2]):
                    return {
                        "passed": False,
                        "message": f"STELE_VERSION {inline_ver} != core package.json {core_ver}",
                    }

    return {"passed": True}
