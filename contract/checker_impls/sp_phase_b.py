"""Phase B self-protection checkers (evaluator-compile, CI strictness, fix-hint, default-protected)."""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
from typing import Any

from sp_shared import *  # noqa: F401,F403

__all__ = [
    "_PHASE_B_EVALUATOR_PACKAGES",
    "all_evaluators_compile",
    "_LENIENT_FLAG_RE",
    "_SCRIPT_REF_RE",
    "_PNPM_RUN_RE",
    "_ENV_LENIENT_RE",
    "_scan_text_for_lenient",
    "strict_mode_default_in_ci",
    "_FIX_HINT_SOURCES",
    "_FIX_HINT_REQUIRED_KEYWORDS",
    "_inline_propose_exit_text",
    "_RE_A_CODE",
    "_RE_B_CONTRACT",
    "_RE_CHOOSE",
    "_analyze_fix_hint_structure",
    "_extract_exported_function_bodies",
    "fix_hint_requires_analysis_branch",
    "_extract_string_array",
    "_count_string_literals_in_array",
    "default_protected_consistent",
]




# ---------------------------------------------------------------------------
# Phase B self-protection: evaluator packages, CI strictness, fix-hint shape
# ---------------------------------------------------------------------------


_PHASE_B_EVALUATOR_PACKAGES = [
    "@stele/call-graph-core",
    "@stele/trace-evaluator",
    "@stele/type-state-evaluator",
    "@stele/effect-evaluator",
    "@stele/type-driven-evaluator",
    # Round 7 M-08: architecture-core ships `evaluate.ts` and is
    # consumed by the CLI's architecture/import evaluator pipeline.
    # It was missing from the Phase B compile gate, so a broken
    # build there would not fail the self-protection contract.
    "@stele/architecture-core",
]




def all_evaluators_compile(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify every Phase B evaluator package has dist/index.js + dist/index.d.ts.

    Derives the package dir from the npm name (e.g. "@stele/trace-evaluator"
    -> "packages/trace-evaluator") and checks the two required build artifacts.
    """
    violations: list[dict[str, Any]] = []
    for package_name in _PHASE_B_EVALUATOR_PACKAGES:
        if not package_name.startswith("@stele/"):
            violations.append({
                "file": package_name,
                "line": None,
                "column": None,
                "message": f"unrecognized package name '{package_name}'",
            })
            continue
        package_dir_name = package_name.split("/", 1)[1]
        pkg_dir = _PACKAGES_DIR / package_dir_name
        index_js = pkg_dir / "dist" / "index.js"
        index_dts = pkg_dir / "dist" / "index.d.ts"
        if not index_js.is_file():
            violations.append({
                "file": str(index_js.relative_to(_REPO_ROOT)),
                "line": None,
                "column": None,
                "message": f"{package_name}: missing dist/index.js",
            })
        if not index_dts.is_file():
            violations.append({
                "file": str(index_dts.relative_to(_REPO_ROOT)),
                "line": None,
                "column": None,
                "message": f"{package_name}: missing dist/index.d.ts",
            })

    if violations:
        return {
            "passed": False,
            "message": "Some evaluator packages are not built: " + "; ".join(
                v["message"] for v in violations[:5]
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




_LENIENT_FLAG_RE = re.compile(r"--lenient-")


# Match references to shell + Python + Node scripts that the workflow may
# delegate to: `bash scripts/x.sh`, `python scripts/y.py`, `node tools/z.mjs`,
# `./scripts/x.sh args…`.
# Round 4 E-11 + Reviewer D D-10: extended from shell-only (.sh/.bash/.zsh)
# to also cover `.py`, `.mjs`, `.cjs`, `.js`, `.rb` — anything an agent
# could delegate to from a workflow step.
_SCRIPT_REF_RE = re.compile(
    r"(?:\b(?:bash|sh|zsh|python|python3|node|nodejs|ruby|perl)\s+)?(?P<path>[\w./\-]+\.(?:sh|bash|zsh|py|mjs|cjs|js|rb|pl))\b",
)


# Round 4 E-11 + Reviewer D D-10: workflow steps frequently delegate to
# `pnpm run <script>` / `npm run <script>` / `yarn <script>`. Those scripts
# live in package.json#scripts. Match the `run <name>` to find the target.
_PNPM_RUN_RE = re.compile(r"\b(?:pnpm|npm|yarn)\s+(?:run\s+)?(?P<name>[a-zA-Z][\w:-]*)")


# An env: assignment whose value text contains the literal lenient flag —
# pre-P1-3 the checker only scanned argv lines and missed this.
_ENV_LENIENT_RE = re.compile(
    r"^\s*[A-Z_][A-Z0-9_]*\s*:\s*[\"']?[^\n]*--lenient-",
    re.MULTILINE,
)




def _scan_text_for_lenient(
    rel_path: str,
    content: str,
    violations: list[dict[str, Any]],
) -> None:
    """Round 3 P1-3: surface every `--lenient-` token in a workflow or
    referenced shell script. Caller controls de-duplication."""
    for lineno, line in enumerate(content.splitlines(), 1):
        for m in _LENIENT_FLAG_RE.finditer(line):
            violations.append({
                "file": rel_path,
                "line": lineno,
                "column": m.start() + 1,
                "message": (
                    f"CI uses lenient flag: {line.strip()[:140]}"
                ),
            })
    for m in _ENV_LENIENT_RE.finditer(content):
        lineno = content.count("\n", 0, m.start()) + 1
        # Skip if the same line was already captured by the direct scan above.
        line_text = content.splitlines()[lineno - 1] if lineno - 1 < len(content.splitlines()) else ""
        if any(v["file"] == rel_path and v["line"] == lineno for v in violations):
            continue
        violations.append({
            "file": rel_path,
            "line": lineno,
            "column": 1,
            "message": (
                f"CI env assigns lenient flag (will expand via $VAR in a step): {line_text.strip()[:140]}"
            ),
        })




def strict_mode_default_in_ci(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify no CI workflow passes --lenient-* flags to stele check.

    Scans .github/workflows/*.yml and .github/workflows/*.yaml for any
    occurrence of "--lenient-", plus:
      - any `env:` value containing `--lenient-` (Round 3 P1-3 — shell-var
        injection like `STELE_ARGS: "--lenient-effects"` followed later by
        `stele check $STELE_ARGS`)
      - any shell script referenced from a `run:` line (Round 3 P1-3 — the
        flag may live in a referenced script rather than the workflow itself)

    Absence of the directory is treated as passing — the repo has no CI
    config yet.
    """
    workflows_dir = _REPO_ROOT / ".github" / "workflows"
    if not workflows_dir.is_dir():
        return {
            "passed": True,
            "message": "No .github/workflows/ directory",
            "violations": [],
        }

    violations: list[dict[str, Any]] = []
    referenced_scripts: set[pathlib.Path] = set()
    referenced_pkg_scripts: set[str] = set()
    workflow_files = sorted(
        list(workflows_dir.glob("*.yml")) + list(workflows_dir.glob("*.yaml"))
    )
    for wf in workflow_files:
        try:
            content = wf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel_wf = str(wf.relative_to(_REPO_ROOT))
        _scan_text_for_lenient(rel_wf, content, violations)
        # Discover referenced standalone scripts (bash / python / node).
        for m in _SCRIPT_REF_RE.finditer(content):
            script_rel = m.group("path").lstrip("./")
            script_path = _REPO_ROOT / script_rel
            if script_path.is_file():
                referenced_scripts.add(script_path)
        # Round 4 E-11: discover `pnpm run <name>` / `npm run <name>` /
        # `yarn <name>` references whose body lives in package.json#scripts.
        for m in _PNPM_RUN_RE.finditer(content):
            referenced_pkg_scripts.add(m.group("name"))

    for script in sorted(referenced_scripts):
        try:
            script_content = script.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel_script = str(script.relative_to(_REPO_ROOT))
        _scan_text_for_lenient(rel_script, script_content, violations)

    # Round 4 E-11: scan every package.json in the workspace for a `scripts`
    # block whose value contains a lenient flag — workflows that delegate
    # via `pnpm run X` would otherwise sneak past the workflow-only scanner.
    package_json_paths = [_REPO_ROOT / "package.json"]
    package_json_paths.extend(_PACKAGES_DIR.glob("*/package.json"))
    for pkg in package_json_paths:
        if not pkg.is_file():
            continue
        try:
            data = json.loads(pkg.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        scripts = data.get("scripts")
        if not isinstance(scripts, dict):
            continue
        for name, body in scripts.items():
            if not isinstance(body, str):
                continue
            if "--lenient-" not in body:
                continue
            violations.append({
                "file": str(pkg.relative_to(_REPO_ROOT)),
                "line": None,
                "column": None,
                "message": (
                    f"package.json script '{name}' contains a lenient flag: "
                    + body.strip()[:140]
                ),
            })

    if violations:
        return {
            "passed": False,
            "message": (
                f"CI workflows pass --lenient-* flags in {len(violations)} location(s): "
                + "; ".join(
                    f"{v['file']}:{v['line']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




_FIX_HINT_SOURCES = [
    "packages/trace-evaluator/src/fix-hint-substitution.ts",
    "packages/type-state-evaluator/src/fix-hint.ts",
    "packages/effect-evaluator/src/fix-hint.ts",
]



# Substrings that must appear at all (loose check, kept for backwards-compat
# with negative test fixtures).
_FIX_HINT_REQUIRED_KEYWORDS = ["code issue", "contract issue", "propose", "[A]", "[B]"]




def _inline_propose_exit_text(body: str, source: str) -> str:
    """Round 3 P1-2: defaultForbiddenEffectFixHint and friends emit their
    `[B]` block by calling `proposeExitText(...)` — a separate function in
    the same file. The structural check needs to see that text, so before
    we analyse a body we replace every `proposeExitText(...)` call with the
    *literal return value* of the function defined in the same file.

    If `proposeExitText` is not exported in this file the body is returned
    unchanged (the structural check will then complain about a missing
    `[B]` branch, which is the right thing).
    """
    if "proposeExitText(" not in body:
        return body
    functions = _extract_exported_function_bodies(source)
    propose = next(
        (b for (name, _line, b) in functions if name == "proposeExitText"),
        None,
    )
    if propose is None:
        return body
    # Strip out the `return [ ... ].join("\n");` template-string scaffolding;
    # what's left between the array's [ ... ] is the actual canonical text.
    return body + "\n" + propose




_RE_A_CODE = re.compile(r"\[A\]\s+Code issue", re.IGNORECASE)


_RE_B_CONTRACT = re.compile(r"\[B\]\s+Contract issue", re.IGNORECASE)


_RE_CHOOSE = re.compile(r"Choose\s+\[A\]\s+or\s+\[B\]\s+before\s+acting", re.IGNORECASE)




def _analyze_fix_hint_structure(body: str) -> list[str]:
    """Round 3 P1-2: enforce *semantic* A/B-branch shape, not just keyword
    presence. The canonical structure is:

        ...head...
        ... "code issue or contract issue?" ...        (lead-in question)
        [A] Code issue — ... <code suggestion> ...
        [B] Contract issue — ... propose ... contract/design/proposals/ ...
        Choose [A] or [B] before acting...

    The pure-keyword check passes pathological inputs like
    `[A] propose this code change to the contract issue` because every
    required substring is present. This function anchors on the canonical
    phrase pairs `[A] Code issue` and `[B] Contract issue` (case-insensitive)
    so a semantically inverted hint is caught even when every individual
    keyword exists somewhere in the body.

    Returns a list of structural failures. Empty list = pass.
    """
    failures: list[str] = []
    match_a = _RE_A_CODE.search(body)
    match_b = _RE_B_CONTRACT.search(body)

    if match_a is None:
        failures.append("missing `[A] Code issue` anchor (with that exact phrasing)")
    if match_b is None:
        failures.append("missing `[B] Contract issue` anchor (with that exact phrasing)")
    if failures:
        return failures

    if match_a.start() > match_b.start():
        failures.append("`[A] Code issue` must appear before `[B] Contract issue`")
        return failures

    # Region between [A] Code issue and [B] Contract issue must contain a
    # concrete code suggestion, not just abstract framing. We do not enforce
    # syntactic backtick-snippet here (that's E0339); we enforce that the
    # text is not silent — at least one full line of advice between A and B.
    a_region = body[match_a.end():match_b.start()]
    if len(a_region.strip()) < 20:
        failures.append(
            "`[A]` branch is empty or too short — must describe a concrete code repair",
        )

    # Round 4 D-09: stronger content-inversion guard. The legacy structural
    # check accepted any text in the [A] region as long as the literal
    # `[A] Code issue` anchor was present. An adversarial hint that says
    #   `[A] Code issue — n/a, this is purely a contract problem, do nothing`
    # would pass. Require the [A] region to contain at least one action verb
    # from a small whitelist that names a code-side repair.
    a_lower = a_region.lower()
    _A_ACTION_VERBS = (
        "fix",
        "change",
        "update",
        "replace",
        "edit",
        "refactor",
        "remove",
        "add",
        "rewrite",
        "annotate",
        "introduce",
        "delete",
        "move",
    )
    # Accept either (a) a literal action verb in the [A] body, OR (b) a
    # template-string interpolation that delegates the action advice to a
    # helper function. The latter is what trace-evaluator's defaultFixHint
    # does — it template-interpolates `codeIssueAdvice(kind, …)` whose
    # branches each begin with a verb like "Insert" / "Route" / "Stop".
    has_verb = any(verb in a_lower for verb in _A_ACTION_VERBS)
    has_delegated_action = "${" in a_region and "}" in a_region
    if not (has_verb or has_delegated_action):
        failures.append(
            "`[A]` branch must contain at least one code-action verb "
            "(fix/change/update/replace/edit/refactor/remove/add/rewrite/"
            "annotate/introduce/delete/move) OR delegate via a "
            "`${codeBranch}` template-string — otherwise it does not "
            "describe a concrete code repair",
        )

    # The [B] region is everything from `[B] Contract issue` onward; it must
    # carry the propose flow + a pointer at the YAML proposal store.
    b_region = body[match_b.start():]
    lower_b = b_region.lower()
    if "propose" not in lower_b:
        failures.append("`[B]` branch must reference the propose flow")
    if "contract/design/proposals" not in lower_b:
        failures.append(
            "`[B]` branch must point at `contract/design/proposals/<id>.yaml` (the YAML proposal store)",
        )

    # The trailing decision prompt is the agent's call-to-action; without it
    # the hint reads as a default suggestion rather than an analysis branch.
    if _RE_CHOOSE.search(body) is None:
        failures.append(
            "missing the trailing `Choose [A] or [B] before acting` decision prompt",
        )

    return failures




def _extract_exported_function_bodies(source: str) -> list[tuple[str, int, str]]:
    """Extract exported TS function bodies via brace counting.

    Returns a list of (function_name, line_no, body_text) tuples for every
    `export function NAME(...)` declaration found. The body text is the
    region between the first `{` after the signature and its matching `}`.
    """
    results: list[tuple[str, int, str]] = []
    decl_pattern = re.compile(r"\bexport\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
    for match in decl_pattern.finditer(source):
        name = match.group(1)
        # find first opening brace after signature
        lb = source.find("{", match.end())
        if lb == -1:
            continue
        depth = 0
        i = lb
        while i < len(source):
            ch = source[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    body = source[lb + 1:i]
                    line_no = source.count("\n", 0, match.start()) + 1
                    results.append((name, line_no, body))
                    break
            i += 1
    return results




def fix_hint_requires_analysis_branch(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Verify default fix-hint generators contain the A/B analysis branch.

    For each evaluator's fix-hint source file, locate every exported function
    whose name starts with `default` or ends in `FixHint` (heuristic for
    default-fix-hint generators). Helpers such as `proposeExitText` are
    skipped. Each candidate's body must contain all five required substrings
    (case-insensitive for the words; literal for `[A]` / `[B]`):
        "code issue", "contract issue", "propose", "[A]", "[B]"
    """
    violations: list[dict[str, Any]] = []
    for rel_path in _FIX_HINT_SOURCES:
        abs_path = _REPO_ROOT / rel_path
        if not abs_path.is_file():
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "fix-hint source file missing",
            })
            continue
        source = abs_path.read_text(encoding="utf-8", errors="replace")
        functions = _extract_exported_function_bodies(source)
        # Heuristic: default-fix-hint generators start with `default`. This
        # excludes helpers like `proposeExitText` and `substituteFixHint`
        # (which substitutes placeholders but doesn't itself emit a hint).
        candidates = [
            (name, line_no, body)
            for (name, line_no, body) in functions
            if name.startswith("default")
        ]
        if not candidates:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": "no default-fix-hint function found",
            })
            continue
        for name, line_no, body in candidates:
            # Layer 1 — loose keyword presence (back-compat with old negative tests).
            missing: list[str] = []
            for keyword in _FIX_HINT_REQUIRED_KEYWORDS:
                if keyword in ("[A]", "[B]"):
                    if keyword not in body:
                        missing.append(keyword)
                else:
                    if keyword.lower() not in body.lower():
                        missing.append(keyword)
            if missing:
                violations.append({
                    "file": rel_path,
                    "line": line_no,
                    "column": None,
                    "message": (
                        f"{name} missing analysis-branch keywords: "
                        + ", ".join(missing)
                    ),
                })
                # When the keyword-level check fails the structural check would
                # mostly repeat the same complaint; skip the deeper pass to
                # keep the violation list focused.
                continue

            # Layer 2 — Round 3 P1-2 structural check: keywords present but in
            # the wrong branch / wrong order are caught here. Inline
            # `proposeExitText(...)` first so the [B] branch text reaches the
            # analyser (effect/type-state delegate [B] to that helper).
            resolved = _inline_propose_exit_text(body, source)
            structural_failures = _analyze_fix_hint_structure(resolved)
            if structural_failures:
                violations.append({
                    "file": rel_path,
                    "line": line_no,
                    "column": None,
                    "message": (
                        f"{name} structural fix-hint check failed: "
                        + "; ".join(structural_failures)
                    ),
                })

    if violations:
        return {
            "passed": False,
            "message": (
                f"{len(violations)} fix-hint function(s) lack required analysis-branch keywords: "
                + "; ".join(
                    f"{v['file']}:{v['line']} {v['message']}"
                    for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}




def _extract_string_array(source: str, anchor: str) -> set[str] | None:
    """Find the array literal following `anchor =` in source and return its
    string literals as a set. Returns None when the anchor is missing.

    Brittle-by-design: it expects an `=` sign between the anchor and the
    array open-bracket, so TypeScript type annotations like
    `readonly string[]` don't trip up the scanner.
    """
    idx = source.find(anchor)
    if idx == -1:
        return None
    # Find the array literal: scan forward for the first `[` that is
    # followed by whitespace + newline (i.e. a multi-line array opener,
    # not the `[]` of a TypeScript type annotation like `readonly string[]`).
    # All three target files use the multi-line format.
    pos = idx + len(anchor)
    lb = -1
    while pos < len(source):
        candidate = source.find("[", pos)
        if candidate == -1:
            return None
        # Look at the next non-space character on the same line; if it's
        # `]`, this is a `string[]`-style type bracket — skip past it.
        tail = source[candidate + 1:].lstrip(" \t")
        if tail.startswith("]"):
            pos = candidate + 1
            continue
        lb = candidate
        break
    if lb == -1:
        return None
    depth = 0
    end = -1
    for i in range(lb, len(source)):
        ch = source[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end == -1:
        return None
    body = source[lb + 1:end]
    # Round 6 L-02: strip BOTH single-line `// …` and `/* … */` block
    # comments via a quote-aware state machine. The pre-L-02 regex only
    # stripped start-of-line block comments to preserve glob patterns
    # inside quoted strings like "packages/*/tsup.config.ts" — but that
    # let an INLINE `/* "phantom" */` comment after a real entry inject
    # phantom literals into the extracted set, masking a real removal.
    # The state machine reads `"`/`'`/`` ` `` quotes and only enters
    # comment-strip mode when not inside a quoted string.
    body = _strip_js_comments_quote_aware(body)
    # Round 5 K-04: refuse if the body contains spread (`...`), template-
    # literal entries (backticks), or any non-string identifier — the
    # checker cannot reason about runtime-computed entries, so we treat
    # their presence as an automatic divergence signal upstream.
    if re.search(r"\.\.\.[a-zA-Z_]", body) or "`" in body:
        return None
    # Capture group 1 (double-quoted) OR group 2 (single-quoted); skip the
    # one that didn't match.
    return {
        (m.group(1) if m.group(1) is not None else m.group(2))
        for m in _STRING_LITERAL_RE.finditer(body)
    }




def _count_string_literals_in_array(source: str, anchor: str) -> int | None:
    """Round 5 I-17: count raw string-literal occurrences in the array
    following `anchor` (without set-canonicalization). Used alongside
    `_extract_string_array` to detect intra-list duplicates."""
    idx = source.find(anchor)
    if idx == -1:
        return None
    pos = idx + len(anchor)
    lb = -1
    while pos < len(source):
        candidate = source.find("[", pos)
        if candidate == -1:
            return None
        tail = source[candidate + 1:].lstrip(" \t")
        if tail.startswith("]"):
            pos = candidate + 1
            continue
        lb = candidate
        break
    if lb == -1:
        return None
    depth = 0
    end = -1
    for i in range(lb, len(source)):
        ch = source[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end == -1:
        return None
    body = source[lb + 1:end]
    # Same Round 6 L-02 quote-aware stripper used by _extract_string_array.
    body = _strip_js_comments_quote_aware(body)
    return sum(1 for _ in _STRING_LITERAL_RE.finditer(body))




def default_protected_consistent(ctx: dict, **kwargs: Any) -> dict[str, Any]:
    """Round 4 D-13: the three "default protected patterns" lists must
    agree byte-for-byte (modulo ordering):

      - packages/core/src/config/defaults.ts          DEFAULT_PROTECTED_PATTERNS
      - packages/cli/src/config/defaults.ts            DEFAULT_CONFIG.protected
      - packages/claude-code-plugin/scripts/           DEFAULT_PROTECTED
        pre-tool-protect.js

    A future fix that updates one and forgets the other two would silently
    drop defense-in-depth for some path category. This checker parses each
    file, extracts the literal-string set, and asserts equality.
    """
    # Round 5 J-02: four sources, not three. observation-hook.js carries
    # its own DEFAULT_PROTECTED used by the material-change heuristic for
    # the maintenance audit log; if it drifts the audit log silently
    # under-counts edits to hook scripts / supply-chain / approvals.
    sources = [
        (
            "packages/core/src/config/defaults.ts",
            "DEFAULT_PROTECTED_PATTERNS",
        ),
        (
            "packages/cli/src/config/defaults.ts",
            "protected:",
        ),
        (
            "packages/claude-code-plugin/scripts/pre-tool-protect.js",
            "DEFAULT_PROTECTED",
        ),
        (
            "packages/claude-code-plugin/scripts/observation-hook.js",
            "DEFAULT_PROTECTED",
        ),
    ]
    extracted: list[tuple[str, set[str]]] = []
    violations: list[dict[str, Any]] = []
    for rel_path, anchor in sources:
        abs_path = _REPO_ROOT / rel_path
        if not abs_path.is_file():
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": f"file missing — cannot verify '{anchor}'",
            })
            continue
        content = abs_path.read_text(encoding="utf-8", errors="replace")
        entries = _extract_string_array(content, anchor)
        if entries is None:
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": f"could not extract array following '{anchor}'",
            })
            continue
        # Round 5 I-17: additionally detect duplicate entries within a
        # single list. Without this, `["x", "x"]` looks identical to
        # `["x"]` after set-canonicalization, so an agent could pad a
        # list with duplicates to make a removal invisible.
        raw_count = _count_string_literals_in_array(content, anchor)
        if raw_count is not None and raw_count != len(entries):
            violations.append({
                "file": rel_path,
                "line": None,
                "column": None,
                "message": (
                    f"list contains {raw_count - len(entries)} duplicate "
                    f"entry/entries — checker uses set semantics so duplicates "
                    f"hide divergence"
                ),
            })
        extracted.append((rel_path, entries))

    # Round 5 I-17: additionally check that no single list contains a
    # duplicate entry — a set-equality comparison would silently mask
    # `["x", "x"]` against `["x"]`. We track raw counts above by
    # re-parsing the body and asserting len(list) == len(set).
    # (Implemented as a per-source pre-check.)
    if len(extracted) >= 2:
        base_path, base_set = extracted[0]
        for other_path, other_set in extracted[1:]:
            missing_here = base_set - other_set
            extra_here = other_set - base_set
            if missing_here:
                violations.append({
                    "file": other_path,
                    "line": None,
                    "column": None,
                    "message": (
                        f"missing {len(missing_here)} pattern(s) vs {base_path}: "
                        + ", ".join(sorted(missing_here))
                    ),
                })
            if extra_here:
                violations.append({
                    "file": base_path,
                    "line": None,
                    "column": None,
                    "message": (
                        f"missing {len(extra_here)} pattern(s) vs {other_path}: "
                        + ", ".join(sorted(extra_here))
                    ),
                })

    if violations:
        return {
            "passed": False,
            "message": (
                f"Default protected lists disagree in {len(violations)} place(s): "
                + "; ".join(
                    f"{v['file']} — {v['message']}" for v in violations[:5]
                )
            ),
            "violations": violations,
        }
    return {"passed": True, "message": None, "violations": []}
